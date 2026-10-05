import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, lagosDate, login, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";

describe.skipIf(!integration)("server-driven UI contract", () => {
  let app: App;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("returns each user's permissions at sign-in and in the session", async () => {
    const finance = await signedIn(app, propertyId, "finance");
    const session = (await app.inject({ url: "/api/v1/auth/session", headers: finance.headers })).json<{ user: { permissions: string[] } }>();
    expect(session.user.permissions).toEqual(["dashboard:read", "pos:read", "payments:read", "reports:read"]);
    const owner = await signedIn(app, propertyId, "owner");
    const ownerLogin = await login(app, owner.user.email);
    expect((ownerLogin.body.user as { permissions: string[] }).permissions).toContain("settings:manage");
  });

  it("serves the public property", async () => {
    const property = (await app.inject("/api/v1/public/property")).json<{ name: string; timezone: string; currency: string }>();
    expect(property).toMatchObject({ timezone: "Africa/Lagos", currency: "NGN" });
    expect(property.name.length).toBeGreaterThan(0);
  });

  it("serves form vocabularies and only the roles the caller may assign", async () => {
    const owner = await signedIn(app, propertyId, "owner");
    const manager = await signedIn(app, propertyId, "manager");
    const desk = await signedIn(app, propertyId, "front_desk");
    const values = async (headers: Record<string, string>) =>
      (await app.inject({ url: `${M}/reference`, headers })).json<{ assignableRoles: Array<{ value: string }>; staffPaymentMethods: Array<{ value: string; label: string }> }>();
    expect((await values(owner.headers)).assignableRoles.map((role) => role.value)).toContain("finance");
    expect((await values(manager.headers)).assignableRoles.map((role) => role.value)).not.toContain("finance");
    const forDesk = await values(desk.headers);
    expect(forDesk.assignableRoles).toEqual([]);
    expect(forDesk.staffPaymentMethods.map((method) => method.value)).toEqual(["cash", "pos", "bank_transfer"]);
    expect((await app.inject(`${M}/reference`)).statusCode).toBe(401);
  });

  it("tells each caller which room states and stay actions are allowed", async () => {
    const desk = await signedIn(app, propertyId, "front_desk");
    const housekeeping = await signedIn(app, propertyId, "housekeeping");
    const auditor = await signedIn(app, propertyId, "auditor");
    const room = await seedRoom(app, propertyId, { status: "vacant_dirty" });
    const roomFor = async (headers: Record<string, string>) =>
      (await app.inject({ url: `${M}/rooms?limit=200`, headers })).json<{ rooms: Array<{ id: string; next_statuses: string[] }> }>().rooms.find((entry) => entry.id === room.id)!;
    expect((await roomFor(desk.headers)).next_statuses).toEqual(["vacant_clean", "inspected", "maintenance", "out_of_order"]);
    expect((await roomFor(housekeeping.headers)).next_statuses).toEqual(["vacant_clean", "inspected"]);
    expect((await roomFor(auditor.headers)).next_statuses).toEqual([]);

    const future = await app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Later", roomId: room.id, checkIn: lagosDate(5), checkOut: lagosDate(6), guests: 1 } });
    expect(future.json()).toMatchObject({ reservation: { actions: { next_statuses: ["cancelled"], record_payment: true } } });
    const today = await app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Today", roomId: room.id, checkIn: lagosDate(0), checkOut: lagosDate(1), guests: 1 } });
    expect(today.json()).toMatchObject({ reservation: { actions: { next_statuses: ["checked_in", "cancelled", "no_show"] } } });
    const asAuditor = await app.inject({ url: `${M}/reservations?limit=200`, headers: auditor.headers });
    expect(asAuditor.json<{ reservations: Array<{ actions: { next_statuses: string[]; record_payment: boolean } }> }>().reservations.every((row) => row.actions.next_statuses.length === 0 && !row.actions.record_payment)).toBe(true);
  });

  it("marks which staff the caller may manage", async () => {
    const manager = await signedIn(app, propertyId, "manager", { staffProfile: true });
    await signedIn(app, propertyId, "finance", { staffProfile: true });
    await signedIn(app, propertyId, "housekeeping", { staffProfile: true });
    const rows = (await app.inject({ url: `${M}/staff?limit=200`, headers: manager.headers })).json<{ staff: Array<{ role: string; user_id: string; can_manage: boolean }> }>().staff;
    expect(rows.find((row) => row.role === "finance")?.can_manage).toBe(false);
    expect(rows.find((row) => row.role === "housekeeping")?.can_manage).toBe(true);
    expect(rows.find((row) => row.user_id === manager.user.id)?.can_manage).toBe(false);
  });
});
