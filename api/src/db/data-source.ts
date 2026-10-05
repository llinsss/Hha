import type { FastifyBaseLogger } from "fastify";
import { DataSource } from "typeorm";
import type { AppConfig } from "../config/env.js";
import { entities } from "./entities/index.js";
import { migrations } from "./migrations/index.js";
import { PinoTypeOrmLogger } from "./typeorm-logger.js";

export function createDataSource(config: AppConfig, log?: FastifyBaseLogger): DataSource {
  const { database } = config;
  return new DataSource({
    type: "postgres",
    url: database.url,
    ssl: database.ssl ? { rejectUnauthorized: database.sslRejectUnauthorized } : false,
    applicationName: "houzzhills-api",
    entities,
    migrations,
    migrationsTableName: "typeorm_migrations",
    migrationsTransactionMode: "each",
    // The schema is owned by migrations only. Never let TypeORM alter it.
    synchronize: false,
    migrationsRun: false,
    logging: database.logging ? ["query", "error", "warn", "migration"] : ["error", "warn", "migration"],
    ...(log ? { logger: new PinoTypeOrmLogger(log, database.logging) } : {}),
    maxQueryExecutionTime: 1000,
    poolSize: database.poolMax,
    // Passed to node-postgres Pool / per-connection settings.
    extra: {
      max: database.poolMax,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: database.statementTimeoutMs,
      idle_in_transaction_session_timeout: database.statementTimeoutMs * 2,
      keepAlive: true,
    },
  });
}
