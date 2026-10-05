import { timingSafeEqual } from "node:crypto";
import fp from "fastify-plugin";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { withConnection } from "../db/sql.js";
import { sha256Hex } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";

export type AppMetrics = { webhookEvents: Counter<"outcome"> };

/**
 * Prometheus metrics (PRD §8 P1: monitoring and alerts). Alert on
 * `houzzhills_stale_payment_holds` > 0 for several minutes (the hold-expiry
 * scheduler is not running), on webhook failures, and on open payment
 * exceptions. GET /metrics requires `Authorization: Bearer <METRICS_TOKEN>`
 * and is not registered without a token.
 */
export default fp(
  async (app) => {
    const registry = new Registry();
    collectDefaultMetrics({ register: registry, prefix: "houzzhills_" });

    const httpDuration = new Histogram({
      name: "houzzhills_http_request_duration_seconds",
      help: "HTTP request duration by route and status",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    });
    const webhookEvents = new Counter({
      name: "houzzhills_payment_webhooks_total",
      help: "Payment webhook deliveries by outcome",
      labelNames: ["outcome"] as const,
      registers: [registry],
    });
    new Gauge({
      name: "houzzhills_stale_payment_holds",
      help: "Checkout holds expired for more than 10 minutes but not yet released",
      registers: [registry],
      async collect() {
        const row = await withConnection(app.db, (sql) =>
          sql.one<{ count: number }>(
            `SELECT count(*)::int AS count FROM reservations
              WHERE status IN ('hold', 'pending_payment') AND hold_expires_at < now() - interval '10 minutes'`,
          ),
        );
        this.set(row.count);
      },
    });
    new Gauge({
      name: "houzzhills_open_payment_exceptions",
      help: "Payment exceptions awaiting an owner or manager",
      registers: [registry],
      async collect() {
        const row = await withConnection(app.db, (sql) => sql.one<{ count: number }>(`SELECT count(*)::int AS count FROM payment_exceptions WHERE status = 'open'`));
        this.set(row.count);
      },
    });

    app.decorate("metrics", { webhookEvents });
    app.addHook("onResponse", async (request, reply) => {
      httpDuration.observe(
        { method: request.method, route: request.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
    });

    const token = app.config.metricsToken;
    if (!token) return;
    const expected = Buffer.from(sha256Hex(token), "hex");
    app.get("/metrics", { schema: { hide: true }, config: { rateLimit: false }, logLevel: "warn" }, async (request, reply) => {
      const header = request.headers.authorization ?? "";
      const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!supplied || !timingSafeEqual(Buffer.from(sha256Hex(supplied), "hex"), expected)) throw Errors.unauthorized();
      return reply.header("content-type", registry.contentType).send(await registry.metrics());
    });
  },
  { name: "metrics", dependencies: ["database"] },
);
