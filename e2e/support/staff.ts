import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Values one spec creates through the UI and a later spec needs (e.g. a generated one-time password). */
export const STAFF_FILE = join(tmpdir(), "houzzhills-e2e-state.json");

export function readStaffState(): { frontDeskPassword: string } {
  return JSON.parse(readFileSync(STAFF_FILE, "utf8")) as { frontDeskPassword: string };
}

export function removeStaffState(): void {
  rmSync(STAFF_FILE, { force: true });
}
