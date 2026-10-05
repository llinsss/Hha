import { timingSafeEqual } from "node:crypto";
import { inTransaction } from "@/lib/server/db";
import { logOutbox } from "@/lib/server/auth";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!secret || supplied.length !== secret.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const count = await inTransaction(async (client) => {
      const expired = await client.query<{ id: string; property_id: string; reference: string }>(
        `UPDATE reservations SET status='expired',payment_status=CASE
             WHEN (SELECT coalesce(sum(p.amount_kobo),0) FROM payments p WHERE p.reservation_id=reservations.id AND p.status='settled') >= amount_kobo THEN 'paid'
             WHEN EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id=reservations.id AND p.status='settled') THEN 'part_paid'
             ELSE 'unpaid' END,updated_at=now()
         WHERE status IN ('hold','pending_payment') AND hold_expires_at <= now()
         RETURNING id,property_id,reference`,
      );
      if (expired.rowCount) {
        const ids = expired.rows.map((row) => row.id);
        await client.query("UPDATE payments SET status='failed' WHERE reservation_id=ANY($1::uuid[]) AND method='online' AND status='pending'", [ids]);
        for (const reservation of expired.rows) await logOutbox(client, reservation.property_id, "reservation.hold_expired", reservation.id, { reference: reservation.reference });
      }
      return expired.rowCount ?? 0;
    });
    return Response.json({ expired: count });
  } catch (error) {
    console.error("reservation hold expiry failed", error);
    return Response.json({ error: "Unable to expire payment holds" }, { status: 500 });
  }
}
