import { spawnSync } from "node:child_process";
import { mkdir, access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = join(root, ".local", "postgres-data");
const log = join(root, ".local", "postgres.log");
const port = "5440";
const username = userInfo().username;
const mode = process.argv[2] ?? "start";

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} exited with status ${result.status}`);
  return result.status === 0;
}

if (mode === "stop") {
  run("pg_ctl", ["-D", data, "stop", "-m", "fast"], { allowFailure: true });
  console.log("Houzz Hills development PostgreSQL stopped.");
} else if (mode === "start") {
  await mkdir(dirname(data), { recursive: true });
  let initialized = true;
  try { await access(join(data, "PG_VERSION")); } catch { initialized = false; }
  if (!initialized) run("initdb", ["-D", data, "-U", username, "--auth-local=trust", "--auth-host=trust", "--no-instructions"]);
  const running = run("pg_ctl", ["-D", data, "status"], { allowFailure: true });
  if (!running) run("pg_ctl", ["-D", data, "-l", log, "-o", `-h 127.0.0.1 -p ${port}`, "start"]);
  run("createdb", ["-h", "127.0.0.1", "-p", port, "-U", username, "houzzhills"], { allowFailure: true });
  try { await access(join(root, ".env.local")); }
  catch {
    const databaseUrl = `postgresql://${encodeURIComponent(username)}@127.0.0.1:${port}/houzzhills`;
    await writeFile(join(root, ".env.local"), `DATABASE_URL=${databaseUrl}\nDATABASE_SSL=false\n`, { mode: 0o600 });
    console.log("Created .env.local for local database access.");
  }
  console.log(`Houzz Hills development PostgreSQL is running on 127.0.0.1:${port}. Run npm run db:migrate next.`);
} else {
  throw new Error("Usage: node scripts/dev-db.mjs [start|stop]");
}
