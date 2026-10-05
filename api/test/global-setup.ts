import { DataSource } from "typeorm";
import type { TestProject } from "vitest/node";
import { migrations } from "../src/db/migrations/index.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** An empty, migrated database for the one-time setup tests (no users). */
    setupDatabaseUrl: string | null;
  }
}

async function migrateFresh(url: string): Promise<DataSource> {
  const dataSource = new DataSource({ type: "postgres", url, migrations, migrationsTableName: "typeorm_migrations", logging: false });
  await dataSource.initialize();
  await dataSource.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await dataSource.runMigrations({ transaction: "each" });
  return dataSource;
}

/**
 * Integration tests need TEST_DATABASE_URL and TEST_REDIS_URL. The database (and
 * a sibling `<name>_setup` database) are wiped and migrated from scratch once
 * per run, so never point them at a database you care about.
 */
export default async function setup(project: TestProject): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  project.provide("setupDatabaseUrl", null);
  if (!url) {
    console.warn("TEST_DATABASE_URL/TEST_REDIS_URL not set: integration tests will be skipped.");
    return;
  }

  const main = await migrateFresh(url);
  try {
    // The primary property: public booking endpoints serve the oldest property.
    await main.query("INSERT INTO properties(name) VALUES ('Houzz Hills Test Primary')");
    const setupUrl = new URL(url);
    const setupName = `${setupUrl.pathname.slice(1)}_setup`;
    if (!/^[A-Za-z0-9_]+$/.test(setupName)) throw new Error("TEST_DATABASE_URL database name must be alphanumeric");
    await main.query(`DROP DATABASE IF EXISTS "${setupName}" WITH (FORCE)`);
    await main.query(`CREATE DATABASE "${setupName}"`);
    setupUrl.pathname = `/${setupName}`;
    await (await migrateFresh(setupUrl.href)).destroy();
    project.provide("setupDatabaseUrl", setupUrl.href);
  } finally {
    await main.destroy();
  }
}
