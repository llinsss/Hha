import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyRequest } from "fastify";
import { Type } from "typebox";
import { sha256Hex } from "../../lib/crypto.js";
import { Errors } from "../../lib/errors.js";
import { errorResponses } from "../../lib/schemas.js";
import { expireAllLapsedHolds } from "./holds.service.js";
import { reconcilePayments } from "./reconciliation.service.js";

/**
 * Scheduler-only endpoints (PRD §7). Authenticated with `Authorization: Bearer
 * <CRON_SECRET>`; when no secret is configured every call is rejected.
 */
const jobRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const secret = app.config.jobs.cronSecret;
  const expected = secret ? Buffer.from(sha256Hex(secret), "hex") : null;

  async function requireScheduler(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Compare digests so timing does not depend on the secret's length or content.
    if (!expected || !supplied || !timingSafeEqual(Buffer.from(sha256Hex(supplied), "hex"), expected)) {
      throw Errors.unauthorized("Scheduler authentication required", "UNAUTHORIZED");
    }
  }

  const common = { preHandler: requireScheduler, config: { rateLimit: { max: 30, timeWindow: 60_000 } } };

  app.post(
    "/expire-payment-holds",
    {
      ...common,
      schema: {
        tags: ["jobs"],
        summary: "Expire lapsed checkout holds",
        description: "Releases rooms held by unpaid checkouts past their expiry and fails their pending online payments. Call every few minutes.",
        security: [{ schedulerToken: [] }],
        response: { 200: Type.Object({ expired: Type.Integer() }), ...errorResponses(401, 429) },
      },
    },
    async () => ({ expired: await expireAllLapsedHolds(app) }),
  );

  app.post(
    "/reconcile-payments",
    {
      ...common,
      schema: {
        tags: ["jobs"],
        summary: "Reconcile provider settlements and queue stale transfers",
        security: [{ schedulerToken: [] }],
        response: {
          200: Type.Object({
            window: Type.Object({ from: Type.String(), to: Type.String() }),
            providerTransactions: Type.Integer(),
            outcomes: Type.Record(Type.String(), Type.Integer()),
            unresolvedTransfersQueued: Type.Integer(),
          }),
          ...errorResponses(401, 429, 502),
        },
      },
    },
    async () => reconcilePayments(app),
  );
};

export default jobRoutes;
