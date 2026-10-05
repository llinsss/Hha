import { createHash, timingSafeEqual } from "node:crypto";
import { nairaToKobo } from "../../../lib/money.js";
import { providerRequest, record, text } from "./http.js";
import { ProviderError, REFERENCE_PATTERN, type PaymentProvider, type TransactionStatus, type VerifiedTransaction } from "./types.js";

const MAX_LIST_PAGES = 50;

function toStatus(value: string | null): TransactionStatus {
  if (value === "successful") return "success";
  if (value === "failed" || value === "cancelled") return "failed";
  return "pending";
}

function toTransaction(data: Record<string, unknown>): VerifiedTransaction | null {
  const reference = text(data.tx_ref);
  const id = text(data.id);
  if (!reference || !id) return null;
  return {
    provider: "flutterwave",
    reference,
    providerTransactionId: id,
    status: toStatus(text(data.status)),
    amountKobo: nairaToKobo(data.amount),
    currency: text(data.currency) ?? "",
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Flutterwave v3: amounts in naira; webhooks carry the dashboard secret hash in `verif-hash`. */
export function createFlutterwave(config: { secretKey: string; webhookHash: string; baseUrl: string; timeoutMs: number }): PaymentProvider {
  const request = (path: string, method: "GET" | "POST" = "GET", body?: unknown) =>
    providerRequest(`${config.baseUrl}${path}`, { method, body, secretKey: config.secretKey, timeoutMs: config.timeoutMs });
  const expectedHash = digest(config.webhookHash);

  return {
    name: "flutterwave",

    async initializeCheckout(input) {
      const response = await request("/v3/payments", "POST", {
        tx_ref: input.reference,
        amount: input.amountKobo / 100,
        currency: "NGN",
        redirect_url: input.callbackUrl,
        customer: { email: input.email, name: input.name },
        customizations: { title: "Houzz Hills Kaduna", description: `Reservation ${input.reference}` },
        meta: { reservation_reference: input.reference },
      });
      const url = text(record(response.body?.data)?.link);
      if (response.status !== 200 || response.body?.status !== "success" || !url?.startsWith("https://")) {
        throw new ProviderError("Flutterwave did not return a checkout URL", false);
      }
      return { checkoutUrl: url };
    },

    async verify(reference) {
      const response = await request(`/v3/transactions/verify_by_reference?${new URLSearchParams({ tx_ref: reference }).toString()}`);
      if (response.status === 404 || (response.status === 400 && response.body?.status === "error")) return null;
      const data = record(response.body?.data);
      const transaction = data ? toTransaction(data) : null;
      if (response.status !== 200 || response.body?.status !== "success" || !transaction) throw new ProviderError("Flutterwave verification response was invalid", true);
      return transaction;
    },

    isAuthenticWebhook(_rawBody, headers) {
      const supplied = headers["verif-hash"];
      // Hash both sides so the comparison is constant-time regardless of length.
      return typeof supplied === "string" && supplied.length > 0 && timingSafeEqual(digest(supplied), expectedHash);
    },

    parseWebhook(payload) {
      const event = record(payload);
      const data = record(event?.data);
      const reference = text(data?.tx_ref);
      const id = text(data?.id);
      const status = toStatus(text(data?.status));
      if (event?.event !== "charge.completed" || !reference || !id || !REFERENCE_PATTERN.test(reference) || status === "pending") return null;
      return { reference, outcome: status, eventId: `flutterwave:${id}:${status}` };
    },

    async *listSuccessful(from, to) {
      for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), status: "successful", page: String(page) });
        const response = await request(`/v3/transactions?${query.toString()}`);
        const items = response.body?.data;
        if (response.status !== 200 || response.body?.status !== "success" || !Array.isArray(items)) throw new ProviderError("Flutterwave transaction list was invalid", true);
        for (const item of items) {
          const data = record(item);
          const transaction = data ? toTransaction(data) : null;
          if (transaction && REFERENCE_PATTERN.test(transaction.reference)) yield transaction;
        }
        const totalPages = Number(record(record(response.body?.meta)?.page_info)?.total_pages ?? 1);
        if (!Number.isFinite(totalPages) || page >= totalPages) return;
      }
    },
  };
}
