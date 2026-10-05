import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
try {
  const localEnv = await readFile(resolve(root, ".env.local"), "utf8");
  for (const line of localEnv.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch { /* Production environments provide variables directly. */ }
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running migrations.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined });
try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
    if (applied.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  console.log("Houzz Hills database schema is up to date.");
} finally {
  await pool.end();
}
