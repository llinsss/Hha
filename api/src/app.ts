import { randomUUID } from "node:crypto";
import sensible from "@fastify/sensible";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config/env.js";
import attendanceRoutes from "./modules/attendance/attendance.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import dashboardRoutes from "./modules/dashboard/dashboard.routes.js";
import eventRoutes from "./modules/events/events.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import inventoryRoutes from "./modules/inventory/inventory.routes.js";
import jobRoutes from "./modules/jobs/jobs.routes.js";
import menuRoutes from "./modules/menu/menu.routes.js";
import { paymentExceptionRoutes, paymentRoutes } from "./modules/payments/payments.routes.js";
import posRoutes from "./modules/pos/pos.routes.js";
import publicRoutes from "./modules/public/public.routes.js";
import reservationRoutes from "./modules/reservations/reservations.routes.js";
import roomRoutes from "./modules/rooms/rooms.routes.js";
import settingsRoutes from "./modules/settings/settings.routes.js";
import referenceRoutes from "./modules/reference/reference.routes.js";
import setupRoutes from "./modules/setup/setup.routes.js";
import staffRoutes from "./modules/staff/staff.routes.js";
import webhookRoutes from "./modules/webhooks/webhooks.routes.js";
import authPlugin from "./plugins/auth.js";
import databasePlugin from "./plugins/database.js";
import errorHandler from "./plugins/error-handler.js";
import idempotencyPlugin from "./plugins/idempotency.js";
import metricsPlugin from "./plugins/metrics.js";
import paymentsPlugin from "./plugins/payments.js";
import redisPlugin from "./plugins/redis.js";
import securityPlugin from "./plugins/security.js";
import swaggerPlugin from "./plugins/swagger.js";

const REQUEST_ID = /^[A-Za-z0-9_\-:.]{8,128}$/;

/** pino-pretty is a dev dependency; production images log JSON even if NODE_ENV=development. */
function prettyLoggerAvailable(): boolean {
  try {
    import.meta.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

function loggerOptions(config: AppConfig): FastifyServerOptions["logger"] {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "*.password",
        "*.currentPassword",
        "*.newPassword",
        "*.passwordHash",
        "*.accessToken",
        "*.refreshToken",
      ],
      censor: "[redacted]",
    },
    ...(config.env === "development" && prettyLoggerAvailable()
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" } } }
      : {}),
  };
}

/**
 * Builds the Fastify application without listening. Plugins and routes load when
 * `ready()`/`listen()` is called, so tests may register extra routes first.
 */
export function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: loggerOptions(config),
    // Reuse a caller-supplied request id only when it is well-formed; otherwise mint one.
    requestIdHeader: false,
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && REQUEST_ID.test(supplied) ? supplied : randomUUID();
    },
    // Trust exactly N proxy hops (e.g. 1 behind a single load balancer); never the whole chain.
    trustProxy: config.trustProxyHops > 0 ? (_address: string, hop: number) => hop < config.trustProxyHops : false,
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: config.requestTimeoutMs,
    handlerTimeout: config.requestTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
    forceCloseConnections: "idle",
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 200 },
    ajv: { customOptions: { allErrors: false, coerceTypes: "array", removeAdditional: true, useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate("config", config);
  // Set early so every response carries it, including hijacked streams and errors.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // Order matters: infrastructure, then cross-cutting concerns, then routes.
  void app.register(sensible);
  void app.register(redisPlugin);
  void app.register(databasePlugin);
  void app.register(securityPlugin);
  void app.register(errorHandler);
  void app.register(swaggerPlugin);
  void app.register(authPlugin);
  void app.register(idempotencyPlugin);
  void app.register(paymentsPlugin);
  void app.register(metricsPlugin);

  void app.register(healthRoutes, { prefix: "/health" });
  void app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(setupRoutes, { prefix: "/setup" });
      await api.register(publicRoutes, { prefix: "/public" });
      await api.register(webhookRoutes, { prefix: "/webhooks" });
      await api.register(jobRoutes, { prefix: "/cron" });
      await api.register(
        async (management) => {
          await management.register(dashboardRoutes, { prefix: "/dashboard" });
          await management.register(eventRoutes, { prefix: "/events" });
          await management.register(reservationRoutes, { prefix: "/reservations" });
          await management.register(paymentRoutes, { prefix: "/payments" });
          await management.register(paymentExceptionRoutes, { prefix: "/payment-exceptions" });
          await management.register(roomRoutes, { prefix: "/rooms" });
          await management.register(staffRoutes, { prefix: "/staff" });
          await management.register(attendanceRoutes, { prefix: "/attendance" });
          await management.register(inventoryRoutes, { prefix: "/inventory" });
          await management.register(menuRoutes, { prefix: "/menu" });
          await management.register(posRoutes, { prefix: "/pos" });
          await management.register(settingsRoutes, { prefix: "/settings" });
          await management.register(referenceRoutes, { prefix: "/reference" });
        },
        { prefix: "/management" },
      );
    },
    { prefix: config.apiPrefix },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
