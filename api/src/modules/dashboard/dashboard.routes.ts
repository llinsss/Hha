import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withConnection } from "../../db/sql.js";
import { BUSINESS_TIMEZONE } from "../../lib/dates.js";
import { canSeeEvent } from "../../lib/events.js";
import { hasPermission } from "../../lib/permissions.js";
import { Nullable, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";
import { ReservationRow } from "../reservations/reservations.schemas.js";
import { RESERVATION_SELECT, type ReservationRow as ReservationRecord } from "../reservations/reservations.service.js";

const TODAY = `(now() AT TIME ZONE '${BUSINESS_TIMEZONE}')::date`;
const ACTIVITY_SCAN = 100;
const ACTIVITY_LIMIT = 8;

const Metrics = Type.Object({
  sellable_rooms: Type.Integer(),
  occupied_rooms: Type.Integer(),
  arrivals: Type.Integer(),
  departures: Type.Integer(),
  maintenance_rooms: Type.Integer(),
  active_staff: Type.Integer(),
  low_stock_items: Type.Integer(),
  room_revenue_kobo: Type.Optional(Type.String()),
  restaurant_revenue_kobo: Type.Optional(Type.String()),
  restaurant_orders: Type.Optional(Type.Integer()),
  pending_transfers: Type.Optional(Type.Integer()),
  open_payment_exceptions: Type.Optional(Type.Integer()),
});

type MetricsRow = {
  sellable_rooms: number;
  occupied_rooms: number;
  arrivals: number;
  departures: number;
  maintenance_rooms: number;
  active_staff: number;
  low_stock_items: number;
  room_revenue_kobo: string;
  restaurant_revenue_kobo: string;
  restaurant_orders: number;
  pending_transfers: number;
  open_payment_exceptions: number;
};

const dashboardRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize("dashboard:read"),
      schema: {
        tags: ["dashboard"],
        summary: "Property snapshot for today (Africa/Lagos business date)",
        description:
          "Revenue and payment metrics are included only for roles that can read payments or reports; reservations only for roles that can read reservations; activity is filtered to event types the role may see. All figures come from committed records.",
        security: [{ bearerAuth: [] }],
        response: {
          200: Type.Object({
            property: Type.Object({ name: Type.String(), timezone: Type.String(), currency: Type.String() }),
            metrics: Metrics,
            reservations: Type.Array(ReservationRow),
            activity: Type.Array(Type.Object({ id: Type.String(), event_type: Type.String(), entity_id: Type.String(), payload: Type.Object({ reference: Type.Optional(Type.String()) }), created_at: Timestamp })),
            operations: Type.Object({ open_housekeeping: Type.Integer(), completed_housekeeping: Type.Integer() }),
            staff: Type.Object({ clocked_in: Type.Integer() }),
            user: Type.Object({ id: Uuid, fullName: Type.String(), email: Type.String(), role: Type.String(), mustChangePassword: Type.Boolean() }),
            serverTime: Timestamp,
            lastEventId: Nullable(Type.String()),
          }),
          ...errorResponses(401, 403),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const propertyId = principal.propertyId;
      const canSeeMoney = hasPermission(principal.role, "payments:read") || hasPermission(principal.role, "reports:read");
      const canSeeReservations = hasPermission(principal.role, "reservations:read");

      return withConnection(app.db, async (sql) => {
        const property = await sql.one<{ name: string; timezone: string; currency: string }>(`SELECT name, timezone, currency FROM properties WHERE id = $1`, [propertyId]);
        const metrics = await sql.one<MetricsRow>(
          `SELECT
             (SELECT count(*)::int FROM rooms WHERE property_id = $1 AND active AND status NOT IN ('maintenance', 'out_of_order')) AS sellable_rooms,
             (SELECT count(DISTINCT room_id)::int FROM reservations
               WHERE property_id = $1 AND room_id IS NOT NULL AND status IN ('confirmed', 'checked_in') AND check_in <= ${TODAY} AND check_out > ${TODAY}) AS occupied_rooms,
             (SELECT count(*)::int FROM reservations WHERE property_id = $1 AND check_in = ${TODAY} AND status IN ('confirmed', 'checked_in')) AS arrivals,
             (SELECT count(*)::int FROM reservations WHERE property_id = $1 AND check_out = ${TODAY} AND status IN ('confirmed', 'checked_in')) AS departures,
             (SELECT count(*)::int FROM rooms WHERE property_id = $1 AND status IN ('maintenance', 'out_of_order')) AS maintenance_rooms,
             (SELECT count(*)::int FROM staff_profiles WHERE property_id = $1 AND employment_status = 'active') AS active_staff,
             (SELECT count(*)::int FROM inventory_items WHERE property_id = $1 AND active AND quantity <= reorder_level) AS low_stock_items,
             (SELECT coalesce(sum(amount_kobo), 0)::text FROM payments
               WHERE property_id = $1 AND status = 'settled' AND (coalesce(settled_at, created_at) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = ${TODAY}) AS room_revenue_kobo,
             (SELECT coalesce(sum(total_kobo), 0)::text FROM pos_orders
               WHERE property_id = $1 AND status = 'paid' AND payment_status = 'settled'
                 AND (coalesce(payment_confirmed_at, created_at) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = ${TODAY}) AS restaurant_revenue_kobo,
             (SELECT count(*)::int FROM pos_orders
               WHERE property_id = $1 AND status = 'paid' AND payment_status = 'settled'
                 AND (coalesce(payment_confirmed_at, created_at) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = ${TODAY}) AS restaurant_orders,
             ((SELECT count(*) FROM payments WHERE property_id = $1 AND method = 'bank_transfer' AND status = 'pending')
              + (SELECT count(*) FROM pos_orders WHERE property_id = $1 AND payment_method = 'bank_transfer' AND payment_status = 'pending' AND status <> 'voided'))::int AS pending_transfers,
             (SELECT count(*)::int FROM payment_exceptions WHERE property_id = $1 AND status = 'open') AS open_payment_exceptions`,
          [propertyId],
        );
        const reservations = canSeeReservations
          ? await sql.rows<ReservationRecord>(
              `${RESERVATION_SELECT}
                WHERE r.property_id = $1 AND r.status IN ('confirmed', 'checked_in', 'pending_payment')
                  AND r.check_in <= ${TODAY} + 3 AND r.check_out >= ${TODAY}
                ORDER BY r.check_in, r.created_at DESC
                LIMIT 30`,
              [propertyId],
            )
          : [];
        const events = await sql.rows<{ id: string; event_type: string; entity_id: string; reference: string | null; created_at: Date }>(
          `SELECT id::text, event_type, entity_id, payload->>'reference' AS reference, created_at
             FROM outbox_events WHERE property_id = $1 ORDER BY id DESC LIMIT $2`,
          [propertyId, ACTIVITY_SCAN],
        );
        const operations = await sql.one<{ open_housekeeping: number; completed_housekeeping: number }>(
          `SELECT (SELECT count(*)::int FROM housekeeping_tasks WHERE property_id = $1 AND status <> 'complete') AS open_housekeeping,
                  (SELECT count(*)::int FROM housekeeping_tasks
                    WHERE property_id = $1 AND status = 'complete' AND (completed_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = ${TODAY}) AS completed_housekeeping`,
          [propertyId],
        );
        const staff = await sql.one<{ clocked_in: number }>(
          `SELECT count(*)::int AS clocked_in FROM staff_profiles sp
            WHERE sp.property_id = $1 AND sp.employment_status = 'active'
              AND (SELECT event_type FROM attendance_events WHERE staff_id = sp.id ORDER BY happened_at DESC LIMIT 1) = 'clock_in'`,
          [propertyId],
        );

        const { room_revenue_kobo, restaurant_revenue_kobo, restaurant_orders, pending_transfers, open_payment_exceptions, ...operational } = metrics;
        return {
          property,
          metrics: {
            ...operational,
            ...(canSeeMoney ? { room_revenue_kobo, restaurant_revenue_kobo, restaurant_orders, pending_transfers } : {}),
            ...(hasPermission(principal.role, "payments:confirm") ? { open_payment_exceptions } : {}),
          },
          reservations,
          activity: events
            .filter((event) => canSeeEvent(principal.role, event.event_type))
            .slice(0, ACTIVITY_LIMIT)
            .map((event) => ({ id: event.id, event_type: event.event_type, entity_id: event.entity_id, payload: event.reference ? { reference: event.reference } : {}, created_at: event.created_at })),
          operations,
          staff,
          user: { id: principal.userId, fullName: principal.fullName, email: principal.email, role: principal.role, mustChangePassword: principal.mustChangePassword },
          serverTime: new Date(),
          lastEventId: events[0]?.id ?? null,
        };
      });
    },
  );
};

export default dashboardRoutes;
