import { inTransaction } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

const methods = new Set(["cash", "bank_transfer", "pos"]);

export async function POST(request: Request, context: RouteContext<"/api/management/reservations/[id]/payments">) {
  const access = await requirePermission("reservations:write");
  if (access.response) return access.response;
  const { id } = await context.params;
  const body = await request.json();
  const amount = Number(body.amountKobo);
  const method = String(body.method ?? "");
  const paymentReference = String(body.paymentReference ?? "").trim().slice(0, 120);
  const idempotencyKey = String(body.idempotencyKey ?? "");
  if (!Number.isSafeInteger(amount) || amount <= 0 || !methods.has(method) || !idempotencyKey) return Response.json({ error: "A valid amount, payment method, and idempotency key are required" }, { status: 400 });
  if (method === "bank_transfer" && !paymentReference) return Response.json({ error: "Enter the sender name or bank transfer reference" }, { status: 400 });
  try {
    const result = await inTransaction(async (client) => {
      const row = await client.query<{ property_id: string; amount_kobo: string; status: string }>("SELECT property_id,amount_kobo::text,status FROM reservations WHERE id=$1 AND property_id=$2 FOR UPDATE", [id, access.user!.propertyId]);
      const reservation = row.rows[0];
      if (!reservation) throw new Error("NOT_FOUND");
      if (["cancelled", "checked_out", "no_show", "expired"].includes(reservation.status)) throw new Error("CLOSED");
      const prior = await client.query("SELECT id FROM payments WHERE property_id=$1 AND idempotency_key=$2", [reservation.property_id, idempotencyKey]);
      if (prior.rowCount) return { duplicate: true };
      const totals = await client.query<{ settled: string; pending: string }>(`SELECT
        coalesce(sum(amount_kobo) FILTER(WHERE status='settled'),0)::text AS settled,
        coalesce(sum(amount_kobo) FILTER(WHERE status='pending'),0)::text AS pending FROM payments WHERE reservation_id=$1`, [id]);
      const settled = BigInt(totals.rows[0].settled);
      const pending = BigInt(totals.rows[0].pending);
      if (settled + pending + BigInt(amount) > BigInt(reservation.amount_kobo)) throw new Error("OVERPAYMENT");
      const paymentStatus = method === "bank_transfer" ? "pending" : "settled";
      await client.query(`INSERT INTO payments(property_id,reservation_id,amount_kobo,method,status,provider_reference,idempotency_key,recorded_by)
        VALUES($1,$2,$3,$4,$5,nullif($6,''),$7,$8)`, [reservation.property_id, id, amount, method, paymentStatus, paymentReference, idempotencyKey, access.user!.id]);
      const nextSettled = paymentStatus === "settled" ? settled + BigInt(amount) : settled;
      const nextPending = paymentStatus === "pending" ? pending + BigInt(amount) : pending;
      const nextStatus = nextSettled >= BigInt(reservation.amount_kobo) ? "paid" : nextPending > BigInt(0) ? "pending" : nextSettled > BigInt(0) ? "part_paid" : "unpaid";
      await client.query("UPDATE reservations SET payment_status=$2,status=CASE WHEN status='pending_payment' AND $2='paid' THEN 'confirmed' ELSE status END,hold_expires_at=CASE WHEN $2='paid' THEN null ELSE hold_expires_at END,updated_at=now() WHERE id=$1", [id, nextStatus]);
      const action = paymentStatus === "pending" ? "payment.submitted_for_confirmation" : "payment.recorded";
      await logAudit(client, reservation.property_id, access.user!.id, action, "reservation", id, { amountKobo: amount, method, paymentReference });
      await logOutbox(client, reservation.property_id, paymentStatus === "pending" ? "payment.pending_confirmation" : "payment.settled", id, { amountKobo: amount, method });
      return { duplicate: false, paid: nextStatus === "paid", paymentStatus };
    });
    return Response.json({ payment: result }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return Response.json({ error: "Reservation not found" }, { status: 404 });
    if (error instanceof Error && error.message === "CLOSED") return Response.json({ error: "Cannot add a payment to a closed stay" }, { status: 409 });
    if (error instanceof Error && error.message === "OVERPAYMENT") return Response.json({ error: "Payment exceeds the remaining balance" }, { status: 409 });
    return Response.json({ error: "Unable to record payment" }, { status: 500 });
  }
}
