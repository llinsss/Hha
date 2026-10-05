import type { IncomingHttpHeaders } from "node:http";

export type ProviderName = "paystack" | "flutterwave";

/** Provider-reported state of a transaction, normalised. */
export type TransactionStatus = "success" | "failed" | "pending";

/** A transaction as reported by the provider's server API (never by a webhook body). */
export type VerifiedTransaction = Readonly<{
  provider: ProviderName;
  reference: string;
  providerTransactionId: string;
  status: TransactionStatus;
  /** Null when the provider returned an amount that is not an exact kobo value. */
  amountKobo: number | null;
  currency: string;
}>;

/** What an authenticated webhook claims happened; always re-verified server-to-server. */
export type WebhookClaim = Readonly<{ reference: string; outcome: "success" | "failed"; eventId: string }>;

export type CheckoutInput = Readonly<{ reference: string; amountKobo: number; email: string; name: string; callbackUrl: string }>;

export interface PaymentProvider {
  readonly name: ProviderName;
  initializeCheckout(input: CheckoutInput): Promise<{ checkoutUrl: string }>;
  /** Null when the provider has no transaction with this reference. */
  verify(reference: string): Promise<VerifiedTransaction | null>;
  isAuthenticWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Null for authentic events that are irrelevant to payments. */
  parseWebhook(payload: unknown): WebhookClaim | null;
  /** Successful transactions created in [from, to], for settlement reconciliation. */
  listSuccessful(from: Date, to: Date): AsyncGenerator<VerifiedTransaction>;
}

/** Our reservation references (`HH-…`); anything else from a provider is ignored. */
export const REFERENCE_PATTERN = /^HH-[A-Z0-9-]{8,64}$/;

export class ProviderError extends Error {
  constructor(
    message: string,
    /** True when retrying later may succeed (network failure, timeout, 429, 5xx). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
