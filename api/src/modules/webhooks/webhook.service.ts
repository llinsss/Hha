import type { FastifyInstance } from "fastify";
import { withConnection, withTransaction } from "../../db/sql.js";
import { recordEvent } from "../../lib/events.js";
import { applyProviderTransaction, raiseException, type ProviderOutcome } from "../payments/ledger.js";
import type { PaymentProvider, WebhookClaim } from "../payments/providers/index.js";

export type WebhookResult = { duplicate: boolean; outcome: ProviderOutcome | "ignored" };

/**
 * Applies an authenticated provider webhook (PRD §4.1 steps 4–6).
 *
 * The webhook body is only a hint: the transaction is re-fetched from the
 * provider's server API and only that response is trusted for status, amount,
 * currency and reference. Events are processed exactly once (keyed by provider
 * event id inside the same transaction as the ledger change), so duplicates and
 * retries are acknowledged without side effects. Provider errors propagate so
 * the provider retries later.
 */
export async function processWebhook(app: FastifyInstance, provider: PaymentProvider, claim: WebhookClaim): Promise<WebhookResult> {
  const alreadyProcessed = await withConnection(app.db, (sql) =>
    sql.maybeOne<{ processed: boolean }>(`SELECT processed_at IS NOT NULL AS processed FROM provider_webhook_events WHERE provider_event_id = $1`, [claim.eventId]),
  );
  if (alreadyProcessed?.processed) return { duplicate: true, outcome: "ignored" };

  const verified = await provider.verify(claim.reference);

  return withTransaction(app.db, async (tx) => {
    await tx.exec(
      `INSERT INTO provider_webhook_events(provider_event_id, provider, payload) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      // Only what is needed for audit: no customer details are retained.
      [claim.eventId, provider.name, JSON.stringify({ reference: claim.reference, outcome: claim.outcome })],
    );
    const event = await tx.one<{ processed: boolean }>(
      `SELECT processed_at IS NOT NULL AS processed FROM provider_webhook_events WHERE provider_event_id = $1 FOR UPDATE`,
      [claim.eventId],
    );
    if (event.processed) return { duplicate: true, outcome: "ignored" as const };

    let outcome: ProviderOutcome = "not_successful";
    if (verified) outcome = await applyProviderTransaction(tx, verified);

    if (claim.outcome === "success" && verified?.status !== "success") {
      const reservation = await tx.maybeOne<{ id: string; property_id: string }>(`SELECT id, property_id FROM reservations WHERE reference = $1`, [claim.reference]);
      if (reservation) {
        await raiseException(tx, {
          propertyId: reservation.property_id,
          kind: "verification_failed",
          dedupeKey: `verification_failed:${claim.eventId}`,
          reservationId: reservation.id,
          provider: provider.name,
          providerReference: claim.reference,
          details: { verifiedStatus: verified?.status ?? "not_found" },
        });
        outcome = "exception";
      }
    } else if (claim.outcome === "failed" && verified?.status === "failed") {
      // A declined attempt: the guest may retry inside the hold window, so the hold is kept.
      const reservation = await tx.maybeOne<{ id: string; property_id: string }>(`SELECT id, property_id FROM reservations WHERE reference = $1`, [claim.reference]);
      if (reservation) {
        await recordEvent(tx, {
          propertyId: reservation.property_id,
          actorId: null,
          action: "payment.attempt_failed",
          entityType: "reservation",
          entityId: reservation.id,
          details: { provider: provider.name, eventId: claim.eventId },
          outbox: { reference: claim.reference },
        });
      }
    }

    await tx.exec(`UPDATE provider_webhook_events SET processed_at = now() WHERE provider_event_id = $1`, [claim.eventId]);
    return { duplicate: false, outcome };
  });
}
