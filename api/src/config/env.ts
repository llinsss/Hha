import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Environment contract. Every variable the process reads is declared here and
 * validated once at boot; the rest of the codebase consumes the typed `AppConfig`
 * and never touches `process.env` directly.
 */
const Bool = (defaultValue: boolean) => Type.Boolean({ default: defaultValue });
const Int = (defaultValue: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Type.Integer({ default: defaultValue, minimum, maximum });

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal("development"), Type.Literal("test"), Type.Literal("production")], { default: "development" }),
  HOST: Type.String({ default: "0.0.0.0", minLength: 1 }),
  PORT: Int(4000, 1, 65535),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal("fatal"),
      Type.Literal("error"),
      Type.Literal("warn"),
      Type.Literal("info"),
      Type.Literal("debug"),
      Type.Literal("trace"),
      Type.Literal("silent"),
    ],
    { default: "info" },
  ),
  /** Number of reverse-proxy hops to trust for X-Forwarded-* (0 = trust none). */
  TRUST_PROXY_HOPS: Int(0, 0, 10),
  API_PREFIX: Type.String({ default: "/api/v1", pattern: "^/[A-Za-z0-9/_-]*[A-Za-z0-9_-]$" }),
  /** Comma-separated list of exact browser origins allowed to call the API with credentials. */
  CORS_ORIGINS: Type.String({ default: "" }),
  BODY_LIMIT_BYTES: Int(1_048_576, 1024, 50 * 1_048_576),
  REQUEST_TIMEOUT_MS: Int(30_000, 1000, 300_000),
  KEEP_ALIVE_TIMEOUT_MS: Int(72_000, 1000, 600_000),
  SHUTDOWN_GRACE_MS: Int(10_000, 1000, 120_000),
  DOCS_ENABLED: Type.Optional(Type.Boolean()),

  DATABASE_URL: Type.String({ minLength: 1, pattern: "^postgres(ql)?://" }),
  DATABASE_SSL: Bool(false),
  DATABASE_SSL_REJECT_UNAUTHORIZED: Bool(true),
  DATABASE_POOL_MAX: Int(10, 1, 200),
  DATABASE_STATEMENT_TIMEOUT_MS: Int(15_000, 100, 600_000),
  DATABASE_LOGGING: Bool(false),

  REDIS_URL: Type.String({ minLength: 1, pattern: "^rediss?://" }),
  REDIS_KEY_PREFIX: Type.String({ default: "hh:", maxLength: 64 }),

  JWT_ACCESS_SECRET: Type.String({ minLength: 32 }),
  JWT_ISSUER: Type.String({ default: "houzzhills-api", minLength: 1 }),
  JWT_AUDIENCE: Type.String({ default: "houzzhills-web", minLength: 1 }),
  JWT_ACCESS_TTL_SECONDS: Int(900, 60, 3600),
  REFRESH_TOKEN_TTL_SECONDS: Int(604_800, 3600, 7_776_000),

  COOKIE_DOMAIN: Type.Optional(Type.String({ minLength: 1 })),
  COOKIE_SECURE: Bool(true),
  COOKIE_SAME_SITE: Type.Union([Type.Literal("strict"), Type.Literal("lax"), Type.Literal("none")], { default: "strict" }),

  RATE_LIMIT_MAX: Int(300, 1),
  RATE_LIMIT_WINDOW_MS: Int(60_000, 1000),
  AUTH_RATE_LIMIT_MAX: Int(10, 1),
  AUTH_RATE_LIMIT_WINDOW_MS: Int(60_000, 1000),
  LOGIN_MAX_FAILURES: Int(7, 1, 100),
  LOGIN_LOCKOUT_SECONDS: Int(900, 60, 86_400),
  /** Public booking attempts per client IP per minute. */
  PUBLIC_BOOKING_RATE_LIMIT_MAX: Int(10, 1),

  /** Web origin guests return to after hosted checkout (…/payment-result?reference=…). */
  PUBLIC_WEB_URL: Type.Optional(Type.String({ minLength: 1 })),
  PAYMENT_PROVIDER: Type.Union([Type.Literal("none"), Type.Literal("paystack"), Type.Literal("flutterwave")], { default: "none" }),
  PAYSTACK_SECRET_KEY: Type.Optional(Type.String({ minLength: 8 })),
  PAYSTACK_BASE_URL: Type.String({ default: "https://api.paystack.co", minLength: 1 }),
  FLUTTERWAVE_SECRET_KEY: Type.Optional(Type.String({ minLength: 8 })),
  FLUTTERWAVE_WEBHOOK_HASH: Type.Optional(Type.String({ minLength: 16 })),
  FLUTTERWAVE_BASE_URL: Type.String({ default: "https://api.flutterwave.com", minLength: 1 }),
  PROVIDER_TIMEOUT_MS: Int(12_000, 1000, 60_000),
  HOLD_MINUTES: Int(20, 5, 120),
  MAX_STAY_NIGHTS: Int(90, 1, 365),
  BOOKING_HORIZON_DAYS: Int(365, 1, 730),

  /** Bearer secret for the scheduler-only job endpoints (/jobs/*). Jobs are disabled when unset. */
  CRON_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  BANK_TRANSFER_REVIEW_HOURS: Int(48, 1, 720),
  RECONCILIATION_WINDOW_HOURS: Int(48, 1, 720),
  /** One-time owner bootstrap secret sent as x-setup-secret. Setup is closed when unset (except loopback in development). */
  SETUP_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  /** Bearer token for GET /metrics. The endpoint is not registered when unset. */
  METRICS_TOKEN: Type.Optional(Type.String({ minLength: 32 })),
});

type Env = Static<typeof EnvSchema>;

export type AppConfig = Readonly<{
  env: Env["NODE_ENV"];
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: Env["LOG_LEVEL"];
  trustProxyHops: number;
  apiPrefix: string;
  corsOrigins: readonly string[];
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  shutdownGraceMs: number;
  docsEnabled: boolean;
  database: Readonly<{
    url: string;
    ssl: boolean;
    sslRejectUnauthorized: boolean;
    poolMax: number;
    statementTimeoutMs: number;
    logging: boolean;
  }>;
  redis: Readonly<{ url: string; keyPrefix: string }>;
  jwt: Readonly<{ accessSecret: string; issuer: string; audience: string; accessTtlSeconds: number }>;
  session: Readonly<{ refreshTtlSeconds: number }>;
  cookie: Readonly<{ domain: string | undefined; secure: boolean; sameSite: "strict" | "lax" | "none" }>;
  rateLimit: Readonly<{
    max: number;
    windowMs: number;
    authMax: number;
    authWindowMs: number;
    loginMaxFailures: number;
    loginLockoutSeconds: number;
    publicBookingMax: number;
  }>;
  payments: Readonly<{
    provider: PaymentProviderConfig | null;
    publicWebUrl: string | null;
    timeoutMs: number;
  }>;
  booking: Readonly<{ holdMinutes: number; maxStayNights: number; horizonDays: number }>;
  jobs: Readonly<{ cronSecret: string | null; bankTransferReviewHours: number; reconciliationWindowHours: number }>;
  setupSecret: string | null;
  metricsToken: string | null;
}>;

export type PaymentProviderConfig =
  | Readonly<{ name: "paystack"; secretKey: string; baseUrl: string }>
  | Readonly<{ name: "flutterwave"; secretKey: string; webhookHash: string; baseUrl: string }>;

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

const PLACEHOLDER = /replace|change-?me|example|secret123|^x+$/i;

function parseBaseUrl(name: string, raw: string, isProduction: boolean, issues: string[]): string {
  let parsed: URL | undefined;
  try { parsed = new URL(raw); } catch { /* reported below */ }
  if (!parsed || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    issues.push(`${name} must be an absolute http(s) URL without credentials, query or fragment`);
    return raw;
  }
  if (isProduction && parsed.protocol !== "https:") issues.push(`${name} must use https in production`);
  return parsed.href.replace(/\/+$/, "");
}

function parseOrigins(raw: string, issues: string[]): string[] {
  const origins = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const origin of origins) {
    let parsed: URL | undefined;
    try { parsed = new URL(origin); } catch { /* reported below */ }
    if (!parsed || parsed.origin !== origin) issues.push(`CORS_ORIGINS entry "${origin}" must be an exact origin such as https://app.example.com`);
  }
  return origins;
}

/**
 * Validates and normalises environment variables. Empty strings are treated as
 * unset so that blank lines in `.env` files fall back to defaults.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.properties)) {
    const value = source[key]?.trim();
    if (value) raw[key] = value;
  }

  const candidate = Value.Clean(EnvSchema, Value.Convert(EnvSchema, Value.Default(EnvSchema, raw)));
  const issues = [...Value.Errors(EnvSchema, candidate)].map((error) => {
    const key = error.instancePath.replace(/^\//, "");
    return key ? `${key} ${error.message}` : error.message;
  });
  if (issues.length > 0) throw new ConfigError(issues);
  const env = candidate as Env;

  const isProduction = env.NODE_ENV === "production";
  const corsOrigins = parseOrigins(env.CORS_ORIGINS, issues);

  if (env.COOKIE_SAME_SITE === "none" && !env.COOKIE_SECURE) issues.push("COOKIE_SAME_SITE=none requires COOKIE_SECURE=true");

  let provider: PaymentProviderConfig | null = null;
  if (env.PAYMENT_PROVIDER === "paystack") {
    if (!env.PAYSTACK_SECRET_KEY) issues.push("PAYSTACK_SECRET_KEY is required when PAYMENT_PROVIDER=paystack");
    else provider = { name: "paystack", secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: parseBaseUrl("PAYSTACK_BASE_URL", env.PAYSTACK_BASE_URL, isProduction, issues) };
  } else if (env.PAYMENT_PROVIDER === "flutterwave") {
    if (!env.FLUTTERWAVE_SECRET_KEY || !env.FLUTTERWAVE_WEBHOOK_HASH) issues.push("FLUTTERWAVE_SECRET_KEY and FLUTTERWAVE_WEBHOOK_HASH are required when PAYMENT_PROVIDER=flutterwave");
    else provider = { name: "flutterwave", secretKey: env.FLUTTERWAVE_SECRET_KEY, webhookHash: env.FLUTTERWAVE_WEBHOOK_HASH, baseUrl: parseBaseUrl("FLUTTERWAVE_BASE_URL", env.FLUTTERWAVE_BASE_URL, isProduction, issues) };
  }
  const publicWebUrl = env.PUBLIC_WEB_URL ? parseBaseUrl("PUBLIC_WEB_URL", env.PUBLIC_WEB_URL, isProduction, issues) : null;
  if (env.PAYMENT_PROVIDER !== "none" && !publicWebUrl) issues.push("PUBLIC_WEB_URL is required when a payment provider is configured");
  if (isProduction) {
    for (const name of ["JWT_ACCESS_SECRET", "CRON_SECRET", "SETUP_SECRET", "METRICS_TOKEN", "PAYSTACK_SECRET_KEY", "FLUTTERWAVE_SECRET_KEY", "FLUTTERWAVE_WEBHOOK_HASH"] as const) {
      const value = env[name];
      if (value && PLACEHOLDER.test(value)) issues.push(`${name} still contains a placeholder value`);
    }
    if (!env.COOKIE_SECURE) issues.push("COOKIE_SECURE must be true in production");
    if (corsOrigins.length === 0) issues.push("CORS_ORIGINS must list the production web origin(s)");
    if (corsOrigins.some((origin) => origin.startsWith("http://"))) issues.push("CORS_ORIGINS must use https in production");
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    apiPrefix: env.API_PREFIX,
    corsOrigins: Object.freeze(corsOrigins),
    bodyLimitBytes: env.BODY_LIMIT_BYTES,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    keepAliveTimeoutMs: env.KEEP_ALIVE_TIMEOUT_MS,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    docsEnabled: env.DOCS_ENABLED ?? !isProduction,
    database: Object.freeze({
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL,
      sslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      logging: env.DATABASE_LOGGING,
    }),
    redis: Object.freeze({ url: env.REDIS_URL, keyPrefix: env.REDIS_KEY_PREFIX }),
    jwt: Object.freeze({
      accessSecret: env.JWT_ACCESS_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    }),
    session: Object.freeze({ refreshTtlSeconds: env.REFRESH_TOKEN_TTL_SECONDS }),
    cookie: Object.freeze({ domain: env.COOKIE_DOMAIN, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE }),
    rateLimit: Object.freeze({
      max: env.RATE_LIMIT_MAX,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      authMax: env.AUTH_RATE_LIMIT_MAX,
      authWindowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
      loginMaxFailures: env.LOGIN_MAX_FAILURES,
      loginLockoutSeconds: env.LOGIN_LOCKOUT_SECONDS,
      publicBookingMax: env.PUBLIC_BOOKING_RATE_LIMIT_MAX,
    }),
    payments: Object.freeze({ provider: provider ? Object.freeze(provider) : null, publicWebUrl, timeoutMs: env.PROVIDER_TIMEOUT_MS }),
    booking: Object.freeze({ holdMinutes: env.HOLD_MINUTES, maxStayNights: env.MAX_STAY_NIGHTS, horizonDays: env.BOOKING_HORIZON_DAYS }),
    jobs: Object.freeze({
      cronSecret: env.CRON_SECRET ?? null,
      bankTransferReviewHours: env.BANK_TRANSFER_REVIEW_HOURS,
      reconciliationWindowHours: env.RECONCILIATION_WINDOW_HOURS,
    }),
    setupSecret: env.SETUP_SECRET ?? null,
    metricsToken: env.METRICS_TOKEN ?? null,
  });
}
