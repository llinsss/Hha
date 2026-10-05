import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../../lib/password.js";
import { IdParams, IsoDate, Nullable, StringEnum, Text, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

/** Roles that can be given to staff. `owner` is created only by setup. */
export const ASSIGNABLE_ROLES = ["manager", "front_desk", "housekeeping", "restaurant_cashier", "restaurant_manager", "storekeeper", "finance", "auditor"] as const;
/** Roles only the owner may assign or manage. */
export const OWNER_MANAGED_ROLES: ReadonlySet<string> = new Set(["owner", "manager", "finance", "auditor"]);
export const EMPLOYMENT_STATUSES = ["active", "on_leave", "terminated"] as const;

const security = [{ bearerAuth: [] }];

const StaffMember = Type.Object({
  id: Uuid,
  user_id: Nullable(Uuid),
  employee_number: Type.String(),
  department: Type.String(),
  job_title: Type.String(),
  phone: Nullable(Type.String()),
  emergency_contact: Nullable(Type.String()),
  start_date: Nullable(IsoDate),
  employment_status: Type.String(),
  full_name: Nullable(Type.String()),
  email: Nullable(Type.String()),
  role: Nullable(Type.String()),
  last_attendance_event: Nullable(Type.String()),
  last_attendance_at: Nullable(Timestamp),
  can_manage: Type.Boolean({ description: "Whether the caller may change this member's status or reset their password" }),
});

export const ListStaffSchema = {
  tags: ["staff"],
  summary: "Staff profiles, roles, employment state and last attendance event",
  description: "Personal contact fields (phone, emergency contact, start date) are only returned to roles that manage staff.",
  security,
  querystring: Type.Object(PageQuery, { additionalProperties: false }),
  response: { 200: Type.Object({ staff: Type.Array(StaffMember), nextCursor: NextCursor }), ...errorResponses(401, 403, 422) },
};

const OneTimePassword = Type.String({ description: "Shown once. Hand it to the staff member securely; they must change it at first sign-in." });

export const CreateStaffSchema = {
  tags: ["staff"],
  summary: "Onboard a staff member with a sign-in account",
  description:
    "Creates the user and staff profile under the caller's property. Omit `temporaryPassword` to have a strong one generated and returned once. Only the owner can assign manager, finance or auditor roles.",
  security,
  body: Type.Object(
    {
      fullName: Text(120),
      email: Type.String({ format: "email", maxLength: 254 }),
      employeeNumber: Text(40),
      department: Text(80),
      jobTitle: Text(80),
      role: StringEnum(ASSIGNABLE_ROLES),
      phone: Type.Optional(Type.String({ maxLength: 32, pattern: "^[+0-9 ()-]*$" })),
      emergencyContact: Type.Optional(Type.String({ maxLength: 160 })),
      startDate: Type.Optional(Type.Union([IsoDate, Type.Literal("")])),
      temporaryPassword: Type.Optional(Type.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object({ staff: Type.Object({ id: Uuid, userId: Uuid, temporaryPassword: Type.Optional(OneTimePassword) }) }),
    ...errorResponses(401, 403, 409, 422),
  },
};

export const UpdateStaffSchema = {
  tags: ["staff"],
  summary: "Change employment status",
  description: "Leave or termination disables sign-in and revokes every session immediately; reactivation restores sign-in.",
  security,
  params: IdParams,
  body: Type.Object({ employmentStatus: StringEnum(EMPLOYMENT_STATUSES) }, { additionalProperties: false }),
  response: { 200: Type.Object({ id: Uuid, employmentStatus: Type.String() }), ...errorResponses(401, 403, 404, 409, 422) },
};

export const ResetPasswordSchema = {
  tags: ["staff"],
  summary: "Issue a new temporary password",
  description: "Generates a one-time temporary password, requires a change at next sign-in and revokes the member's sessions.",
  security,
  params: IdParams,
  response: { 200: Type.Object({ temporaryPassword: OneTimePassword }), ...errorResponses(401, 403, 404, 409) },
};
