CREATE INDEX IF NOT EXISTS reservations_expiring_holds_idx
  ON reservations(hold_expires_at) WHERE status IN ('hold','pending_payment');

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_unique
  ON payments(provider,provider_reference)
  WHERE provider IS NOT NULL AND provider_reference IS NOT NULL;

ALTER TABLE provider_webhook_events
  ADD COLUMN IF NOT EXISTS provider text;
