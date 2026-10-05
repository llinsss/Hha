import { randomBytes } from "node:crypto";

/**
 * One place for the end-to-end stack's addresses and secrets. Postgres and
 * Redis are the developer's local instances; the test database is created
 * fresh for the run and dropped afterwards, and Redis keys use a dedicated
 * prefix that teardown deletes.
 *
 *   E2E_PG_ADMIN_URL  connection to an existing database used to create/drop the test one
 *   E2E_REDIS_URL     local Redis
 */
export const PG_ADMIN_URL = process.env.E2E_PG_ADMIN_URL ?? "postgresql://houzzhills:houzzhills@127.0.0.1:5432/postgres";
export const REDIS_URL = process.env.E2E_REDIS_URL ?? "redis://127.0.0.1:6379/0";
export const DATABASE_NAME = "houzzhills_e2e";
export const REDIS_PREFIX = "hh-e2e:";

export const WEB_PORT = 3310;
export const API_PORT = 4310;
export const PAYSTACK_PORT = 4399;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const PAYSTACK_URL = `http://127.0.0.1:${PAYSTACK_PORT}`;

export const SETUP_SECRET = "e2e-setup-secret-0123456789abcdefghijklmn";
export const PAYSTACK_KEY = "sk_test_a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
export const OWNER = { name: "Amina Bello", email: "owner@houzzhills.e2e", password: "owner password 2026" };

export function databaseUrl(): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${DATABASE_NAME}`;
  return url.href;
}

/** Environment for the API process (and its migration step). */
export function apiEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "development",
    LOG_LEVEL: "warn",
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    DATABASE_URL: databaseUrl(),
    REDIS_URL,
    REDIS_KEY_PREFIX: REDIS_PREFIX,
    JWT_ACCESS_SECRET: randomBytes(48).toString("base64"),
    SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SETUP_SECRET,
    CORS_ORIGINS: WEB_URL,
    PUBLIC_WEB_URL: WEB_URL,
    COOKIE_SECURE: "false",
    TRUST_PROXY_HOPS: "1",
    PAYSTACK_BASE_URL: PAYSTACK_URL,
    // A browser run signs in many times from one address.
    AUTH_RATE_LIMIT_MAX: "1000",
    RATE_LIMIT_MAX: "100000",
    PUBLIC_BOOKING_RATE_LIMIT_MAX: "1000",
  };
}
