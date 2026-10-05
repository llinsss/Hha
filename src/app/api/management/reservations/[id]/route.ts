import { inTransaction } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function PATCH(request: Request, context: RouteContext<"/api/management/reservations/[id]">) {
  const access = await requirePermission("reservations:write");
  if (access.response) return access.response;
  const { id } = await context.params;
  const body = await request.json();
  const nextStatus = String(body.status ?? "");
  const allowed: Record<string, string[]> = { confirmed: ["checked_in", "cancelled", "no_show"], checked_in: ["checked_out"], pending_payment: ["cancelled"] };
  try {
    const result = await inTransaction(async (client) => {
      const found = await client.query<{ status: string; property_id: string; room_id: string | null }>("SELECT status,property_id,room_id FROM reservations WHERE id=$1 AND property_id=$2 FOR UPDATE", [id, access.user!.propertyId]);
      const reservation = found.rows[0];
      if (!reservation) throw new Error("NOT_FOUND");
      if (!allowed[reservation.status]?.includes(nextStatus)) throw new Error("INVALID_TRANSITION");
      await client.query("UPDATE reservations SET status=$2,updated_at=now(),hold_expires_at=null WHERE id=$1", [id, nextStatus]);
      if (reservation.room_id && nextStatus === "checked_in") await client.query("UPDATE rooms SET status='occupied' WHERE id=$1", [reservation.room_id]);
      if (reservation.room_id && nextStatus === "checked_out") {
        await client.query("UPDATE rooms SET status='vacant_dirty' WHERE id=$1", [reservation.room_id]);
        await client.query("INSERT INTO housekeeping_tasks(property_id,room_id,task_type,status) VALUES($1,$2,'turnover','pending')", [reservation.property_id, reservation.room_id]);
      }
      if (nextStatus === "cancelled") await client.query("UPDATE payments SET status='failed' WHERE reservation_id=$1 AND status='pending'", [id]);
      await logAudit(client, reservation.property_id, access.user!.id, `reservation.${nextStatus}`, "reservation", id);
      await logOutbox(client, reservation.property_id, "reservation.status_changed", id, { status: nextStatus });
      return { id, status: nextStatus };
    });
    return Response.json({ reservation: result });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return Response.json({ error: "Reservation not found" }, { status: 404 });
    if (error instanceof Error && error.message === "INVALID_TRANSITION") return Response.json({ error: "That reservation status change is not allowed" }, { status: 409 });
    return Response.json({ error: "Unable to update reservation" }, { status: 500 });
  }
}
