import { Redis } from "ioredis";
import pg from "pg";
import { DATABASE_NAME, PG_ADMIN_URL, REDIS_PREFIX, REDIS_URL, databaseUrl } from "./env.js";

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: PG_ADMIN_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Recreates an empty test database (migrations are applied by the API's own migrate script). */
export async function createDatabase(): Promise<void> {
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${DATABASE_NAME}"`);
  });
}

/** Drops the test database and deletes every Redis key the run created. */
export async function clearEverything(): Promise<{ redisKeys: number }> {
  await admin((client) => client.query(`DROP DATABASE IF EXISTS "${DATABASE_NAME}" WITH (FORCE)`));
  const redis = new Redis(REDIS_URL, { lazyConnect: true, family: 0 });
  await redis.connect();
  let deleted = 0;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${REDIS_PREFIX}*`, "COUNT", 500);
      if (keys.length) deleted += await redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  } finally {
    redis.disconnect();
  }
  return { redisKeys: deleted };
}

/** Direct access for steps a browser cannot perform, such as letting a checkout hold lapse. */
export async function query(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}
