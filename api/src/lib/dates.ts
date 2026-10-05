/** Property business dates are Africa/Lagos calendar days (PRD §9). */
export const BUSINESS_TIMEZONE = "Africa/Lagos";

const DAY_MS = 86_400_000;
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's business date as YYYY-MM-DD. */
export function businessToday(now: Date = new Date()): string {
  return formatter.format(now);
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Nights between two YYYY-MM-DD dates (check-out exclusive). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY_MS);
}
