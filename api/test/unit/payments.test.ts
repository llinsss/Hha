import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/lib/csv.js";
import { canSeeEvent } from "../../src/lib/events.js";
import { koboFrom, nairaToKobo } from "../../src/lib/money.js";
import { decodeCursor, encodeCursor, toPage } from "../../src/lib/pagination.js";
import { createFlutterwave } from "../../src/modules/payments/providers/flutterwave.js";
import { createPaystack } from "../../src/modules/payments/providers/paystack.js";

const reference = "HH-ABC123-0123456789ABCDEF0123456789ABCDEF";

describe("money conversion", () => {
  it("converts naira to kobo exactly", () => {
    expect(nairaToKobo(150000)).toBe(15_000_000);
    expect(nairaToKobo("1234.5")).toBe(123_450);
    expect(nairaToKobo("0.07")).toBe(7);
    expect(nairaToKobo(0.1 + 0.2)).toBe(30);
    for (const bad of ["1.234", "-1", "abc", "", null, Number.NaN, "1e5"]) expect(nairaToKobo(bad)).toBeNull();
  });
  it("accepts only safe integer kobo", () => {
    expect(koboFrom(500)).toBe(500);
    expect(koboFrom("500")).toBe(500);
    for (const bad of [1.5, -1, "5.0", 2 ** 60]) expect(koboFrom(bad)).toBeNull();
  });
});

describe("Paystack adapter", () => {
  const paystack = createPaystack({ secretKey: "sk_test_secret", baseUrl: "https://api.paystack.co", timeoutMs: 1000 });
  const body = Buffer.from(JSON.stringify({ event: "charge.success", data: { id: 42, reference } }));

  it("authenticates webhooks with HMAC-SHA512 of the raw body", () => {
    const signature = createHmac("sha512", "sk_test_secret").update(body).digest("hex");
    expect(paystack.isAuthenticWebhook(body, { "x-paystack-signature": signature })).toBe(true);
    expect(paystack.isAuthenticWebhook(Buffer.concat([body, Buffer.from(" ")]), { "x-paystack-signature": signature })).toBe(false);
    expect(paystack.isAuthenticWebhook(body, { "x-paystack-signature": "abc" })).toBe(false);
    expect(paystack.isAuthenticWebhook(body, {})).toBe(false);
  });

  it("only turns charge.success events for our references into claims", () => {
    expect(paystack.parseWebhook(JSON.parse(body.toString()))).toEqual({ reference, outcome: "success", eventId: "paystack:42:charge.success" });
    expect(paystack.parseWebhook({ event: "transfer.success", data: { id: 1, reference } })).toBeNull();
    expect(paystack.parseWebhook({ event: "charge.success", data: { id: 1, reference: "someone-else" } })).toBeNull();
    expect(paystack.parseWebhook("nonsense")).toBeNull();
  });
});

describe("Flutterwave adapter", () => {
  const flutterwave = createFlutterwave({ secretKey: "FLWSECK_TEST", webhookHash: "my-webhook-hash-value", baseUrl: "https://api.flutterwave.com", timeoutMs: 1000 });

  it("authenticates webhooks with the configured verif-hash in constant time", () => {
    expect(flutterwave.isAuthenticWebhook(Buffer.from("{}"), { "verif-hash": "my-webhook-hash-value" })).toBe(true);
    expect(flutterwave.isAuthenticWebhook(Buffer.from("{}"), { "verif-hash": "my-webhook-hash-valuX" })).toBe(false);
    expect(flutterwave.isAuthenticWebhook(Buffer.from("{}"), { "verif-hash": "" })).toBe(false);
    expect(createHash("sha256").update("x").digest()).toHaveLength(32);
  });

  it("maps charge.completed outcomes and ignores pending ones", () => {
    expect(flutterwave.parseWebhook({ event: "charge.completed", data: { id: 7, tx_ref: reference, status: "successful" } })).toEqual({ reference, outcome: "success", eventId: "flutterwave:7:success" });
    expect(flutterwave.parseWebhook({ event: "charge.completed", data: { id: 7, tx_ref: reference, status: "failed" } })).toMatchObject({ outcome: "failed" });
    expect(flutterwave.parseWebhook({ event: "charge.completed", data: { id: 7, tx_ref: reference, status: "pending" } })).toBeNull();
  });
});

describe("CSV export", () => {
  it("quotes RFC 4180 fields and neutralises spreadsheet formulas", () => {
    expect(toCsv(["a", "b"], [["=SUM(A1)", 'He said "hi", ok'], ["-5", null], ["@x", new Date("2026-01-02T03:04:05.000Z")]])).toBe(
      'a,b\r\n\'=SUM(A1),"He said ""hi"", ok"\r\n\'-5,\r\n\'@x,2026-01-02T03:04:05.000Z\r\n',
    );
  });
});

describe("event visibility", () => {
  it("shows events only to roles with the matching permission", () => {
    expect(canSeeEvent("housekeeping", "room.status_changed")).toBe(true);
    expect(canSeeEvent("housekeeping", "reservation.created")).toBe(false);
    expect(canSeeEvent("front_desk", "payment.settled")).toBe(true);
    expect(canSeeEvent("finance", "payment_exception.raised")).toBe(false);
    expect(canSeeEvent("manager", "payment_exception.raised")).toBe(true);
    expect(canSeeEvent("owner", "unknown.event")).toBe(false);
  });
});

describe("keyset pagination", () => {
  it("round-trips cursors and rejects tampered ones", () => {
    expect(decodeCursor(encodeCursor(["2026-01-01", "id"]), 2)).toEqual(["2026-01-01", "id"]);
    expect(decodeCursor(undefined, 2)).toBeNull();
    expect(() => decodeCursor(encodeCursor(["a"]), 2)).toThrow();
    expect(() => decodeCursor("not-base64-json", 1)).toThrow();
    const page = toPage([1, 2, 3], 2, (value) => [String(value)]);
    expect(page.items).toEqual([1, 2]);
    expect(decodeCursor(page.nextCursor ?? undefined, 1)).toEqual(["2"]);
    expect(toPage([1], 2, (value) => [String(value)]).nextCursor).toBeNull();
  });
});
