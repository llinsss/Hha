import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withTransaction } from "../../db/sql.js";
import { businessToday } from "../../lib/dates.js";
import { toCsv } from "../../lib/csv.js";
import { requirePrincipal } from "../auth/principal.js";
import { confirmBankTransfer } from "./ledger.js";
import { ConfirmPaymentSchema, ExportPaymentsSchema, ListExceptionsSchema, ListPaymentsSchema, ResolveExceptionSchema } from "./payments.schemas.js";
import { exportPayments, listExceptions, listPayments, resolveException } from "./payments.service.js";
import { optionalText } from "../../lib/text.js";

export const paymentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: ListPaymentsSchema, preHandler: app.authorize("payments:read") }, async (request) =>
    listPayments(app, requirePrincipal(request).propertyId, { ...request.query, limit: request.query.limit ?? 50 }),
  );

  app.get(
    "/export",
    { schema: ExportPaymentsSchema, preHandler: app.authorize("payments:read"), config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      const rows = await exportPayments(app, requirePrincipal(request).propertyId, request.query);
      const csv = toCsv(
        ["source", "reference", "guest", "unit", "amount_kobo", "method", "status", "payment_reference", "created_at", "recorded_by", "confirmed_by", "confirmed_at"],
        rows.map((row) => [row.source, row.reference, row.guest_name, row.unit_label, row.amount_kobo, row.method, row.status, row.payment_reference, row.created_at, row.recorded_by, row.confirmed_by, row.confirmed_at]),
      );
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="payments-${businessToday().replaceAll("-", "")}.csv"`)
        .header("cache-control", "no-store")
        .send(csv);
    },
  );

  app.patch("/:id", { schema: ConfirmPaymentSchema, preHandler: app.authorize("payments:confirm") }, async (request) => {
    const principal = requirePrincipal(request);
    await withTransaction(app.db, (tx) =>
      confirmBankTransfer(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        paymentId: request.params.id,
        source: request.body.source,
        note: optionalText(request.body.note),
      }),
    );
    return { ok: true as const };
  });
};

export const paymentExceptionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: ListExceptionsSchema, preHandler: app.authorize("payments:confirm") }, async (request) =>
    listExceptions(app, requirePrincipal(request).propertyId, { ...request.query, limit: request.query.limit ?? 50 }),
  );

  app.patch("/:id", { schema: ResolveExceptionSchema, preHandler: app.authorize("payments:confirm") }, async (request) =>
    resolveException(app, requirePrincipal(request), request.params.id, request.body.resolutionNote.trim()),
  );
};
