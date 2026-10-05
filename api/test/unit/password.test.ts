import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../../src/lib/password.js";

/** The exact algorithm used by the legacy Next.js stack (removed; see git history). */
async function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await promisify(scrypt)(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}

describe("password hashing", () => {
  it("verifies its own hashes", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
  });

  it("verifies hashes created by the legacy stack, and vice versa", async () => {
    await expect(verifyPassword("légacy pässword", await legacyHash("légacy pässword"))).resolves.toBe(true);
    const ours = await hashPassword("shared users table");
    const [salt, key] = ours.split(":") as [string, string];
    const legacyKey = (await promisify(scrypt)("shared users table", salt, 64)) as Buffer;
    expect(legacyKey.toString("hex")).toBe(key);
  });

  it("rejects malformed hashes without throwing", async () => {
    for (const encoded of ["", "nocolon", "abc:", ":abc", "abc:zz", "a:b:c", "abc:123"]) {
      await expect(verifyPassword("x", encoded)).resolves.toBe(false);
    }
  });

  it("never matches the dummy hash", async () => {
    await expect(verifyPassword("", DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    await expect(verifyPassword("password", DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });
});
