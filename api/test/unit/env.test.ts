import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgresql://user@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_ACCESS_SECRET: "a-very-long-random-secret-value-0123456789",
};

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("applies defaults and coerces types", () => {
    const config = loadConfig({ ...base, PORT: "8080", DATABASE_SSL: "true", CORS_ORIGINS: "http://localhost:3000, https://app.example.com" });
    expect(config.port).toBe(8080);
    expect(config.database.ssl).toBe(true);
    expect(config.apiPrefix).toBe("/api/v1");
    expect(config.corsOrigins).toEqual(["http://localhost:3000", "https://app.example.com"]);
    expect(config.docsEnabled).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("treats blank values as unset", () => {
    expect(loadConfig({ ...base, PORT: "  ", LOG_LEVEL: "" }).port).toBe(4000);
  });

  it("reports every missing or invalid variable at once", () => {
    const issues = issuesOf({ PORT: "abc", JWT_ACCESS_SECRET: "short" });
    expect(issues.join("\n")).toMatch(/DATABASE_URL|required/);
    expect(issues.length).toBeGreaterThan(1);
  });

  it("rejects CORS entries that are not exact origins", () => {
    expect(issuesOf({ ...base, CORS_ORIGINS: "https://app.example.com/path" })[0]).toMatch(/exact origin/);
  });

  it("enforces production safety rules", () => {
    const issues = issuesOf({ ...base, NODE_ENV: "production", JWT_ACCESS_SECRET: "replace-with-a-long-random-value-please", COOKIE_SECURE: "false" });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/JWT_ACCESS_SECRET/),
        expect.stringMatching(/COOKIE_SECURE/),
        expect.stringMatching(/CORS_ORIGINS/),
      ]),
    );
  });

  it("requires complete provider settings and a return URL for online payments", () => {
    expect(issuesOf({ ...base, PAYMENT_PROVIDER: "paystack" })).toEqual(
      expect.arrayContaining([expect.stringMatching(/PAYSTACK_SECRET_KEY/), expect.stringMatching(/PUBLIC_WEB_URL/)]),
    );
    expect(issuesOf({ ...base, PAYMENT_PROVIDER: "flutterwave", FLUTTERWAVE_SECRET_KEY: "FLWSECK-abcdef" })[0]).toMatch(/FLUTTERWAVE_WEBHOOK_HASH/);
    const config = loadConfig({ ...base, PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: "sk_test_abcdef", PUBLIC_WEB_URL: "https://app.example.com/" });
    expect(config.payments.provider).toMatchObject({ name: "paystack", baseUrl: "https://api.paystack.co" });
    expect(config.payments.publicWebUrl).toBe("https://app.example.com");
    expect(issuesOf({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com", PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: "sk_live_abcdef", PUBLIC_WEB_URL: "http://app.example.com" })[0]).toMatch(/PUBLIC_WEB_URL must use https/);
  });

  it("disables docs by default in production", () => {
    const config = loadConfig({ ...base, NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com" });
    expect(config.docsEnabled).toBe(false);
    expect(config.isProduction).toBe(true);
  });
});
