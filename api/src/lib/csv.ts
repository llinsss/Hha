/**
 * RFC 4180 CSV with spreadsheet formula-injection protection: cells starting
 * with = + - @ or a control character are prefixed with an apostrophe so Excel
 * and Sheets treat them as text.
 */
export type CsvValue = string | number | Date | null | undefined;

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly CsvValue[]>): string {
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
