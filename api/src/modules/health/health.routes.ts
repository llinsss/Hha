import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";

const CHECK_TIMEOUT_MS = 2_000;

async function probe(check: () => Promise<unknown>): Promise<"up" | "down"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

const Status = Type.Union([Type.Literal("up"), Type.Literal("down")]);
const ReadyResponse = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("unavailable")]),
  checks: Type.Object({ database: Status, redis: Status }),
});

/** Probes for orchestrators. Responses never include versions, hosts or error text. */
const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/live",
    {
      schema: { tags: ["health"], summary: "Liveness probe", response: { 200: Type.Object({ status: Type.Literal("ok") }) } },
      config: { rateLimit: false },
      logLevel: "warn",
    },
    async () => ({ status: "ok" as const }),
  );

  app.get(
    "/ready",
    {
      schema: { tags: ["health"], summary: "Readiness probe (database and Redis)", response: { 200: ReadyResponse, 503: ReadyResponse } },
      config: { rateLimit: false },
      logLevel: "warn",
    },
    async (_request, reply) => {
      const [database, redis] = await Promise.all([probe(() => app.db.query("SELECT 1")), probe(() => app.redis.ping())]);
      const ok = database === "up" && redis === "up";
      return reply.status(ok ? 200 : 503).send({ status: ok ? "ok" : "unavailable", checks: { database, redis } });
    },
  );
};

export default healthRoutes;
