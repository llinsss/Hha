import { createHmac, timingSafeEqual } from "node:crypto";
import { koboFrom } from "../../../lib/money.js";
import { providerRequest, record, text } from "./http.js";
import { ProviderError, REFERENCE_PATTERN, type PaymentProvider, type TransactionStatus, type VerifiedTransaction } from "./types.js";

const MAX_LIST_PAGES = 50;

function toStatus(value: string | null): TransactionStatus {
  if (value === "success") return "success";
  if (value === "failed" || value === "abandoned" || value === "reversed") return "failed";
  return "pending";
}

function toTransaction(data: Record<string, unknown>): VerifiedTransaction | null {
  const reference = text(data.reference);
  const id = text(data.id);
  if (!reference || !id) return null;
  return {
    provider: "paystack",
    reference,
    providerTransactionId: id,
    status: toStatus(text(data.status)),
    amountKobo: koboFrom(data.amount),
    currency: text(data.currency) ?? "",
  };
}

/** Paystack: amounts in kobo; webhooks signed with HMAC-SHA512 of the raw body using the secret key. */
export function createPaystack(config: { secretKey: string; baseUrl: string; timeoutMs: number }): PaymentProvider {
  const request = (path: string, method: "GET" | "POST" = "GET", body?: unknown) =>
    providerRequest(`${config.baseUrl}${path}`, { method, body, secretKey: config.secretKey, timeoutMs: config.timeoutMs });

  return {
    name: "paystack",

    async initializeCheckout(input) {
      const response = await request("/transaction/initialize", "POST", {
        email: input.email,
        amount: input.amountKobo,
        currency: "NGN",
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: { reservation_reference: input.reference, guest_name: input.name },
      });
      const url = text(record(response.body?.data)?.authorization_url);
      if (response.status !== 200 || response.body?.status !== true || !url?.startsWith("https://")) {
        throw new ProviderError("Paystack did not return a checkout URL", false);
      }
      return { checkoutUrl: url };
    },

    async verify(reference) {
      const response = await request(`/transaction/verify/${encodeURIComponent(reference)}`);
      if (response.status === 404 || (response.status === 400 && response.body?.status === false)) return null;
      const data = record(response.body?.data);
      const transaction = data ? toTransaction(data) : null;
      if (response.status !== 200 || response.body?.status !== true || !transaction) throw new ProviderError("Paystack verification response was invalid", true);
      return transaction;
    },

    isAuthenticWebhook(rawBody, headers) {
      const signature = headers["x-paystack-signature"];
      if (typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return false;
      const expected = createHmac("sha512", config.secretKey).update(rawBody).digest();
      return timingSafeEqual(expected, Buffer.from(signature, "hex"));
    },

    parseWebhook(payload) {
      const event = record(payload);
      const data = record(event?.data);
      const reference = text(data?.reference);
      const id = text(data?.id);
      if (event?.event !== "charge.success" || !reference || !id || !REFERENCE_PATTERN.test(reference)) return null;
      return { reference, outcome: "success", eventId: `paystack:${id}:charge.success` };
    },

    async *listSuccessful(from, to) {
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ status: "success", from: from.toISOString(), to: to.toISOString(), perPage: "100", page: String(page) });
        const response = await request(`/transaction?${query.toString()}`);
        const items = response.body?.data;
        if (response.status !== 200 || response.body?.status !== true || !Array.isArray(items)) throw new ProviderError("Paystack transaction list was invalid", true);
        for (const item of items) {
          const data = record(item);
          const transaction = data ? toTransaction(data) : null;
          if (transaction && REFERENCE_PATTERN.test(transaction.reference)) yield transaction;
        }
        const pageCount = Number(record(response.body?.meta)?.pageCount ?? 1);
        if (!Number.isFinite(pageCount) || page >= pageCount) return;
      }
    },
  };
}
