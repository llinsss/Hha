import type { FastifyBaseLogger } from "fastify";
import type { Logger as TypeOrmLogger } from "typeorm";

/**
 * Routes TypeORM output through the application's pino logger so database
 * events share request-independent structured logging. Query parameters are
 * never logged: they can contain credentials or guest PII.
 */
export class PinoTypeOrmLogger implements TypeOrmLogger {
  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly logQueries: boolean,
  ) {}

  logQuery(query: string): void {
    if (this.logQueries) this.logger.debug({ query }, "db query");
  }

  logQueryError(error: string | Error, query: string): void {
    this.logger.error({ err: error, query }, "db query failed");
  }

  logQuerySlow(time: number, query: string): void {
    this.logger.warn({ durationMs: time, query }, "db query slow");
  }

  logSchemaBuild(message: string): void {
    this.logger.info({ message }, "db schema");
  }

  logMigration(message: string): void {
    this.logger.info({ message }, "db migration");
  }

  log(level: "log" | "info" | "warn", message: unknown): void {
    if (level === "warn") this.logger.warn({ message }, "db");
    else this.logger.info({ message }, "db");
  }
}
