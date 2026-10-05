import type { FastifyInstance } from "fastify";
import { withTransaction } from "../../db/sql.js";
import { applyProviderTransaction, raiseException, type ProviderOutcome } from "../payments/ledger.js";

export type ReconciliationReport = {
  window: { from: string; to: string };
  providerTransactions: number;
  outcomes: Partial<Record<ProviderOutcome, number>>;
  unresolvedTransfersQueued: number;
};

/**
 * Settlement reconciliation (PRD §7, "do not rely on webhook delivery alone").
 * Every successful provider transaction in the window is applied through the
 * same idempotent ledger path as webhooks, so a missed webhook still settles
 * and mismatches become exceptions. Bank transfers left pending past the review
 * window are queued for owner/manager follow-up.
 */
export async function reconcilePayments(app: FastifyInstance): Promise<ReconciliationReport> {
  const to = new Date();
  const from = new Date(to.getTime() - app.config.jobs.reconciliationWindowHours * 3_600_000);
  const outcomes: Partial<Record<ProviderOutcome, number>> = {};
  let providerTransactions = 0;

  const provider = await app.payments.provider();
  const settings = await app.settings.current();
  if (provider) {
    for await (const transaction of provider.listSuccessful(from, to)) {
      providerTransactions += 1;
      const outcome = await withTransaction(app.db, (tx) => applyProviderTransaction(tx, transaction));
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
  }

  const unresolvedTransfersQueued = await withTransaction(app.db, async (tx) => {
    const stale = await tx.rows<{ property_id: string; payment_id: string | null; pos_order_id: string | null; reservation_id: string | null; reference: string; amount_kobo: string }>(
      `SELECT p.property_id, p.id AS payment_id, NULL::uuid AS pos_order_id, p.reservation_id, r.reference, p.amount_kobo::text
         FROM payments p JOIN reservations r ON r.id = p.reservation_id
        WHERE p.method = 'bank_transfer' AND p.status = 'pending' AND p.created_at < now() - make_interval(hours => $1)
       UNION ALL
       SELECT o.property_id, NULL, o.id, NULL, o.receipt_number, o.total_kobo::text
         FROM pos_orders o
        WHERE o.payment_method = 'bank_transfer' AND o.payment_status = 'pending' AND o.status <> 'voided'
          AND o.created_at < now() - make_interval(hours => $1)`,
      [settings.bankTransferReviewHours],
    );
    let queued = 0;
    for (const transfer of stale) {
      const raised = await raiseException(tx, {
        propertyId: transfer.property_id,
        kind: "unresolved_bank_transfer",
        dedupeKey: `unresolved_bank_transfer:${transfer.payment_id ?? transfer.pos_order_id ?? ""}`,
        paymentId: transfer.payment_id,
        posOrderId: transfer.pos_order_id,
        reservationId: transfer.reservation_id,
        providerReference: transfer.reference,
        expectedAmountKobo: transfer.amount_kobo,
      });
      if (raised) queued += 1;
    }
    return queued;
  });

  return { window: { from: from.toISOString(), to: to.toISOString() }, providerTransactions, outcomes, unresolvedTransfersQueued };
}
