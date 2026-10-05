import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM sealing for secrets stored in the database. The associated data
 * binds each ciphertext to its purpose (e.g. the setting key), so a value
 * copied into another row fails to decrypt. Format: v1.<iv>.<tag>.<ciphertext>
 * (base64url parts).
 */
export function seal(key: Buffer, plaintext: string, associatedData: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Returns null when the value is malformed, tampered with, or sealed with another key. */
export function open(key: Buffer, sealed: string, associatedData: string): string | null {
  const [version, iv, tag, ciphertext, ...rest] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length > 0) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
