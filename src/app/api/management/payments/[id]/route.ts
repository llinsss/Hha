import { inTransaction } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function PATCH(request: Request, context: RouteContext<"/api/management/payments/[id]">) {
  const access = await requirePermission("payments:confirm");
  if (access.response) return access.response;
  const { id } = await context.params;
  const body = await request.json();
  const source = String(body.source ?? "");
  if (!new Set(["accommodation", "restaurant"]).has(source)) return Response.json({ error: "Choose a valid payment source" }, { status: 400 });
  try {
    await inTransaction(async (client) => {
      if (source === "accommodation") {
        const found = await client.query<{ property_id: string; reservation_id: string; amount_kobo: string; method: string; status: string }>(
          `SELECT p.property_id,p.reservation_id,p.amount_kobo::text,p.method,p.status FROM payments p
           WHERE p.id=$1 AND p.property_id=$2 AND p.reservation_id IS NOT NULL FOR UPDATE`, [id, access.user!.propertyId],
        );
        const payment = found.rows[0];
        if (!payment) throw new Error("NOT_FOUND");
        if (payment.status !== "pending" || payment.method !== "bank_transfer") throw new Error("NOT_PENDING");
        await client.query("UPDATE payments SET status='settled',confirmed_by=$2,confirmed_at=now() WHERE id=$1", [id, access.user!.id]);
        const reservation = await client.query<{ amount_kobo: string; status: string }>("SELECT amount_kobo::text,status FROM reservations WHERE id=$1 AND property_id=$2 FOR UPDATE", [payment.reservation_id, access.user!.propertyId]);
        if (!reservation.rows[0]) throw new Error("NOT_FOUND");
        const totals = await client.query<{ settled: string; pending: string }>(`SELECT
          coalesce(sum(amount_kobo) FILTER(WHERE status='settled'),0)::text AS settled,
          coalesce(sum(amount_kobo) FILTER(WHERE status='pending'),0)::text AS pending
          FROM payments WHERE reservation_id=$1`, [payment.reservation_id]);
        const settled = BigInt(totals.rows[0].settled);
        const pending = BigInt(totals.rows[0].pending);
        const nextPaymentStatus = settled >= BigInt(reservation.rows[0].amount_kobo) ? "paid" : pending > BigInt(0) ? "pending" : settled > BigInt(0) ? "part_paid" : "unpaid";
        await client.query(`UPDATE reservations SET payment_status=$2,
          status=CASE WHEN status='pending_payment' AND $2='paid' THEN 'confirmed' ELSE status END,
          hold_expires_at=CASE WHEN $2='paid' THEN null ELSE hold_expires_at END,updated_at=now() WHERE id=$1`, [payment.reservation_id, nextPaymentStatus]);
        await logAudit(client, payment.property_id, access.user!.id, "payment.bank_transfer_confirmed", "payment", id, { reservationId: payment.reservation_id, amountKobo: payment.amount_kobo });
        await logOutbox(client, payment.property_id, "payment.settled", id, { source, reservationId: payment.reservation_id, amountKobo: payment.amount_kobo });
      } else {
        const found = await client.query<{ property_id: string; total_kobo: string; payment_method: string; payment_status: string }>(
          "SELECT property_id,total_kobo::text,payment_method,payment_status FROM pos_orders WHERE id=$1 AND property_id=$2 AND status<>'voided' FOR UPDATE", [id, access.user!.propertyId],
        );
        const order = found.rows[0];
        if (!order) throw new Error("NOT_FOUND");
        if (order.payment_status !== "pending" || order.payment_method !== "bank_transfer") throw new Error("NOT_PENDING");
        await client.query("UPDATE pos_orders SET payment_status='settled',payment_confirmed_by=$2,payment_confirmed_at=now() WHERE id=$1", [id, access.user!.id]);
        await logAudit(client, order.property_id, access.user!.id, "payment.bank_transfer_confirmed", "pos_order", id, { amountKobo: order.total_kobo });
        await logOutbox(client, order.property_id, "payment.settled", id, { source, amountKobo: order.total_kobo });
      }
    });
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return Response.json({ error: "Payment not found" }, { status: 404 });
    if (error instanceof Error && error.message === "NOT_PENDING") return Response.json({ error: "Only pending bank transfers can be confirmed" }, { status: 409 });
    return Response.json({ error: "Unable to confirm bank transfer" }, { status: 500 });
  }
}
