import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fp from "fastify-plugin";
import { ErrorResponse } from "../lib/schemas.js";
import { REFRESH_COOKIE } from "../modules/auth/cookies.js";

/**
 * OpenAPI 3.1 generated from route schemas, so the contract cannot drift from
 * the validation that actually runs. Served at /openapi.json and /docs when
 * DOCS_ENABLED (default: on outside production).
 */
export default fp(
  async (app) => {
    app.addSchema(ErrorResponse);

    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Houzz Hills API",
          version: "1.0.0",
          description: "Backend API for the Houzz Hills management workspace and public booking flow. Money is integer kobo (NGN).",
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            refreshCookie: { type: "apiKey", in: "cookie", name: REFRESH_COOKIE },
          },
        },
        tags: [
          { name: "health", description: "Liveness and readiness probes" },
          { name: "auth", description: "Staff authentication and sessions" },
        ],
      },
      refResolver: { buildLocalReference: (json, _baseUri, _fragment, index) => (typeof json.$id === "string" ? json.$id : `def-${index}`) },
    });

    if (!app.config.docsEnabled) return;

    app.get("/openapi.json", { schema: { hide: true }, config: { rateLimit: false } }, () => app.swagger());
    await app.register(swaggerUi, {
      routePrefix: "/docs",
      staticCSP: true,
      uiConfig: { deepLinking: true, persistAuthorization: false },
    });
  },
  { name: "swagger" },
);
