import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { Errors } from "../lib/errors.js";
import { hasPermission, type Permission } from "../lib/permissions.js";
import { SessionService } from "../modules/auth/session.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bearer-JWT authentication backed by revocable database sessions, plus
 * permission-based authorisation. Every protected request re-validates the
 * session (cached in Redis for up to 60s), so revocation and deactivation take
 * effect without waiting for the access token to expire.
 */
export default fp(
  async (app) => {
    const { jwt: jwtConfig } = app.config;

    await app.register(cookie, { hook: "onRequest" });
    await app.register(jwt, {
      secret: jwtConfig.accessSecret,
      sign: { algorithm: "HS256", iss: jwtConfig.issuer, aud: jwtConfig.audience, expiresIn: `${jwtConfig.accessTtlSeconds}s` },
      verify: { algorithms: ["HS256"], allowedIss: jwtConfig.issuer, allowedAud: jwtConfig.audience },
    });

    app.decorate("sessions", new SessionService(app.db, app.redis, app.log.child({ module: "sessions" }), app.config.session.refreshTtlSeconds));
    app.decorateRequest("principal", null);

    async function authenticate(request: FastifyRequest): Promise<void> {
      if (request.principal) return;
      let payload: { sub: string; sid: string };
      try {
        payload = await request.jwtVerify<{ sub: string; sid: string }>();
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED") throw Errors.unauthorized("Access token has expired", "TOKEN_EXPIRED");
        if (code === "FST_JWT_NO_AUTHORIZATION_IN_HEADER") throw Errors.unauthorized("Authentication required", "UNAUTHORIZED");
        throw Errors.unauthorized("Access token is invalid", "TOKEN_INVALID");
      }
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || !UUID.test(payload.sub) || !UUID.test(payload.sid)) {
        throw Errors.unauthorized("Access token is invalid", "TOKEN_INVALID");
      }
      const principal = await app.sessions.resolvePrincipal(payload.sid, payload.sub);
      if (!principal) throw Errors.unauthorized("Session is no longer valid", "SESSION_REVOKED");
      request.principal = principal;
    }

    app.decorate("authenticate", authenticate);
    app.decorate("authorize", (...permissions: Permission[]) => async (request: FastifyRequest) => {
      await authenticate(request);
      const principal = request.principal;
      if (!principal) throw Errors.unauthorized();
      if (principal.mustChangePassword && !request.routeOptions.config.allowPasswordChangeRequired) {
        throw Errors.forbidden("Change your temporary password before using the workspace", "PASSWORD_CHANGE_REQUIRED");
      }
      for (const permission of permissions) {
        if (!hasPermission(principal.role, permission)) throw Errors.forbidden();
      }
    });
  },
  { name: "auth", dependencies: ["database", "redis"] },
);
