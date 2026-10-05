import fp from "fastify-plugin";
import { createPaymentProvider, type PaymentProvider } from "../modules/payments/providers/index.js";
import type { GlobalSettings } from "../modules/settings/settings.registry.js";
import { SettingsService } from "../modules/settings/settings.service.js";

/**
 * Global settings and the payment provider derived from them. The provider is
 * rebuilt only when the settings change, so keys rotated by the owner take
 * effect on the next request without a restart.
 */
export default fp(
  async (app) => {
    const settings = new SettingsService(app.db, app.redis, app.config.settingsEncryptionKey, app.log.child({ module: "settings" }));
    let built: { from: GlobalSettings; provider: PaymentProvider | null } | null = null;
    app.decorate("settings", settings);
    app.decorate("payments", {
      async provider() {
        const current = await settings.current();
        if (built?.from !== current) built = { from: current, provider: createPaymentProvider(current, app.config) };
        return built.provider;
      },
    });
  },
  { name: "payments", dependencies: ["database", "redis"] },
);
