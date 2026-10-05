import { getSessionUser } from "@/lib/server/auth";
import { query } from "@/lib/server/db";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const result = await query<{ event_type: string }>(`SELECT ae.event_type FROM attendance_events ae JOIN staff_profiles sp ON sp.id=ae.staff_id
    WHERE sp.user_id=$1 AND sp.property_id=$2 ORDER BY ae.happened_at DESC LIMIT 1`, [user.id, user.propertyId]);
  return Response.json({ clockedIn: result.rows[0]?.event_type === "clock_in" });
}
