import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withConnection, withTransaction } from "../../db/sql.js";
import { BUSINESS_TIMEZONE } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import { hasPermission, type Role } from "../../lib/permissions.js";
import { requirePrincipal } from "../auth/principal.js";
import { CreateRoomsSchema, ListRoomsSchema, RoomHistorySchema, UpdateRoomSchema, type RoomStatus } from "./rooms.schemas.js";
import { optionalText } from "../../lib/text.js";

/** Allowed manual state changes. `occupied` is entered only by check-in. */
const TRANSITIONS: Readonly<Record<RoomStatus, readonly RoomStatus[]>> = {
  vacant_clean: ["vacant_dirty", "inspected", "maintenance", "out_of_order"],
  vacant_dirty: ["vacant_clean", "inspected", "maintenance", "out_of_order"],
  inspected: ["vacant_clean", "vacant_dirty", "maintenance", "out_of_order"],
  occupied: ["vacant_dirty", "maintenance", "out_of_order"],
  maintenance: ["vacant_clean", "vacant_dirty", "inspected", "out_of_order"],
  out_of_order: ["maintenance", "vacant_dirty"],
};
const HOUSEKEEPING_STATES: readonly RoomStatus[] = ["vacant_clean", "vacant_dirty", "inspected"];

/** The states this caller may move a room to next; clients offer exactly these. */
export function nextRoomStatuses(role: Role, current: string, inHouse: boolean): RoomStatus[] {
  if (!hasPermission(role, "rooms:write")) return [];
  return (TRANSITIONS[current as RoomStatus] ?? []).filter(
    (status) => (role !== "housekeeping" || HOUSEKEEPING_STATES.includes(status)) && !(inHouse && (status.startsWith("vacant") || status === "inspected")),
  );
}

type RoomRow = {
  id: string;
  room_number: string;
  room_type: string;
  nightly_rate_kobo: string | null;
  capacity: number;
  status: string;
  active: boolean;
  stay: { reference?: string; guest?: string; checkOut: string } | null;
  in_house: boolean;
};

const roomRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: ListRoomsSchema, preHandler: app.authorize("rooms:read") }, async (request) => {
    const principal = requirePrincipal(request);
    const limit = request.query.limit ?? 50;
    const cursor = decodeCursor(request.query.cursor, 2);
    const rows = await withConnection(app.db, (sql) =>
      sql.rows<RoomRow>(
        `SELECT ro.id, ro.room_number, ro.room_type, ro.nightly_rate_kobo::text, ro.capacity, ro.status, ro.active, h.in_house,
                CASE WHEN r.id IS NULL THEN NULL
                     ELSE json_build_object('reference', r.reference, 'guest', g.full_name, 'checkOut', r.check_out::text) END AS stay
           FROM rooms ro
           LEFT JOIN LATERAL (
             SELECT * FROM reservations
              WHERE room_id = ro.id AND status IN ('confirmed', 'checked_in')
                AND check_in <= (now() AT TIME ZONE '${BUSINESS_TIMEZONE}')::date
                AND check_out > (now() AT TIME ZONE '${BUSINESS_TIMEZONE}')::date
              ORDER BY (status = 'checked_in') DESC, created_at DESC
              LIMIT 1) r ON true
           LEFT JOIN guests g ON g.id = r.guest_id
           CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM reservations WHERE room_id = ro.id AND status = 'checked_in') AS in_house) h
          WHERE ro.property_id = $1 AND ($2::text IS NULL OR (ro.room_number, ro.id) > ($2::text, $3::uuid))
          ORDER BY ro.room_number, ro.id
          LIMIT $4`,
        [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      ),
    );
    const page = toPage(rows, limit, (row) => [row.room_number, row.id]);
    const rooms = page.items.map((room) => ({
      ...room,
      ...(principal.role === "housekeeping" ? { nightly_rate_kobo: null, stay: room.stay ? { checkOut: room.stay.checkOut } : null } : {}),
      next_statuses: nextRoomStatuses(principal.role, room.status, room.in_house),
    }));
    return { rooms, nextCursor: page.nextCursor };
  });

  app.post("/", { schema: CreateRoomsSchema, preHandler: app.authorize("rooms:write") }, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { rooms: many, ...single } = request.body;
    const hasSingle = Object.values(single).some((value) => value !== undefined);
    if (many && hasSingle) throw Errors.unprocessable("Send either one room or a `rooms` list, not both", "VALIDATION_FAILED");
    let rooms = many;
    if (!rooms) {
      if (single.roomNumber === undefined || single.roomType === undefined || single.nightlyRateKobo === undefined) {
        throw Errors.unprocessable("roomNumber, roomType and nightlyRateKobo are required", "VALIDATION_FAILED");
      }
      rooms = [{ roomNumber: single.roomNumber, roomType: single.roomType, nightlyRateKobo: single.nightlyRateKobo, capacity: single.capacity ?? 2 }];
    }
    const values = rooms.map((room) => ({ ...room, roomNumber: room.roomNumber.trim(), roomType: room.roomType.trim() }));
    if (values.some((room) => !room.roomNumber || !room.roomType)) throw Errors.unprocessable("Room number and type cannot be blank", "VALIDATION_FAILED");
    if (new Set(values.map((room) => room.roomNumber)).size !== values.length) throw Errors.unprocessable("Room numbers must be unique", "VALIDATION_FAILED");

    const roomIds = await withTransaction(app.db, async (tx) => {
      const created = await tx.rows<{ id: string }>(
        `INSERT INTO rooms(property_id, room_number, room_type, nightly_rate_kobo, capacity)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[], $5::int[])
         RETURNING id`,
        [principal.propertyId, values.map((room) => room.roomNumber), values.map((room) => room.roomType), values.map((room) => room.nightlyRateKobo), values.map((room) => room.capacity)],
      );
      const ids = created.map((row) => row.id);
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "room.created",
        entityType: "room",
        entityId: ids.length === 1 ? (ids[0] ?? "") : "bulk",
        details: { count: ids.length, roomNumbers: values.map((room) => room.roomNumber) },
      });
      return ids;
    });
    return reply.status(201).send({ created: roomIds.length, roomIds });
  });

  app.patch("/:id", { schema: UpdateRoomSchema, preHandler: app.authorize("rooms:write") }, async (request) => {
    const principal = requirePrincipal(request);
    const next = request.body.status;
    if (principal.role === "housekeeping" && !HOUSEKEEPING_STATES.includes(next)) {
      throw Errors.forbidden("Housekeeping can only update cleaning readiness", "FORBIDDEN");
    }
    const note = optionalText(request.body.note);
    return withTransaction(app.db, async (tx) => {
      const room = await tx.maybeOne<{ status: RoomStatus; room_number: string }>(
        `SELECT status, room_number FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [request.params.id, principal.propertyId],
      );
      if (!room) throw Errors.notFound("Room not found");
      if (room.status === next) return { id: request.params.id, status: next };
      if (next === "occupied") throw Errors.conflict("Rooms become occupied through guest check-in", "INVALID_TRANSITION");
      if (!TRANSITIONS[room.status].includes(next)) {
        throw Errors.conflict(`A ${room.status.replaceAll("_", " ")} room cannot be set to ${next.replaceAll("_", " ")}`, "INVALID_TRANSITION");
      }
      if (next.startsWith("vacant") || next === "inspected") {
        const inHouse = await tx.maybeOne(`SELECT 1 FROM reservations WHERE room_id = $1 AND status = 'checked_in' LIMIT 1`, [request.params.id]);
        if (inHouse) throw Errors.conflict("A guest is checked in to this room. Check them out first.", "GUEST_IN_ROOM");
      }
      await tx.exec(`UPDATE rooms SET status = $2 WHERE id = $1`, [request.params.id, next]);
      if (next === "vacant_clean" || next === "inspected") {
        await tx.exec(
          `UPDATE housekeeping_tasks SET status = 'complete', completed_at = now() WHERE room_id = $1 AND status <> 'complete'`,
          [request.params.id],
        );
      }
      if (next === "vacant_dirty") {
        await tx.exec(
          `INSERT INTO housekeeping_tasks(property_id, room_id, task_type, status)
           SELECT $1, $2, 'turnover', 'pending'
            WHERE NOT EXISTS (SELECT 1 FROM housekeeping_tasks WHERE room_id = $2 AND status <> 'complete')`,
          [principal.propertyId, request.params.id],
        );
      }
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "room.status_changed",
        entityType: "room",
        entityId: request.params.id,
        details: { from: room.status, to: next, note },
        outbox: { reference: `Room ${room.room_number}` },
      });
      return { id: request.params.id, status: next };
    });
  });

  app.get("/:id/history", { schema: RoomHistorySchema, preHandler: app.authorize("rooms:read") }, async (request) => {
    const principal = requirePrincipal(request);
    return withConnection(app.db, async (sql) => {
      const room = await sql.maybeOne(`SELECT 1 FROM rooms WHERE id = $1 AND property_id = $2`, [request.params.id, principal.propertyId]);
      if (!room) throw Errors.notFound("Room not found");
      const history = await sql.rows<{ action: string; from: string | null; to: string | null; note: string | null; actor: string | null; at: Date }>(
        `SELECT a.action, a.details->>'from' AS "from", a.details->>'to' AS "to", a.details->>'note' AS note, u.full_name AS actor, a.created_at AS at
           FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.property_id = $1 AND a.entity_type = 'room' AND a.entity_id = $2
          ORDER BY a.id DESC LIMIT 100`,
        [principal.propertyId, request.params.id],
      );
      return { history };
    });
  });
};

export default roomRoutes;
