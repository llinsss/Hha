/** Playwright web server: production build of the web app, forwarding /api/v1/* to the local API. */
import { cpSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { API_URL, WEB_PORT } from "./env.js";

const webDir = fileURLToPath(new URL("../../web", import.meta.url));
const env = { ...process.env, API_INTERNAL_URL: API_URL, NEXT_TELEMETRY_DISABLED: "1" };

rmSync(`${webDir}/.next`, { recursive: true, force: true });
const built = spawnSync("npx", ["next", "build"], { cwd: webDir, env, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
cpSync(`${webDir}/.next/static`, `${webDir}/.next/standalone/.next/static`, { recursive: true });

const server = spawn(process.execPath, ["server.js"], {
  cwd: `${webDir}/.next/standalone`,
  env: { ...env, NODE_ENV: "production", PORT: String(WEB_PORT), HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
