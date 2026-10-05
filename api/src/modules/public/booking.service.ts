import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withTransaction, type Sql } from "../../db/sql.js";
import { sha256Hex } from "../../lib/crypto.js";
import { addDays, businessToday, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import type { GlobalSettings } from "../settings/settings.registry.js";
import { expireLapsedHolds, refreshReservationPayment } from "../payments/ledger.js";

/** Statuses that occupy a room for their dates (holds only while unexpired). */
export const OCCUPYING_STAY_SQL = `
  r.status IN ('hold', 'pending_payment', 'confirmed', 'checked_in')
  AND (r.status NOT IN ('hold', 'pending_payment') OR r.hold_expires_at > now())`;

/** Rooms that can be sold: active and not taken out of service. */
export const SELLABLE_ROOM_SQL = `ro.active AND ro.status NOT IN ('maintenance', 'out_of_order')`;

export type StayDates = { checkIn: string; checkOut: string; nights: number };

/** Validates a stay against today's business date, the maximum length and the booking horizon. */
export function validateStay(rules: Pick<GlobalSettings, "maxStayNights" | "horizonDays">, checkIn: string, checkOut: string): StayDates {
  const nights = nightsBetween(checkIn, checkOut);
  const today = businessToday();
  const { maxStayNights, horizonDays } = rules;
  if (nights < 1 || nights > maxStayNights) throw Errors.unprocessable(`Choose a stay of 1 to ${maxStayNights} nights`, "INVALID_STAY");
  if (checkIn < today) throw Errors.unprocessable("Check-in must be today or a future date", "INVALID_STAY");
  if (checkIn > addDays(today, horizonDays)) throw Errors.unprocessable(`Bookings open ${horizonDays} days ahead`, "INVALID_STAY");
  return { checkIn, checkOut, nights };
}

/** Unguessable public reference (~128 bits of randomness) used for the guest's status page. */
export function publicReference(): string {
  return `HH-${Date.now().toString(36).toUpperCase()}-${randomBytes(16).toString("hex").toUpperCase()}`;
}

/** Short staff reference; not accepted by the public status endpoint. */
export function staffReference(): string {
  return `HH-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function primaryPropertyId(sql: Sql): Promise<string> {
  const property = await sql.maybeOne<{ id: string }>(`SELECT id FROM properties ORDER BY created_at, id LIMIT 1`);
  if (!property) throw Errors.unavailable("Bookings are not configured yet", "PROPERTY_NOT_CONFIGURED");
  return property.id;
}

export async function insertGuest(tx: Sql, propertyId: string, guest: { name: string; email: string | null; phone: string | null }): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO guests(property_id, full_name, email, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, guest.name, guest.email, guest.phone],
  );
  return row.id;
}

type PublicBookingInput = {
  name: string;
  email: string;
  phone: string | null;
  roomType: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  notes: string | null;
  idempotencyKey: string;
  fingerprint: string;
};

type BookingResult = {
  reservation: { id: string; reference: string; amountKobo: string; currency: "NGN"; status: "pending_payment"; holdExpiresAt: string };
  checkoutUrl: string;
};

type ExistingBooking = {
  id: string;
  reference: string;
  amount_kobo: string;
  status: string;
  hold_expires_at: Date | null;
  checkout_url: string | null;
  request_fingerprint: string | null;
};

/**
 * Public booking + hosted checkout (PRD §4.1). The room is chosen and held in a
 * short transaction; the provider call happens after commit so no database lock
 * is held across the network. A failed checkout start releases the hold.
 */
export async function createPublicBooking(app: FastifyInstance, input: PublicBookingInput): Promise<BookingResult> {
  const provider = await app.payments.provider();
  const webUrl = app.config.payments.publicWebUrl;
  if (!provider || !webUrl) throw Errors.unavailable("Online payment is temporarily unavailable. Please contact the property to book.", "PAYMENTS_UNAVAILABLE");
  const rules = await app.settings.current();
  const stay = validateStay(rules, input.checkIn, input.checkOut);
  const paymentKey = `public:${sha256Hex(input.idempotencyKey)}`;

  const held = await withTransaction(app.db, async (tx) => {
    const propertyId = await primaryPropertyId(tx);
    const existing = await tx.maybeOne<ExistingBooking>(
      `SELECT r.id, r.reference, r.amount_kobo::text, r.status, r.hold_expires_at, p.checkout_url, p.request_fingerprint
         FROM payments p JOIN reservations r ON r.id = p.reservation_id
        WHERE p.property_id = $1 AND p.idempotency_key = $2`,
      [propertyId, paymentKey],
    );
    if (existing) return { kind: "replay" as const, prior: existing };

    const room = await tx.maybeOne<{ id: string; nightly_rate_kobo: string }>(
      `SELECT ro.id, ro.nightly_rate_kobo::text FROM rooms ro
        WHERE ro.property_id = $1 AND ro.room_type = $2 AND ro.capacity >= $3 AND ${SELLABLE_ROOM_SQL}
          AND NOT EXISTS (SELECT 1 FROM reservations r
                           WHERE r.room_id = ro.id AND ${OCCUPYING_STAY_SQL}
                             AND r.check_in < $5::date AND r.check_out > $4::date)
        ORDER BY ro.room_number
        LIMIT 1
        FOR UPDATE OF ro SKIP LOCKED`,
      [propertyId, input.roomType, input.guests, stay.checkIn, stay.checkOut],
    );
    if (!room) throw Errors.conflict("That room type is unavailable for the selected dates", "ROOM_UNAVAILABLE");
    // Lapsed holds on this room still count for the exclusion constraint until expired.
    await expireLapsedHolds(tx, { roomId: room.id, limit: 100 });

    const amount = BigInt(room.nightly_rate_kobo) * BigInt(stay.nights);
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw Errors.unavailable("This room is not currently available for online payment. Please contact the property.", "PRICE_NOT_PAYABLE");
    }
    const guestId = await insertGuest(tx, propertyId, { name: input.name, email: input.email, phone: input.phone });
    const reference = publicReference();
    const reservation = await tx.one<{ id: string; hold_expires_at: Date }>(
      `INSERT INTO reservations(property_id, guest_id, reference, room_id, room_type, check_in, check_out, guests_count,
                                amount_kobo, status, source, payment_status, notes, hold_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', 'public_website', 'pending', $10,
               now() + make_interval(mins => $11))
       RETURNING id, hold_expires_at`,
      [propertyId, guestId, reference, room.id, input.roomType, stay.checkIn, stay.checkOut, input.guests, amount.toString(), input.notes, rules.holdMinutes],
    );
    await tx.exec(
      `INSERT INTO payments(property_id, reservation_id, amount_kobo, method, status, provider, provider_reference, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, 'online', 'pending', $4, $5, $6, $7)`,
      [propertyId, reservation.id, amount.toString(), provider.name, reference, paymentKey, input.fingerprint],
    );
    await recordEvent(tx, {
      propertyId,
      actorId: null,
      action: "reservation.created",
      entityType: "reservation",
      entityId: reservation.id,
      details: { source: "public_website", roomId: room.id, amountKobo: amount.toString() },
      outbox: { reference },
    });
    return { kind: "created" as const, booking: { id: reservation.id, reference, amountKobo: amount.toString(), holdExpiresAt: reservation.hold_expires_at, propertyId } };
  });

  if (held.kind === "replay") {
    const { prior } = held;
    if (prior.request_fingerprint !== input.fingerprint) {
      throw Errors.conflict("This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
    }
    if (prior.status !== "pending_payment" || !prior.checkout_url || !prior.hold_expires_at || prior.hold_expires_at.getTime() <= Date.now()) {
      throw Errors.conflict("This booking attempt has ended. Start a new booking.", "BOOKING_ATTEMPT_CLOSED");
    }
    return {
      reservation: { id: prior.id, reference: prior.reference, amountKobo: prior.amount_kobo, currency: "NGN", status: "pending_payment", holdExpiresAt: prior.hold_expires_at.toISOString() },
      checkoutUrl: prior.checkout_url,
    };
  }

  const { booking } = held;
  let checkoutUrl: string;
  try {
    ({ checkoutUrl } = await provider.initializeCheckout({
      reference: booking.reference,
      amountKobo: Number(booking.amountKobo),
      email: input.email,
      name: input.name,
      callbackUrl: `${webUrl}/payment-result?reference=${encodeURIComponent(booking.reference)}`,
    }));
  } catch (error) {
    // No charge can exist without a checkout session, so release the room. ProviderError maps to 502.
    app.log.error({ err: error, reference: booking.reference }, "checkout initialization failed");
    await releaseFailedCheckout(app, booking.id, booking.propertyId, booking.reference);
    throw error;
  }
  await withTransaction(app.db, (tx) => tx.exec(`UPDATE payments SET checkout_url = $2 WHERE reservation_id = $1 AND method = 'online'`, [booking.id, checkoutUrl]));
  return {
    reservation: { id: booking.id, reference: booking.reference, amountKobo: booking.amountKobo, currency: "NGN", status: "pending_payment", holdExpiresAt: booking.holdExpiresAt.toISOString() },
    checkoutUrl,
  };
}

/** Compensates a booking whose checkout could not be started: no charge exists, so the hold is released. */
async function releaseFailedCheckout(app: FastifyInstance, reservationId: string, propertyId: string, reference: string): Promise<void> {
  await withTransaction(app.db, async (tx) => {
    await tx.exec(`UPDATE payments SET status = 'failed' WHERE reservation_id = $1 AND method = 'online' AND status = 'pending'`, [reservationId]);
    const released = await tx.exec(`UPDATE reservations SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [reservationId]);
    if (released === 0) return;
    await refreshReservationPayment(tx, reservationId);
    await recordEvent(tx, {
      propertyId,
      actorId: null,
      action: "reservation.checkout_failed",
      entityType: "reservation",
      entityId: reservationId,
      outbox: { reference },
    });
  });
}
