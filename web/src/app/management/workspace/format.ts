import type { Option, Property } from "@/lib/api";

/**
 * Display helpers. Business dates and times follow the property's timezone and
 * currency from the API (`/public/property`), applied once at start-up with
 * `applyProperty`. Money is integer kobo from the API.
 */

let timeZone = "UTC";
let currency = "NGN";
let moneyFormat = new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 0 });

export function applyProperty(property: Property): void {
  timeZone = property.timezone;
  currency = property.currency;
  moneyFormat = new Intl.NumberFormat("en-NG", { style: "currency", currency, maximumFractionDigits: 0 });
}

export function money(kobo: string | number | bigint | null | undefined): string {
  return moneyFormat.format(Number(kobo ?? 0) / 100);
}

/** The API's label for a value, falling back to a readable form of the value itself. */
export function optionLabel(options: readonly Option[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? humanize(value);
}

/** Readable form of machine identifiers such as event types ("reservation.created"). */
export function humanize(value: string): string {
  return value.replaceAll(".", " · ").replaceAll("_", " ");
}

export function dateLabel(isoDate: string): string {
  return new Date(`${isoDate.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-NG", { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone });
}

export function dateTimeLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-NG", { timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Full date for headings, in the property's timezone. */
export function longDateLabel(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-NG", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone }).format(date);
}

/** Hour of day (0–23) in the property's timezone. */
export function propertyHour(date: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-NG", { hour: "numeric", hourCycle: "h23", timeZone }).format(date));
}

/** YYYY-MM-DD business date in the property's timezone, offset by whole days. */
export function propertyDate(days = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}

export function timeZoneName(): string {
  return timeZone;
}

export function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

/** Naira typed into a form → integer kobo. */
export function toKobo(naira: FormDataEntryValue | null | undefined): number {
  return Math.round(Number(naira ?? 0) * 100);
}

export function text(value: FormDataEntryValue | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}
