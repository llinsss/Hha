import { Type, type Static } from "typebox";

/** Standard error envelope returned by every non-2xx response. */
export const ErrorResponse = Type.Object(
  {
    statusCode: Type.Integer(),
    error: Type.String(),
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    details: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String() }))),
  },
  { $id: "ErrorResponse", title: "ErrorResponse" },
);
export type ErrorResponse = Static<typeof ErrorResponse>;

/** Shorthand for documenting the standard error responses of a route. */
export function errorResponses(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, Type.Ref("ErrorResponse")]));
}

// ---- Shared field schemas ----

export const Uuid = Type.String({ format: "uuid" });
export const IsoDate = Type.String({ format: "date", description: "YYYY-MM-DD" });
/** ISO-8601 timestamp; Date values are serialised by fast-json-stringify. */
export const Timestamp = Type.Unsafe<Date | string>({ type: "string", format: "date-time" });
/** Integer kobo serialised as a string so values above 2^53 cannot lose precision. */
export const KoboString = Type.String({ pattern: "^-?\\d+$", description: "Integer kobo (NGN × 100)" });
/** Integer kobo accepted from clients. */
export const KoboInput = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Integer kobo (NGN × 100)" });
/** Fixed-point stock quantity (numeric(12,3)) serialised as a string. */
export const QuantityString = Type.String({ pattern: "^-?\\d+(\\.\\d{1,3})?$" });
export const IdParams = Type.Object({ id: Uuid }, { additionalProperties: false });

export function Nullable<T extends Parameters<typeof Type.Union>[0][number]>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

/** Free text: trimmed by the service, bounded here. */
export function Text(maxLength: number, minLength = 1) {
  return Type.String({ minLength, maxLength });
}

/** A string restricted to a fixed set of values, typed as their union. */
export function StringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

const MAX_QUANTITY = 100_000_000;

/** Stock quantity with at most 3 decimal places (numeric(12,3)). */
export function Quantity(options: { minimum?: number; exclusiveMinimum?: number } = {}) {
  return Type.Number({ maximum: MAX_QUANTITY, minimum: -MAX_QUANTITY, ...options, description: "Up to 3 decimal places" });
}

/** True when `value` has no more than 3 decimal places; returns the exact decimal text for SQL. */
export function toQuantityText(value: number): string | null {
  const scaled = Math.round(value * 1000);
  return Number.isFinite(value) && Math.abs(scaled - value * 1000) < 1e-6 ? (scaled / 1000).toFixed(3) : null;
}
