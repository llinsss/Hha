import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withConnection, withTransaction } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { NextCursor, PageQuery, decodeCursor, toPage } from "../../lib/pagination.js";
import { Nullable, StringEnum, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";

const security = [{ bearerAuth: [] }];

const attendanceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize("attendance:read"),
      schema: {
        tags: ["attendance"],
        summary: "Active team members with their latest clock event",
        security,
        querystring: Type.Object(PageQuery, { additionalProperties: false }),
        response: {
          200: Type.Object({
            attendance: Type.Array(
              Type.Object({
                id: Uuid,
                employee_number: Type.String(),
                full_name: Type.String(),
                department: Type.String(),
                last_event: Nullable(Type.String()),
                last_event_at: Nullable(Timestamp),
              }),
            ),
            nextCursor: NextCursor,
          }),
          ...errorResponses(401, 403, 422),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const limit = request.query.limit ?? 50;
      const cursor = decodeCursor(request.query.cursor, 2);
      const rows = await withConnection(app.db, (sql) =>
        sql.rows<{ id: string; employee_number: string; full_name: string; department: string; last_event: string | null; last_event_at: Date | null }>(
          `SELECT sp.id, sp.employee_number, u.full_name, sp.department, last.event_type AS last_event, last.happened_at AS last_event_at
             FROM staff_profiles sp
             JOIN users u ON u.id = sp.user_id
             LEFT JOIN LATERAL (SELECT event_type, happened_at FROM attendance_events
                                 WHERE staff_id = sp.id ORDER BY happened_at DESC LIMIT 1) last ON true
            WHERE sp.property_id = $1 AND sp.employment_status = 'active'
              AND ($2::text IS NULL OR (u.full_name, sp.id) > ($2::text, $3::uuid))
            ORDER BY u.full_name, sp.id
            LIMIT $4`,
          [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
        ),
      );
      const page = toPage(rows, limit, (row) => [row.full_name, row.id]);
      return { attendance: page.items, nextCursor: page.nextCursor };
    },
  );

  app.post(
    "/",
    {
      preHandler: app.authorize(),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        tags: ["attendance"],
        summary: "Clock yourself in or out",
        description: "Requires an active staff profile. Repeated clock-ins and clock-outs without an open shift are rejected.",
        security,
        body: Type.Object({ eventType: StringEnum(["clock_in", "clock_out"] as const) }, { additionalProperties: false }),
        response: { 201: Type.Object({ event: Type.Object({ id: Uuid, happened_at: Timestamp }) }), ...errorResponses(401, 403, 404, 409, 422) },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const eventType = request.body.eventType;
      const event = await withTransaction(app.db, async (tx) => {
        const staff = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM staff_profiles WHERE user_id = $1 AND property_id = $2 AND employment_status = 'active' FOR UPDATE`,
          [principal.userId, principal.propertyId],
        );
        if (!staff) throw Errors.notFound("Your account is not linked to an active staff profile", "NO_STAFF_PROFILE");
        const latest = await tx.maybeOne<{ event_type: string }>(
          `SELECT event_type FROM attendance_events WHERE staff_id = $1 ORDER BY happened_at DESC LIMIT 1`,
          [staff.id],
        );
        if (eventType === "clock_in" && latest?.event_type === "clock_in") throw Errors.conflict("You are already clocked in", "ALREADY_CLOCKED_IN");
        if (eventType === "clock_out" && latest?.event_type !== "clock_in") throw Errors.conflict("You do not have an open shift", "NOT_CLOCKED_IN");
        const inserted = await tx.one<{ id: string; happened_at: Date }>(
          `INSERT INTO attendance_events(property_id, staff_id, event_type, method, recorded_by)
           VALUES ($1, $2, $3, 'web', $4) RETURNING id, happened_at`,
          [principal.propertyId, staff.id, eventType, principal.userId],
        );
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: `attendance.${eventType}`,
          entityType: "staff",
          entityId: staff.id,
          details: { eventId: inserted.id, ip: request.ip },
          outbox: { reference: principal.fullName },
        });
        return inserted;
      });
      return reply.status(201).send({ event });
    },
  );

  app.get(
    "/self",
    {
      preHandler: app.authorize(),
      schema: {
        tags: ["attendance"],
        summary: "Your current clock state",
        security,
        response: { 200: Type.Object({ clockedIn: Type.Boolean() }), ...errorResponses(401, 403) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const latest = await withConnection(app.db, (sql) =>
        sql.maybeOne<{ event_type: string }>(
          `SELECT ae.event_type FROM attendance_events ae JOIN staff_profiles sp ON sp.id = ae.staff_id
            WHERE sp.user_id = $1 AND sp.property_id = $2 ORDER BY ae.happened_at DESC LIMIT 1`,
          [principal.userId, principal.propertyId],
        ),
      );
      return { clockedIn: latest?.event_type === "clock_in" };
    },
  );
};

export default attendanceRoutes;
