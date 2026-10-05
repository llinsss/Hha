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
