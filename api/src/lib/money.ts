/**
 * Converts a provider's naira amount (number or decimal string, at most 2
 * decimal places) to integer kobo without floating-point rounding.
 * Returns null for anything that is not an exact, non-negative naira value.
 */
export function nairaToKobo(value: unknown): number | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(2) : "") : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const kobo = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(kobo) ? kobo : null;
}

/** Integer kobo from a provider field that is already in kobo (e.g. Paystack `amount`). */
export function koboFrom(value: unknown): number | null {
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}
