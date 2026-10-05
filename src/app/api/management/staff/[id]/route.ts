import { inTransaction } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function PATCH(request: Request, context: RouteContext<"/api/management/staff/[id]">) {
  const access = await requirePermission("staff:write");
  if (access.response) return access.response;
  const { id } = await context.params;
  const body = await request.json();
  const status = String(body.employmentStatus ?? "");
  if (!["active", "on_leave", "terminated"].includes(status)) return Response.json({ error: "Invalid employment status" }, { status: 400 });
  try {
    await inTransaction(async (client) => {
      const result = await client.query<{ user_id: string | null }>("UPDATE staff_profiles SET employment_status=$3 WHERE id=$1 AND property_id=$2 RETURNING user_id", [id, access.user!.propertyId, status]);
      if (!result.rows[0]) throw new Error("NOT_FOUND");
      if (result.rows[0].user_id) {
        await client.query("UPDATE users SET active=$2 WHERE id=$1", [result.rows[0].user_id, status === "active"]);
        if (status !== "active") await client.query("DELETE FROM sessions WHERE user_id=$1", [result.rows[0].user_id]);
      }
      await logAudit(client, access.user!.propertyId, access.user!.id, "staff.employment_status_changed", "staff", id, { status });
      await logOutbox(client, access.user!.propertyId, "staff.employment_status_changed", id, { status });
    });
    return Response.json({ id, employmentStatus: status });
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return Response.json({ error: "Staff member not found" }, { status: 404 });
    return Response.json({ error: "Unable to update staff member" }, { status: 500 });
  }
}
