import { DataSource } from "typeorm";
import type { TestProject } from "vitest/node";
import { migrations } from "../src/db/migrations/index.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** An empty, migrated database for the one-time setup tests (no users). */
    setupDatabaseUrl: string | null;
    /** A migrated database of its own for global-settings tests, which change process-wide state. */
    settingsDatabaseUrl: string | null;
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
 * Integration tests need TEST_DATABASE_URL and TEST_REDIS_URL. That database and
 * its siblings `<name>_setup` and `<name>_settings` are wiped and migrated from
 * scratch once per run, so never point them at a database you care about.
 */
export default async function setup(project: TestProject): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  project.provide("setupDatabaseUrl", null);
  project.provide("settingsDatabaseUrl", null);
  if (!url) {
    console.warn("TEST_DATABASE_URL/TEST_REDIS_URL not set: integration tests will be skipped.");
    return;
  }

  const main = await migrateFresh(url);
  try {
    // The primary property: public booking endpoints serve the oldest property.
    await main.query("INSERT INTO properties(name) VALUES ('Houzz Hills Test Primary')");
    const isolated = async (suffix: string): Promise<string> => {
      const target = new URL(url);
      const name = `${target.pathname.slice(1)}_${suffix}`;
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("TEST_DATABASE_URL database name must be alphanumeric");
      await main.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await main.query(`CREATE DATABASE "${name}"`);
      target.pathname = `/${name}`;
      await (await migrateFresh(target.href)).destroy();
      return target.href;
    };
    project.provide("setupDatabaseUrl", await isolated("setup"));
    project.provide("settingsDatabaseUrl", await isolated("settings"));
  } finally {
    await main.destroy();
  }
}
