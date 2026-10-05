import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { bearer, createTestApp, integration, lagosDate, login, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";

describe.skipIf(!integration)("rooms, staff accounts and attendance", () => {
  let app: App;
  let propertyId: string;
  let owner: Awaited<ReturnType<typeof signedIn>>;
  let manager: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
    [owner, manager] = await Promise.all([signedIn(app, propertyId, "owner"), signedIn(app, propertyId, "manager")]);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("creates rooms singly or in bulk and rejects duplicates", async () => {
    const single = await app.inject({ method: "POST", url: `${M}/rooms`, headers: manager.headers, payload: { roomNumber: "101", roomType: "Studio", nightlyRateKobo: 4_500_000 } });
    expect(single.statusCode).toBe(201);
    expect(single.json<{ created: number }>().created).toBe(1);
    const bulk = await app.inject({
      method: "POST",
      url: `${M}/rooms`,
      headers: manager.headers,
      payload: { rooms: [{ roomNumber: "201", roomType: "Suite", nightlyRateKobo: 7_500_000, capacity: 3 }, { roomNumber: "202", roomType: "Suite", nightlyRateKobo: 7_500_000 }] },
    });
    expect(bulk.json<{ created: number; roomIds: string[] }>()).toMatchObject({ created: 2 });
    expect((await app.inject({ method: "POST", url: `${M}/rooms`, headers: manager.headers, payload: { roomNumber: "101", roomType: "Studio", nightlyRateKobo: 1 } })).json()).toMatchObject({ statusCode: 409, code: "UNIQUE_VIOLATION" });
    expect((await app.inject({ method: "POST", url: `${M}/rooms`, headers: manager.headers, payload: { roomNumber: "9", roomType: "Studio", nightlyRateKobo: 1, rooms: [] } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `${M}/rooms`, headers: manager.headers, payload: { roomNumber: "9", roomType: "Studio" } })).statusCode).toBe(422);
  });

  it("restricts housekeeping to cleaning states and hides rates and guest details from them", async () => {
    const housekeeping = await signedIn(app, propertyId, "housekeeping");
    const room = await seedRoom(app, propertyId, { status: "vacant_dirty" });
    const patch = (headers: Record<string, string>, status: string) => app.inject({ method: "PATCH", url: `${M}/rooms/${room.id}`, headers, payload: { status } });
    expect((await patch(housekeeping.headers, "maintenance")).statusCode).toBe(403);
    const created = await app.inject({ method: "POST", url: `${M}/rooms`, headers: housekeeping.headers, payload: { roomNumber: "HK1", roomType: "Studio", nightlyRateKobo: 1 } });
    expect(created.statusCode).toBe(403);
    expect((await patch(housekeeping.headers, "vacant_clean")).json()).toEqual({ id: room.id, status: "vacant_clean" });
    expect((await patch(manager.headers, "occupied")).json()).toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await patch(manager.headers, "out_of_order")).statusCode).toBe(200);
    expect((await patch(manager.headers, "vacant_clean")).json()).toMatchObject({ code: "INVALID_TRANSITION" });

    const list = await app.inject({ url: `${M}/rooms?limit=200`, headers: housekeeping.headers });
    const rooms = list.json<{ rooms: Array<{ id: string; nightly_rate_kobo: string | null }> }>().rooms;
    expect(rooms.length).toBeGreaterThan(0);
    expect(rooms.every((entry) => entry.nightly_rate_kobo === null)).toBe(true);
  });

  it("refuses to mark a room vacant while a guest is checked in", async () => {
    const room = await seedRoom(app, propertyId, { status: "inspected" });
    const desk = await signedIn(app, propertyId, "front_desk");
    const created = await app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "In House", roomId: room.id, checkIn: lagosDate(0), checkOut: lagosDate(2), guests: 1 } });
    const id = created.json<{ reservation: { id: string } }>().reservation.id;
    await app.inject({ method: "PATCH", url: `${M}/reservations/${id}`, headers: desk.headers, payload: { status: "checked_in" } });
    const vacant = await app.inject({ method: "PATCH", url: `${M}/rooms/${room.id}`, headers: manager.headers, payload: { status: "vacant_dirty" } });
    expect(vacant.json()).toMatchObject({ code: "GUEST_IN_ROOM" });
    const list = await app.inject({ url: `${M}/rooms?limit=200`, headers: desk.headers });
    expect(list.json<{ rooms: Array<{ id: string; stay: { guest?: string } | null }> }>().rooms.find((entry) => entry.id === room.id)?.stay?.guest).toBe("In House");
  });

  it("onboards staff with a one-time generated password and forces a change at first sign-in", async () => {
    const email = `new-${randomUUID().slice(0, 8)}@houzzhills.test`;
    const created = await app.inject({
      method: "POST",
      url: `${M}/staff`,
      headers: manager.headers,
      payload: { fullName: "New Starter", email, employeeNumber: `E-${randomUUID().slice(0, 6)}`, department: "Front desk", jobTitle: "Officer", role: "front_desk", phone: "+234 800 111 2222" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    const { temporaryPassword } = created.json<{ staff: { temporaryPassword: string } }>().staff;
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const session = await login(app, email, temporaryPassword);
    expect(session.body).toMatchObject({ user: { mustChangePassword: true, role: "front_desk" } });
    expect((await app.inject({ url: `${M}/rooms`, headers: bearer(session.accessToken) })).json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });

    expect((await app.inject({ method: "POST", url: `${M}/staff`, headers: manager.headers, payload: { fullName: "X", email: `x-${randomUUID()}@h.test`, employeeNumber: "X1", department: "Finance", jobTitle: "Accountant", role: "finance" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${M}/staff`, headers: owner.headers, payload: { fullName: "X", email, employeeNumber: `E-${randomUUID().slice(0, 6)}`, department: "Ops", jobTitle: "Ops", role: "housekeeping" } })).statusCode).toBe(409);
  });

  it("hides personal contact fields from roles that cannot manage staff", async () => {
    const restaurantManager = await signedIn(app, propertyId, "restaurant_manager");
    const asManager = (await app.inject({ url: `${M}/staff?limit=200`, headers: manager.headers })).json<{ staff: Array<{ phone: string | null }> }>().staff;
    const asRestaurant = (await app.inject({ url: `${M}/staff?limit=200`, headers: restaurantManager.headers })).json<{ staff: Array<{ phone: string | null }> }>().staff;
    expect(asManager.some((member) => member.phone !== null)).toBe(true);
    expect(asRestaurant.every((member) => member.phone === null)).toBe(true);
  });

  it("deactivation and password resets revoke sessions immediately; managers cannot touch owner-managed accounts", async () => {
    const worker = await signedIn(app, propertyId, "housekeeping", { staffProfile: true });
    const profile = (await app.db.query("SELECT id FROM staff_profiles WHERE user_id = $1", [worker.user.id]))[0].id as string;
    const setStatus = (headers: Record<string, string>, id: string, employmentStatus: string) => app.inject({ method: "PATCH", url: `${M}/staff/${id}`, headers, payload: { employmentStatus } });

    expect((await setStatus(manager.headers, profile, "on_leave")).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/auth/session", headers: worker.headers })).json()).toMatchObject({ code: "SESSION_REVOKED" });
    expect((await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: worker.user.email, password: "correct horse battery staple" } })).statusCode).toBe(401);
    expect((await setStatus(manager.headers, profile, "active")).statusCode).toBe(200);
    const again = await login(app, worker.user.email);

    const reset = await app.inject({ method: "POST", url: `${M}/staff/${profile}/temporary-password`, headers: manager.headers });
    const { temporaryPassword } = reset.json<{ temporaryPassword: string }>();
    expect((await app.inject({ url: "/api/v1/auth/session", headers: bearer(again.accessToken) })).json()).toMatchObject({ code: "SESSION_REVOKED" });
    expect((await login(app, worker.user.email, temporaryPassword)).body).toMatchObject({ user: { mustChangePassword: true } });

    const financeMember = await signedIn(app, propertyId, "finance", { staffProfile: true });
    const financeProfile = (await app.db.query("SELECT id FROM staff_profiles WHERE user_id = $1", [financeMember.user.id]))[0].id as string;
    expect((await setStatus(manager.headers, financeProfile, "terminated")).statusCode).toBe(403);
    const self = await signedIn(app, propertyId, "manager", { staffProfile: true });
    const selfProfile = (await app.db.query("SELECT id FROM staff_profiles WHERE user_id = $1", [self.user.id]))[0].id as string;
    expect((await setStatus(self.headers, selfProfile, "terminated")).json()).toMatchObject({ statusCode: 409, code: "SELF_CHANGE_FORBIDDEN" });
    expect((await setStatus(owner.headers, selfProfile, "on_leave")).statusCode).toBe(200);
    expect((await setStatus(self.headers, selfProfile, "active")).json()).toMatchObject({ statusCode: 401, code: "SESSION_REVOKED" });
  });

  it("records attendance with no duplicate clock-ins and reports team state", async () => {
    const cashier = await signedIn(app, propertyId, "restaurant_cashier", { staffProfile: true });
    const clock = (eventType: string) => app.inject({ method: "POST", url: `${M}/attendance`, headers: cashier.headers, payload: { eventType } });
    expect((await clock("clock_out")).json()).toMatchObject({ code: "NOT_CLOCKED_IN" });
    const results = await Promise.all([clock("clock_in"), clock("clock_in")]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
    expect((await app.inject({ url: `${M}/attendance/self`, headers: cashier.headers })).json()).toEqual({ clockedIn: true });
    const team = await app.inject({ url: `${M}/attendance?limit=200`, headers: manager.headers });
    expect(team.json<{ attendance: Array<{ full_name: string; last_event: string }> }>().attendance.some((row) => row.last_event === "clock_in")).toBe(true);
    expect((await app.inject({ url: `${M}/attendance`, headers: cashier.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${M}/attendance`, headers: owner.headers, payload: { eventType: "clock_in" } })).json()).toMatchObject({ code: "NO_STAFF_PROFILE" });
  });
});
