import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/app.js";
import { bearer, createTestApp, integration, login, seedProperty, seedUser } from "../helpers.js";

describe.skipIf(!integration)("Idempotency-Key", () => {
  let app: App;
  let token: string;
  let executions = 0;

  beforeAll(async () => {
    app = await createTestApp({}, (root) => {
      // Decorators exist once plugins load, so test routes are registered as a plugin.
      root.register(async (instance) => {
        instance.post(
          "/api/v1/__test/charges",
          { preHandler: [instance.authorize("pos:write"), instance.idempotent()] },
          async (request, reply) => {
            executions += 1;
            const body = request.body as { amountKobo: number; fail?: boolean; delayMs?: number };
            if (body.delayMs) await new Promise((resolve) => setTimeout(resolve, body.delayMs));
            if (body.fail) throw new Error("simulated failure");
            return reply.status(201).send({ chargeId: randomUUID(), amountKobo: body.amountKobo });
          },
        );
      });
    });
    const propertyId = await seedProperty(app);
    const user = await seedUser(app, propertyId, { role: "restaurant_cashier" });
    token = (await login(app, user.email)).accessToken;
  });
  afterAll(async () => {
    await app?.close();
  });

  const charge = (key: string | undefined, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/__test/charges", headers: { ...bearer(token), ...(key ? { "idempotency-key": key } : {}) }, payload });

  it("replays the original response for a retried request", async () => {
    const key = randomUUID();
    const before = executions;
    const first = await charge(key, { amountKobo: 5000 });
    expect(first.statusCode).toBe(201);
    const retry = await charge(key, { amountKobo: 5000 });
    expect(retry.statusCode).toBe(201);
    expect(retry.body).toBe(first.body);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(executions - before).toBe(1);
  });

  it("rejects reuse of a key with a different payload", async () => {
    const key = randomUUID();
    await charge(key, { amountKobo: 5000 });
    const reused = await charge(key, { amountKobo: 9999 });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("requires a well-formed key", async () => {
    expect((await charge(undefined, { amountKobo: 1 })).json()).toMatchObject({ statusCode: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect((await charge("short", { amountKobo: 1 })).json()).toMatchObject({ statusCode: 400, code: "IDEMPOTENCY_KEY_INVALID" });
  });

  it("does not store server errors, so the client can retry", async () => {
    const key = randomUUID();
    const before = executions;
    expect((await charge(key, { amountKobo: 1, fail: true })).statusCode).toBe(500);
    expect((await charge(key, { amountKobo: 1, fail: true })).statusCode).toBe(500);
    expect(executions - before).toBe(2);
  });

  it("rejects a concurrent duplicate while the first is in flight", async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([charge(key, { amountKobo: 7, delayMs: 300 }), charge(key, { amountKobo: 7, delayMs: 300 })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect([a, b].find((response) => response.statusCode === 409)!.json()).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });
  });

  it("scopes keys per user", async () => {
    const key = randomUUID();
    const propertyId = await seedProperty(app);
    const otherUser = await seedUser(app, propertyId, { role: "restaurant_cashier" });
    const otherToken = (await login(app, otherUser.email)).accessToken;
    const mine = await charge(key, { amountKobo: 1 });
    const theirs = await app.inject({ method: "POST", url: "/api/v1/__test/charges", headers: { ...bearer(otherToken), "idempotency-key": key }, payload: { amountKobo: 1 } });
    expect(theirs.statusCode).toBe(201);
    expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
    expect(theirs.body).not.toBe(mine.body);
  });

  it("fails closed when the idempotency store is down", async () => {
    const set = vi.spyOn(app.redis, "set").mockRejectedValue(new Error("redis down"));
    try {
      const response = await charge(randomUUID(), { amountKobo: 1 });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "IDEMPOTENCY_UNAVAILABLE" });
    } finally {
      set.mockRestore();
    }
  });
});
