/**
 * Applies (default) or reverts the last migration:
 *   node dist/scripts/migrate.js [up|down|status]
 * Run as a one-off release step before starting new API replicas; the server
 * never migrates on boot, so replicas cannot race each other.
 */
import { ConfigError, loadConfig } from "../config/env.js";
import { createDataSource } from "../db/data-source.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";
  if (!["up", "down", "status"].includes(command)) throw new Error("Usage: migrate [up|down|status]");

  const dataSource = createDataSource(loadConfig());
  await dataSource.initialize();
  try {
    if (command === "status") {
      const pending = await dataSource.showMigrations();
      console.log(pending ? "There are pending migrations." : "Database schema is up to date.");
      process.exitCode = pending ? 2 : 0;
    } else if (command === "down") {
      await dataSource.undoLastMigration({ transaction: "each" });
      console.log("Reverted the last migration.");
    } else {
      const applied = await dataSource.runMigrations({ transaction: "each" });
      for (const migration of applied) console.log(`Applied ${migration.name}`);
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database schema is up to date.");
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
