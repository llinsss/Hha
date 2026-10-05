import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PRD §5/§8 hardening:
 * - Database-enforced "no overlapping active stays per room" (exclusion constraint).
 * - Online-checkout bookkeeping on payments (checkout URL, request fingerprint,
 *   provider transaction id, settlement time).
 * - A consistent POS order lifecycle: `pending_payment` until a transfer is confirmed.
 * - The owner/manager payment-exception queue.
 * - Indexes for every list, register and lookup path.
 */
export class BookingIntegrityAndPaymentExceptions1791158400002 implements MigrationInterface {
  name = "BookingIntegrityAndPaymentExceptions1791158400002";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    // Holds that have already lapsed must not block the constraint below.
    await queryRunner.query(`
      UPDATE reservations SET status = 'expired', updated_at = now()
       WHERE status IN ('hold', 'pending_payment') AND hold_expires_at <= now()`);
    await queryRunner.query(`
      UPDATE payments p SET status = 'failed'
        FROM reservations r
       WHERE r.id = p.reservation_id AND r.status = 'expired' AND p.method = 'online' AND p.status = 'pending'`);
    await queryRunner.query(`
      ALTER TABLE reservations ADD CONSTRAINT reservations_room_no_overlap
        EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out, '[)') WITH &&)
        WHERE (room_id IS NOT NULL AND status IN ('hold', 'pending_payment', 'confirmed', 'checked_in'))`);

    await queryRunner.query(`
      ALTER TABLE payments
        ADD COLUMN checkout_url text,
        ADD COLUMN request_fingerprint text,
        ADD COLUMN provider_transaction_id text,
        ADD COLUMN settled_at timestamptz,
        ADD CONSTRAINT payments_method_check CHECK (method IN ('cash', 'pos', 'bank_transfer', 'online')),
        ADD CONSTRAINT payments_currency_check CHECK (currency = 'NGN')`);
    await queryRunner.query(`UPDATE payments SET settled_at = coalesce(confirmed_at, created_at) WHERE status = 'settled'`);

    await queryRunner.query(`ALTER TABLE pos_orders DROP CONSTRAINT IF EXISTS pos_orders_status_check`);
    await queryRunner.query(`UPDATE pos_orders SET status = 'pending_payment' WHERE status = 'paid' AND payment_status = 'pending'`);
    await queryRunner.query(`
      ALTER TABLE pos_orders
        ADD CONSTRAINT pos_orders_status_check CHECK (status IN ('pending_payment', 'paid', 'voided')),
        ADD CONSTRAINT pos_orders_lifecycle_check CHECK (status = 'voided' OR (status = 'pending_payment') = (payment_status = 'pending')),
        ADD CONSTRAINT pos_orders_method_check CHECK (payment_method IN ('cash', 'pos', 'bank_transfer'))`);

    await queryRunner.query(`
      CREATE TABLE payment_exceptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id uuid NOT NULL REFERENCES properties(id),
        kind text NOT NULL CHECK (kind IN (
          'late_success', 'amount_mismatch', 'currency_mismatch', 'overpayment', 'verification_failed',
          'unknown_reference', 'missing_local_record', 'unresolved_bank_transfer')),
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        dedupe_key text NOT NULL,
        reservation_id uuid REFERENCES reservations(id),
        payment_id uuid REFERENCES payments(id),
        pos_order_id uuid REFERENCES pos_orders(id),
        provider text,
        provider_reference text,
        expected_amount_kobo bigint,
        received_amount_kobo bigint,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        detected_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz,
        resolved_by uuid REFERENCES users(id),
        resolution_note text,
        UNIQUE (property_id, dedupe_key),
        CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
      )`);
    await queryRunner.query(`CREATE INDEX payment_exceptions_queue_idx ON payment_exceptions(property_id, status, detected_at DESC, id DESC)`);

    for (const statement of [
      `CREATE INDEX reservations_list_idx ON reservations(property_id, check_in DESC, created_at DESC, id DESC)`,
      `CREATE INDEX reservations_reference_idx ON reservations(reference)`,
      `CREATE INDEX payments_reservation_idx ON payments(reservation_id)`,
      `CREATE INDEX payments_register_idx ON payments(property_id, created_at DESC, id DESC)`,
      `CREATE INDEX pos_orders_register_idx ON pos_orders(property_id, created_at DESC, id DESC)`,
      `CREATE INDEX pos_orders_shift_idx ON pos_orders(shift_id)`,
      `CREATE INDEX pos_order_items_order_idx ON pos_order_items(order_id)`,
      `CREATE INDEX guests_email_idx ON guests(property_id, lower(email))`,
      `CREATE INDEX audit_events_entity_idx ON audit_events(property_id, entity_type, entity_id, id DESC)`,
      `CREATE INDEX stock_movements_item_idx ON stock_movements(item_id, created_at DESC)`,
      `CREATE INDEX rooms_type_idx ON rooms(property_id, room_type)`,
      `CREATE INDEX housekeeping_open_idx ON housekeeping_tasks(room_id) WHERE status <> 'complete'`,
      `CREATE INDEX staff_profiles_list_idx ON staff_profiles(property_id, created_at DESC, id DESC)`,
    ]) {
      await queryRunner.query(statement);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of [
      "staff_profiles_list_idx", "housekeeping_open_idx", "rooms_type_idx", "stock_movements_item_idx", "audit_events_entity_idx",
      "guests_email_idx", "pos_order_items_order_idx", "pos_orders_shift_idx", "pos_orders_register_idx", "payments_register_idx",
      "payments_reservation_idx", "reservations_reference_idx", "reservations_list_idx",
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS ${index}`);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS payment_exceptions`);
    await queryRunner.query(`
      ALTER TABLE pos_orders
        DROP CONSTRAINT IF EXISTS pos_orders_method_check,
        DROP CONSTRAINT IF EXISTS pos_orders_lifecycle_check,
        DROP CONSTRAINT IF EXISTS pos_orders_status_check`);
    await queryRunner.query(`UPDATE pos_orders SET status = 'paid' WHERE status = 'pending_payment'`);
    await queryRunner.query(`ALTER TABLE pos_orders ADD CONSTRAINT pos_orders_status_check CHECK (status IN ('paid', 'voided'))`);
    await queryRunner.query(`
      ALTER TABLE payments
        DROP CONSTRAINT IF EXISTS payments_currency_check,
        DROP CONSTRAINT IF EXISTS payments_method_check,
        DROP COLUMN IF EXISTS settled_at,
        DROP COLUMN IF EXISTS provider_transaction_id,
        DROP COLUMN IF EXISTS request_fingerprint,
        DROP COLUMN IF EXISTS checkout_url`);
    await queryRunner.query(`ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_room_no_overlap`);
  }
}
