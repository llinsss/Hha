import type { DataSource, QueryRunner } from "typeorm";
import { QueryFailedError } from "typeorm";

/**
 * Thin typed layer over TypeORM query runners for hand-written, parameterised
 * SQL. Every value is passed as a bind parameter ($1, $2, …); never interpolate
 * input into SQL text.
 */
export interface Sql {
  rows<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Exactly one row, or throws (a programming error, surfaced as 500). */
  one<T>(text: string, params?: readonly unknown[]): Promise<T>;
  maybeOne<T>(text: string, params?: readonly unknown[]): Promise<T | null>;
  /** Number of rows affected by an INSERT/UPDATE/DELETE. */
  exec(text: string, params?: readonly unknown[]): Promise<number>;
  readonly runner: QueryRunner;
}

function wrap(runner: QueryRunner): Sql {
  const run = async (text: string, params: readonly unknown[] = []) => runner.query(text, [...params], true);
  return {
    runner,
    async rows<T>(text: string, params?: readonly unknown[]) {
      return (await run(text, params)).records as T[];
    },
    async one<T>(text: string, params?: readonly unknown[]) {
      const records = (await run(text, params)).records as T[];
      if (records.length !== 1) throw new Error(`Expected exactly one row, got ${records.length}`);
      return records[0] as T;
    },
    async maybeOne<T>(text: string, params?: readonly unknown[]) {
      return ((await run(text, params)).records as T[])[0] ?? null;
    },
    async exec(text: string, params?: readonly unknown[]) {
      return (await run(text, params)).affected ?? 0;
    },
  };
}

/** SQLSTATEs where re-running the whole transaction is the correct response. */
const RETRYABLE = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 3;

function sqlState(error: unknown): string | undefined {
  if (!(error instanceof QueryFailedError)) return undefined;
  const code = (error.driverError as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function isSqlState(error: unknown, code: string): boolean {
  return sqlState(error) === code;
}

/**
 * Runs `work` in a READ COMMITTED transaction (writers take explicit row locks).
 * Serialization failures and deadlocks are retried with jitter, so `work` must
 * only have database side effects.
 */
export async function withTransaction<T>(db: DataSource, work: (tx: Sql) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const runner = db.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction("READ COMMITTED");
      const result = await work(wrap(runner));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
      const retryable = RETRYABLE.has(sqlState(error) ?? "");
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 30)));
    } finally {
      await runner.release();
    }
  }
}

/** Runs read-only work on one pooled connection without a transaction. */
export async function withConnection<T>(db: DataSource, work: (sql: Sql) => Promise<T>): Promise<T> {
  const runner = db.createQueryRunner();
  try {
    await runner.connect();
    return await work(wrap(runner));
  } finally {
    await runner.release();
  }
}
