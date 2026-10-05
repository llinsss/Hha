import { query } from "@/lib/server/db";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const checkIn = url.searchParams.get("checkIn") ?? "";
  const checkOut = url.searchParams.get("checkOut") ?? "";
  const guests = Math.max(1, Math.min(12, Number(url.searchParams.get("guests") ?? 1)));
  const inDate = new Date(`${checkIn}T00:00:00Z`), outDate = new Date(`${checkOut}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime()) || inDate.toISOString().slice(0, 10) !== checkIn || outDate.toISOString().slice(0, 10) !== checkOut || outDate <= inDate) return Response.json({ roomTypes: [] });
  const property = await query<{ id: string }>("SELECT id FROM properties ORDER BY created_at LIMIT 1");
  if (!property.rows[0]) return Response.json({ roomTypes: [] });
  const result = await query(`SELECT ro.room_type,min(ro.nightly_rate_kobo)::text AS nightly_rate_kobo,max(ro.capacity)::int AS capacity,count(*)::int AS available_count
    FROM rooms ro WHERE ro.property_id=$1 AND ro.active=true AND ro.capacity >= $4 AND ro.status IN ('vacant_clean','inspected')
    AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.room_id=ro.id AND r.status IN ('hold','pending_payment','confirmed','checked_in')
      AND (r.status NOT IN ('hold','pending_payment') OR r.hold_expires_at IS NULL OR r.hold_expires_at>now())
      AND r.check_in < $3::date AND r.check_out > $2::date)
    GROUP BY ro.room_type ORDER BY ro.room_type`, [property.rows[0].id, checkIn, checkOut, guests]);
  return Response.json({ roomTypes: result.rows });
}
