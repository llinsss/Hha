import { query } from "@/lib/server/db";
import { requirePermission } from "@/lib/server/auth";

export async function GET() {
  const access = await requirePermission("payments:read");
  if (access.response) return access.response;
  const propertyId = access.user!.propertyId;
  const [stays, restaurant] = await Promise.all([
    query(`SELECT p.id,'accommodation' AS source,r.reference,g.full_name AS guest_name,
      coalesce('Room '||ro.room_number,r.room_type) AS unit_label,p.amount_kobo::text,
      p.method,p.status,p.provider_reference AS payment_reference,p.created_at,
      recorder.full_name AS recorded_by,confirmer.full_name AS confirmed_by,p.confirmed_at
      FROM payments p JOIN reservations r ON r.id=p.reservation_id
      JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms ro ON ro.id=r.room_id
      LEFT JOIN users recorder ON recorder.id=p.recorded_by LEFT JOIN users confirmer ON confirmer.id=p.confirmed_by
      WHERE p.property_id=$1 ORDER BY p.created_at DESC LIMIT 300`, [propertyId]),
    query(`SELECT o.id,'restaurant' AS source,o.receipt_number AS reference,
      'Restaurant sale'::text AS guest_name,'Restaurant'::text AS unit_label,o.total_kobo::text AS amount_kobo,
      o.payment_method AS method,o.payment_status AS status,o.payment_reference,o.created_at,
      cashier.full_name AS recorded_by,confirmer.full_name AS confirmed_by,o.payment_confirmed_at AS confirmed_at
      FROM pos_orders o JOIN users cashier ON cashier.id=o.cashier_id
      LEFT JOIN users confirmer ON confirmer.id=o.payment_confirmed_by
      WHERE o.property_id=$1 AND o.status<>'voided' ORDER BY o.created_at DESC LIMIT 300`, [propertyId]),
  ]);
  const payments = [...stays.rows, ...restaurant.rows].sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime()).slice(0, 500);
  return Response.json({ payments });
}
