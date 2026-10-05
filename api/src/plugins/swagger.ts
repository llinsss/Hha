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
          description:
            "Backend API for the Houzz Hills management workspace and public booking flow. Money is integer kobo (NGN) serialised as strings; business dates are Africa/Lagos. Errors use the ErrorResponse envelope: 401 unauthenticated, 403 forbidden, 404 missing, 409 state conflict, 422 invalid input, 429 rate limited, 5xx service failure.",
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            refreshCookie: { type: "apiKey", in: "cookie", name: REFRESH_COOKIE },
            schedulerToken: { type: "http", scheme: "bearer", description: "CRON_SECRET, for the hosting scheduler only" },
          },
        },
        tags: [
          { name: "health", description: "Liveness and readiness probes" },
          { name: "auth", description: "Staff authentication and sessions" },
          { name: "setup", description: "One-time owner bootstrap" },
          { name: "public", description: "Guest availability, booking and payment status (no login, rate limited)" },
          { name: "webhooks", description: "Payment provider callbacks" },
          { name: "jobs", description: "Scheduler-only maintenance and reconciliation" },
          { name: "dashboard", description: "Owner/manager snapshot" },
          { name: "events", description: "Live property updates" },
          { name: "reservations", description: "Stays, status changes and staff-collected payments" },
          { name: "payments", description: "Payment register, transfer confirmation and exceptions" },
          { name: "rooms", description: "Room inventory and state" },
          { name: "staff", description: "Staff onboarding and accounts" },
          { name: "attendance", description: "Clock in/out" },
          { name: "inventory", description: "Stock items and movements" },
          { name: "menu", description: "Restaurant menu and recipes" },
          { name: "pos", description: "Restaurant sales, receipts and cashier shifts" },
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
