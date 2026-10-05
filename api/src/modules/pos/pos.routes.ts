import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withConnection, withTransaction } from "../../db/sql.js";
import { BUSINESS_TIMEZONE } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import { requirePrincipal } from "../auth/principal.js";
import { CreateOrderSchema, GetShiftSchema, OverviewSchema, ReceiptSchema, ShiftActionSchema } from "./pos.schemas.js";
import { createOrder } from "./pos.service.js";
import { optionalText } from "../../lib/text.js";

type ReceiptOrder = {
  id: string;
  receipt_number: string;
  subtotal_kobo: string;
  discount_kobo: string;
  total_kobo: string;
  payment_method: string;
  payment_status: string;
  payment_reference: string | null;
  created_at: Date;
  cashier: string;
  property_name: string;
};

type ShiftRow = { id: string; opening_float_kobo: string; opened_at: Date };

const SHIFT_SELECT = `SELECT id, opening_float_kobo::text, opened_at FROM pos_shifts WHERE property_id = $1 AND cashier_id = $2 AND closed_at IS NULL`;

const posRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: OverviewSchema, preHandler: app.authorize("pos:read") }, async (request) => {
    const principal = requirePrincipal(request);
    const limit = request.query.limit ?? 50;
    const cursor = decodeCursor(request.query.cursor, 2);
    return withConnection(app.db, async (sql) => {
      const shift = await sql.maybeOne<ShiftRow>(SHIFT_SELECT, [principal.propertyId, principal.userId]);
      const rows = await sql.rows<{ id: string; cursor_created: string; created_at: Date; receipt_number: string; total_kobo: string; payment_method: string; payment_status: string; status: string; cashier: string }>(
        `SELECT o.id, o.receipt_number, o.total_kobo::text, o.payment_method, o.payment_status, o.status, o.created_at,
                u.full_name AS cashier, o.created_at::text AS cursor_created
           FROM pos_orders o JOIN users u ON u.id = o.cashier_id
          WHERE o.property_id = $1
            AND (o.created_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = (now() AT TIME ZONE '${BUSINESS_TIMEZONE}')::date
            AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid))
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $4`,
        [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      );
      const page = toPage(rows, limit, (row) => [row.cursor_created, row.id]);
      return { shift, orders: page.items, nextCursor: page.nextCursor };
    });
  });

  app.post("/", { schema: CreateOrderSchema, preHandler: [app.authorize("pos:write"), app.idempotent()] }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (request.body.idempotencyKey !== undefined && request.body.idempotencyKey !== key) {
      throw Errors.unprocessable("idempotencyKey must match the Idempotency-Key header", "IDEMPOTENCY_KEY_MISMATCH");
    }
    const result = await createOrder(app, requirePrincipal(request), {
      items: request.body.items,
      paymentMethod: request.body.paymentMethod,
      paymentReference: optionalText(request.body.paymentReference),
      idempotencyKey: key,
    });
    return reply.status(result.created ? 201 : 200).send({ order: result.order });
  });

  app.get("/shift", { schema: GetShiftSchema, preHandler: app.authorize("pos:read") }, async (request) => {
    const principal = requirePrincipal(request);
    const shift = await withConnection(app.db, (sql) => sql.maybeOne<ShiftRow>(SHIFT_SELECT, [principal.propertyId, principal.userId]));
    return { shift };
  });

  app.post("/shift", { schema: ShiftActionSchema, preHandler: app.authorize("pos:write") }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = request.body;
    if (body.action === "open") {
      if (body.openingFloatKobo === undefined || body.countedCashKobo !== undefined) throw Errors.unprocessable("Opening a shift needs openingFloatKobo only", "VALIDATION_FAILED");
      const openingFloat = body.openingFloatKobo;
      const shift = await withTransaction(app.db, async (tx) => {
        const opened = await tx.maybeOne<ShiftRow>(
          `INSERT INTO pos_shifts(property_id, cashier_id, opening_float_kobo) VALUES ($1, $2, $3)
           ON CONFLICT (cashier_id) WHERE closed_at IS NULL DO NOTHING
           RETURNING id, opening_float_kobo::text, opened_at`,
          [principal.propertyId, principal.userId, openingFloat],
        );
        if (!opened) throw Errors.conflict("You already have an open shift", "SHIFT_ALREADY_OPEN");
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: "pos.shift_opened",
          entityType: "pos_shift",
          entityId: opened.id,
          details: { openingFloatKobo: openingFloat },
          outbox: { reference: principal.fullName },
        });
        return opened;
      });
      return reply.status(201).send({ shift });
    }

    if (body.countedCashKobo === undefined || body.openingFloatKobo !== undefined) throw Errors.unprocessable("Closing a shift needs countedCashKobo only", "VALIDATION_FAILED");
    const counted = BigInt(body.countedCashKobo);
    const closed = await withTransaction(app.db, async (tx) => {
      const shift = await tx.maybeOne<{ id: string; opening_float_kobo: string }>(
        `SELECT id, opening_float_kobo::text FROM pos_shifts WHERE property_id = $1 AND cashier_id = $2 AND closed_at IS NULL FOR UPDATE`,
        [principal.propertyId, principal.userId],
      );
      if (!shift) throw Errors.conflict("There is no open shift", "NO_OPEN_SHIFT");
      const tenders = await tx.rows<{ method: string; paymentStatus: string; orders: number; totalKobo: string }>(
        `SELECT payment_method AS method, payment_status AS "paymentStatus", count(*)::int AS orders, sum(total_kobo)::text AS "totalKobo"
           FROM pos_orders WHERE shift_id = $1 AND status <> 'voided'
          GROUP BY payment_method, payment_status ORDER BY payment_method, payment_status`,
        [shift.id],
      );
      const cashSales = tenders.filter((tender) => tender.method === "cash" && tender.paymentStatus === "settled").reduce((sum, tender) => sum + BigInt(tender.totalKobo), 0n);
      const expected = BigInt(shift.opening_float_kobo) + cashSales;
      const variance = counted - expected;
      await tx.exec(
        `UPDATE pos_shifts SET closing_cash_kobo = $2, expected_cash_kobo = $3, variance_kobo = $4, closed_at = now() WHERE id = $1`,
        [shift.id, counted.toString(), expected.toString(), variance.toString()],
      );
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "pos.shift_closed",
        entityType: "pos_shift",
        entityId: shift.id,
        details: { countedCashKobo: counted.toString(), expectedCashKobo: expected.toString(), varianceKobo: variance.toString(), tenders },
        outbox: { reference: principal.fullName },
      });
      return { id: shift.id, expectedCashKobo: expected.toString(), varianceKobo: variance.toString(), tenders };
    });
    return reply.status(200).send({ shift: closed });
  });

  app.get("/:id", { schema: ReceiptSchema, preHandler: app.authorize("pos:read") }, async (request) => {
    const principal = requirePrincipal(request);
    return withConnection(app.db, async (sql) => {
      const order = await sql.maybeOne<ReceiptOrder>(
        `SELECT o.id, o.receipt_number, o.subtotal_kobo::text, o.discount_kobo::text, o.total_kobo::text, o.payment_method, o.payment_status,
                o.payment_reference, o.created_at, u.full_name AS cashier, p.name AS property_name
           FROM pos_orders o JOIN users u ON u.id = o.cashier_id JOIN properties p ON p.id = o.property_id
          WHERE o.id = $1 AND o.property_id = $2 AND o.status <> 'voided'`,
        [request.params.id, principal.propertyId],
      );
      if (!order) throw Errors.notFound("Receipt not found");
      if (order.payment_status !== "settled") throw Errors.conflict("Receipt is available after payment is confirmed", "PAYMENT_PENDING");
      const items = await sql.rows<{ item_name: string; quantity: number; unit_price_kobo: string; line_total_kobo: string }>(
        `SELECT item_name, quantity, unit_price_kobo::text, line_total_kobo::text FROM pos_order_items WHERE order_id = $1 ORDER BY item_name`,
        [request.params.id],
      );
      return { receipt: { ...order, items } };
    });
  });
};

export default posRoutes;
