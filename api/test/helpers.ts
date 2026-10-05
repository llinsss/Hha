import { randomUUID } from "node:crypto";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashPassword } from "../src/lib/password.js";
import type { Role } from "../src/lib/permissions.js";

export const integration = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
export const WEB_ORIGIN = "https://app.houzzhills.test";
export const PASSWORD = "correct horse battery staple";
export const CRON_SECRET = "cron-secret-for-integration-tests-0123456789";
export const SETUP_SECRET = "setup-secret-for-integration-tests-0123456789";
export const METRICS_TOKEN = "metrics-token-for-integration-tests-012345678";

/** Environment for an app wired to the fake Paystack server. */
export function paystackEnv(baseUrl: string): Record<string, string> {
  return {
    PAYMENT_PROVIDER: "paystack",
    PAYSTACK_SECRET_KEY: "sk_test_fake_paystack_secret_for_tests",
    PAYSTACK_BASE_URL: baseUrl,
    PUBLIC_WEB_URL: "https://app.houzzhills.test",
    PROVIDER_TIMEOUT_MS: "3000",
  };
}

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
    PUBLIC_BOOKING_RATE_LIMIT_MAX: "10000",
    CRON_SECRET: CRON_SECRET,
    SETUP_SECRET: SETUP_SECRET,
    METRICS_TOKEN: METRICS_TOKEN,
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

/** The property public endpoints serve (created first by global setup). */
export async function primaryPropertyId(app: App): Promise<string> {
  const rows: Array<{ id: string }> = await app.db.query("SELECT id FROM properties ORDER BY created_at, id LIMIT 1");
  return rows[0]!.id;
}

export async function seedRoom(
  app: App,
  propertyId: string,
  options: { roomType?: string; rateKobo?: number; capacity?: number; status?: string; roomNumber?: string } = {},
): Promise<{ id: string; roomType: string; roomNumber: string }> {
  const roomType = options.roomType ?? `Suite ${randomUUID().slice(0, 8)}`;
  const roomNumber = options.roomNumber ?? randomUUID().slice(0, 8);
  const rows: Array<{ id: string }> = await app.db.query(
    "INSERT INTO rooms(property_id, room_number, room_type, nightly_rate_kobo, capacity, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [propertyId, roomNumber, roomType, options.rateKobo ?? 5_000_000, options.capacity ?? 2, options.status ?? "vacant_clean"],
  );
  return { id: rows[0]!.id, roomType, roomNumber };
}

/** Seeds a user with the role and returns a ready access token. */
export async function signedIn(app: App, propertyId: string, role: Role, options: { staffProfile?: boolean } = {}) {
  const user = await seedUser(app, propertyId, { role });
  if (options.staffProfile) {
    await app.db.query(
      "INSERT INTO staff_profiles(property_id, user_id, employee_number, department, job_title) VALUES ($1, $2, $3, 'Ops', 'Staff')",
      [propertyId, user.id, `E-${randomUUID().slice(0, 8)}`],
    );
  }
  const { accessToken } = await login(app, user.email);
  return { user, token: accessToken, headers: bearer(accessToken) };
}

/** YYYY-MM-DD in Africa/Lagos, offset by whole days. */
export function lagosDate(days = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}
