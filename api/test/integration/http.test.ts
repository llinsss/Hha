import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/app.js";
import { WEB_ORIGIN, createTestApp, integration } from "../helpers.js";

describe.skipIf(!integration)("HTTP foundation", () => {
  let app: App;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("serves liveness and readiness", async () => {
    expect((await app.inject("/health/live")).json()).toEqual({ status: "ok" });
    const ready = await app.inject("/health/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
  });

  it("reports readiness failure without leaking details", async () => {
    const ping = vi.spyOn(app.redis, "ping").mockRejectedValue(new Error("boom"));
    try {
      const ready = await app.inject("/health/ready");
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({ status: "unavailable", checks: { database: "up", redis: "down" } });
    } finally {
      ping.mockRestore();
    }
  });

  it("returns the standard envelope for unknown routes", async () => {
    const response = await app.inject("/api/v1/does-not-exist?x=1");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ statusCode: 404, error: "Not Found", code: "ROUTE_NOT_FOUND", message: "Route GET /api/v1/does-not-exist not found" });
    expect(response.json<{ requestId: string }>().requestId).toBe(response.headers["x-request-id"]);
  });

  it("propagates well-formed request ids and replaces malformed ones", async () => {
    expect((await app.inject({ url: "/health/live", headers: { "x-request-id": "trace-12345678" } })).headers["x-request-id"]).toBe("trace-12345678");
    const replaced = (await app.inject({ url: "/health/live", headers: { "x-request-id": "bad id\n" } })).headers["x-request-id"];
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends security headers", async () => {
    const { headers } = await app.inject("/health/live");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  it("allows credentialed CORS only for allowlisted origins", async () => {
    const preflight = (origin: string) =>
      app.inject({ method: "OPTIONS", url: "/api/v1/auth/login", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    const allowed = await preflight(WEB_ORIGIN);
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const denied = await preflight("https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("maps schema violations to 422 with field details", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "not-an-email", password: "x" } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED", details: [{ path: "body/email" }] });
  });

  it("rejects malformed JSON and oversized bodies", async () => {
    const malformed = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: "{" });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ statusCode: 400, requestId: expect.any(String) });
    const huge = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a@b.co", password: "x".repeat(2_000_000) } });
    expect(huge.statusCode).toBe(413);
  });

  it("publishes the OpenAPI document", async () => {
    const response = await app.inject("/openapi.json");
    expect(response.statusCode).toBe(200);
    const document = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/api/v1/auth/login", "/health/ready"]));
  });
});

describe.skipIf(!integration)("rate limiting", () => {
  let app: App;
  beforeAll(async () => {
    app = await createTestApp({ RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000" });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("limits per client and exempts health probes", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) codes.push((await app.inject("/api/v1/nothing-here")).statusCode);
    expect(codes).toEqual([404, 404, 404, 429]);
    const limited = await app.inject("/api/v1/nothing-here");
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await app.inject("/health/live")).statusCode).toBe(200);
  });
});
