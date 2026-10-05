import type { AppConfig } from "../../../config/env.js";
import type { GlobalSettings } from "../../settings/settings.registry.js";
import { createFlutterwave } from "./flutterwave.js";
import { createPaystack } from "./paystack.js";
import type { PaymentProvider } from "./types.js";

export * from "./types.js";

/**
 * The provider selected in the owner's settings (PRD §5: one provider per
 * environment), or null when online payment is off or not fully configured.
 */
export function createPaymentProvider(settings: GlobalSettings, config: AppConfig): PaymentProvider | null {
  const timeoutMs = config.payments.timeoutMs;
  if (settings.provider === "paystack" && settings.paystackSecretKey) {
    return createPaystack({ secretKey: settings.paystackSecretKey, baseUrl: config.payments.paystackBaseUrl, timeoutMs });
  }
  if (settings.provider === "flutterwave" && settings.flutterwaveSecretKey && settings.flutterwaveWebhookHash) {
    return createFlutterwave({
      secretKey: settings.flutterwaveSecretKey,
      webhookHash: settings.flutterwaveWebhookHash,
      baseUrl: config.payments.flutterwaveBaseUrl,
      timeoutMs,
    });
  }
  return null;
}
