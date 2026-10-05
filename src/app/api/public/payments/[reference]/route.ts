import { query } from "@/lib/server/db";

export async function GET(_request: Request, context: RouteContext<"/api/public/payments/[reference]">) {
  const { reference } = await context.params;
  if (!/^HH-[A-Z0-9-]{8,64}$/.test(reference)) return Response.json({ error: "Invalid payment reference" }, { status: 400 });
  const result = await query<{ payment_status: string; status: string; amount_kobo: string }>(
    `SELECT r.payment_status,r.status,r.amount_kobo::text FROM reservations r WHERE r.reference=$1 LIMIT 1`, [reference],
  );
  const reservation = result.rows[0];
  if (!reservation) return Response.json({ error: "Reservation not found" }, { status: 404 });
  return Response.json({ reference, paymentStatus: reservation.payment_status, reservationStatus: reservation.status, amountKobo: reservation.amount_kobo });
}
