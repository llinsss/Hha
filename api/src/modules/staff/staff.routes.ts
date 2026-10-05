import { randomBytes } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withConnection, withTransaction, type Sql } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import { hashPassword } from "../../lib/password.js";
import { hasPermission } from "../../lib/permissions.js";
import { requirePrincipal } from "../auth/principal.js";
import type { Principal } from "../auth/session.service.js";
import { CreateStaffSchema, ListStaffSchema, OWNER_MANAGED_ROLES, ResetPasswordSchema, UpdateStaffSchema } from "./staff.schemas.js";
import { optionalText } from "../../lib/text.js";

/** 18 random bytes → 24 URL-safe characters (~144 bits). */
function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

type StaffRow = {
  id: string;
  user_id: string | null;
  employee_number: string;
  department: string;
  job_title: string;
  phone: string | null;
  emergency_contact: string | null;
  start_date: string | null;
  employment_status: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
  last_attendance_event: string | null;
  last_attendance_at: Date | null;
  cursor_created: string;
};

/** Locks the target profile and enforces who may manage whom. */
async function lockManageableStaff(tx: Sql, principal: Principal, staffId: string) {
  const target = await tx.maybeOne<{ user_id: string | null; role: string | null; employee_number: string }>(
    `SELECT sp.user_id, u.role, sp.employee_number FROM staff_profiles sp LEFT JOIN users u ON u.id = sp.user_id
      WHERE sp.id = $1 AND sp.property_id = $2 FOR UPDATE OF sp`,
    [staffId, principal.propertyId],
  );
  if (!target) throw Errors.notFound("Staff member not found");
  if (target.user_id === principal.userId) throw Errors.conflict("You cannot change your own account here", "SELF_CHANGE_FORBIDDEN");
  if (principal.role !== "owner" && target.role !== null && OWNER_MANAGED_ROLES.has(target.role)) {
    throw Errors.forbidden("Only the owner can manage management, finance or audit accounts");
  }
  return target;
}

const staffRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: ListStaffSchema, preHandler: app.authorize("staff:read") }, async (request) => {
    const principal = requirePrincipal(request);
    const limit = request.query.limit ?? 50;
    const cursor = decodeCursor(request.query.cursor, 2);
    const rows = await withConnection(app.db, (sql) =>
      sql.rows<StaffRow>(
        `SELECT sp.id, sp.user_id, sp.employee_number, sp.department, sp.job_title, sp.phone, sp.emergency_contact,
                sp.start_date::text, sp.employment_status, u.full_name, u.email, u.role,
                last.event_type AS last_attendance_event, last.happened_at AS last_attendance_at, sp.created_at::text AS cursor_created
           FROM staff_profiles sp
           LEFT JOIN users u ON u.id = sp.user_id
           LEFT JOIN LATERAL (SELECT event_type, happened_at FROM attendance_events
                               WHERE staff_id = sp.id ORDER BY happened_at DESC LIMIT 1) last ON true
          WHERE sp.property_id = $1 AND ($2::timestamptz IS NULL OR (sp.created_at, sp.id) < ($2::timestamptz, $3::uuid))
          ORDER BY sp.created_at DESC, sp.id DESC
          LIMIT $4`,
        [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      ),
    );
    const page = toPage(rows, limit, (row) => [row.cursor_created, row.id]);
    const showPersonal = hasPermission(principal.role, "staff:write");
    const staff = showPersonal ? page.items : page.items.map((row) => ({ ...row, phone: null, emergency_contact: null, start_date: null }));
    return { staff, nextCursor: page.nextCursor };
  });

  app.post("/", { schema: CreateStaffSchema, preHandler: app.authorize("staff:write") }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = request.body;
    if (principal.role !== "owner" && OWNER_MANAGED_ROLES.has(body.role)) {
      throw Errors.forbidden("Only the owner can assign management, finance, or audit roles");
    }
    const fields = {
      fullName: body.fullName.trim(),
      employeeNumber: body.employeeNumber.trim(),
      department: body.department.trim(),
      jobTitle: body.jobTitle.trim(),
    };
    if (Object.values(fields).some((value) => !value)) throw Errors.unprocessable("Complete every staff detail", "VALIDATION_FAILED");
    const generated = body.temporaryPassword === undefined ? generateTemporaryPassword() : null;
    const passwordHash = await hashPassword(body.temporaryPassword ?? generated ?? "");

    const staff = await withTransaction(app.db, async (tx) => {
      const user = await tx.one<{ id: string }>(
        `INSERT INTO users(property_id, email, full_name, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [principal.propertyId, body.email.trim().toLowerCase(), fields.fullName, passwordHash, body.role],
      );
      const profile = await tx.one<{ id: string }>(
        `INSERT INTO staff_profiles(property_id, user_id, employee_number, department, job_title, phone, emergency_contact, start_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [principal.propertyId, user.id, fields.employeeNumber, fields.department, fields.jobTitle, optionalText(body.phone), optionalText(body.emergencyContact), optionalText(body.startDate)],
      );
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "staff.onboarded",
        entityType: "staff",
        entityId: profile.id,
        details: { employeeNumber: fields.employeeNumber, role: body.role, passwordGenerated: generated !== null },
        outbox: { reference: fields.fullName },
      });
      return { id: profile.id, userId: user.id };
    });
    reply.header("cache-control", "no-store");
    return reply.status(201).send({ staff: generated ? { ...staff, temporaryPassword: generated } : staff });
  });

  app.patch("/:id", { schema: UpdateStaffSchema, preHandler: app.authorize("staff:write") }, async (request) => {
    const principal = requirePrincipal(request);
    const status = request.body.employmentStatus;
    await withTransaction(app.db, async (tx) => {
      const target = await lockManageableStaff(tx, principal, request.params.id);
      await tx.exec(`UPDATE staff_profiles SET employment_status = $2 WHERE id = $1`, [request.params.id, status]);
      let sessionsRevoked = 0;
      if (target.user_id) {
        await tx.exec(`UPDATE users SET active = $2 WHERE id = $1`, [target.user_id, status === "active"]);
        if (status !== "active") sessionsRevoked = await app.sessions.revokeAllForUser(tx.runner.manager, target.user_id, `employment_${status}`);
      }
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "staff.employment_status_changed",
        entityType: "staff",
        entityId: request.params.id,
        details: { status, sessionsRevoked },
        outbox: { reference: target.employee_number },
      });
    });
    return { id: request.params.id, employmentStatus: status };
  });

  app.post(
    "/:id/temporary-password",
    { schema: ResetPasswordSchema, preHandler: app.authorize("staff:write"), config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword);
      await withTransaction(app.db, async (tx) => {
        const target = await lockManageableStaff(tx, principal, request.params.id);
        if (!target.user_id) throw Errors.conflict("This staff member has no sign-in account", "NO_ACCOUNT");
        await tx.exec(`UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1`, [target.user_id, passwordHash]);
        await app.sessions.revokeAllForUser(tx.runner.manager, target.user_id, "password_reset");
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: "staff.password_reset",
          entityType: "staff",
          entityId: request.params.id,
          outbox: false,
        });
      });
      reply.header("cache-control", "no-store");
      return { temporaryPassword };
    },
  );
};

export default staffRoutes;
