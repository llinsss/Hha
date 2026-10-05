import { inTransaction } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

const statuses = new Set(["vacant_clean", "vacant_dirty", "occupied", "inspected", "maintenance", "out_of_order"]);

export async function PATCH(request: Request, context: RouteContext<"/api/management/rooms/[id]">) {
  const access = await requirePermission("rooms:write");
  if (access.response) return access.response;
  const { id } = await context.params;
  const body = await request.json();
  const status = String(body.status ?? "");
  if (!statuses.has(status)) return Response.json({ error: "Invalid room status" }, { status: 400 });
  if (access.user!.role === "housekeeping" && !["vacant_clean", "vacant_dirty", "inspected"].includes(status)) return Response.json({ error: "Housekeeping can only update cleaning readiness" }, { status: 403 });
  try {
    await inTransaction(async (client) => {
      const update = await client.query("UPDATE rooms SET status=$3 WHERE id=$1 AND property_id=$2 RETURNING id", [id, access.user!.propertyId, status]);
      if (!update.rowCount) throw new Error("NOT_FOUND");
      await logAudit(client, access.user!.propertyId, access.user!.id, "room.status_changed", "room", id, { status, note: String(body.note ?? "") });
      await logOutbox(client, access.user!.propertyId, "room.status_changed", id, { status });
      if (status === "vacant_clean" || status === "inspected") await client.query("UPDATE housekeeping_tasks SET status='complete',completed_at=now() WHERE room_id=$1 AND status IN ('pending','in_progress','ready_for_inspection')", [id]);
      if (status === "vacant_dirty") await client.query("INSERT INTO housekeeping_tasks(property_id,room_id,task_type,status) VALUES($1,$2,'turnover','pending')", [access.user!.propertyId, id]);
    });
    return Response.json({ id, status });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return Response.json({ error: "Room not found" }, { status: 404 });
    return Response.json({ error: "Unable to update room" }, { status: 500 });
  }
}
