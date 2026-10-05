import type { preHandlerAsyncHookHandler } from "fastify";
import type { Redis } from "ioredis";
import type { DataSource } from "typeorm";
import type { AppConfig } from "../config/env.js";
import type { Permission } from "../lib/permissions.js";
import type { Principal, SessionService } from "../modules/auth/session.service.js";
import type { PaymentProvider } from "../modules/payments/providers/index.js";
import type { IdempotencyOptions, IdempotencyState } from "../plugins/idempotency.js";
import type { AppMetrics } from "../plugins/metrics.js";

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: DataSource;
    redis: Redis;
    sessions: SessionService;
    /** The configured payment provider, or null when online payment is disabled. */
    paymentProvider: PaymentProvider | null;
    metrics: AppMetrics;
    /** Verifies the bearer access token and loads `request.principal`. */
    authenticate: preHandlerAsyncHookHandler;
    /** Authenticates, enforces the temporary-password gate, then checks every listed permission. */
    authorize: (...permissions: Permission[]) => preHandlerAsyncHookHandler;
    /** Route preHandler enabling `Idempotency-Key` replay protection. Place it after `authorize`. */
    idempotent: (options?: IdempotencyOptions) => preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    principal: Principal | null;
    idempotency: IdempotencyState | null;
  }

  interface FastifyContextConfig {
    /** Allow this route while the user still has to replace a temporary password. */
    allowPasswordChangeRequired?: boolean;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string; iat?: number; exp?: number };
  }
}
