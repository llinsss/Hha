import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing compatible with the legacy stack (`<saltHex>:<keyHex>`,
 * scrypt N=16384 r=8 p=1, 64-byte key) so both APIs can share the `users`
 * table during the migration. Runs on the libuv thread pool, off the event loop.
 */
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS: ScryptOptions = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function scrypt(password: string, salt: string, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, SCRYPT_OPTIONS, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, stored, ...rest] = encoded.split(":");
  if (!salt || !stored || rest.length > 0 || !/^[0-9a-f]+$/i.test(stored) || stored.length % 2 !== 0) return false;
  const expected = Buffer.from(stored, "hex");
  if (expected.length === 0 || expected.length > 128) return false;
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

/**
 * Hash verified against when a login targets an unknown account, so response
 * time does not reveal whether an email exists.
 */
export const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(KEY_LENGTH * 2)}`;
