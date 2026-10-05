import { DataSource } from "typeorm";
import { migrations } from "../src/db/migrations/index.js";

/**
 * Integration tests need TEST_DATABASE_URL and TEST_REDIS_URL. The database is
 * wiped (public schema dropped) and migrated from scratch once per run, so
 * never point it at a database you care about.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    console.warn("TEST_DATABASE_URL/TEST_REDIS_URL not set: integration tests will be skipped.");
    return;
  }
  const dataSource = new DataSource({ type: "postgres", url, migrations, migrationsTableName: "typeorm_migrations", logging: false });
  await dataSource.initialize();
  try {
    await dataSource.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await dataSource.runMigrations({ transaction: "each" });
  } finally {
    await dataSource.destroy();
  }
}
