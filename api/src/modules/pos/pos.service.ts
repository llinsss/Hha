import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withTransaction } from "../../db/sql.js";
import { businessToday } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import type { Principal } from "../auth/session.service.js";

type OrderInput = {
  items: { menuItemId: string; quantity: number }[];
  paymentMethod: "cash" | "pos" | "bank_transfer";
  paymentReference: string | null;
  idempotencyKey: string;
};

type CreatedOrder = { id: string; receipt_number: string; total_kobo: string; payment_status: string; duplicate: boolean };

function receiptNumber(): string {
  return `R-${businessToday().replaceAll("-", "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

/** Finalises a sale (PRD §4.3): order, lines, stock deduction and audit commit together or not at all. */
export async function createOrder(app: FastifyInstance, principal: Principal, input: OrderInput): Promise<{ created: boolean; order: CreatedOrder }> {
  if (input.paymentMethod === "bank_transfer" && !input.paymentReference) {
    throw Errors.unprocessable("Enter the sender name or bank transfer reference", "TRANSFER_REFERENCE_REQUIRED");
  }
  const quantities = new Map<string, number>();
  for (const line of input.items) quantities.set(line.menuItemId, (quantities.get(line.menuItemId) ?? 0) + line.quantity);
  const menuIds = [...quantities.keys()];
  const menuQuantities = menuIds.map((id) => quantities.get(id) ?? 0);

  return withTransaction(app.db, async (tx) => {
    const prior = await tx.maybeOne<Omit<CreatedOrder, "duplicate"> & { cashier_id: string }>(
      `SELECT id, receipt_number, total_kobo::text, payment_status, cashier_id FROM pos_orders WHERE property_id = $1 AND idempotency_key = $2`,
      [principal.propertyId, input.idempotencyKey],
    );
    if (prior) {
      if (prior.cashier_id !== principal.userId) throw Errors.conflict("This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
      return { created: false, order: { id: prior.id, receipt_number: prior.receipt_number, total_kobo: prior.total_kobo, payment_status: prior.payment_status, duplicate: true } };
    }

    const shift = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM pos_shifts WHERE property_id = $1 AND cashier_id = $2 AND closed_at IS NULL FOR UPDATE`,
      [principal.propertyId, principal.userId],
    );
    if (!shift) throw Errors.conflict("Open a cashier shift before taking a sale", "NO_OPEN_SHIFT");

    const menu = await tx.rows<{ id: string; name: string; price_kobo: string }>(
      `SELECT id, name, price_kobo::text FROM menu_items WHERE id = ANY($1::uuid[]) AND property_id = $2 AND active FOR SHARE`,
      [menuIds, principal.propertyId],
    );
    if (menu.length !== menuIds.length) throw Errors.conflict("A menu item is unavailable", "MENU_ITEM_UNAVAILABLE");
    const byId = new Map(menu.map((item) => [item.id, item]));
    const lines = menuIds.map((id, index) => {
      const item = byId.get(id);
      if (!item) throw Errors.conflict("A menu item is unavailable", "MENU_ITEM_UNAVAILABLE");
      const quantity = menuQuantities[index] ?? 0;
      return { ...item, quantity, lineTotal: BigInt(item.price_kobo) * BigInt(quantity) };
    });
    const total = lines.reduce((sum, line) => sum + line.lineTotal, 0n);

    // Lock every affected stock row in id order (deadlock-free) and check sufficiency in one pass.
    const stock = await tx.rows<{ id: string; name: string; needed: string; enough: boolean }>(
      `WITH lines AS (SELECT * FROM unnest($1::uuid[], $2::int[]) AS l(menu_item_id, qty)),
            usage AS (SELECT mr.inventory_item_id AS id, sum(mr.quantity * lines.qty) AS needed
                        FROM menu_recipes mr JOIN lines ON lines.menu_item_id = mr.menu_item_id
                       GROUP BY mr.inventory_item_id)
       SELECT i.id, i.name, usage.needed::text AS needed, i.quantity >= usage.needed AS enough
         FROM inventory_items i JOIN usage ON usage.id = i.id
        WHERE i.property_id = $3
        ORDER BY i.id
        FOR UPDATE OF i`,
      [menuIds, menuQuantities, principal.propertyId],
    );
    const short = stock.find((row) => !row.enough);
    if (short) throw Errors.conflict(`Insufficient stock for ${short.name}`, "INSUFFICIENT_STOCK");

    const pending = input.paymentMethod === "bank_transfer";
    const receipt = receiptNumber();
    const order = await tx.one<{ id: string }>(
      `INSERT INTO pos_orders(property_id, receipt_number, subtotal_kobo, discount_kobo, total_kobo, payment_method, status, payment_status,
                              payment_reference, idempotency_key, cashier_id, shift_id)
       VALUES ($1, $2, $3, 0, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [principal.propertyId, receipt, total.toString(), input.paymentMethod, pending ? "pending_payment" : "paid", pending ? "pending" : "settled", input.paymentReference, input.idempotencyKey, principal.userId, shift.id],
    );
    await tx.exec(
      `INSERT INTO pos_order_items(order_id, menu_item_id, item_name, quantity, unit_price_kobo, line_total_kobo)
       SELECT $1, * FROM unnest($2::uuid[], $3::text[], $4::int[], $5::bigint[], $6::bigint[])`,
      [order.id, lines.map((line) => line.id), lines.map((line) => line.name), lines.map((line) => line.quantity), lines.map((line) => line.price_kobo), lines.map((line) => line.lineTotal.toString())],
    );
    if (stock.length > 0) {
      const ids = stock.map((row) => row.id);
      const needed = stock.map((row) => row.needed);
      await tx.exec(
        `UPDATE inventory_items i SET quantity = i.quantity - u.needed
           FROM unnest($1::uuid[], $2::numeric[]) AS u(id, needed) WHERE i.id = u.id`,
        [ids, needed],
      );
      await tx.exec(
        `INSERT INTO stock_movements(property_id, item_id, movement_type, quantity_delta, reason, reference, recorded_by)
         SELECT $1, u.id, 'sale', -u.needed, $3, $4, $5 FROM unnest($2::uuid[], $6::numeric[]) AS u(id, needed)`,
        [principal.propertyId, ids, `Restaurant sale ${receipt}`, receipt, principal.userId, needed],
      );
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "inventory.sale_deducted",
        entityType: "pos_order",
        entityId: order.id,
        details: { items: stock.map((row) => ({ id: row.id, quantity: row.needed })) },
        outbox: { type: "inventory.stock_changed", reference: receipt },
      });
    }
    await recordEvent(tx, {
      propertyId: principal.propertyId,
      actorId: principal.userId,
      action: "pos.order_finalized",
      entityType: "pos_order",
      entityId: order.id,
      details: { receiptNumber: receipt, totalKobo: total.toString(), paymentMethod: input.paymentMethod },
      outbox: { reference: receipt },
    });
    if (pending) {
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "payment.submitted_for_confirmation",
        entityType: "pos_order",
        entityId: order.id,
        details: { amountKobo: total.toString(), paymentReference: input.paymentReference },
        outbox: { type: "payment.pending_confirmation", reference: receipt },
      });
    }
    return {
      created: true,
      order: { id: order.id, receipt_number: receipt, total_kobo: total.toString(), payment_status: pending ? "pending" : "settled", duplicate: false },
    };
  });
}
