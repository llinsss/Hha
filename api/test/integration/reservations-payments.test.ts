import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, lagosDate, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";

describe.skipIf(!integration)("staff reservations, payments and the payment register", () => {
  let app: App;
  let propertyId: string;
  let desk: Awaited<ReturnType<typeof signedIn>>;
  let manager: Awaited<ReturnType<typeof signedIn>>;
  let finance: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
    [desk, manager, finance] = await Promise.all([signedIn(app, propertyId, "front_desk"), signedIn(app, propertyId, "manager"), signedIn(app, propertyId, "finance")]);
  });
  afterAll(async () => {
    await app?.close();
  });

  const createReservation = (headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `${M}/reservations`, headers, payload: { name: "Grace Guest", guests: 1, ...payload } });
  const pay = (id: string, payload: Record<string, unknown>, key: string = randomUUID(), headers = desk.headers) =>
    app.inject({ method: "POST", url: `${M}/reservations/${id}/payments`, headers: { ...headers, "idempotency-key": key }, payload });

  it("creates a priced, confirmed staff booking and rejects overlaps, past dates and over-capacity", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 3_000_000, capacity: 2 });
    const created = await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(5), checkOut: lagosDate(8), email: "Grace@Example.com" });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ reservation: Record<string, unknown> }>().reservation).toMatchObject({
      amount_kobo: "9000000",
      paid_kobo: "0",
      status: "confirmed",
      payment_status: "unpaid",
      source: "staff",
      email: "grace@example.com",
      room_number: room.roomNumber,
    });

    expect((await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(7), checkOut: lagosDate(9) })).json()).toMatchObject({ statusCode: 409, code: "ROOM_UNAVAILABLE" });
    expect((await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(8), checkOut: lagosDate(9) })).statusCode).toBe(201);
    expect((await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(-3), checkOut: lagosDate(-1) })).json()).toMatchObject({ code: "INVALID_STAY" });
    expect((await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(20), checkOut: lagosDate(21), guests: 3 })).json()).toMatchObject({ code: "ROOM_CAPACITY" });
    expect((await createReservation(desk.headers, { roomId: randomUUID(), checkIn: lagosDate(20), checkOut: lagosDate(21) })).statusCode).toBe(404);
    expect((await createReservation(finance.headers, { roomId: room.id, checkIn: lagosDate(30), checkOut: lagosDate(31) })).statusCode).toBe(403);
  });

  it("isolates properties: another property's room is not found", async () => {
    const otherProperty = await seedProperty(app);
    const foreignRoom = await seedRoom(app, otherProperty);
    expect((await createReservation(desk.headers, { roomId: foreignRoom.id, checkIn: lagosDate(5), checkOut: lagosDate(6) })).statusCode).toBe(404);
  });

  it("lists with filters and stable keyset pagination", async () => {
    const room = await seedRoom(app, propertyId);
    const guest = `Paged ${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 5; i += 1) {
      await createReservation(desk.headers, { name: guest, roomId: room.id, checkIn: lagosDate(40 + i * 2), checkOut: lagosDate(41 + i * 2) });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { reservations: Array<{ id: string; guest_name: string }>; nextCursor: string | null } = (
        await app.inject({ url: `${M}/reservations?q=${encodeURIComponent(guest)}&limit=2${cursor ? `&cursor=${cursor}` : ""}`, headers: desk.headers })
      ).json();
      seen.push(...page.reservations.map((row) => row.id));
      expect(page.reservations.every((row) => row.guest_name === guest)).toBe(true);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    expect((await app.inject({ url: `${M}/reservations?cursor=garbage`, headers: desk.headers })).json()).toMatchObject({ code: "INVALID_CURSOR" });
    expect((await app.inject({ url: `${M}/reservations?from=2026-01-01&to=2028-01-01`, headers: desk.headers })).json()).toMatchObject({ code: "INVALID_RANGE" });
    const statusFiltered = await app.inject({ url: `${M}/reservations?status=checked_out&q=${encodeURIComponent(guest)}`, headers: desk.headers });
    expect(statusFiltered.json<{ reservations: unknown[] }>().reservations).toHaveLength(0);
  });

  it("enforces stay transitions, room readiness and audited reasons", async () => {
    const room = await seedRoom(app, propertyId, { status: "vacant_dirty" });
    const future = (await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(3), checkOut: lagosDate(4) })).json<{ reservation: { id: string } }>().reservation;
    const patch = (id: string, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `${M}/reservations/${id}`, headers: desk.headers, payload });
    expect((await patch(future.id, { status: "checked_in" })).json()).toMatchObject({ code: "ARRIVAL_NOT_DUE" });
    expect((await patch(future.id, { status: "cancelled" })).json()).toMatchObject({ code: "REASON_REQUIRED" });
    expect((await patch(future.id, { status: "cancelled", reason: "Guest changed plans" })).json()).toEqual({ reservation: { id: future.id, status: "cancelled" } });
    expect((await patch(future.id, { status: "checked_in" })).json()).toMatchObject({ code: "INVALID_TRANSITION" });

    const today = (await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(0), checkOut: lagosDate(1) })).json<{ reservation: { id: string } }>().reservation;
    expect((await patch(today.id, { status: "checked_in" })).json()).toMatchObject({ code: "ROOM_NOT_READY" });
    await app.db.query("UPDATE rooms SET status = 'inspected' WHERE id = $1", [room.id]);
    expect((await patch(today.id, { status: "checked_in" })).statusCode).toBe(200);
    expect((await app.db.query("SELECT status FROM rooms WHERE id = $1", [room.id]))[0].status).toBe("occupied");
    expect((await patch(today.id, { status: "checked_out" })).statusCode).toBe(200);
    expect((await app.db.query("SELECT status FROM rooms WHERE id = $1", [room.id]))[0].status).toBe("vacant_dirty");

    const history = await app.inject({ url: `${M}/rooms/${room.id}/history`, headers: desk.headers });
    expect(history.json<{ history: Array<{ from: string; to: string }> }>().history.slice(0, 2).map((entry) => entry.to)).toEqual(["vacant_dirty", "occupied"]);
    const audit = await app.db.query("SELECT details FROM audit_events WHERE entity_id = $1 AND action = 'reservation.cancelled'", [future.id]);
    expect(audit[0].details).toMatchObject({ reason: "Guest changed plans", from: "confirmed" });
  });

  it("records staff payments: cash settles, transfers wait for owner/manager confirmation, no overpayment", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 1_000_000 });
    const reservation = (await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(50), checkOut: lagosDate(52) })).json<{ reservation: { id: string } }>().reservation;

    const key = randomUUID();
    const cash = await pay(reservation.id, { amountKobo: 500_000, method: "cash" }, key);
    expect(cash.statusCode).toBe(201);
    expect(cash.json()).toMatchObject({ payment: { duplicate: false, paid: false, paymentStatus: "settled" } });
    const replay = await pay(reservation.id, { amountKobo: 500_000, method: "cash" }, key);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect((await pay(reservation.id, { amountKobo: 500_000, method: "cash", idempotencyKey: "different-key-123" })).json()).toMatchObject({ code: "IDEMPOTENCY_KEY_MISMATCH" });

    expect((await pay(reservation.id, { amountKobo: 100, method: "online" })).statusCode).toBe(422);
    expect((await pay(reservation.id, { amountKobo: 100, method: "bank_transfer" })).json()).toMatchObject({ code: "TRANSFER_REFERENCE_REQUIRED" });
    const transfer = await pay(reservation.id, { amountKobo: 1_500_000, method: "bank_transfer", paymentReference: "=HYPERLINK(\"evil\")" });
    expect(transfer.json()).toMatchObject({ payment: { paymentStatus: "pending", paid: false } });
    expect((await pay(reservation.id, { amountKobo: 1, method: "cash" })).json()).toMatchObject({ code: "OVERPAYMENT" });
    expect((await app.db.query("SELECT payment_status FROM reservations WHERE id = $1", [reservation.id]))[0].payment_status).toBe("pending");

    const transferId = transfer.json<{ payment: { id: string } }>().payment.id;
    const confirm = (headers: Record<string, string>) =>
      app.inject({ method: "PATCH", url: `${M}/payments/${transferId}`, headers, payload: { source: "accommodation", note: "Seen in GTB statement" } });
    expect((await confirm(desk.headers)).statusCode).toBe(403);
    expect((await confirm(finance.headers)).statusCode).toBe(403);
    const [first, second] = await Promise.all([confirm(manager.headers), confirm(manager.headers)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect((await app.db.query("SELECT payment_status FROM reservations WHERE id = $1", [reservation.id]))[0].payment_status).toBe("paid");
  });

  it("serves the register with separate settled/pending totals, filters and a safe CSV export", async () => {
    const register = await app.inject({ url: `${M}/payments?source=accommodation&limit=1`, headers: finance.headers });
    expect(register.statusCode).toBe(200);
    const body = register.json<{ payments: Array<Record<string, unknown>>; nextCursor: string | null; totals: Record<string, unknown> }>();
    expect(body.payments).toHaveLength(1);
    expect(body.nextCursor).not.toBeNull();
    expect(body.totals).toMatchObject({ settledKobo: "2000000", pendingKobo: "0" });
    expect(body.payments[0]).toHaveProperty("confirmed_by");

    const pending = await app.inject({ url: `${M}/payments?status=pending`, headers: finance.headers });
    expect(pending.json<{ totals: { count: number } }>().totals.count).toBe(0);

    const csv = await app.inject({ url: `${M}/payments/export?source=accommodation`, headers: finance.headers });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toMatch(/^attachment; filename="payments-\d{8}\.csv"$/);
    expect(csv.body.split("\r\n")[0]).toBe("source,reference,guest,unit,amount_kobo,method,status,payment_reference,created_at,recorded_by,confirmed_by,confirmed_at");
    expect(csv.body).toContain(`"'=HYPERLINK(""evil"")"`);
    expect((await app.inject({ url: `${M}/payments`, headers: desk.headers })).statusCode).toBe(403);
  });

  it("lets owners and managers work the exception queue without side effects", async () => {
    const owner = await signedIn(app, propertyId, "owner");
    const room = await seedRoom(app, propertyId);
    const reservation = (await createReservation(desk.headers, { roomId: room.id, checkIn: lagosDate(60), checkOut: lagosDate(61) })).json<{ reservation: { id: string; reference: string } }>().reservation;
    const raised = await app.db.query(
      `INSERT INTO payment_exceptions(property_id, kind, dedupe_key, reservation_id, provider, provider_reference, received_amount_kobo)
       VALUES ($1, 'late_success', $2, $3, 'paystack', $4, 1000) RETURNING id`,
      [propertyId, `test:${randomUUID()}`, reservation.id, reservation.reference],
    );
    const id = raised[0].id as string;
    expect((await app.inject({ url: `${M}/payment-exceptions`, headers: finance.headers })).statusCode).toBe(403);
    const queue = await app.inject({ url: `${M}/payment-exceptions?kind=late_success`, headers: owner.headers });
    expect(queue.json<{ exceptions: Array<{ id: string; reservation_reference: string }> }>().exceptions.find((row) => row.id === id)?.reservation_reference).toBe(reservation.reference);

    const resolve = () => app.inject({ method: "PATCH", url: `${M}/payment-exceptions/${id}`, headers: manager.headers, payload: { resolutionNote: "Rebooked guest into room 12" } });
    const resolved = await resolve();
    expect(resolved.json()).toMatchObject({ exception: { status: "resolved", resolution_note: "Rebooked guest into room 12" } });
    expect((await resolve()).json()).toMatchObject({ code: "ALREADY_RESOLVED" });
    expect((await app.db.query("SELECT status FROM reservations WHERE id = $1", [reservation.id]))[0].status).toBe("confirmed");
  });
});
