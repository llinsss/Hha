import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withConnection } from "../../db/sql.js";
import { canonicalJson, sha256Hex } from "../../lib/crypto.js";
import { addDays, businessToday, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { OCCUPYING_STAY_SQL, SELLABLE_ROOM_SQL, createPublicBooking } from "./booking.service.js";
import { AvailabilitySchema, CreatePublicReservationSchema, PaymentStatusSchema } from "./public.schemas.js";
import { optionalText } from "../../lib/text.js";

/** Guest-facing endpoints: no staff login, but validated and rate limited (PRD §7). */
const publicRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/availability", { schema: AvailabilitySchema, config: { rateLimit: { max: 60, timeWindow: 60_000 } } }, async (request) => {
    const { checkIn, checkOut, guests } = request.query;
    const nights = nightsBetween(checkIn, checkOut);
    const today = businessToday();
    if (nights < 1 || nights > app.config.booking.maxStayNights || checkIn < today || checkIn > addDays(today, app.config.booking.horizonDays)) {
      return { roomTypes: [] };
    }
    const roomTypes = await withConnection(app.db, (sql) =>
      sql.rows<{ room_type: string; nightly_rate_kobo: string; capacity: number; available_count: number }>(
        `SELECT ro.room_type, min(ro.nightly_rate_kobo)::text AS nightly_rate_kobo, max(ro.capacity)::int AS capacity, count(*)::int AS available_count
           FROM rooms ro
          WHERE ro.property_id = (SELECT id FROM properties ORDER BY created_at, id LIMIT 1)
            AND ro.capacity >= $3 AND ${SELLABLE_ROOM_SQL}
            AND NOT EXISTS (SELECT 1 FROM reservations r
                             WHERE r.room_id = ro.id AND ${OCCUPYING_STAY_SQL}
                               AND r.check_in < $2::date AND r.check_out > $1::date)
          GROUP BY ro.room_type
          ORDER BY ro.room_type`,
        [checkIn, checkOut, guests],
      ),
    );
    return { roomTypes };
  });

  app.post(
    "/reservations",
    {
      schema: CreatePublicReservationSchema,
      config: { rateLimit: { max: app.config.rateLimit.publicBookingMax, timeWindow: 60_000 } },
      preHandler: app.idempotent(),
    },
    async (request, reply) => {
      const body = request.body;
      const result = await createPublicBooking(app, {
        name: body.name.trim(),
        email: body.email.trim().toLowerCase(),
        phone: optionalText(body.phone),
        roomType: body.roomType.trim(),
        checkIn: body.checkIn,
        checkOut: body.checkOut,
        guests: body.guests,
        notes: optionalText(body.notes),
        idempotencyKey: request.headers["idempotency-key"],
        fingerprint: sha256Hex(canonicalJson(body)),
      });
      reply.header("cache-control", "no-store");
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/payments/:reference",
    { schema: PaymentStatusSchema, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request, reply) => {
      const reservation = await withConnection(app.db, (sql) =>
        sql.maybeOne<{ payment_status: string; status: string; amount_kobo: string }>(
          `SELECT payment_status, status, amount_kobo::text FROM reservations
            WHERE reference = $1 AND source = 'public_website' LIMIT 1`,
          [request.params.reference],
        ),
      );
      if (!reservation) throw Errors.notFound("Reservation not found");
      reply.header("cache-control", "no-store");
      return {
        reference: request.params.reference,
        paymentStatus: reservation.payment_status,
        reservationStatus: reservation.status,
        amountKobo: reservation.amount_kobo,
      };
    },
  );
};

export default publicRoutes;
