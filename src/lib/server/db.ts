import { Pool, type PoolClient, type QueryResultRow } from "pg";

const globalForPool = globalThis as unknown as { houzzPool?: Pool };

export const pool = globalForPool.houzzPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});

if (process.env.NODE_ENV !== "production") globalForPool.houzzPool = pool;

export async function query<T extends QueryResultRow>(sql: string, values: unknown[] = []) {
  return pool.query<T>(sql, values);
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
