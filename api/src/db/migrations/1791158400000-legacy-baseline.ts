import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Baseline: the schema created by the legacy Next.js stack
 * (db/migrations/001-004, removed; see git history), copied verbatim. Every statement is
 * idempotent (IF NOT EXISTS / DROP ... IF EXISTS + ADD), so this is safe to run
 * against both an empty database and one the legacy migrator already built.
 */
const LEGACY_SQL: readonly string[] = [
  // ---- 001_initial.sql
  `
CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, timezone text NOT NULL DEFAULT 'Africa/Lagos',
  currency char(3) NOT NULL DEFAULT 'NGN', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id),
  email text NOT NULL UNIQUE, full_name text NOT NULL, password_hash text NOT NULL, must_change_password boolean NOT NULL DEFAULT false,
  role text NOT NULL CHECK (role IN ('owner','manager','front_desk','housekeeping','restaurant_cashier','restaurant_manager','storekeeper','finance','auditor')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_attempts (
  fingerprint text PRIMARY KEY, window_started_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0,
  blocked_until timestamptz
);
CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), room_number text NOT NULL,
  room_type text NOT NULL, nightly_rate_kobo bigint NOT NULL CHECK (nightly_rate_kobo >= 0), capacity int NOT NULL DEFAULT 2,
  status text NOT NULL DEFAULT 'vacant_clean' CHECK (status IN ('vacant_clean','vacant_dirty','occupied','inspected','maintenance','out_of_order')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,room_number)
);
CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), full_name text NOT NULL,
  email text, phone text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), guest_id uuid NOT NULL REFERENCES guests(id),
  reference text NOT NULL, room_id uuid REFERENCES rooms(id), room_type text NOT NULL, check_in date NOT NULL, check_out date NOT NULL,
  guests_count int NOT NULL DEFAULT 1 CHECK(guests_count > 0), amount_kobo bigint NOT NULL CHECK(amount_kobo >= 0),
  status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('hold','pending_payment','confirmed','checked_in','checked_out','cancelled','no_show','expired')),
  hold_expires_at timestamptz,
  source text NOT NULL DEFAULT 'staff', payment_status text NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','pending','part_paid','paid')),
  notes text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(check_out > check_in), UNIQUE(property_id,reference)
);
CREATE INDEX IF NOT EXISTS reservations_dates_idx ON reservations(property_id,check_in,check_out) WHERE status IN ('hold','pending_payment','confirmed','checked_in');
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), reservation_id uuid REFERENCES reservations(id),
  amount_kobo bigint NOT NULL CHECK(amount_kobo > 0), currency char(3) NOT NULL DEFAULT 'NGN', method text NOT NULL,
  status text NOT NULL DEFAULT 'settled' CHECK(status IN ('pending','settled','failed')), provider text, provider_reference text,
  idempotency_key text, recorded_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS provider_webhook_events (
  provider_event_id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, payload jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), user_id uuid UNIQUE REFERENCES users(id),
  employee_number text NOT NULL, department text NOT NULL, job_title text NOT NULL, phone text, emergency_contact text,
  employment_status text NOT NULL DEFAULT 'active' CHECK(employment_status IN ('active','on_leave','terminated')),
  start_date date, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,employee_number)
);
CREATE TABLE IF NOT EXISTS attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), staff_id uuid NOT NULL REFERENCES staff_profiles(id),
  event_type text NOT NULL CHECK(event_type IN ('clock_in','clock_out')), happened_at timestamptz NOT NULL DEFAULT now(), method text NOT NULL DEFAULT 'web',
  note text, recorded_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attendance_staff_time_idx ON attendance_events(staff_id,happened_at DESC);
CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), name text NOT NULL, sku text,
  unit text NOT NULL DEFAULT 'unit', quantity numeric(12,3) NOT NULL DEFAULT 0, reorder_level numeric(12,3) NOT NULL DEFAULT 0,
  cost_kobo bigint NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,sku)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), item_id uuid NOT NULL REFERENCES inventory_items(id),
  movement_type text NOT NULL CHECK(movement_type IN ('purchase','sale','adjustment','wastage','return')), quantity_delta numeric(12,3) NOT NULL,
  reason text, reference text, recorded_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), name text NOT NULL, category text NOT NULL,
  price_kobo bigint NOT NULL CHECK(price_kobo >= 0), active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS menu_recipes (
  menu_item_id uuid NOT NULL REFERENCES menu_items(id), inventory_item_id uuid NOT NULL REFERENCES inventory_items(id), quantity numeric(12,3) NOT NULL CHECK(quantity > 0),
  PRIMARY KEY(menu_item_id,inventory_item_id)
);
CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), room_id uuid NOT NULL REFERENCES rooms(id),
  task_type text NOT NULL DEFAULT 'turnover', status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','ready_for_inspection','complete')),
  assigned_to uuid REFERENCES staff_profiles(id), notes text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS pos_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), cashier_id uuid NOT NULL REFERENCES users(id),
  opening_float_kobo bigint NOT NULL DEFAULT 0, closing_cash_kobo bigint, expected_cash_kobo bigint, variance_kobo bigint,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_pos_shift_per_cashier ON pos_shifts(cashier_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS pos_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid NOT NULL REFERENCES properties(id), receipt_number text NOT NULL,
  subtotal_kobo bigint NOT NULL, discount_kobo bigint NOT NULL DEFAULT 0, total_kobo bigint NOT NULL, payment_method text NOT NULL,
  status text NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','voided')), idempotency_key text NOT NULL,
  cashier_id uuid NOT NULL REFERENCES users(id), shift_id uuid REFERENCES pos_shifts(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(property_id,receipt_number), UNIQUE(property_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS pos_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES pos_orders(id) ON DELETE CASCADE, menu_item_id uuid REFERENCES menu_items(id),
  item_name text NOT NULL, quantity int NOT NULL CHECK(quantity > 0), unit_price_kobo bigint NOT NULL, line_total_kobo bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY, property_id uuid NOT NULL REFERENCES properties(id), actor_id uuid REFERENCES users(id), action text NOT NULL,
  entity_type text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox_events (
  id bigserial PRIMARY KEY, property_id uuid NOT NULL REFERENCES properties(id), event_type text NOT NULL, entity_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_property_cursor_idx ON outbox_events(property_id,id);
`,
  // ---- 002_no_refunds.sql
  `
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_payment_status_check;
ALTER TABLE reservations
  ADD CONSTRAINT reservations_payment_status_check
  CHECK (payment_status IN ('unpaid','pending','part_paid','paid'));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','settled','failed'));

ALTER TABLE pos_orders DROP CONSTRAINT IF EXISTS pos_orders_status_check;
ALTER TABLE pos_orders
  ADD CONSTRAINT pos_orders_status_check
  CHECK (status IN ('paid','voided'));
`,
  // ---- 003_payment_register.sql
  `
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

ALTER TABLE pos_orders
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'settled',
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS payment_confirmed_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz;

ALTER TABLE pos_orders DROP CONSTRAINT IF EXISTS pos_orders_payment_status_check;
ALTER TABLE pos_orders
  ADD CONSTRAINT pos_orders_payment_status_check
  CHECK (payment_status IN ('pending','settled'));

CREATE INDEX IF NOT EXISTS payments_pending_confirmation_idx ON payments(property_id, created_at DESC) WHERE status='pending';
CREATE INDEX IF NOT EXISTS pos_pending_confirmation_idx ON pos_orders(property_id, created_at DESC) WHERE payment_status='pending';
`,
  // ---- 004_online_payments.sql
  `
CREATE INDEX IF NOT EXISTS reservations_expiring_holds_idx
  ON reservations(hold_expires_at) WHERE status IN ('hold','pending_payment');

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_unique
  ON payments(provider,provider_reference)
  WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;

ALTER TABLE provider_webhook_events
  ADD COLUMN IF NOT EXISTS provider text;
`,
];

export class LegacyBaseline1791158400000 implements MigrationInterface {
  name = "LegacyBaseline1791158400000";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of LEGACY_SQL) await queryRunner.query(statement);
  }

  async down(): Promise<void> {
    // Reverting the baseline would drop every business table. Refuse instead.
    throw new Error("LegacyBaseline is irreversible; restore from backup instead of reverting it.");
  }
}
