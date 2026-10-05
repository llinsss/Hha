import { describe, expect, it } from "vitest";
import { canonicalJson, safeEqualHex, sha256Hex } from "../../src/lib/crypto.js";
import { hasPermission } from "../../src/lib/permissions.js";
import { parseRefreshToken } from "../../src/modules/auth/session.service.js";

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(canonicalJson({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonicalJson([undefined])).toBe("[null]");
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("safeEqualHex", () => {
  it("compares digests", () => {
    expect(safeEqualHex(sha256Hex("a"), sha256Hex("a"))).toBe(true);
    expect(safeEqualHex(sha256Hex("a"), sha256Hex("b"))).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
    expect(safeEqualHex("ab", "abcd")).toBe(false);
  });
});

describe("parseRefreshToken", () => {
  const id = "74455ec0-7392-4c46-9394-28f4ab9585b0";
  const secret = "rFos4A46TQUYiGZGzjHJTAkl5J6cutMDVmYoMZjJjQw";
  it("accepts <uuid>.<43-char base64url>", () => {
    expect(parseRefreshToken(`${id}.${secret}`)).toEqual({ sessionId: id, secret });
  });
  it.each([undefined, "", secret, `${id}.`, `${id}.${secret}x`, `not-a-uuid.${secret}`, `${id}.${secret.replace("Q", "+")}`])("rejects %s", (token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });
});

describe("permissions", () => {
  it("matches the legacy role table for key rules", () => {
    expect(hasPermission("owner", "payments:confirm")).toBe(true);
    expect(hasPermission("manager", "payments:confirm")).toBe(true);
    expect(hasPermission("finance", "payments:read")).toBe(true);
    expect(hasPermission("finance", "payments:confirm")).toBe(false);
    expect(hasPermission("housekeeping", "reservations:read")).toBe(false);
    expect(hasPermission("auditor", "rooms:write")).toBe(false);
  });
});
