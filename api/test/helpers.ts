import { randomUUID } from "node:crypto";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashPassword } from "../src/lib/password.js";
import type { Role } from "../src/lib/permissions.js";

export const integration = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
export const WEB_ORIGIN = "https://app.houzzhills.test";
export const PASSWORD = "correct horse battery staple";

export function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://unused@localhost/unused",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379",
    // Unique prefix per app so rate limits, caches and locks never leak between test files.
    REDIS_KEY_PREFIX: `test:${randomUUID()}:`,
    JWT_ACCESS_SECRET: "test-secret-that-is-long-enough-for-hs256-signing",
    CORS_ORIGINS: WEB_ORIGIN,
    DOCS_ENABLED: "true",
    AUTH_RATE_LIMIT_MAX: "1000",
    RATE_LIMIT_MAX: "10000",
    ...overrides,
  });
}

/** Builds an app; `configure` may register extra test-only routes before it boots. */
export async function createTestApp(overrides: Record<string, string> = {}, configure?: (app: App) => void): Promise<App> {
  const app = buildApp(testConfig(overrides));
  configure?.(app);
  await app.ready();
  return app;
}

export type SeededUser = { id: string; email: string; propertyId: string; role: Role };

export async function seedProperty(app: App): Promise<string> {
  const rows: Array<{ id: string }> = await app.db.query("INSERT INTO properties(name) VALUES($1) RETURNING id", [`Test ${randomUUID()}`]);
  return rows[0]!.id;
}

export async function seedUser(
  app: App,
  propertyId: string,
  options: { role?: Role; active?: boolean; mustChangePassword?: boolean; password?: string } = {},
): Promise<SeededUser> {
  const email = `user-${randomUUID()}@houzzhills.test`;
  const role = options.role ?? "owner";
  const rows: Array<{ id: string }> = await app.db.query(
    `INSERT INTO users(property_id, email, full_name, password_hash, role, active, must_change_password)
     VALUES($1, $2, 'Test User', $3, $4, $5, $6) RETURNING id`,
    [propertyId, email, await hashPassword(options.password ?? PASSWORD), role, options.active ?? true, options.mustChangePassword ?? false],
  );
  return { id: rows[0]!.id, email, propertyId, role };
}

export type LoginResponse = { accessToken: string; refreshCookie: string; body: Record<string, unknown> };

export async function login(app: App, email: string, password = PASSWORD): Promise<LoginResponse> {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const cookie = response.cookies.find((item) => item.name === "hh_refresh");
  if (!cookie) throw new Error("login did not set the refresh cookie");
  const body = response.json<Record<string, unknown>>();
  return { accessToken: String(body.accessToken), refreshCookie: cookie.value, body };
}

export function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}
