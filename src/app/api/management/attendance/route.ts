import { getSessionUser, logAudit, logOutbox, requirePermission } from "@/lib/server/auth";
import { inTransaction, query } from "@/lib/server/db";

export async function GET() {
  const access = await requirePermission("attendance:read");
  if (access.response) return access.response;
  const result = await query(`SELECT sp.id,sp.employee_number,u.full_name,sp.department,
    (SELECT event_type FROM attendance_events WHERE staff_id=sp.id ORDER BY happened_at DESC LIMIT 1) AS last_event,
    (SELECT happened_at FROM attendance_events WHERE staff_id=sp.id ORDER BY happened_at DESC LIMIT 1) AS last_event_at
    FROM staff_profiles sp JOIN users u ON u.id=sp.user_id WHERE sp.property_id=$1 AND sp.employment_status='active' ORDER BY u.full_name`, [access.user!.propertyId]);
  return Response.json({ attendance: result.rows });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (user.mustChangePassword) return Response.json({ error: "Change your temporary password first" }, { status: 403 });
  const body = await request.json();
  const eventType = String(body.eventType ?? "");
  if (!["clock_in", "clock_out"].includes(eventType)) return Response.json({ error: "Choose clock_in or clock_out" }, { status: 400 });
  try {
    const event = await inTransaction(async (client) => {
      const found = await client.query<{ id: string }>("SELECT id FROM staff_profiles WHERE user_id=$1 AND property_id=$2 AND employment_status='active'", [user.id, user.propertyId]);
      const staffId = found.rows[0]?.id;
      if (!staffId) throw new Error("NO_STAFF_PROFILE");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [staffId]);
      const latest = await client.query<{ event_type: string }>("SELECT event_type FROM attendance_events WHERE staff_id=$1 ORDER BY happened_at DESC LIMIT 1", [staffId]);
      if (eventType === "clock_in" && latest.rows[0]?.event_type === "clock_in") throw new Error("ALREADY_CLOCKED_IN");
      if (eventType === "clock_out" && latest.rows[0]?.event_type !== "clock_in") throw new Error("NOT_CLOCKED_IN");
      const inserted = await client.query<{ id: string; happened_at: Date }>("INSERT INTO attendance_events(property_id,staff_id,event_type,method,recorded_by) VALUES($1,$2,$3,'web',$4) RETURNING id,happened_at", [user.propertyId, staffId, eventType, user.id]);
      await logAudit(client, user.propertyId, user.id, `attendance.${eventType}`, "staff", staffId);
      await logOutbox(client, user.propertyId, `attendance.${eventType}`, staffId, { eventId: inserted.rows[0].id });
      return inserted.rows[0];
    });
    return Response.json({ event }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "NO_STAFF_PROFILE") return Response.json({ error: "Your account is not linked to a staff profile" }, { status: 404 });
    if (error instanceof Error && error.message === "ALREADY_CLOCKED_IN") return Response.json({ error: "You are already clocked in" }, { status: 409 });
    if (error instanceof Error && error.message === "NOT_CLOCKED_IN") return Response.json({ error: "You do not have an open shift" }, { status: 409 });
    return Response.json({ error: "Unable to record attendance" }, { status: 500 });
  }
}
