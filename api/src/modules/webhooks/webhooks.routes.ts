import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import secureJson from "secure-json-parse";
import { Type } from "typebox";
import { Errors } from "../../lib/errors.js";
import { errorResponses } from "../../lib/schemas.js";
import { processWebhook } from "./webhook.service.js";

const WEBHOOK_BODY_LIMIT = 256 * 1024;

const WebhookSchema = {
  tags: ["webhooks"],
  summary: "Payment provider webhook (Paystack or Flutterwave)",
  description:
    "Authenticated by the provider signature (`x-paystack-signature` HMAC-SHA512, or Flutterwave `verif-hash`) over the raw body. Successful payments are re-verified with the provider before settlement. Duplicates return 2xx without side effects.",
  response: {
    200: Type.Object({ received: Type.Literal(true), duplicate: Type.Optional(Type.Boolean()), ignored: Type.Optional(Type.Boolean()) }),
    ...errorResponses(400, 401, 502, 503),
  },
};

const webhookRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // The signature covers the exact bytes received, so this scope keeps the raw body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/payments", { schema: WebhookSchema, config: { rateLimit: { max: 600, timeWindow: 60_000 } } }, async (request) => {
    const provider = await app.payments.provider();
    if (!provider) throw Errors.unavailable("Online payments are not configured", "PAYMENTS_UNAVAILABLE");
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) throw Errors.badRequest("Expected a JSON body", "INVALID_WEBHOOK");
    if (!provider.isAuthenticWebhook(raw, request.headers)) {
      request.log.warn({ provider: provider.name }, "rejected webhook with invalid signature");
      app.metrics.webhookEvents.inc({ outcome: "invalid_signature" });
      throw Errors.unauthorized("Invalid webhook signature", "INVALID_SIGNATURE");
    }
    let payload: unknown;
    try {
      payload = secureJson.parse(raw.toString("utf8"), undefined, { protoAction: "error", constructorAction: "error" });
    } catch {
      throw Errors.badRequest("Webhook body is not valid JSON", "INVALID_WEBHOOK");
    }
    const claim = provider.parseWebhook(payload);
    if (!claim) {
      app.metrics.webhookEvents.inc({ outcome: "ignored" });
      return { received: true as const, ignored: true };
    }
    const result = await processWebhook(app, provider, claim).catch((error: unknown) => {
      app.metrics.webhookEvents.inc({ outcome: "error" });
      throw error;
    });
    app.metrics.webhookEvents.inc({ outcome: result.duplicate ? "duplicate" : result.outcome });
    request.log.info({ eventId: claim.eventId, outcome: result.outcome, duplicate: result.duplicate }, "payment webhook processed");
    return result.duplicate ? { received: true as const, duplicate: true } : { received: true as const };
  });
};

export default webhookRoutes;
