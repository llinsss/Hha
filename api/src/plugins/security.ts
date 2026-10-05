import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import underPressure from "@fastify/under-pressure";
import fp from "fastify-plugin";
import { AppError } from "../lib/errors.js";

/**
 * HTTP hardening: security headers, credentialed CORS restricted to an explicit
 * origin allowlist, Redis-backed rate limiting shared by every replica, and
 * load shedding when the event loop is saturated.
 */
export default fp(
  async (app) => {
    const { config } = app;
    const allowedOrigins = new Set(config.corsOrigins);

    await app.register(helmet, {
      global: true,
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    });

    await app.register(cors, {
      // Requests without an Origin header are not browser CORS requests.
      origin: (origin, callback) => callback(null, origin === undefined || allowedOrigins.has(origin)),
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "Retry-After", "Idempotent-Replayed", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
      maxAge: 600,
      strictPreflight: true,
    });

    await app.register(rateLimit, {
      global: true,
      max: config.rateLimit.max,
      timeWindow: config.rateLimit.windowMs,
      redis: app.redis,
      nameSpace: "rl:",
      // A Redis outage must not take the API down; health checks report it.
      skipOnError: true,
      keyGenerator: (request) => request.ip,
      allowList: (request) => request.url.startsWith("/health/"),
      errorResponseBuilder: (_request, context) =>
        new AppError(429, "RATE_LIMITED", `Too many requests. Retry in ${context.after}.`),
    });

    await app.register(underPressure, {
      maxEventLoopDelay: 1_000,
      maxEventLoopUtilization: 0.98,
      retryAfter: 10,
      exposeStatusRoute: false,
    });
  },
  { name: "security", dependencies: ["redis"] },
);
