import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors.js";
import { requirePrincipal } from "./principal.js";
import { AuthService } from "./auth.service.js";
import { ChangePasswordSchema, LoginSchema, LogoutSchema, RefreshSchema, SessionSchema } from "./auth.schemas.js";
import { REFRESH_COOKIE, assertTrustedOrigin, clearRefreshCookie, setRefreshCookie } from "./cookies.js";
import type { Principal, SessionMeta } from "./session.service.js";

function meta(request: FastifyRequest): SessionMeta {
  return { userAgent: request.headers["user-agent"], ipAddress: request.ip };
}

function toUser(principal: Principal) {
  return {
    id: principal.userId,
    email: principal.email,
    fullName: principal.fullName,
    role: principal.role,
    propertyId: principal.propertyId,
    mustChangePassword: principal.mustChangePassword,
  };
}

const authRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const auth = new AuthService(app);
  const { config } = app;
  const strictLimit = { max: config.rateLimit.authMax, timeWindow: config.rateLimit.authWindowMs };

  app.post("/login", { schema: LoginSchema, config: { rateLimit: strictLimit } }, async (request, reply) => {
    const result = await auth.login(request.body.email, request.body.password, meta(request));
    setRefreshCookie(reply, config, result.session.refreshToken, result.session.expiresAt);
    reply.header("cache-control", "no-store");
    return {
      accessToken: result.accessToken,
      tokenType: "Bearer" as const,
      expiresIn: config.jwt.accessTtlSeconds,
      user: toUser(result.principal),
    };
  });

  app.post("/refresh", { schema: RefreshSchema, config: { rateLimit: strictLimit } }, async (request, reply) => {
    assertTrustedOrigin(request, config);
    try {
      const result = await auth.refresh(request.cookies[REFRESH_COOKIE], meta(request));
      if (result.refreshToken) setRefreshCookie(reply, config, result.refreshToken, result.expiresAt);
      reply.header("cache-control", "no-store");
      return {
        accessToken: result.accessToken,
        tokenType: "Bearer" as const,
        expiresIn: config.jwt.accessTtlSeconds,
        user: toUser(result.principal),
      };
    } catch (error) {
      // Only a definitively rejected token clears the cookie; transient failures keep it for a retry.
      if (error instanceof AppError && error.statusCode === 401) clearRefreshCookie(reply, config);
      throw error;
    }
  });

  app.post("/logout", { schema: LogoutSchema }, async (request, reply) => {
    assertTrustedOrigin(request, config);
    await auth.logout(request.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, config);
    return reply.status(204).send(null);
  });

  app.get(
    "/session",
    { schema: SessionSchema, config: { allowPasswordChangeRequired: true } },
    async (request, reply) => {
      if (request.headers.authorization === undefined) return { user: null };
      await app.authenticate.call(app, request, reply);
      return { user: toUser(requirePrincipal(request)) };
    },
  );

  app.post(
    "/password",
    {
      schema: ChangePasswordSchema,
      preHandler: app.authorize(),
      config: { allowPasswordChangeRequired: true, rateLimit: strictLimit },
    },
    async (request, reply) => {
      await auth.changePassword(requirePrincipal(request), request.body.currentPassword, request.body.newPassword);
      return reply.status(204).send(null);
    },
  );
};

export default authRoutes;
