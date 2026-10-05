import { Type } from "typebox";
import { IsoDate, KoboString, Text, Timestamp, errorResponses } from "../../lib/schemas.js";

export const AvailabilitySchema = {
  tags: ["public"],
  summary: "Room types available for a stay",
  description: "Counts sellable rooms per type with no overlapping active stay or unexpired checkout hold. Invalid or past date ranges return an empty list.",
  querystring: Type.Object(
    {
      checkIn: IsoDate,
      checkOut: IsoDate,
      guests: Type.Integer({ minimum: 1, maximum: 12, default: 1 }),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({
      roomTypes: Type.Array(
        Type.Object({
          room_type: Type.String(),
          nightly_rate_kobo: KoboString,
          capacity: Type.Integer(),
          available_count: Type.Integer(),
        }),
      ),
    }),
    ...errorResponses(422, 429),
  },
};

export const CreatePublicReservationSchema = {
  tags: ["public"],
  summary: "Reserve a stay and start hosted checkout",
  description:
    "Holds one physical room for the configured hold window, prices the full stay server-side and returns the provider checkout URL. Requires an `Idempotency-Key` header: retries with the same key and body return the original reservation and checkout URL; the same key with a different body is rejected.",
  headers: Type.Object({ "idempotency-key": Type.String({ minLength: 8, maxLength: 128 }) }),
  body: Type.Object(
    {
      name: Text(120),
      email: Type.String({ format: "email", maxLength: 254 }),
      phone: Type.Optional(Type.String({ maxLength: 32, pattern: "^[+0-9 ()-]*$" })),
      roomType: Text(80),
      checkIn: IsoDate,
      checkOut: IsoDate,
      guests: Type.Integer({ minimum: 1, maximum: 12 }),
      notes: Type.Optional(Type.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object({
      reservation: Type.Object({
        id: Type.String(),
        reference: Type.String(),
        amountKobo: KoboString,
        currency: Type.Literal("NGN"),
        status: Type.Literal("pending_payment"),
        holdExpiresAt: Timestamp,
      }),
      checkoutUrl: Type.String(),
    }),
    ...errorResponses(400, 409, 422, 429, 502, 503),
  },
};

export const PaymentStatusSchema = {
  tags: ["public"],
  summary: "Payment status of an online booking",
  description: "For the guest's payment-result page. Returns no guest data. The reference is the unguessable value returned at booking.",
  params: Type.Object({ reference: Type.String({ pattern: "^HH-[A-Z0-9-]{8,64}$" }) }, { additionalProperties: false }),
  response: {
    200: Type.Object({
      reference: Type.String(),
      paymentStatus: Type.String(),
      reservationStatus: Type.String(),
      amountKobo: KoboString,
    }),
    ...errorResponses(404, 422, 429),
  },
};
