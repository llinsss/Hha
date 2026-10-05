import { Type } from "typebox";
import { Errors } from "./errors.js";

export const MAX_PAGE_SIZE = 200;

export const PageQuery = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 50, description: "Page size" })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Opaque `nextCursor` from the previous page" })),
};

export const NextCursor = Type.Union([Type.String(), Type.Null()], { description: "Pass as `cursor` to fetch the next page; null on the last page" });

/**
 * Keyset pagination. A cursor is the sort key of the last row returned,
 * base64url-encoded, so pages stay stable while rows are inserted and deep
 * pages cost the same as the first one.
 */
export function encodeCursor(values: readonly string[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined, arity: number): string[] | null {
  if (cursor === undefined) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  if (!Array.isArray(decoded) || decoded.length !== arity || !decoded.every((value) => typeof value === "string" && value.length <= 64)) {
    throw Errors.unprocessable("The pagination cursor is invalid", "INVALID_CURSOR");
  }
  return decoded as string[];
}

/** Splits a `limit + 1` result into the page and the cursor for the next one. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => readonly string[]): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(keyOf(items[items.length - 1] as T)) };
}
