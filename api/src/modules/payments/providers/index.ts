import type { AppConfig } from "../../../config/env.js";
import { createFlutterwave } from "./flutterwave.js";
import { createPaystack } from "./paystack.js";
import type { PaymentProvider } from "./types.js";

export * from "./types.js";

/** The single provider configured for this environment (PRD §5), or null when online payment is off. */
export function createPaymentProvider(config: AppConfig): PaymentProvider | null {
  const provider = config.payments.provider;
  if (!provider) return null;
  const timeoutMs = config.payments.timeoutMs;
  return provider.name === "paystack"
    ? createPaystack({ secretKey: provider.secretKey, baseUrl: provider.baseUrl, timeoutMs })
    : createFlutterwave({ secretKey: provider.secretKey, webhookHash: provider.webhookHash, baseUrl: provider.baseUrl, timeoutMs });
}
