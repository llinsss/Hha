import { getSessionUser, hashPassword, verifyPassword } from "@/lib/server/auth";
import { query } from "@/lib/server/db";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json();
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 12) return Response.json({ error: "Use a password of at least 12 characters" }, { status: 400 });
  const row = await query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id=$1", [user.id]);
  if (!row.rows[0] || !(await verifyPassword(currentPassword, row.rows[0].password_hash))) return Response.json({ error: "Current password is incorrect" }, { status: 403 });
  await query("UPDATE users SET password_hash=$2,must_change_password=false WHERE id=$1", [user.id, await hashPassword(newPassword)]);
  return Response.json({ ok: true });
}
