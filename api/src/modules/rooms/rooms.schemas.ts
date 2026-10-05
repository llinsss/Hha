import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { IdParams, IsoDate, KoboInput, KoboString, Nullable, StringEnum, Text, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

export const ROOM_STATUSES = ["vacant_clean", "vacant_dirty", "occupied", "inspected", "maintenance", "out_of_order"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

const security = [{ bearerAuth: [] }];

const Room = Type.Object({
  id: Uuid,
  room_number: Type.String(),
  room_type: Type.String(),
  nightly_rate_kobo: Nullable(KoboString),
  capacity: Type.Integer(),
  status: Type.String(),
  active: Type.Boolean(),
  stay: Nullable(Type.Object({ reference: Type.Optional(Type.String()), guest: Type.Optional(Type.String()), checkOut: IsoDate })),
});

export const ListRoomsSchema = {
  tags: ["rooms"],
  summary: "Rooms with type, rate, capacity, state and current stay",
  description: "Housekeeping sees cleaning state and the due check-out date only (no rates or guest details).",
  security,
  querystring: Type.Object(PageQuery, { additionalProperties: false }),
  response: { 200: Type.Object({ rooms: Type.Array(Room), nextCursor: NextCursor }), ...errorResponses(401, 403, 422) },
};

const NewRoom = Type.Object(
  {
    roomNumber: Text(20),
    roomType: Text(80),
    nightlyRateKobo: KoboInput,
    capacity: Type.Integer({ minimum: 1, maximum: 12, default: 2 }),
  },
  { additionalProperties: false },
);

export const CreateRoomsSchema = {
  tags: ["rooms"],
  summary: "Add one room, or up to 200 with `rooms: [...]`",
  security,
  body: Type.Object(
    {
      roomNumber: Type.Optional(Text(20)),
      roomType: Type.Optional(Text(80)),
      nightlyRateKobo: Type.Optional(KoboInput),
      capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      rooms: Type.Optional(Type.Array(NewRoom, { minItems: 1, maxItems: 200 })),
    },
    { additionalProperties: false },
  ),
  response: { 201: Type.Object({ created: Type.Integer(), roomIds: Type.Array(Uuid) }), ...errorResponses(401, 403, 409, 422) },
};

export const UpdateRoomSchema = {
  tags: ["rooms"],
  summary: "Change a room's state",
  description:
    "Rooms become `occupied` only through check-in, and cannot be marked vacant while a guest is checked in. Housekeeping may set only vacant_clean, vacant_dirty and inspected.",
  security,
  params: IdParams,
  body: Type.Object({ status: StringEnum(ROOM_STATUSES), note: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }),
  response: { 200: Type.Object({ id: Uuid, status: Type.String() }), ...errorResponses(401, 403, 404, 409, 422) },
};

export const RoomHistorySchema = {
  tags: ["rooms"],
  summary: "Room state change history (latest 100)",
  security,
  params: IdParams,
  response: {
    200: Type.Object({
      history: Type.Array(
        Type.Object({
          action: Type.String(),
          from: Nullable(Type.String()),
          to: Nullable(Type.String()),
          note: Nullable(Type.String()),
          actor: Nullable(Type.String()),
          at: Timestamp,
        }),
      ),
    }),
    ...errorResponses(401, 403, 404),
  },
};
