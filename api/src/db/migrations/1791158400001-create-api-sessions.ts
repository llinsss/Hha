import type { MigrationInterface, QueryRunner } from "typeorm";

export class CreateApiSessions1791158400001 implements MigrationInterface {
  name = "CreateApiSessions1791158400001";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE api_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        refresh_token_hash text NOT NULL,
        previous_token_hash text,
        rotated_at timestamptz,
        user_agent text,
        ip_address text,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        revoked_reason text,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT api_sessions_expiry_check CHECK (expires_at > created_at)
      )
    `);
    await queryRunner.query(`CREATE INDEX api_sessions_active_user_idx ON api_sessions(user_id) WHERE revoked_at IS NULL`);
    await queryRunner.query(`CREATE INDEX api_sessions_expires_idx ON api_sessions(expires_at)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS api_sessions`);
  }
}
