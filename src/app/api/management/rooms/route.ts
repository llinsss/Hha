import { inTransaction, query } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function GET() {
  const access = await requirePermission("rooms:read");
  if (access.response) return access.response;
  const result = await query(`SELECT ro.id,ro.room_number,ro.room_type,ro.nightly_rate_kobo::text,ro.capacity,ro.status,ro.active,
    CASE WHEN r.id IS NULL THEN null ELSE json_build_object('reference',r.reference,'guest',g.full_name,'checkOut',r.check_out::text) END AS stay
    FROM rooms ro LEFT JOIN LATERAL (SELECT * FROM reservations WHERE room_id=ro.id AND status IN ('confirmed','checked_in')
      AND check_in<=(now() AT TIME ZONE 'Africa/Lagos')::date AND check_out>(now() AT TIME ZONE 'Africa/Lagos')::date ORDER BY created_at DESC LIMIT 1) r ON true
    LEFT JOIN guests g ON g.id=r.guest_id WHERE ro.property_id=$1 ORDER BY ro.room_number`, [access.user!.propertyId]);
  const rooms = access.user!.role === "housekeeping"
    ? result.rows.map((room) => ({ ...room, nightly_rate_kobo: null, stay: room.stay ? { checkOut: room.stay.checkOut } : null }))
    : result.rows;
  return Response.json({ rooms });
}

export async function POST(request: Request) {
  const access = await requirePermission("rooms:write");
  if (access.response) return access.response;
  try {
    const body = await request.json();
    const rooms: Record<string, unknown>[] = Array.isArray(body.rooms) ? body.rooms : [body as Record<string, unknown>];
    if (!rooms.length || rooms.length > 200) return Response.json({ error: "Add between 1 and 200 rooms at a time" }, { status: 400 });
    const values = rooms.map((r: Record<string, unknown>) => ({
      roomNumber: String(r.roomNumber ?? "").trim(), roomType: String(r.roomType ?? "").trim(),
      rate: Number(r.nightlyRateKobo), capacity: Number(r.capacity ?? 2),
    }));
    if (values.some((r) => !r.roomNumber || !r.roomType || !Number.isSafeInteger(r.rate) || r.rate < 0 || !Number.isInteger(r.capacity) || r.capacity < 1 || r.capacity > 12)) {
      return Response.json({ error: "Each room needs a unique number, type, nightly rate in kobo, and capacity" }, { status: 400 });
    }
    const created = await inTransaction(async (client) => {
      const rows = [];
      for (const room of values) {
        const result = await client.query<{ id: string }>("INSERT INTO rooms(property_id,room_number,room_type,nightly_rate_kobo,capacity) VALUES($1,$2,$3,$4,$5) RETURNING id", [access.user!.propertyId, room.roomNumber, room.roomType, room.rate, room.capacity]);
        rows.push(result.rows[0].id);
      }
      await logAudit(client, access.user!.propertyId, access.user!.id, "rooms.created", "room", "bulk", { count: rows.length });
      await logOutbox(client, access.user!.propertyId, "rooms.created", "bulk", { count: rows.length });
      return rows;
    });
    return Response.json({ created: created.length, roomIds: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "23505") return Response.json({ error: "A room number already exists" }, { status: 409 });
    return Response.json({ error: "Unable to create rooms" }, { status: 500 });
  }
}
