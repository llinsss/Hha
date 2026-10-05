import { EntitySchema } from "typeorm";

/**
 * A refresh-token session issued by this API. The refresh token presented by a
 * client is `<id>.<secret>`; only a SHA-256 of the secret is stored.
 */
export interface ApiSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  previousTokenHash: string | null;
  rotatedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export const ApiSessionEntity = new EntitySchema<ApiSession>({
  name: "ApiSession",
  tableName: "api_sessions",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    userId: { type: "uuid", name: "user_id" },
    refreshTokenHash: { type: "text", name: "refresh_token_hash" },
    previousTokenHash: { type: "text", name: "previous_token_hash", nullable: true },
    rotatedAt: { type: "timestamptz", name: "rotated_at", nullable: true },
    userAgent: { type: "text", name: "user_agent", nullable: true },
    ipAddress: { type: "text", name: "ip_address", nullable: true },
    expiresAt: { type: "timestamptz", name: "expires_at" },
    revokedAt: { type: "timestamptz", name: "revoked_at", nullable: true },
    revokedReason: { type: "text", name: "revoked_reason", nullable: true },
    lastUsedAt: { type: "timestamptz", name: "last_used_at", nullable: true },
    createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  },
});
