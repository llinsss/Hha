import { randomUUID } from "node:crypto";
import sensible from "@fastify/sensible";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config/env.js";
import authRoutes from "./modules/auth/auth.routes.js";
import healthRoutes from "./modules/health/health.routes.js";
import authPlugin from "./plugins/auth.js";
import databasePlugin from "./plugins/database.js";
import errorHandler from "./plugins/error-handler.js";
import idempotencyPlugin from "./plugins/idempotency.js";
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
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
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

  void app.register(healthRoutes, { prefix: "/health" });
  void app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: "/auth" });
      // Register further feature modules here, e.g. api.register(roomRoutes, { prefix: "/rooms" }).
    },
    { prefix: config.apiPrefix },
  );

  return app;
}

export type App = ReturnType<typeof buildApp>;
