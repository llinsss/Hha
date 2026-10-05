import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { FakePaystack } from "../fakes/paystack.js";
import { CRON_SECRET, createTestApp, enablePaystack, integration, lagosDate, paystackEnv, primaryPropertyId, seedRoom, signedIn } from "../helpers.js";

const PUBLIC = "/api/v1/public";

describe.skipIf(!integration)("public booking, checkout and online settlement", () => {
  const paystack = new FakePaystack();
  let app: App;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp(paystackEnv(await paystack.start()));
    propertyId = await primaryPropertyId(app);
    await enablePaystack(app, propertyId);
  });
  afterAll(async () => {
    await app?.close();
    await paystack.stop();
  });

  const stay = { checkIn: lagosDate(10), checkOut: lagosDate(12) };
  const book = (roomType: string, key: string = randomUUID(), overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: `${PUBLIC}/reservations`,
      headers: { "idempotency-key": key },
      payload: { name: "Ada Guest", email: "Ada@Example.com", phone: "+234 800 000 0000", roomType, guests: 2, ...stay, ...overrides },
    });
  const availability = (roomType: string, query = stay) =>
    app
      .inject({ url: `${PUBLIC}/availability?checkIn=${query.checkIn}&checkOut=${query.checkOut}&guests=2` })
      .then((response) => response.json<{ roomTypes: Array<{ room_type: string; available_count: number; nightly_rate_kobo: string }> }>().roomTypes.find((type) => type.room_type === roomType));
  const cron = (path: string) => app.inject({ method: "POST", url: `/api/v1/cron/${path}`, headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const webhook = (reference: string) => {
    const { body, signature } = paystack.webhook(reference);
    return app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "x-paystack-signature": signature }, payload: body });
  };
  const reservationState = async (reference: string) =>
    (await app.db.query("SELECT r.status, r.payment_status, p.status AS payment FROM reservations r JOIN payments p ON p.reservation_id = r.id AND p.method = 'online' WHERE r.reference = $1", [reference]))[0] as {
      status: string;
      payment_status: string;
      payment: string;
    };
  const exceptions = async (reference: string) =>
    (await app.db.query("SELECT kind FROM payment_exceptions WHERE provider_reference = $1 ORDER BY detected_at", [reference])).map((row: { kind: string }) => row.kind);

  it("reports availability per room type, excluding out-of-service rooms and booked dates", async () => {
    const type = `Studio ${randomUUID().slice(0, 6)}`;
    await seedRoom(app, propertyId, { roomType: type, rateKobo: 4_500_000 });
    await seedRoom(app, propertyId, { roomType: type, rateKobo: 4_500_000, status: "occupied" });
    await seedRoom(app, propertyId, { roomType: type, status: "maintenance" });
    expect(await availability(type)).toEqual({ room_type: type, nightly_rate_kobo: "4500000", capacity: 2, available_count: 2 });
    expect(await availability(type, { checkIn: lagosDate(-2), checkOut: lagosDate(1) })).toBeUndefined();
    const invalid = await app.inject({ url: `${PUBLIC}/availability?checkIn=2026-02-30&checkOut=2026-03-02` });
    expect(invalid.statusCode).toBe(422);
  });

  it("holds a room, prices it server-side and returns the hosted checkout URL", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 7_500_000 });
    const response = await book(room.roomType);
    expect(response.statusCode).toBe(201);
    const body = response.json<{ reservation: { reference: string; amountKobo: string; status: string; holdExpiresAt: string }; checkoutUrl: string }>();
    expect(body.reservation).toMatchObject({ amountKobo: "15000000", status: "pending_payment" });
    expect(body.reservation.reference).toMatch(/^HH-[A-Z0-9]+-[0-9A-F]{32}$/);
    expect(body.checkoutUrl).toBe(`https://checkout.paystack.test/${body.reservation.reference}`);
    const holdMinutes = (Date.parse(body.reservation.holdExpiresAt) - Date.now()) / 60_000;
    expect(holdMinutes).toBeGreaterThan(19);
    expect(holdMinutes).toBeLessThanOrEqual(20);
    expect(paystack.transactions.get(body.reservation.reference)?.amount).toBe(15_000_000);
    expect(await availability(room.roomType)).toBeUndefined();

    const status = await app.inject({ url: `${PUBLIC}/payments/${body.reservation.reference}` });
    expect(status.json()).toEqual({ reference: body.reservation.reference, paymentStatus: "pending", reservationStatus: "pending_payment", amountKobo: "15000000" });
  });

  it("requires an Idempotency-Key and never creates a duplicate booking or charge for a retry", async () => {
    const room = await seedRoom(app, propertyId);
    const missing = await app.inject({ method: "POST", url: `${PUBLIC}/reservations`, payload: { name: "A", email: "a@b.co", roomType: room.roomType, guests: 1, ...stay } });
    expect(missing.statusCode).toBe(422);

    const key = randomUUID();
    const first = await book(room.roomType, key);
    const retry = await book(room.roomType, key);
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(first.json());

    // Even if the Redis record is gone (new instance, different prefix), the database replays the original.
    const other = await createTestApp(paystackEnv(paystack.baseUrl));
    try {
      const fromDb = await other.inject({
        method: "POST",
        url: `${PUBLIC}/reservations`,
        headers: { "idempotency-key": key },
        payload: { name: "Ada Guest", email: "Ada@Example.com", phone: "+234 800 000 0000", roomType: room.roomType, guests: 2, ...stay },
      });
      expect(fromDb.statusCode).toBe(201);
      expect(fromDb.json<{ reservation: { reference: string } }>().reservation.reference).toBe(first.json<{ reservation: { reference: string } }>().reservation.reference);
    } finally {
      await other.close();
    }
    const count = await app.db.query("SELECT count(*)::int AS count FROM reservations WHERE room_id = $1", [room.id]);
    expect(count[0].count).toBe(1);

    const changed = await book(room.roomType, key, { guests: 1 });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("never sells the last room twice under concurrent bookings", async () => {
    const room = await seedRoom(app, propertyId);
    const results = await Promise.all(Array.from({ length: 5 }, () => book(room.roomType)));
    const codes = results.map((result) => result.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409]);
    expect(results.find((result) => result.statusCode === 409)?.json()).toMatchObject({ code: "ROOM_UNAVAILABLE" });
  });

  it("releases the hold when checkout cannot be started", async () => {
    const room = await seedRoom(app, propertyId);
    paystack.failInitialize = true;
    try {
      const response = await book(room.roomType);
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    } finally {
      paystack.failInitialize = false;
    }
    expect((await availability(room.roomType))?.available_count).toBe(1);
  });

  it("rejects bookings in the past, longer than allowed, or over capacity", async () => {
    const room = await seedRoom(app, propertyId, { capacity: 2 });
    expect((await book(room.roomType, randomUUID(), { checkIn: lagosDate(-1), checkOut: lagosDate(1) })).json()).toMatchObject({ code: "INVALID_STAY" });
    expect((await book(room.roomType, randomUUID(), { checkIn: lagosDate(1), checkOut: lagosDate(100) })).json()).toMatchObject({ code: "INVALID_STAY" });
    expect((await book(room.roomType, randomUUID(), { guests: 3 })).statusCode).toBe(409);
  });

  it("confirms the stay only after a signed webhook verified server-to-server, exactly once", async () => {
    const room = await seedRoom(app, propertyId);
    const { reservation } = (await book(room.roomType)).json<{ reservation: { reference: string } }>();

    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payments",
      headers: { "content-type": "application/json", "x-paystack-signature": "0".repeat(128) },
      payload: paystack.webhook(reservation.reference).body,
    });
    expect(forged.statusCode).toBe(401);

    // Claimed success that the provider does not confirm is not settled.
    const unconfirmed = await webhook(reservation.reference);
    expect(unconfirmed.statusCode).toBe(200);
    expect(await reservationState(reservation.reference)).toMatchObject({ status: "pending_payment", payment: "pending" });
    expect(await exceptions(reservation.reference)).toEqual(["verification_failed"]);

    paystack.succeed(reservation.reference);
    const applied = await webhook(reservation.reference);
    expect(applied.json()).toEqual({ received: true, duplicate: true });

    // A new delivery id (the provider's real success event) settles.
    paystack.transactions.get(reservation.reference)!.id += 1_000_000;
    expect((await webhook(reservation.reference)).json()).toEqual({ received: true });
    expect(await reservationState(reservation.reference)).toEqual({ status: "confirmed", payment_status: "paid", payment: "settled" });
    expect((await webhook(reservation.reference)).json()).toEqual({ received: true, duplicate: true });
    const settled = await app.db.query("SELECT count(*)::int AS count FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE r.reference = $1 AND p.status = 'settled'", [reservation.reference]);
    expect(settled[0].count).toBe(1);
  });

  it("queues an amount mismatch instead of settling", async () => {
    const room = await seedRoom(app, propertyId);
    const { reservation } = (await book(room.roomType)).json<{ reservation: { reference: string } }>();
    paystack.succeed(reservation.reference, { amount: 100 });
    await webhook(reservation.reference);
    expect(await reservationState(reservation.reference)).toMatchObject({ status: "pending_payment", payment: "pending" });
    expect(await exceptions(reservation.reference)).toEqual(["amount_mismatch"]);
  });

  it("expires lapsed holds, and records a late payment as an exception without confirming the stay", async () => {
    const room = await seedRoom(app, propertyId);
    const { reservation } = (await book(room.roomType)).json<{ reservation: { reference: string } }>();
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/expire-payment-holds" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/cron/expire-payment-holds", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);

    await app.db.query("UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1", [reservation.reference]);
    expect((await availability(room.roomType))?.available_count).toBe(1);
    const expired = await cron("expire-payment-holds");
    expect(expired.json<{ expired: number }>().expired).toBeGreaterThanOrEqual(1);
    expect(await reservationState(reservation.reference)).toEqual({ status: "expired", payment_status: "unpaid", payment: "failed" });

    paystack.succeed(reservation.reference);
    await webhook(reservation.reference);
    expect(await reservationState(reservation.reference)).toEqual({ status: "expired", payment_status: "paid", payment: "settled" });
    expect(await exceptions(reservation.reference)).toEqual(["late_success"]);
  });

  it("reconciles a success whose webhook never arrived and queues stale bank transfers", async () => {
    const room = await seedRoom(app, propertyId);
    const { reservation } = (await book(room.roomType)).json<{ reservation: { reference: string } }>();
    paystack.succeed(reservation.reference);

    const staffRoom = await seedRoom(app, propertyId);
    const desk = await signedIn(app, propertyId, "front_desk");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/management/reservations",
      headers: desk.headers,
      payload: { name: "Walk In", roomId: staffRoom.id, checkIn: lagosDate(20), checkOut: lagosDate(21), guests: 1 },
    });
    const staffReservation = created.json<{ reservation: { id: string; reference: string } }>().reservation;
    await app.inject({
      method: "POST",
      url: `/api/v1/management/reservations/${staffReservation.id}/payments`,
      headers: { ...desk.headers, "idempotency-key": randomUUID() },
      payload: { amountKobo: 1000, method: "bank_transfer", paymentReference: "GTB 123" },
    });
    await app.db.query("UPDATE payments SET created_at = now() - interval '3 days' WHERE reservation_id = $1", [staffReservation.id]);

    const report = await cron("reconcile-payments");
    expect(report.statusCode).toBe(200);
    expect(report.json<{ outcomes: Record<string, number>; unresolvedTransfersQueued: number }>().outcomes.confirmed).toBeGreaterThanOrEqual(1);
    expect(await reservationState(reservation.reference)).toEqual({ status: "confirmed", payment_status: "paid", payment: "settled" });
    expect(await exceptions(staffReservation.reference)).toEqual(["unresolved_bank_transfer"]);
    // Idempotent: a second run queues nothing new.
    expect((await cron("reconcile-payments")).json<{ unresolvedTransfersQueued: number }>().unresolvedTransfersQueued).toBe(0);
  });

  it("exposes payment status only for public references, without guest data", async () => {
    expect((await app.inject({ url: `${PUBLIC}/payments/not-a-reference` })).statusCode).toBe(422);
    expect((await app.inject({ url: `${PUBLIC}/payments/HH-UNKNOWN-0000` })).statusCode).toBe(404);
    const desk = await signedIn(app, propertyId, "front_desk");
    const room = await seedRoom(app, propertyId);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/management/reservations",
      headers: desk.headers,
      payload: { name: "Staff Guest", roomId: room.id, checkIn: lagosDate(30), checkOut: lagosDate(31), guests: 1 },
    });
    const reference = created.json<{ reservation: { reference: string } }>().reservation.reference;
    expect((await app.inject({ url: `${PUBLIC}/payments/${reference}` })).statusCode).toBe(404);
  });
});
