import { hashPassword, logAudit, logOutbox, requirePermission, type Role } from "@/lib/server/auth";
import { inTransaction, query } from "@/lib/server/db";

const roles = new Set<Role>(["manager", "front_desk", "housekeeping", "restaurant_cashier", "restaurant_manager", "storekeeper", "finance", "auditor"]);

export async function GET() {
  const access = await requirePermission("staff:read");
  if (access.response) return access.response;
  const result = await query(`SELECT sp.id,sp.employee_number,sp.department,sp.job_title,sp.phone,sp.emergency_contact,sp.employment_status,sp.start_date,
    u.id AS user_id,u.full_name,u.email,u.role,
    (SELECT ae.event_type FROM attendance_events ae WHERE ae.staff_id=sp.id ORDER BY ae.happened_at DESC LIMIT 1) AS last_attendance_event,
    (SELECT ae.happened_at FROM attendance_events ae WHERE ae.staff_id=sp.id ORDER BY ae.happened_at DESC LIMIT 1) AS last_attendance_at
    FROM staff_profiles sp LEFT JOIN users u ON u.id=sp.user_id WHERE sp.property_id=$1 ORDER BY sp.created_at DESC`, [access.user!.propertyId]);
  return Response.json({ staff: result.rows });
}

export async function POST(request: Request) {
  const access = await requirePermission("staff:write");
  if (access.response) return access.response;
  try {
    const body = await request.json();
    const name = String(body.fullName ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const employeeNumber = String(body.employeeNumber ?? "").trim();
    const department = String(body.department ?? "").trim();
    const jobTitle = String(body.jobTitle ?? "").trim();
    const password = String(body.temporaryPassword ?? "");
    const role = String(body.role ?? "") as Role;
    if (!name || !email.includes("@") || !employeeNumber || !department || !jobTitle || !roles.has(role) || password.length < 12) {
      return Response.json({ error: "Complete staff details, choose an allowed role, and set a temporary password of at least 12 characters" }, { status: 400 });
    }
    if (access.user!.role !== "owner" && ["manager", "finance", "auditor"].includes(role)) return Response.json({ error: "Only the owner can assign management, finance, or audit roles" }, { status: 403 });
    const passwordHash = await hashPassword(password);
    const staff = await inTransaction(async (client) => {
      const user = await client.query<{ id: string }>(`INSERT INTO users(property_id,email,full_name,password_hash,role,must_change_password)
        VALUES($1,$2,$3,$4,$5,true) RETURNING id`, [access.user!.propertyId, email, name, passwordHash, role]);
      const profile = await client.query<{ id: string }>(`INSERT INTO staff_profiles(property_id,user_id,employee_number,department,job_title,phone,emergency_contact,start_date)
        VALUES($1,$2,$3,$4,$5,nullif($6,''),nullif($7,''),nullif($8,'')::date) RETURNING id`, [access.user!.propertyId, user.rows[0].id, employeeNumber, department, jobTitle, String(body.phone ?? ""), String(body.emergencyContact ?? ""), String(body.startDate ?? "")]);
      await logAudit(client, access.user!.propertyId, access.user!.id, "staff.onboarded", "staff", profile.rows[0].id, { employeeNumber, role });
      await logOutbox(client, access.user!.propertyId, "staff.onboarded", profile.rows[0].id, { employeeNumber, department });
      return { id: profile.rows[0].id, userId: user.rows[0].id };
    });
    return Response.json({ staff }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "23505") return Response.json({ error: "That email or employee number is already in use" }, { status: 409 });
    console.error("staff onboarding failed", error);
    return Response.json({ error: "Unable to onboard staff member" }, { status: 500 });
  }
}
