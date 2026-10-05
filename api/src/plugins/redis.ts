import fp from "fastify-plugin";
import { Redis } from "ioredis";

/**
 * Shared Redis client. Commands fail fast while disconnected (no offline queue)
 * so callers can degrade gracefully instead of hanging; the client reconnects in
 * the background with capped backoff.
 */
export default fp(
  async (app) => {
    const redis = new Redis(app.config.redis.url, {
      keyPrefix: app.config.redis.keyPrefix,
      lazyConnect: true,
      connectTimeout: 5_000,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableAutoPipelining: true,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
      reconnectOnError: (error) => error.message.startsWith("READONLY"),
    });
    const log = app.log.child({ module: "redis" });
    redis.on("error", (error) => log.warn({ err: error }, "redis error"));
    redis.on("reconnecting", (delay: number) => log.warn({ delay }, "redis reconnecting"));
    redis.on("ready", () => log.info("redis ready"));

    await redis.connect();
    app.decorate("redis", redis);
    app.addHook("onClose", async () => {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    });
  },
  { name: "redis" },
);
