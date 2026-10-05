import type { FastifyInstance } from "fastify";
import { withConnection, withTransaction, type Sql } from "../../db/sql.js";
import { BUSINESS_TIMEZONE, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import { EXCEPTION_TITLES } from "../reference/labels.js";
import type { Principal } from "../auth/session.service.js";

export type RegisterFilters = {
  source?: "accommodation" | "restaurant";
  status?: "pending" | "settled" | "failed";
  method?: "cash" | "pos" | "bank_transfer" | "online";
  from?: string;
  to?: string;
  q?: string;
};

export type PaymentRecord = {
  id: string;
  source: string;
  reference: string;
  guest_name: string;
  unit_label: string;
  amount_kobo: string;
  method: string;
  status: string;
  payment_reference: string | null;
  created_at: Date;
  recorded_by: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  cursor_created: string;
};

const MAX_RANGE_DAYS = 366;
export const EXPORT_MAX_ROWS = 10_000;

/** Both ledgers as one register, filtered by parameters $1–$7. */
const REGISTER_SQL = `
  WITH register AS (
    SELECT p.id, 'accommodation'::text AS source, r.reference, g.full_name AS guest_name,
           coalesce('Room ' || ro.room_number, r.room_type) AS unit_label, p.amount_kobo, p.method, p.status,
           p.provider_reference AS payment_reference, p.created_at, recorder.full_name AS recorded_by,
           confirmer.full_name AS confirmed_by, p.confirmed_at
      FROM payments p
      JOIN reservations r ON r.id = p.reservation_id
      JOIN guests g ON g.id = r.guest_id
      LEFT JOIN rooms ro ON ro.id = r.room_id
      LEFT JOIN users recorder ON recorder.id = p.recorded_by
      LEFT JOIN users confirmer ON confirmer.id = p.confirmed_by
     WHERE p.property_id = $1 AND ($2::text IS NULL OR $2 = 'accommodation')
    UNION ALL
    SELECT o.id, 'restaurant', o.receipt_number, 'Restaurant sale', 'Restaurant', o.total_kobo, o.payment_method,
           CASE o.payment_status WHEN 'pending' THEN 'pending' ELSE 'settled' END,
           o.payment_reference, o.created_at, cashier.full_name, confirmer.full_name, o.payment_confirmed_at
      FROM pos_orders o
      JOIN users cashier ON cashier.id = o.cashier_id
      LEFT JOIN users confirmer ON confirmer.id = o.payment_confirmed_by
     WHERE o.property_id = $1 AND o.status <> 'voided' AND ($2::text IS NULL OR $2 = 'restaurant')
  )
  SELECT * FROM register
   WHERE ($3::text IS NULL OR status = $3)
     AND ($4::text IS NULL OR method = $4)
     AND ($5::date IS NULL OR (created_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date >= $5::date)
     AND ($6::date IS NULL OR (created_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date <= $6::date)
     AND ($7::text IS NULL OR reference ILIKE $7 ESCAPE '\\' OR guest_name ILIKE $7 ESCAPE '\\' OR payment_reference ILIKE $7 ESCAPE '\\')`;

function registerParams(propertyId: string, filters: RegisterFilters): unknown[] {
  if (filters.from && filters.to && (filters.to < filters.from || nightsBetween(filters.from, filters.to) > MAX_RANGE_DAYS)) {
    throw Errors.unprocessable(`"to" must not be before "from" and at most ${MAX_RANGE_DAYS} days later`, "INVALID_RANGE");
  }
  const like = filters.q ? `%${filters.q.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
  return [propertyId, filters.source ?? null, filters.status ?? null, filters.method ?? null, filters.from ?? null, filters.to ?? null, like];
}

export async function listPayments(app: FastifyInstance, propertyId: string, filters: RegisterFilters & { limit: number; cursor?: string }) {
  const params = registerParams(propertyId, filters);
  const cursor = decodeCursor(filters.cursor, 2);
  return withConnection(app.db, async (sql) => {
    const rows = await sql.rows<PaymentRecord>(
      `SELECT x.*, x.created_at::text AS cursor_created FROM (${REGISTER_SQL}) x
        WHERE ($8::timestamptz IS NULL OR (x.created_at, x.id) < ($8::timestamptz, $9::uuid))
        ORDER BY x.created_at DESC, x.id DESC
        LIMIT $10`,
      [...params, cursor?.[0] ?? null, cursor?.[1] ?? null, filters.limit + 1],
    );
    const totals = await sql.one<{ count: number; settled: string; pending: string; failed: string }>(
      `SELECT count(*)::int AS count,
              coalesce(sum(amount_kobo) FILTER (WHERE status = 'settled'), 0)::text AS settled,
              coalesce(sum(amount_kobo) FILTER (WHERE status = 'pending'), 0)::text AS pending,
              coalesce(sum(amount_kobo) FILTER (WHERE status = 'failed'), 0)::text AS failed
         FROM (${REGISTER_SQL}) x`,
      params,
    );
    const page = toPage(rows, filters.limit, (row) => [row.cursor_created, row.id]);
    return {
      payments: page.items.map((row) => ({ ...row, amount_kobo: String(row.amount_kobo) })),
      nextCursor: page.nextCursor,
      totals: { count: totals.count, settledKobo: totals.settled, pendingKobo: totals.pending, failedKobo: totals.failed },
    };
  });
}

export async function exportPayments(app: FastifyInstance, propertyId: string, filters: RegisterFilters): Promise<PaymentRecord[]> {
  const params = registerParams(propertyId, filters);
  const rows = await withConnection(app.db, (sql) =>
    sql.rows<PaymentRecord>(`SELECT x.*, x.created_at::text AS cursor_created FROM (${REGISTER_SQL}) x ORDER BY x.created_at DESC, x.id DESC LIMIT $8`, [
      ...params,
      EXPORT_MAX_ROWS + 1,
    ]),
  );
  if (rows.length > EXPORT_MAX_ROWS) throw Errors.unprocessable(`More than ${EXPORT_MAX_ROWS} records match; narrow the date range`, "EXPORT_TOO_LARGE");
  return rows;
}

type ExceptionRow = {
  id: string;
  kind: string;
  status: string;
  reservation_id: string | null;
  reservation_reference: string | null;
  payment_id: string | null;
  pos_order_id: string | null;
  provider: string | null;
  provider_reference: string | null;
  expected_amount_kobo: string | null;
  received_amount_kobo: string | null;
  details: Record<string, unknown>;
  detected_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
  cursor_detected: string;
};

function withTitle(row: ExceptionRow) {
  return { ...row, title: EXCEPTION_TITLES[row.kind] ?? row.kind };
}

const EXCEPTION_SELECT = `
  SELECT e.id, e.kind, e.status, e.reservation_id, r.reference AS reservation_reference, e.payment_id, e.pos_order_id,
         e.provider, e.provider_reference, e.expected_amount_kobo::text, e.received_amount_kobo::text, e.details,
         e.detected_at, e.resolved_at, u.full_name AS resolved_by, e.resolution_note, e.detected_at::text AS cursor_detected
    FROM payment_exceptions e
    LEFT JOIN reservations r ON r.id = e.reservation_id
    LEFT JOIN users u ON u.id = e.resolved_by`;

export async function listExceptions(
  app: FastifyInstance,
  propertyId: string,
  filters: { status?: "open" | "resolved"; kind?: string; limit: number; cursor?: string },
) {
  const cursor = decodeCursor(filters.cursor, 2);
  const rows = await withConnection(app.db, (sql) =>
    sql.rows<ExceptionRow>(
      `${EXCEPTION_SELECT}
        WHERE e.property_id = $1 AND e.status = $2 AND ($3::text IS NULL OR e.kind = $3)
          AND ($4::timestamptz IS NULL OR (e.detected_at, e.id) < ($4::timestamptz, $5::uuid))
        ORDER BY e.detected_at DESC, e.id DESC
        LIMIT $6`,
      [propertyId, filters.status ?? "open", filters.kind ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, filters.limit + 1],
    ),
  );
  const page = toPage(rows, filters.limit, (row) => [row.cursor_detected, row.id]);
  return { exceptions: page.items.map(withTitle), nextCursor: page.nextCursor };
}

/** Records the owner/manager decision. Deliberately has no side effects on stays or money. */
export async function resolveException(app: FastifyInstance, principal: Principal, id: string, note: string) {
  return withTransaction(app.db, async (tx: Sql) => {
    const resolved = await tx.exec(
      `UPDATE payment_exceptions SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution_note = $4
        WHERE id = $1 AND property_id = $2 AND status = 'open'`,
      [id, principal.propertyId, principal.userId, note],
    );
    if (resolved === 0) {
      const exists = await tx.maybeOne(`SELECT 1 FROM payment_exceptions WHERE id = $1 AND property_id = $2`, [id, principal.propertyId]);
      if (!exists) throw Errors.notFound("Payment exception not found");
      throw Errors.conflict("This exception is already resolved", "ALREADY_RESOLVED");
    }
    await recordEvent(tx, {
      propertyId: principal.propertyId,
      actorId: principal.userId,
      action: "payment_exception.resolved",
      entityType: "payment_exception",
      entityId: id,
      details: { note },
    });
    const exception = await tx.one<ExceptionRow>(`${EXCEPTION_SELECT} WHERE e.id = $1`, [id]);
    return { exception: withTitle(exception) };
  });
}
