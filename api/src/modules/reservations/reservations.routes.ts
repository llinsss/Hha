import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../lib/errors.js";
import { requirePrincipal } from "../auth/principal.js";
import { CreateReservationSchema, ListReservationsSchema, RecordPaymentSchema, UpdateReservationSchema } from "./reservations.schemas.js";
import { changeReservationStatus, createStaffReservation, listReservations, recordStaffPayment } from "./reservations.service.js";
import { optionalText } from "../../lib/text.js";

const reservationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: ListReservationsSchema, preHandler: app.authorize("reservations:read") }, async (request) => {
    const query = request.query;
    return listReservations(app, requirePrincipal(request).propertyId, { ...query, limit: query.limit ?? 50 });
  });

  app.post("/", { schema: CreateReservationSchema, preHandler: app.authorize("reservations:write") }, async (request, reply) => {
    const body = request.body;
    const reservation = await createStaffReservation(app, requirePrincipal(request), {
      name: body.name.trim(),
      email: optionalText(body.email)?.toLowerCase() ?? null,
      phone: optionalText(body.phone),
      roomId: body.roomId,
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      guests: body.guests,
      notes: optionalText(body.notes),
    });
    return reply.status(201).send({ reservation });
  });

  app.patch("/:id", { schema: UpdateReservationSchema, preHandler: app.authorize("reservations:write") }, async (request) =>
    changeReservationStatus(app, requirePrincipal(request), request.params.id, request.body.status, request.body.reason),
  );

  app.post(
    "/:id/payments",
    { schema: RecordPaymentSchema, preHandler: [app.authorize("reservations:write"), app.idempotent()] },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (request.body.idempotencyKey !== undefined && request.body.idempotencyKey !== key) {
        throw Errors.unprocessable("idempotencyKey must match the Idempotency-Key header", "IDEMPOTENCY_KEY_MISMATCH");
      }
      const result = await recordStaffPayment(app, requirePrincipal(request), request.params.id, {
        amountKobo: request.body.amountKobo,
        method: request.body.method,
        paymentReference: optionalText(request.body.paymentReference),
        idempotencyKey: key,
      });
      return reply.status(result.created ? 201 : 200).send({ payment: result.payment });
    },
  );
};

export default reservationRoutes;
