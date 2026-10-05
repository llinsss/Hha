import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/app.js";
import { PASSWORD, WEB_ORIGIN, bearer, createTestApp, integration, login, seedProperty, seedUser } from "../helpers.js";

const AUTH = "/api/v1/auth";

describe.skipIf(!integration)("authentication", () => {
  let app: App;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp({}, (instance) => {
      // Test-only routes exercising the authorisation decorators.
      instance.register(
        async (api) => {
          api.get("/payments-confirm", { preHandler: api.authorize("payments:confirm") }, async () => ({ ok: true }));
          api.get("/rooms-read", { preHandler: api.authorize("rooms:read") }, async () => ({ ok: true }));
        },
        { prefix: "/api/v1/__test" },
      );
    });
    propertyId = await seedProperty(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  const refresh = (cookie: string, origin: string | undefined = WEB_ORIGIN) =>
    app.inject({ method: "POST", url: `${AUTH}/refresh`, cookies: { hh_refresh: cookie }, headers: origin ? { origin } : {} });

  it("signs in, returns a short-lived token and a scoped HttpOnly refresh cookie", async () => {
    const user = await seedUser(app, propertyId);
    const response = await app.inject({ method: "POST", url: `${AUTH}/login`, payload: { email: user.email.toUpperCase(), password: PASSWORD } });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; expiresIn: number; user: Record<string, unknown> }>();
    expect(body.expiresIn).toBe(900);
    expect(body.user).toEqual({ id: user.id, email: user.email, fullName: "Test User", role: "owner", propertyId, mustChangePassword: false });
    expect(body.user).not.toHaveProperty("passwordHash");
    const claims = JSON.parse(Buffer.from(body.accessToken.split(".")[1]!, "base64url").toString()) as Record<string, number | string>;
    expect(Number(claims.exp) - Number(claims.iat)).toBe(900);
    expect(claims).toMatchObject({ sub: user.id, iss: "houzzhills-api", aud: "houzzhills-web" });
    const cookie = response.cookies.find((item) => item.name === "hh_refresh");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/api/v1/auth" });
    expect(response.headers["cache-control"]).toBe("no-store");

    const audit: unknown[] = await app.db.query("SELECT 1 FROM audit_events WHERE actor_id = $1 AND action = 'auth.login'", [user.id]);
    expect(audit).toHaveLength(1);
  });

  it("rejects bad credentials, unknown and inactive accounts identically", async () => {
    const user = await seedUser(app, propertyId);
    const inactive = await seedUser(app, propertyId, { active: false });
    for (const payload of [
      { email: user.email, password: "wrong password" },
      { email: "nobody@houzzhills.test", password: PASSWORD },
      { email: inactive.email, password: PASSWORD },
    ]) {
      const response = await app.inject({ method: "POST", url: `${AUTH}/login`, payload });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" });
    }
  });

  it("locks an email+IP pair after repeated failures", async () => {
    const locked = await createTestApp({ LOGIN_MAX_FAILURES: "3" });
    try {
      const user = await seedUser(locked, propertyId);
      for (let i = 0; i < 3; i += 1) {
        expect((await locked.inject({ method: "POST", url: `${AUTH}/login`, payload: { email: user.email, password: "nope" } })).statusCode).toBe(401);
      }
      const blocked = await locked.inject({ method: "POST", url: `${AUTH}/login`, payload: { email: user.email, password: PASSWORD } });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ code: "LOGIN_LOCKED" });
    } finally {
      await locked.close();
    }
  });

  it("requires a valid bearer token", async () => {
    expect((await app.inject(`${AUTH}/session`)).json()).toEqual({ user: null });
    expect((await app.inject({ url: `${AUTH}/session`, headers: { authorization: "Basic abc" } })).json()).toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer("not.a.jwt") })).json()).toMatchObject({ code: "TOKEN_INVALID" });

    const user = await seedUser(app, propertyId);
    const { accessToken } = await login(app, user.email);
    const tampered = `${accessToken.slice(0, -2)}${accessToken.endsWith("A") ? "B" : "A"}`;
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(tampered) })).json()).toMatchObject({ code: "TOKEN_INVALID" });

    const foreign = app.jwt.sign({ sub: user.id, sid: "00000000-0000-4000-8000-000000000000" });
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(foreign) })).json()).toMatchObject({ code: "SESSION_REVOKED" });

    const session = await app.inject({ url: `${AUTH}/session`, headers: bearer(accessToken) });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ user: { id: user.id } });
  });

  it("reports expired access tokens distinctly", async () => {
    const user = await seedUser(app, propertyId);
    const { body } = await login(app, user.email);
    const claims = JSON.parse(Buffer.from(String(body.accessToken).split(".")[1]!, "base64url").toString()) as { sid: string };
    const expired = app.jwt.sign({ sub: user.id, sid: claims.sid }, { expiresIn: "1s" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(expired) })).json()).toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("enforces role permissions", async () => {
    const finance = await seedUser(app, propertyId, { role: "finance" });
    const manager = await seedUser(app, propertyId, { role: "manager" });
    const financeToken = (await login(app, finance.email)).accessToken;
    const managerToken = (await login(app, manager.email)).accessToken;
    expect((await app.inject({ url: "/api/v1/__test/payments-confirm", headers: bearer(financeToken) })).json()).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect((await app.inject({ url: "/api/v1/__test/payments-confirm", headers: bearer(managerToken) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/__test/rooms-read", headers: bearer(financeToken) })).statusCode).toBe(403);
  });

  it("rotates refresh tokens, tolerates a parallel refresh and revokes on reuse", async () => {
    const user = await seedUser(app, propertyId);
    const first = await login(app, user.email);

    const rotated = await refresh(first.refreshCookie);
    expect(rotated.statusCode).toBe(200);
    const second = rotated.cookies.find((item) => item.name === "hh_refresh")!.value;
    expect(second).not.toBe(first.refreshCookie);
    const newAccess = rotated.json<{ accessToken: string }>().accessToken;

    // A second tab racing with the same (now previous) token inside the grace window.
    const raced = await refresh(first.refreshCookie);
    expect(raced.statusCode).toBe(200);
    expect(raced.cookies.find((item) => item.name === "hh_refresh")).toBeUndefined();

    // Outside the grace window the previous token is treated as stolen.
    const sessionId = second.split(".")[0];
    await app.db.query("UPDATE api_sessions SET rotated_at = now() - interval '1 hour' WHERE id = $1", [sessionId]);
    const reused = await refresh(first.refreshCookie);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({ code: "REFRESH_REUSED" });

    // The whole session is dead, including the legitimate latest token and live access tokens.
    expect((await refresh(second)).json()).toMatchObject({ code: "REFRESH_INVALID" });
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(newAccess) })).json()).toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("protects cookie endpoints against cross-site requests", async () => {
    const user = await seedUser(app, propertyId);
    const { refreshCookie } = await login(app, user.email);
    expect((await refresh(refreshCookie, "https://evil.example")).json()).toMatchObject({ statusCode: 403, code: "ORIGIN_NOT_ALLOWED" });
    const crossSite = await app.inject({ method: "POST", url: `${AUTH}/refresh`, cookies: { hh_refresh: refreshCookie }, headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.statusCode).toBe(403);
    // Non-browser client (no Origin, no Sec-Fetch-Site) is allowed.
    expect((await refresh(refreshCookie, undefined)).statusCode).toBe(200);
  });

  it("logs out by revoking the session immediately", async () => {
    const user = await seedUser(app, propertyId);
    const { accessToken, refreshCookie } = await login(app, user.email);
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(accessToken) })).statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: `${AUTH}/logout`, cookies: { hh_refresh: refreshCookie }, headers: { origin: WEB_ORIGIN } });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies.find((item) => item.name === "hh_refresh")?.value).toBe("");
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(accessToken) })).json()).toMatchObject({ code: "SESSION_REVOKED" });
    expect((await refresh(refreshCookie)).statusCode).toBe(401);
    // Idempotent.
    expect((await app.inject({ method: "POST", url: `${AUTH}/logout`, headers: { origin: WEB_ORIGIN } })).statusCode).toBe(204);
  });

  it("gates temporary passwords and revokes other sessions on change", async () => {
    const user = await seedUser(app, propertyId, { mustChangePassword: true, role: "front_desk" });
    const other = await login(app, user.email);
    const current = await login(app, user.email);

    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(current.accessToken) })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/__test/rooms-read", headers: bearer(current.accessToken) })).json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });

    const change = (payload: Record<string, string>) => app.inject({ method: "POST", url: `${AUTH}/password`, headers: bearer(current.accessToken), payload });
    expect((await change({ currentPassword: "wrong password!", newPassword: "a brand new password" })).json()).toMatchObject({ code: "INVALID_CURRENT_PASSWORD" });
    expect((await change({ currentPassword: PASSWORD, newPassword: "short" })).statusCode).toBe(422);
    expect((await change({ currentPassword: PASSWORD, newPassword: PASSWORD })).json()).toMatchObject({ code: "PASSWORD_REUSED" });
    expect((await change({ currentPassword: PASSWORD, newPassword: "a brand new password" })).statusCode).toBe(204);

    expect((await app.inject({ url: "/api/v1/__test/rooms-read", headers: bearer(current.accessToken) })).statusCode).toBe(200);
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(other.accessToken) })).json()).toMatchObject({ code: "SESSION_REVOKED" });
    expect((await app.inject({ method: "POST", url: `${AUTH}/login`, payload: { email: user.email, password: PASSWORD } })).statusCode).toBe(401);
    await login(app, user.email, "a brand new password");
  });

  it("revokes every session when an account is deactivated", async () => {
    const user = await seedUser(app, propertyId);
    const { accessToken } = await login(app, user.email);
    await app.db.transaction(async (manager) => {
      await manager.query("UPDATE users SET active = false WHERE id = $1", [user.id]);
      await app.sessions.revokeAllForUser(manager, user.id, "deactivated");
    });
    expect((await app.inject({ url: `${AUTH}/session`, headers: bearer(accessToken) })).json()).toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("keeps authenticating from the database when Redis is unavailable", async () => {
    const user = await seedUser(app, propertyId);
    const { accessToken } = await login(app, user.email);
    const get = vi.spyOn(app.redis, "get").mockRejectedValue(new Error("redis down"));
    const set = vi.spyOn(app.redis, "set").mockRejectedValue(new Error("redis down"));
    try {
      const response = await app.inject({ url: `${AUTH}/session`, headers: bearer(accessToken) });
      expect(response.statusCode).toBe(200);
    } finally {
      expect(get).toHaveBeenCalled();
      get.mockRestore();
      set.mockRestore();
    }
  });
});
