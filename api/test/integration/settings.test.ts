import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { App } from "../../src/app.js";
import { FakePaystack, PAYSTACK_TEST_SECRET } from "../fakes/paystack.js";
import { createTestApp, integration, paystackEnv, seedProperty, signedIn } from "../helpers.js";

const URL_ = "/api/v1/management/settings";

type View = { key: string; value: string | number | null; configured: boolean; hint: string | null; readable: boolean; secret: boolean };

describe.skipIf(!integration)("owner-managed global settings", () => {
  const databaseUrl = inject("settingsDatabaseUrl") ?? "";
  const paystack = new FakePaystack();
  const prefix = `test:${randomUUID()}:`;
  let app: App;
  let propertyId: string;
  let owner: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    const env = { ...paystackEnv(await paystack.start()), DATABASE_URL: databaseUrl, REDIS_KEY_PREFIX: prefix };
    app = await createTestApp(env);
    propertyId = await seedProperty(app);
    owner = await signedIn(app, propertyId, "owner");
  });
  afterAll(async () => {
    await app?.close();
    await paystack.stop();
  });

  const list = async () => (await app.inject({ url: URL_, headers: owner.headers })).json<{ settings: View[]; environment: { webhookUrl: string } }>();
  const setting = async (key: string) => (await list()).settings.find((entry) => entry.key === key)!;
  const change = (changes: Record<string, unknown>, headers = owner.headers) => app.inject({ method: "PATCH", url: URL_, headers, payload: { changes } });

  it("starts from defaults with online payments off and is visible to the owner only", async () => {
    const body = await list();
    expect(body.settings.find((entry) => entry.key === "payments.provider")).toMatchObject({ value: "none", secret: false });
    expect(body.settings.find((entry) => entry.key === "booking.hold_minutes")).toMatchObject({ value: 20 });
    expect(body.settings.find((entry) => entry.key === "payments.paystack_secret_key")).toMatchObject({ secret: true, configured: false, value: null, hint: null });
    expect(body.environment.webhookUrl).toBe("https://app.houzzhills.test/api/v1/webhooks/payments");
    for (const role of ["manager", "finance", "auditor"] as const) {
      const other = await signedIn(app, propertyId, role);
      expect((await app.inject({ url: URL_, headers: other.headers })).statusCode).toBe(403);
      expect((await change({ "booking.hold_minutes": 30 }, other.headers)).statusCode).toBe(403);
    }
    expect((await app.inject({ url: URL_ })).statusCode).toBe(401);
  });

  it("validates values and refuses to enable a provider that is not fully configured", async () => {
    expect((await change({ "payments.provider": "paystack" })).json()).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect((await change({ "payments.paystack_secret_key": "not-a-key" })).json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await change({ "booking.hold_minutes": 500 })).json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await change({ "payments.provider": "stripe" })).statusCode).toBe(422);
    expect((await change({ "unknown.key": 1 })).statusCode).toBe(422);
    expect((await change({})).statusCode).toBe(422);
    expect((await change({ "payments.flutterwave_secret_key": "FLWSECK_TEST-abcdefgh12345678", "payments.provider": "flutterwave" })).json()).toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
    });
    // Nothing above was applied: changes are all-or-nothing.
    expect(await setting("payments.flutterwave_secret_key")).toMatchObject({ configured: false });
  });

  it("stores provider keys encrypted, never returns them, and audits without the value", async () => {
    const response = await change({ "payments.paystack_secret_key": PAYSTACK_TEST_SECRET, "payments.provider": "paystack", "booking.hold_minutes": 15 });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PAYSTACK_TEST_SECRET);
    expect(await setting("payments.paystack_secret_key")).toMatchObject({ configured: true, readable: true, value: null, hint: `••••${PAYSTACK_TEST_SECRET.slice(-4)}` });
    expect(await setting("booking.hold_minutes")).toMatchObject({ value: 15 });

    const stored = await app.db.query("SELECT value FROM settings WHERE key = 'payments.paystack_secret_key'");
    expect(stored[0].value).toMatch(/^v1\./);
    expect(stored[0].value).not.toContain(PAYSTACK_TEST_SECRET);
    const audit = await app.db.query("SELECT details FROM audit_events WHERE action = 'settings.updated' ORDER BY id DESC LIMIT 1");
    expect(JSON.stringify(audit[0].details)).not.toContain(PAYSTACK_TEST_SECRET);
    expect(audit[0].details).toMatchObject({ "payments.paystack_secret_key": "replaced", "payments.provider": "paystack", "booking.hold_minutes": 15 });

    expect((await app.payments.provider())?.name).toBe("paystack");
    expect((await app.settings.current()).holdMinutes).toBe(15);
  });

  it("verifies saved credentials with the provider", async () => {
    expect((await app.inject({ method: "POST", url: `${URL_}/payments/verify`, headers: owner.headers })).json()).toEqual({ ok: true, provider: "paystack" });
    await change({ "payments.paystack_secret_key": "sk_test_rejectedbyprovider0000" });
    expect((await app.inject({ method: "POST", url: `${URL_}/payments/verify`, headers: owner.headers })).json()).toMatchObject({ code: "PROVIDER_REJECTED_CREDENTIALS" });
    await change({ "payments.paystack_secret_key": PAYSTACK_TEST_SECRET });
  });

  it("propagates changes to other replicas immediately through the shared version", async () => {
    const replica = await createTestApp({ ...paystackEnv(paystack.baseUrl), DATABASE_URL: databaseUrl, REDIS_KEY_PREFIX: prefix });
    try {
      expect((await replica.settings.current()).holdMinutes).toBe(15);
      await change({ "booking.hold_minutes": null });
      expect((await replica.settings.current()).holdMinutes).toBe(20);
    } finally {
      await replica.close();
    }
  });

  it("treats tampered or transplanted ciphertext as unreadable and disables the provider", async () => {
    const sealed = (await app.db.query("SELECT value FROM settings WHERE key = 'payments.paystack_secret_key'"))[0].value as string;
    await app.db.query("UPDATE settings SET value = $1 WHERE key = 'payments.flutterwave_secret_key'", [sealed]);
    await app.db.query("UPDATE settings SET value = $1 WHERE key = 'payments.paystack_secret_key'", [`${sealed.slice(0, -2)}AA`]);
    await change({ "booking.horizon_days": 200 });
    expect(await setting("payments.paystack_secret_key")).toMatchObject({ configured: true, readable: false });
    expect(await setting("payments.flutterwave_secret_key")).toMatchObject({ configured: true, readable: false });
    expect(await app.payments.provider()).toBeNull();
    // The owner recovers by entering the key again or clearing it.
    expect((await change({ "payments.paystack_secret_key": PAYSTACK_TEST_SECRET, "payments.flutterwave_secret_key": null })).statusCode).toBe(200);
    expect((await app.payments.provider())?.name).toBe("paystack");
  });

  it("will not enable online payments without a public web URL for the checkout return", async () => {
    const noWeb = await createTestApp({ DATABASE_URL: databaseUrl, PUBLIC_WEB_URL: "" });
    try {
      const anotherOwner = await signedIn(noWeb, propertyId, "owner");
      const response = await noWeb.inject({ method: "PATCH", url: URL_, headers: anotherOwner.headers, payload: { changes: { "payments.provider": "paystack" } } });
      expect(response.json()).toMatchObject({ code: "PUBLIC_WEB_URL_MISSING" });
      const unrelated = await noWeb.inject({ method: "PATCH", url: URL_, headers: anotherOwner.headers, payload: { changes: { "booking.max_stay_nights": 30 } } });
      expect(unrelated.statusCode).toBe(200);
    } finally {
      await noWeb.close();
    }
  });
});
