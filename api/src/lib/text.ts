/** Trims optional free text; blank or missing input becomes null. */
export function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}
