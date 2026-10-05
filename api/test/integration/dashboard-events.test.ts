import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { App } from "../../src/app.js";
import { METRICS_TOKEN, SETUP_SECRET, createTestApp, integration, lagosDate, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";

type StreamEvent = { event: string; id?: string; data: string };

/** Minimal SSE reader over fetch, as a browser client using a bearer token would do. */
async function openStream(url: string, token: string, lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, ...(lastEventId ? { "last-event-id": lastEventId } : {}) }, signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: StreamEvent[] = [];
  let buffer = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith(":")) continue;
          const fields = Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]));
          events.push({ event: fields.event ?? "message", id: fields.id, data: fields.data ?? "" });
        }
      }
    } catch {
      // aborted
    }
  })();
  const waitFor = async (predicate: (event: StreamEvent) => boolean, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  };
  return { response, events, waitFor, close: async () => { controller.abort(); await pump; } };
}

describe.skipIf(!integration)("dashboard, live events and metrics", () => {
  let app: App;
  let base: string;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    propertyId = await seedProperty(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("filters dashboard metrics, reservations and activity by role", async () => {
    const [owner, desk, finance] = await Promise.all([signedIn(app, propertyId, "owner"), signedIn(app, propertyId, "front_desk"), signedIn(app, propertyId, "finance")]);
    const room = await seedRoom(app, propertyId);
    await app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Arriving Today", roomId: room.id, checkIn: lagosDate(0), checkOut: lagosDate(1), guests: 1 } });

    const asOwner = (await app.inject({ url: `${M}/dashboard`, headers: owner.headers })).json<{ metrics: Record<string, unknown>; reservations: unknown[]; activity: Array<{ event_type: string }> }>();
    expect(asOwner.metrics).toMatchObject({ arrivals: 1, room_revenue_kobo: "0", open_payment_exceptions: 0 });
    expect(asOwner.reservations).toHaveLength(1);
    expect(asOwner.activity[0]?.event_type).toBe("reservation.created");

    const asDesk = (await app.inject({ url: `${M}/dashboard`, headers: desk.headers })).json<{ metrics: Record<string, unknown> }>();
    expect(asDesk.metrics).not.toHaveProperty("room_revenue_kobo");
    expect(asDesk.metrics).not.toHaveProperty("open_payment_exceptions");

    const asFinance = (await app.inject({ url: `${M}/dashboard`, headers: finance.headers })).json<{ metrics: Record<string, unknown>; reservations: unknown[]; activity: Array<{ event_type: string }> }>();
    expect(asFinance.metrics).toHaveProperty("room_revenue_kobo");
    expect(asFinance.reservations).toEqual([]);
    expect(asFinance.activity.some((event) => event.event_type.startsWith("reservation."))).toBe(false);

    const housekeeping = await signedIn(app, propertyId, "housekeeping");
    expect((await app.inject({ url: `${M}/dashboard`, headers: housekeeping.headers })).statusCode).toBe(403);
  });

  it("streams committed events to permitted roles only and replays from Last-Event-ID", async () => {
    const [desk, housekeeping] = await Promise.all([signedIn(app, propertyId, "front_desk"), signedIn(app, propertyId, "housekeeping")]);
    const deskStream = await openStream(`${base}${M}/events`, desk.token);
    const housekeepingStream = await openStream(`${base}${M}/events`, housekeeping.token);
    try {
      expect(deskStream.response.headers.get("content-type")).toContain("text/event-stream");
      expect(deskStream.response.headers.get("x-request-id")).toBeTruthy();
      expect(await deskStream.waitFor((event) => event.event === "ready")).toBeDefined();
      expect(await housekeepingStream.waitFor((event) => event.event === "ready")).toBeDefined();

      const room = await seedRoom(app, propertyId);
      await app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Live", roomId: room.id, checkIn: lagosDate(70), checkOut: lagosDate(71), guests: 1 } });
      const update = await deskStream.waitFor((event) => event.event === "property-update");
      expect(update).toBeDefined();
      const payload = JSON.parse(update!.data) as Record<string, unknown>;
      expect(payload).toMatchObject({ type: "reservation.created" });
      expect(Object.keys(payload).sort()).toEqual(["at", "entityId", "reference", "type"]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(housekeepingStream.events.some((event) => event.event === "property-update")).toBe(false);

      const replay = await openStream(`${base}${M}/events`, desk.token, String(BigInt(update!.id!) - 1n));
      try {
        expect((await replay.waitFor((event) => event.event === "property-update"))?.id).toBe(update!.id);
      } finally {
        await replay.close();
      }
    } finally {
      await deskStream.close();
      await housekeepingStream.close();
    }
    expect((await fetch(`${base}${M}/events`)).status).toBe(401);
  });

  it("protects /metrics with its bearer token", async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("houzzhills_http_request_duration_seconds");
    expect(text).toContain("houzzhills_stale_payment_holds");
  });
});

describe.skipIf(!integration)("one-time owner setup", () => {
  const setupDatabaseUrl = inject("setupDatabaseUrl");
  let app: App;

  beforeAll(async () => {
    app = await createTestApp({ DATABASE_URL: setupDatabaseUrl ?? "" });
  });
  afterAll(async () => {
    await app?.close();
  });

  const setup = (secret: string | undefined, email = "owner@houzzhills.test") =>
    app.inject({ method: "POST", url: "/api/v1/setup", headers: secret ? { "x-setup-secret": secret } : {}, payload: { fullName: "First Owner", email, password: "a very long owner password" } });

  it("creates the first property and owner exactly once", async () => {
    expect((await app.inject("/api/v1/setup")).json()).toEqual({ setupRequired: true, setupEnabled: true });
    expect((await setup(undefined)).json()).toMatchObject({ statusCode: 403, code: "SETUP_FORBIDDEN" });
    expect((await setup("wrong-secret-of-a-different-length")).statusCode).toBe(403);

    const [first, second] = await Promise.all([setup(SETUP_SECRET), setup(SETUP_SECRET, "other@houzzhills.test")]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect((await app.inject("/api/v1/setup")).json()).toEqual({ setupRequired: false, setupEnabled: true });
    const owners = await app.db.query("SELECT count(*)::int AS count FROM users WHERE role = 'owner'");
    expect(owners[0].count).toBe(1);
  });
});
