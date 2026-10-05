import type { Sql } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import type { VerifiedTransaction } from "./providers/index.js";

/**
 * The payment ledger: the only code that settles money, confirms stays from
 * payments, expires holds and raises payment exceptions. Every function runs
 * inside the caller's transaction and takes row locks before reading state it
 * then changes. There is deliberately no refund operation (PRD §3).
 */

export type ExceptionKind =
  | "late_success"
  | "amount_mismatch"
  | "currency_mismatch"
  | "overpayment"
  | "verification_failed"
  | "unknown_reference"
  | "missing_local_record"
  | "unresolved_bank_transfer";

export type ExceptionInput = {
  propertyId: string;
  kind: ExceptionKind;
  /** Makes raising idempotent: the same problem is only queued once. */
  dedupeKey: string;
  reservationId?: string | null;
  paymentId?: string | null;
  posOrderId?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  expectedAmountKobo?: string | number | null;
  receivedAmountKobo?: string | number | null;
  details?: Record<string, unknown>;
};

/** Queues an owner/manager exception. Returns false when it was already queued. */
export async function raiseException(tx: Sql, input: ExceptionInput): Promise<boolean> {
  const created = await tx.maybeOne<{ id: string }>(
    `INSERT INTO payment_exceptions(property_id, kind, dedupe_key, reservation_id, payment_id, pos_order_id, provider,
                                    provider_reference, expected_amount_kobo, received_amount_kobo, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (property_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [
      input.propertyId,
      input.kind,
      input.dedupeKey,
      input.reservationId ?? null,
      input.paymentId ?? null,
      input.posOrderId ?? null,
      input.provider ?? null,
      input.providerReference ?? null,
      input.expectedAmountKobo ?? null,
      input.receivedAmountKobo ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
  if (!created) return false;
  await recordEvent(tx, {
    propertyId: input.propertyId,
    actorId: null,
    action: "payment_exception.raised",
    entityType: "payment_exception",
    entityId: created.id,
    details: { kind: input.kind, providerReference: input.providerReference ?? null },
    outbox: { reference: input.providerReference ?? undefined },
  });
  return true;
}

export type PaymentState = "unpaid" | "pending" | "part_paid" | "paid";

/**
 * Recomputes a reservation's payment_status from its payments. Pending amounts
 * never count as received (PRD §5).
 */
export async function refreshReservationPayment(tx: Sql, reservationId: string): Promise<PaymentState> {
  const row = await tx.one<{ payment_status: PaymentState }>(
    `UPDATE reservations r
        SET payment_status = CASE
              WHEN t.settled >= r.amount_kobo THEN 'paid'
              WHEN t.pending > 0 THEN 'pending'
              WHEN t.settled > 0 THEN 'part_paid'
              ELSE 'unpaid' END,
            updated_at = now()
       FROM (SELECT coalesce(sum(amount_kobo) FILTER (WHERE status = 'settled'), 0) AS settled,
                    coalesce(sum(amount_kobo) FILTER (WHERE status = 'pending'), 0) AS pending
               FROM payments WHERE reservation_id = $1) t
      WHERE r.id = $1
      RETURNING r.payment_status`,
    [reservationId],
  );
  return row.payment_status;
}

/**
 * Confirms a stay that is still inside its hold window once it is fully paid.
 * Returns true when the reservation changed to `confirmed`.
 */
export async function confirmHeldStayIfPaid(tx: Sql, reservationId: string, propertyId: string, reference: string): Promise<boolean> {
  const confirmed = await tx.exec(
    `UPDATE reservations SET status = 'confirmed', hold_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending_payment' AND payment_status = 'paid' AND hold_expires_at > now()`,
    [reservationId],
  );
  if (confirmed === 0) return false;
  await recordEvent(tx, {
    propertyId,
    actorId: null,
    action: "reservation.confirmed",
    entityType: "reservation",
    entityId: reservationId,
    outbox: { reference },
  });
  return true;
}

/**
 * Expires lapsed checkout holds (optionally for one room), fails their pending
 * online payments and releases the rooms. Processes at most `limit` holds,
 * oldest first, skipping rows another worker holds.
 */
export async function expireLapsedHolds(tx: Sql, options: { roomId?: string; limit: number }): Promise<number> {
  const expired = await tx.rows<{ id: string; property_id: string; reference: string }>(
    `UPDATE reservations SET status = 'expired', updated_at = now()
      WHERE id IN (
        SELECT id FROM reservations
         WHERE status IN ('hold', 'pending_payment') AND hold_expires_at <= now()
           AND ($1::uuid IS NULL OR room_id = $1)
         ORDER BY hold_expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
      RETURNING id, property_id, reference`,
    [options.roomId ?? null, options.limit],
  );
  if (expired.length === 0) return 0;
  const ids = expired.map((row) => row.id);
  await tx.exec(`UPDATE payments SET status = 'failed' WHERE reservation_id = ANY($1::uuid[]) AND method = 'online' AND status = 'pending'`, [ids]);
  for (const reservation of expired) {
    await refreshReservationPayment(tx, reservation.id);
    await recordEvent(tx, {
      propertyId: reservation.property_id,
      actorId: null,
      action: "reservation.hold_expired",
      entityType: "reservation",
      entityId: reservation.id,
      outbox: { reference: reservation.reference },
    });
  }
  return expired.length;
}

export type ProviderOutcome =
  | "confirmed"
  | "settled_late"
  | "settled_overpayment"
  | "duplicate"
  | "not_successful"
  | "exception";

type LockedReservation = {
  id: string;
  property_id: string;
  reference: string;
  status: string;
  amount_kobo: string;
  hold_valid: boolean;
};

/**
 * Applies a provider-verified transaction (from the provider's server API, never
 * a webhook body). Settles the matching online payment exactly once, confirms
 * the stay only while its hold is valid, and otherwise records the money and
 * queues an exception instead of confirming possibly resold inventory.
 */
export async function applyProviderTransaction(tx: Sql, transaction: VerifiedTransaction): Promise<ProviderOutcome> {
  const reservation = await tx.maybeOne<LockedReservation>(
    `SELECT id, property_id, reference, status, amount_kobo::text, coalesce(hold_expires_at > now(), false) AS hold_valid
       FROM reservations WHERE reference = $1 FOR UPDATE`,
    [transaction.reference],
  );
  if (!reservation) {
    const property = await tx.maybeOne<{ id: string }>(`SELECT id FROM properties ORDER BY created_at, id LIMIT 1`);
    if (property && transaction.status === "success") {
      await raiseException(tx, {
        propertyId: property.id,
        kind: "unknown_reference",
        dedupeKey: `unknown_reference:${transaction.provider}:${transaction.providerTransactionId}`,
        provider: transaction.provider,
        providerReference: transaction.reference,
        receivedAmountKobo: transaction.amountKobo,
      });
    }
    return "exception";
  }

  const payment = await tx.maybeOne<{ id: string; amount_kobo: string; status: string }>(
    `SELECT id, amount_kobo::text, status FROM payments
      WHERE reservation_id = $1 AND method = 'online'
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [reservation.id],
  );
  const base = { propertyId: reservation.property_id, reservationId: reservation.id, provider: transaction.provider, providerReference: transaction.reference };

  if (transaction.status !== "success") return "not_successful";
  if (!payment) {
    await raiseException(tx, { ...base, kind: "missing_local_record", dedupeKey: `missing_local_record:${transaction.provider}:${transaction.providerTransactionId}`, receivedAmountKobo: transaction.amountKobo });
    return "exception";
  }
  if (payment.status === "settled") return "duplicate";
  if (transaction.currency !== "NGN") {
    await raiseException(tx, {
      ...base,
      paymentId: payment.id,
      kind: "currency_mismatch",
      dedupeKey: `currency_mismatch:${transaction.provider}:${transaction.providerTransactionId}`,
      expectedAmountKobo: payment.amount_kobo,
      receivedAmountKobo: transaction.amountKobo,
      details: { currency: transaction.currency },
    });
    return "exception";
  }
  if (transaction.amountKobo === null || BigInt(transaction.amountKobo) !== BigInt(payment.amount_kobo)) {
    await raiseException(tx, {
      ...base,
      paymentId: payment.id,
      kind: "amount_mismatch",
      dedupeKey: `amount_mismatch:${transaction.provider}:${transaction.providerTransactionId}`,
      expectedAmountKobo: payment.amount_kobo,
      receivedAmountKobo: transaction.amountKobo,
    });
    return "exception";
  }

  const prior = await tx.one<{ settled: string }>(
    `SELECT coalesce(sum(amount_kobo), 0)::text AS settled FROM payments WHERE reservation_id = $1 AND status = 'settled'`,
    [reservation.id],
  );
  // Settles even if the hold lapsed and the payment was marked failed: the money was received.
  await tx.exec(
    `UPDATE payments SET status = 'settled', provider = $2, provider_reference = $3, provider_transaction_id = $4, settled_at = now()
      WHERE id = $1`,
    [payment.id, transaction.provider, transaction.reference, transaction.providerTransactionId],
  );
  await refreshReservationPayment(tx, reservation.id);
  await recordEvent(tx, {
    propertyId: reservation.property_id,
    actorId: null,
    action: "payment.settled",
    entityType: "payment",
    entityId: payment.id,
    details: { source: "online", provider: transaction.provider, providerTransactionId: transaction.providerTransactionId, amountKobo: payment.amount_kobo },
    outbox: { reference: reservation.reference },
  });

  if (BigInt(prior.settled) >= BigInt(reservation.amount_kobo)) {
    await raiseException(tx, {
      ...base,
      paymentId: payment.id,
      kind: "overpayment",
      dedupeKey: `overpayment:${payment.id}`,
      expectedAmountKobo: "0",
      receivedAmountKobo: payment.amount_kobo,
    });
    return "settled_overpayment";
  }
  if (reservation.status === "pending_payment" && reservation.hold_valid) {
    await confirmHeldStayIfPaid(tx, reservation.id, reservation.property_id, reservation.reference);
    return "confirmed";
  }
  // Paid after the hold lapsed (or after cancellation): release the room and let a person decide.
  if (reservation.status === "pending_payment" || reservation.status === "hold") {
    await tx.exec(`UPDATE reservations SET status = 'expired', updated_at = now() WHERE id = $1`, [reservation.id]);
  }
  await raiseException(tx, {
    ...base,
    paymentId: payment.id,
    kind: "late_success",
    dedupeKey: `late_success:${payment.id}`,
    receivedAmountKobo: payment.amount_kobo,
    details: { reservationStatus: reservation.status },
  });
  return "settled_late";
}

/**
 * Owner/manager confirmation that a bank transfer reached the company account.
 * Conditional on the row still being a pending transfer, so concurrent or
 * repeated confirmations cannot double-settle.
 */
export async function confirmBankTransfer(
  tx: Sql,
  input: { propertyId: string; actorId: string; paymentId: string; source: "accommodation" | "restaurant"; note: string | null },
): Promise<void> {
  if (input.source === "accommodation") {
    const payment = await tx.maybeOne<{ reservation_id: string; amount_kobo: string; method: string; status: string; reference: string }>(
      `SELECT p.reservation_id, p.amount_kobo::text, p.method, p.status, r.reference
         FROM payments p JOIN reservations r ON r.id = p.reservation_id
        WHERE p.id = $1 AND p.property_id = $2
        FOR UPDATE OF p, r`,
      [input.paymentId, input.propertyId],
    );
    if (!payment) throw Errors.notFound("Payment not found");
    if (payment.status !== "pending" || payment.method !== "bank_transfer") throw Errors.conflict("Only pending bank transfers can be confirmed", "NOT_PENDING_TRANSFER");
    await tx.exec(`UPDATE payments SET status = 'settled', confirmed_by = $2, confirmed_at = now(), settled_at = now() WHERE id = $1`, [input.paymentId, input.actorId]);
    await refreshReservationPayment(tx, payment.reservation_id);
    await confirmHeldStayIfPaid(tx, payment.reservation_id, input.propertyId, payment.reference);
    await recordEvent(tx, {
      propertyId: input.propertyId,
      actorId: input.actorId,
      action: "payment.bank_transfer_confirmed",
      entityType: "payment",
      entityId: input.paymentId,
      details: { reservationId: payment.reservation_id, amountKobo: payment.amount_kobo, note: input.note },
      outbox: { type: "payment.settled", reference: payment.reference },
    });
    await resolveTransferException(tx, input, "payment_id");
    return;
  }

  const order = await tx.maybeOne<{ payment_method: string; payment_status: string; receipt_number: string; total_kobo: string }>(
    `SELECT payment_method, payment_status, receipt_number, total_kobo::text FROM pos_orders
      WHERE id = $1 AND property_id = $2 AND status <> 'voided' FOR UPDATE`,
    [input.paymentId, input.propertyId],
  );
  if (!order) throw Errors.notFound("Payment not found");
  if (order.payment_status !== "pending" || order.payment_method !== "bank_transfer") throw Errors.conflict("Only pending bank transfers can be confirmed", "NOT_PENDING_TRANSFER");
  await tx.exec(
    `UPDATE pos_orders SET status = 'paid', payment_status = 'settled', payment_confirmed_by = $2, payment_confirmed_at = now() WHERE id = $1`,
    [input.paymentId, input.actorId],
  );
  await recordEvent(tx, {
    propertyId: input.propertyId,
    actorId: input.actorId,
    action: "payment.bank_transfer_confirmed",
    entityType: "pos_order",
    entityId: input.paymentId,
    details: { amountKobo: order.total_kobo, note: input.note },
    outbox: { type: "payment.settled", reference: order.receipt_number },
  });
  await resolveTransferException(tx, input, "pos_order_id");
}

/** A confirmed transfer closes its "unresolved bank transfer" exception, if one was queued. */
async function resolveTransferException(tx: Sql, input: { propertyId: string; actorId: string; paymentId: string }, column: "payment_id" | "pos_order_id"): Promise<void> {
  await tx.exec(
    `UPDATE payment_exceptions
        SET status = 'resolved', resolved_at = now(), resolved_by = $3, resolution_note = 'Bank transfer confirmed'
      WHERE property_id = $1 AND ${column} = $2 AND kind = 'unresolved_bank_transfer' AND status = 'open'`,
    [input.propertyId, input.paymentId, input.actorId],
  );
}
