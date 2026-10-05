import { inTransaction } from "@/lib/server/db";
import { logOutbox } from "@/lib/server/auth";
import { validProviderWebhook, verifyProviderTransaction } from "@/lib/server/payment-provider";

export async function POST(request: Request) {
  const raw = await request.text();
  try {
    if (!validProviderWebhook(raw, request.headers)) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  } catch {
    return Response.json({ error: "Payment provider is not configured" }, { status: 503 });
  }
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const provider = process.env.PAYMENT_PROVIDER?.toLowerCase() || "paystack";
    const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
    const reference = String(data.reference ?? data.tx_ref ?? "");
    const providerStatus = String(data.status ?? payload.event ?? "").toLowerCase();
    const failed = ["failed", "cancelled", "canceled", "charge.failed"].includes(providerStatus);
    const succeeded = provider === "paystack" ? providerStatus === "success" || payload.event === "charge.success" : providerStatus === "successful";
    if (!reference || (!failed && !succeeded)) return Response.json({ received: true, ignored: true });

    const verification = succeeded ? await verifyProviderTransaction(reference) : null;
    const eventId = verification?.eventId ?? `${provider}:${String(data.id ?? data.flw_ref ?? reference)}:${providerStatus}`;
    await inTransaction(async (client) => {
      await client.query("INSERT INTO provider_webhook_events(provider_event_id,payload) VALUES($1,$2)", [eventId, JSON.stringify(payload)]);
      const found = await client.query<{ id: string; property_id: string; amount_kobo: string; payment_status: string; status: string; hold_expires_at: Date | null }>(
        "SELECT id,property_id,amount_kobo::text,payment_status,status,hold_expires_at FROM reservations WHERE reference=$1 FOR UPDATE", [reference],
      );
      const reservation = found.rows[0];
      if (!reservation) throw new Error("RESERVATION_NOT_FOUND");
      if (failed) {
        await client.query("UPDATE payments SET status='failed' WHERE reservation_id=$1 AND method='online' AND status='pending'", [reservation.id]);
        await client.query("UPDATE reservations SET status='expired',payment_status='unpaid',updated_at=now() WHERE id=$1 AND status='pending_payment'", [reservation.id]);
        await logOutbox(client, reservation.property_id, "payment.failed", reservation.id, { reference });
      } else {
        if (!verification || verification.status !== (provider === "paystack" ? "success" : "successful") || verification.reference !== reference || verification.currency !== "NGN" || !Number.isSafeInteger(verification.amountKobo) || verification.amountKobo !== Number(reservation.amount_kobo)) throw new Error("PAYMENT_MISMATCH");
        const prior = await client.query<{ settled: string }>("SELECT coalesce(sum(amount_kobo),0)::text AS settled FROM payments WHERE reservation_id=$1 AND status='settled'", [reservation.id]);
        const wasAlreadyPaid = BigInt(prior.rows[0].settled) >= BigInt(reservation.amount_kobo);
        await client.query("UPDATE payments SET status='settled',provider=$2,provider_reference=$3 WHERE reservation_id=$1 AND method='online' AND status='pending'", [reservation.id, provider, reference]);
        const holdIsValid = reservation.status === "pending_payment" && reservation.hold_expires_at && reservation.hold_expires_at.getTime() > Date.now();
        if (!wasAlreadyPaid && holdIsValid) {
          await client.query("UPDATE reservations SET payment_status='paid',status='confirmed',hold_expires_at=null,updated_at=now() WHERE id=$1", [reservation.id]);
          await logOutbox(client, reservation.property_id, "reservation.confirmed", reservation.id, { reference, paymentProvider: provider });
        } else {
          await client.query("UPDATE reservations SET payment_status='paid',updated_at=now() WHERE id=$1", [reservation.id]);
          await logOutbox(client, reservation.property_id, wasAlreadyPaid ? "payment.overpayment_review" : "payment.received_after_hold_expiry", reservation.id, { reference, paymentProvider: provider });
        }
      }
      await client.query("UPDATE provider_webhook_events SET processed_at=now() WHERE provider_event_id=$1", [eventId]);
    });
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "23505") return Response.json({ received: true, duplicate: true });
    if (error instanceof Error && error.message === "RESERVATION_NOT_FOUND") return Response.json({ error: "Reservation not found" }, { status: 404 });
    console.error("payment webhook failed", error);
    return Response.json({ error: "Payment event could not be applied" }, { status: 400 });
  }
}
