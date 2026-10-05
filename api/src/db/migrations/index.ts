import { LegacyBaseline1791158400000 } from "./1791158400000-legacy-baseline.js";
import { CreateApiSessions1791158400001 } from "./1791158400001-create-api-sessions.js";

/**
 * Ordered list of migrations. Registered explicitly (not by glob) so the same
 * list works from compiled JS, tsx and tests. Append new migrations here.
 */
export const migrations = [LegacyBaseline1791158400000, CreateApiSessions1791158400001];
