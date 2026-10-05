import { randomBytes } from "node:crypto";
import { inTransaction, query } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function GET() {
  const access = await requirePermission("reservations:read");
  if (access.response) return access.response;
  const result = await query(`SELECT r.id,r.reference,g.full_name AS guest_name,g.email,g.phone,r.room_type,ro.room_number,
    r.check_in::text,r.check_out::text,r.guests_count,r.amount_kobo::text,r.status,r.payment_status,r.source,r.created_at,
    coalesce((SELECT sum(p.amount_kobo) FROM payments p WHERE p.reservation_id=r.id AND p.status='settled'),0)::text AS paid_kobo
    FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms ro ON ro.id=r.room_id WHERE r.property_id=$1
    ORDER BY r.check_in DESC,r.created_at DESC LIMIT 250`, [access.user!.propertyId]);
  return Response.json({ reservations: result.rows });
}

export async function POST(request: Request) {
  const access = await requirePermission("reservations:write");
  if (access.response) return access.response;
  try {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const phone = String(body.phone ?? "").trim();
    const roomId = String(body.roomId ?? "");
    const checkIn = String(body.checkIn ?? "");
    const checkOut = String(body.checkOut ?? "");
    const guests = Math.max(1, Number(body.guests ?? 1));
    const inDate = new Date(`${checkIn}T00:00:00Z`), outDate = new Date(`${checkOut}T00:00:00Z`);
    if (!name || !roomId || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut) || Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime()) || inDate.toISOString().slice(0,10) !== checkIn || outDate.toISOString().slice(0,10) !== checkOut || outDate <= inDate || !Number.isInteger(guests) || guests > 12 || (outDate.getTime()-inDate.getTime())/86400000 > 90) return Response.json({ error: "Guest, room, and valid stay dates are required" }, { status: 400 });
    const kadunaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (checkIn < kadunaToday) return Response.json({ error: "Check-in must be today or a future date" }, { status: 400 });
    const created = await inTransaction(async (client) => {
      const roomRes = await client.query<{ id: string; room_type: string; room_number: string; nightly_rate_kobo: string; status: string; capacity: number }>("SELECT id,room_type,room_number,nightly_rate_kobo::text,status,capacity FROM rooms WHERE id=$1 AND property_id=$2 AND active FOR UPDATE", [roomId, access.user!.propertyId]);
      const room = roomRes.rows[0];
      if (!room) throw new Error("ROOM_NOT_FOUND");
      if (!["vacant_clean", "inspected"].includes(room.status)) throw new Error("ROOM_UNAVAILABLE");
      if (room.capacity < guests) throw new Error("ROOM_CAPACITY");
      const conflicts = await client.query("SELECT 1 FROM reservations WHERE room_id=$1 AND status IN ('hold','pending_payment','confirmed','checked_in') AND (status NOT IN ('hold','pending_payment') OR hold_expires_at IS NULL OR hold_expires_at>now()) AND check_in<$3::date AND check_out>$2::date LIMIT 1", [roomId, checkIn, checkOut]);
      if (conflicts.rowCount) throw new Error("ROOM_UNAVAILABLE");
      const guest = await client.query<{ id: string }>("INSERT INTO guests(property_id,full_name,email,phone) VALUES($1,$2,nullif($3,''),nullif($4,'')) RETURNING id", [access.user!.propertyId, name, email, phone]);
      const nights = BigInt(Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000));
      const amount = BigInt(room.nightly_rate_kobo) * nights;
      const reference = `HH-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
      const res = await client.query<{ id: string }>(`INSERT INTO reservations(property_id,guest_id,reference,room_id,room_type,check_in,check_out,guests_count,amount_kobo,status,source,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed','staff',$10) RETURNING id`, [access.user!.propertyId, guest.rows[0].id, reference, room.id, room.room_type, checkIn, checkOut, guests, amount.toString(), access.user!.id]);
      await logAudit(client, access.user!.propertyId, access.user!.id, "reservation.created", "reservation", res.rows[0].id, { reference });
      await logOutbox(client, access.user!.propertyId, "reservation.created", res.rows[0].id, { reference });
      return { id: res.rows[0].id, reference, room: room.room_number };
    });
    return Response.json({ reservation: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ROOM_UNAVAILABLE") return Response.json({ error: "The room is not available for those dates" }, { status: 409 });
    if (error instanceof Error && error.message === "ROOM_NOT_FOUND") return Response.json({ error: "Room not found" }, { status: 404 });
    if (error instanceof Error && error.message === "ROOM_CAPACITY") return Response.json({ error: "The selected room cannot accommodate that many guests" }, { status: 409 });
    console.error("reservation create failed", error);
    return Response.json({ error: "Unable to create reservation" }, { status: 500 });
  }
}
