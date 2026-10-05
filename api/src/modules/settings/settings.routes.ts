import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { FastifyReply } from "fastify";
import { Type } from "typebox";
import { Errors } from "../../lib/errors.js";
import { Nullable, StringEnum, Timestamp, errorResponses } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";
import { SETTING_KEYS } from "./settings.registry.js";

const security = [{ bearerAuth: [] }];

const SettingView = Type.Object({
  key: Type.String(),
  group: Type.String(),
  label: Type.String(),
  description: Type.String(),
  type: Type.String(),
  secret: Type.Boolean(),
  value: Type.Union([Type.String(), Type.Integer(), Type.Null()]),
  configured: Type.Boolean(),
  hint: Nullable(Type.String()),
  readable: Type.Boolean(),
  default: Type.Union([Type.String(), Type.Integer(), Type.Null()]),
  options: Nullable(Type.Array(Type.Object({ value: Type.String(), label: Type.String() }))),
  provider: Nullable(Type.String()),
  minimum: Nullable(Type.Integer()),
  maximum: Nullable(Type.Integer()),
  updatedAt: Timestamp,
  updatedBy: Nullable(Type.String()),
});

const SettingsResponse = Type.Object({
  settings: Type.Array(SettingView),
  environment: Type.Object({
    publicWebUrl: Nullable(Type.String()),
    webhookUrl: Nullable(Type.String({ description: "Paste into the payment provider dashboard" })),
  }),
});

/**
 * Owner-only global settings (permission `settings:manage`, held only by the
 * owner). Secret values are write-only: responses show whether a key is set
 * and its last four characters, never the key.
 */
const settingsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const environment = () => {
    const publicWebUrl = app.config.payments.publicWebUrl;
    return { publicWebUrl, webhookUrl: publicWebUrl ? `${publicWebUrl}${app.config.apiPrefix}/webhooks/payments` : null };
  };
  const respond = async (reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    return { settings: await app.settings.list(), environment: environment() };
  };

  app.get(
    "/",
    {
      preHandler: app.authorize("settings:manage"),
      schema: { tags: ["settings"], summary: "Global settings (owner only)", security, response: { 200: SettingsResponse, ...errorResponses(401, 403) } },
    },
    async (_request, reply) => respond(reply),
  );

  app.patch(
    "/",
    {
      preHandler: app.authorize("settings:manage"),
      config: { rateLimit: { max: 20, timeWindow: 60_000 } },
      schema: {
        tags: ["settings"],
        summary: "Change global settings (owner only)",
        description:
          "`changes` maps setting keys to new values. For secrets a string replaces the stored key and null clears it; for other settings null restores the default. The selected payment provider must end up fully configured.",
        security,
        body: Type.Object(
          {
            changes: Type.Record(StringEnum(SETTING_KEYS), Type.Union([Type.String({ maxLength: 200 }), Type.Integer(), Type.Null()]), {
              minProperties: 1,
              maxProperties: SETTING_KEYS.length,
            }),
          },
          { additionalProperties: false },
        ),
        response: { 200: SettingsResponse, ...errorResponses(401, 403, 422) },
      },
    },
    async (request, reply) => {
      await app.settings.update(requirePrincipal(request), request.body.changes, { publicWebUrl: app.config.payments.publicWebUrl });
      request.log.info({ keys: Object.keys(request.body.changes) }, "settings updated");
      return respond(reply);
    },
  );

  app.post(
    "/payments/verify",
    {
      preHandler: app.authorize("settings:manage"),
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
      schema: {
        tags: ["settings"],
        summary: "Check the saved payment provider credentials with the provider",
        security,
        response: { 200: Type.Object({ ok: Type.Literal(true), provider: Type.String() }), ...errorResponses(401, 403, 409, 422, 502) },
      },
    },
    async () => {
      const provider = await app.payments.provider();
      if (!provider) throw Errors.conflict("Online payments are turned off", "PAYMENTS_DISABLED");
      if (!(await provider.verifyCredentials())) throw Errors.unprocessable(`${provider.name} rejected the saved secret key`, "PROVIDER_REJECTED_CREDENTIALS");
      return { ok: true as const, provider: provider.name };
    },
  );
};

export default settingsRoutes;
