import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Owner-managed global settings. Secret values (payment provider keys) are
 * stored AES-256-GCM encrypted by the application; this table never holds them
 * in plain text. Defaults leave online payments off until the owner configures
 * a provider.
 */
export class CreateSettings1791158400003 implements MigrationInterface {
  name = "CreateSettings1791158400003";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE settings (
        key text PRIMARY KEY CHECK (key ~ '^[a-z]+\\.[a-z_]+$'),
        value text,
        is_secret boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
        CHECK (NOT is_secret OR value IS NULL OR value LIKE 'v1.%')
      )`);
    await queryRunner.query(`
      INSERT INTO settings(key, value, is_secret) VALUES
        ('payments.provider', 'none', false),
        ('payments.paystack_secret_key', NULL, true),
        ('payments.flutterwave_secret_key', NULL, true),
        ('payments.flutterwave_webhook_hash', NULL, true),
        ('payments.bank_transfer_review_hours', '48', false),
        ('booking.hold_minutes', '20', false),
        ('booking.max_stay_nights', '90', false),
        ('booking.horizon_days', '365', false)
      ON CONFLICT (key) DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS settings`);
  }
}
