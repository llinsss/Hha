import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import { withConnection, withTransaction } from "../../db/sql.js";
import { sha256Hex } from "../../lib/crypto.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from "../../lib/password.js";
import { Text, errorResponses } from "../../lib/schemas.js";
import { optionalText } from "../../lib/text.js";

/** Arbitrary, fixed advisory-lock key serialising concurrent setup attempts. */
const SETUP_LOCK_KEY = 8_142_026;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * One-time bootstrap of the first property and owner (PRD §7). Allowed with the
 * `x-setup-secret` header, or from the loopback interface in development.
 * Closes permanently once any user exists.
 */
const setupRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const secretDigest = app.config.setupSecret ? Buffer.from(sha256Hex(app.config.setupSecret), "hex") : null;
  const localDevelopment = (request: FastifyRequest) => app.config.env === "development" && LOOPBACK.has(request.ip);

  app.get(
    "/",
    {
      schema: {
        tags: ["setup"],
        summary: "Whether initial setup is required and enabled",
        response: { 200: Type.Object({ setupRequired: Type.Boolean(), setupEnabled: Type.Boolean() }), ...errorResponses(429) },
      },
    },
    async (request) => {
      const exists = await withConnection(app.db, (sql) => sql.one<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM users) AS exists`));
      return { setupRequired: !exists.exists, setupEnabled: secretDigest !== null || localDevelopment(request) };
    },
  );

  app.post(
    "/",
    {
      config: { rateLimit: { max: 5, timeWindow: 15 * 60_000 } },
      schema: {
        tags: ["setup"],
        summary: "Create the first property and owner account",
        headers: Type.Object({ "x-setup-secret": Type.Optional(Type.String({ maxLength: 512 })) }),
        body: Type.Object(
          {
            propertyName: Type.Optional(Text(120)),
            fullName: Text(120),
            email: Type.String({ format: "email", maxLength: 254 }),
            password: Type.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ ok: Type.Literal(true), userId: Type.String() }), ...errorResponses(403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const supplied = request.headers["x-setup-secret"];
      const bySecret = secretDigest !== null && typeof supplied === "string" && timingSafeEqual(Buffer.from(sha256Hex(supplied), "hex"), secretDigest);
      // A key that is sent must be right; the loopback convenience only applies when none is sent.
      const allowed = supplied === undefined ? localDevelopment(request) : bySecret;
      if (!allowed) throw Errors.forbidden("Setup authorization failed", "SETUP_FORBIDDEN");

      const body = request.body;
      const fullName = body.fullName.trim();
      const propertyName = optionalText(body.propertyName) ?? "Houzz Hills Kaduna";
      if (!fullName) throw Errors.unprocessable("Enter your full name", "VALIDATION_FAILED");
      const passwordHash = await hashPassword(body.password);

      const userId = await withTransaction(app.db, async (tx) => {
        await tx.rows(`SELECT pg_advisory_xact_lock($1)`, [SETUP_LOCK_KEY]);
        const exists = await tx.one<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM users) AS exists`);
        if (exists.exists) throw Errors.conflict("Initial setup is already complete", "SETUP_COMPLETE");
        const property = await tx.one<{ id: string }>(`INSERT INTO properties(name) VALUES ($1) RETURNING id`, [propertyName]);
        const user = await tx.one<{ id: string }>(
          `INSERT INTO users(property_id, email, full_name, password_hash, role) VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
          [property.id, body.email.trim().toLowerCase(), fullName, passwordHash],
        );
        await recordEvent(tx, {
          propertyId: property.id,
          actorId: user.id,
          action: "setup.completed",
          entityType: "property",
          entityId: property.id,
          details: { via: bySecret ? "setup_secret" : "local_development" },
          outbox: false,
        });
        return user.id;
      });
      request.log.info({ userId }, "initial owner setup completed");
      return reply.status(201).send({ ok: true as const, userId });
    },
  );
};

export default setupRoutes;
