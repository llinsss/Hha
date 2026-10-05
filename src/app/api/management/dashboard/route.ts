import { requirePermission } from "@/lib/server/auth";
import { query } from "@/lib/server/db";

export async function GET() {
  const access = await requirePermission("dashboard:read");
  if (!access.user) return access.response;
  try {
    const propertyId = access.user.propertyId;
    const [property, metrics, reservations, activity, operations, staff] = await Promise.all([
      query<{ name: string; timezone: string; currency: string }>("SELECT name,timezone,currency FROM properties WHERE id=$1", [propertyId]),
      query(`WITH d AS (SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS today)
        SELECT
          (SELECT count(*)::int FROM rooms WHERE property_id=$1 AND active=true AND status <> 'out_of_order') AS sellable_rooms,
          (SELECT count(DISTINCT room_id)::int FROM reservations,d WHERE property_id=$1 AND status IN ('checked_in','confirmed') AND check_in<=d.today AND check_out>d.today AND room_id IS NOT NULL) AS occupied_rooms,
          (SELECT count(*)::int FROM reservations,d WHERE property_id=$1 AND check_in=d.today AND status IN ('confirmed','checked_in')) AS arrivals,
          (SELECT count(*)::int FROM reservations,d WHERE property_id=$1 AND check_out=d.today AND status IN ('checked_in','confirmed')) AS departures,
          (SELECT COALESCE(sum(amount_kobo),0)::text FROM payments,d WHERE property_id=$1 AND status='settled' AND (created_at AT TIME ZONE 'Africa/Lagos')::date=d.today) AS room_revenue_kobo,
          (SELECT COALESCE(sum(total_kobo),0)::text FROM pos_orders,d WHERE property_id=$1 AND status='paid' AND payment_status='settled' AND (created_at AT TIME ZONE 'Africa/Lagos')::date=d.today) AS restaurant_revenue_kobo,
          (SELECT count(*)::int FROM pos_orders,d WHERE property_id=$1 AND status='paid' AND payment_status='settled' AND (created_at AT TIME ZONE 'Africa/Lagos')::date=d.today) AS restaurant_orders,
          (SELECT count(*)::int FROM staff_profiles WHERE property_id=$1 AND employment_status='active') AS active_staff,
          (SELECT count(*)::int FROM rooms WHERE property_id=$1 AND status='maintenance') AS maintenance_rooms,
          (SELECT count(*)::int FROM inventory_items WHERE property_id=$1 AND active AND quantity<=reorder_level) AS low_stock_items`, [propertyId]),
      query(`SELECT r.id,r.reference,g.full_name AS guest_name,coalesce(ro.room_type,r.room_type) AS room_type,ro.room_number,
        r.check_in::text,r.check_out::text,r.amount_kobo::text,r.status,r.payment_status,r.source,
        coalesce((SELECT sum(p.amount_kobo) FROM payments p WHERE p.reservation_id=r.id AND p.status='settled'),0)::text AS paid_kobo
        FROM reservations r JOIN guests g ON g.id=r.guest_id LEFT JOIN rooms ro ON ro.id=r.room_id
        WHERE r.property_id=$1 AND r.status IN ('confirmed','checked_in','pending_payment')
          AND r.check_in <= (now() AT TIME ZONE 'Africa/Lagos')::date + 3 AND r.check_out >= (now() AT TIME ZONE 'Africa/Lagos')::date
        ORDER BY r.check_in,r.created_at DESC LIMIT 30`, [propertyId]),
      query(`SELECT id,event_type,entity_id,payload,created_at FROM outbox_events WHERE property_id=$1 ORDER BY id DESC LIMIT 8`, [propertyId]),
      query(`SELECT (SELECT count(*)::int FROM housekeeping_tasks WHERE property_id=$1 AND status IN ('pending','in_progress','ready_for_inspection')) AS open_housekeeping,
        (SELECT count(*)::int FROM housekeeping_tasks WHERE property_id=$1 AND status='complete' AND (completed_at AT TIME ZONE 'Africa/Lagos')::date=(now() AT TIME ZONE 'Africa/Lagos')::date) AS completed_housekeeping`, [propertyId]),
      query(`SELECT count(*)::int AS clocked_in FROM staff_profiles sp WHERE sp.property_id=$1 AND sp.employment_status='active' AND EXISTS (
        SELECT 1 FROM attendance_events ai WHERE ai.staff_id=sp.id AND ai.event_type='clock_in' AND NOT EXISTS (
          SELECT 1 FROM attendance_events ao WHERE ao.staff_id=sp.id AND ao.happened_at>ai.happened_at AND ao.event_type='clock_out'))`, [propertyId]),
    ]);
    return Response.json({
      property: property.rows[0],
      metrics: metrics.rows[0],
      activity: activity.rows, operations: operations.rows[0], staff: staff.rows[0],
      reservations: access.user.role === "finance" ? [] : reservations.rows,
      user: { id: access.user.id, fullName: access.user.fullName, email: access.user.email, role: access.user.role, mustChangePassword: access.user.mustChangePassword },
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error("dashboard query failed", error);
    return Response.json({ error: "Unable to load property data" }, { status: 503 });
  }
}
