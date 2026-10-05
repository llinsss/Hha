/** Playwright web server: fresh database, migrations, then the API (forwarding shutdown signals). */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./database.js";
import { apiEnvironment } from "./env.js";

const apiDir = fileURLToPath(new URL("../../api", import.meta.url));
const env = apiEnvironment();

await createDatabase();
const migrated = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/migrate.ts", "up"], { cwd: apiDir, env, stdio: "inherit" });
if (migrated.status !== 0) process.exit(migrated.status ?? 1);

const server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: apiDir, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
