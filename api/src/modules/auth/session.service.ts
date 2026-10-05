import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { DataSource, EntityManager } from "typeorm";
import { ApiSessionEntity } from "../../db/entities/index.js";
import { withTransaction } from "../../db/sql.js";
import { randomToken, safeEqualHex, sha256Hex } from "../../lib/crypto.js";
import { Errors } from "../../lib/errors.js";
import { isRole, type Role } from "../../lib/permissions.js";

/** The authenticated caller, resolved from the database (never from token claims alone). */
export type Principal = Readonly<{
  userId: string;
  sessionId: string;
  propertyId: string;
  role: Role;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
}>;

export type SessionMeta = Readonly<{ userAgent: string | undefined; ipAddress: string }>;

export type IssuedSession = Readonly<{ sessionId: string; refreshToken: string; expiresAt: Date }>;

export type RotationResult = Readonly<{
  principal: Principal;
  /** New refresh token, or null when a concurrent refresh already rotated it (grace window). */
  refreshToken: string | null;
  expiresAt: Date;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** Positive cache lifetime; bounds staleness of role/active changes if invalidation is missed. */
const CACHE_TTL_SECONDS = 60;
/** Revocation markers outlive any in-flight stale cache write (which uses SET NX). */
const REVOKED_TTL_SECONDS = CACHE_TTL_SECONDS * 2;
const REVOKED_MARKER = "revoked";
/** Window in which the previous refresh token is accepted, to absorb parallel refreshes from several tabs. */
const ROTATION_GRACE_MS = 30_000;

type PrincipalRow = {
  sessionId: string;
  userId: string;
  propertyId: string;
  role: string;
  email: string;
  fullName: string;
  mustChangePassword: boolean;
  expiresAt: Date;
};

export function parseRefreshToken(token: string | undefined): { sessionId: string; secret: string } | null {
  if (!token || token.length > 200) return null;
  const separator = token.indexOf(".");
  const sessionId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  return separator > 0 && UUID.test(sessionId) && SECRET.test(secret) ? { sessionId, secret } : null;
}

function isPrincipal(value: unknown): value is Principal {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.propertyId === "string" &&
    typeof candidate.role === "string" &&
    isRole(candidate.role) &&
    typeof candidate.email === "string" &&
    typeof candidate.fullName === "string" &&
    typeof candidate.mustChangePassword === "boolean"
  );
}

/**
 * Refresh-token sessions stored in PostgreSQL (authoritative) with a short-lived
 * Redis cache in front of the per-request validity check. Redis failures fall
 * back to the database; they never authenticate a revoked session.
 */
export class SessionService {
  constructor(
    private readonly db: DataSource,
    private readonly redis: Redis,
    private readonly log: FastifyBaseLogger,
    private readonly refreshTtlSeconds: number,
  ) {}

  async create(manager: EntityManager, userId: string, meta: SessionMeta): Promise<IssuedSession> {
    const secret = randomToken(32);
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
    const result = await manager.insert(ApiSessionEntity, {
      userId,
      refreshTokenHash: sha256Hex(secret),
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ipAddress: meta.ipAddress,
      expiresAt,
    });
    const sessionId = String(result.identifiers[0]?.id ?? "");
    if (!UUID.test(sessionId)) throw new Error("Session insert did not return an id");
    return { sessionId, refreshToken: `${sessionId}.${secret}`, expiresAt };
  }

  /** Per-request check: returns the principal for a live session, or null. */
  async resolvePrincipal(sessionId: string, userId: string): Promise<Principal | null> {
    if (!UUID.test(sessionId)) return null;

    const cached = await this.cacheGet(sessionId);
    if (cached === REVOKED_MARKER) return null;
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (isPrincipal(parsed)) return parsed.userId === userId ? parsed : null;
      } catch {
        // Corrupt entry: fall through to the database.
      }
    }

    const row = await this.loadPrincipal(sessionId);
    if (!row) {
      await this.cacheSet(sessionId, REVOKED_MARKER, REVOKED_TTL_SECONDS, false);
      return null;
    }
    const principal = this.toPrincipal(row);
    if (!principal) return null;
    const ttl = Math.min(CACHE_TTL_SECONDS, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
    if (ttl > 0) await this.cacheSet(sessionId, JSON.stringify(principal), ttl, true);
    return principal.userId === userId ? principal : null;
  }

  /** Rotates a refresh token. Presenting an already-rotated token outside the grace window revokes the session. */
  async rotate(refreshToken: string | undefined, meta: SessionMeta): Promise<RotationResult> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw Errors.unauthorized("Refresh token is missing or invalid", "REFRESH_INVALID");
    const presentedHash = sha256Hex(parsed.secret);

    const outcome = await withTransaction(this.db, async (tx) => {
      const manager = tx.runner.manager;
      const session = await manager
        .getRepository(ApiSessionEntity)
        .createQueryBuilder("s")
        .setLock("pessimistic_write")
        .where("s.id = :id", { id: parsed.sessionId })
        .getOne();
      const now = new Date();
      if (!session || session.revokedAt || session.expiresAt <= now) return { kind: "invalid" as const };

      if (safeEqualHex(presentedHash, session.refreshTokenHash)) {
        const secret = randomToken(32);
        await manager.update(ApiSessionEntity, { id: session.id }, {
          refreshTokenHash: sha256Hex(secret),
          previousTokenHash: presentedHash,
          rotatedAt: now,
          lastUsedAt: now,
          userAgent: meta.userAgent?.slice(0, 512) ?? session.userAgent,
          ipAddress: meta.ipAddress,
        });
        return { kind: "rotated" as const, refreshToken: `${session.id}.${secret}`, expiresAt: session.expiresAt };
      }

      const withinGrace =
        session.previousTokenHash !== null &&
        session.rotatedAt !== null &&
        now.getTime() - session.rotatedAt.getTime() < ROTATION_GRACE_MS &&
        safeEqualHex(presentedHash, session.previousTokenHash);
      if (withinGrace) return { kind: "grace" as const, expiresAt: session.expiresAt };

      await this.revokeWhere(manager, "id = :id", { id: session.id }, "refresh_token_reuse");
      return { kind: "reused" as const, userId: session.userId };
    });

    if (outcome.kind === "reused") {
      this.log.warn({ sessionId: parsed.sessionId, userId: outcome.userId }, "refresh token reuse detected; session revoked");
      throw Errors.unauthorized("Refresh token is no longer valid", "REFRESH_REUSED");
    }
    if (outcome.kind === "invalid") throw Errors.unauthorized("Refresh token is missing or invalid", "REFRESH_INVALID");

    const row = await this.loadPrincipal(parsed.sessionId);
    const principal = row ? this.toPrincipal(row) : null;
    if (!principal) throw Errors.unauthorized("Session is no longer valid", "SESSION_REVOKED");
    await this.cacheSet(principal.sessionId, JSON.stringify(principal), CACHE_TTL_SECONDS, false);
    return { principal, refreshToken: outcome.kind === "rotated" ? outcome.refreshToken : null, expiresAt: outcome.expiresAt };
  }

  /** Revokes the session a refresh token belongs to. Unknown or malformed tokens are ignored. */
  async revokeByRefreshToken(refreshToken: string | undefined, reason: string): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const presentedHash = sha256Hex(parsed.secret);
    const session = await this.db.getRepository(ApiSessionEntity).findOneBy({ id: parsed.sessionId });
    if (!session || session.revokedAt) return;
    const matches =
      safeEqualHex(presentedHash, session.refreshTokenHash) ||
      (session.previousTokenHash !== null && safeEqualHex(presentedHash, session.previousTokenHash));
    if (!matches) return;
    await this.revokeWhere(this.db.manager, "id = :id", { id: session.id }, reason);
  }

  async revoke(manager: EntityManager, sessionId: string, reason: string): Promise<void> {
    await this.revokeWhere(manager, "id = :id", { id: sessionId }, reason);
  }

  /** Revokes every live session of a user (deactivation, password change). */
  async revokeAllForUser(manager: EntityManager, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    return exceptSessionId
      ? this.revokeWhere(manager, "user_id = :userId AND id <> :except", { userId, except: exceptSessionId }, reason)
      : this.revokeWhere(manager, "user_id = :userId", { userId }, reason);
  }

  /** Replaces the cached principal after a change to the user (e.g. temporary password cleared). */
  async refreshCache(sessionId: string): Promise<void> {
    const row = await this.loadPrincipal(sessionId);
    const principal = row ? this.toPrincipal(row) : null;
    if (principal) await this.cacheSet(sessionId, JSON.stringify(principal), CACHE_TTL_SECONDS, false);
    else await this.cacheSet(sessionId, REVOKED_MARKER, REVOKED_TTL_SECONDS, false);
  }

  private async revokeWhere(manager: EntityManager, where: string, parameters: Record<string, string>, reason: string): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(ApiSessionEntity)
      .set({ revokedAt: () => "now()", revokedReason: reason })
      .where(`${where} AND revoked_at IS NULL`, parameters)
      .returning(["id"])
      .execute();
    const rows = Array.isArray(result.raw) ? (result.raw as Array<{ id: string }>) : [];
    // Marked immediately (fail-safe): a rolled-back revocation only costs a re-login.
    await Promise.all(rows.map((row) => this.cacheSet(row.id, REVOKED_MARKER, REVOKED_TTL_SECONDS, false)));
    return rows.length;
  }

  private async loadPrincipal(sessionId: string): Promise<PrincipalRow | null> {
    const rows: PrincipalRow[] = await this.db.query(
      `SELECT s.id AS "sessionId", u.id AS "userId", u.property_id AS "propertyId", u.role, u.email,
              u.full_name AS "fullName", u.must_change_password AS "mustChangePassword", s.expires_at AS "expiresAt"
         FROM api_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`,
      [sessionId],
    );
    return rows[0] ?? null;
  }

  private toPrincipal(row: PrincipalRow): Principal | null {
    if (!isRole(row.role)) {
      this.log.error({ userId: row.userId, role: row.role }, "user has an unknown role; denying access");
      return null;
    }
    return Object.freeze({
      userId: row.userId,
      sessionId: row.sessionId,
      propertyId: row.propertyId,
      role: row.role,
      email: row.email,
      fullName: row.fullName,
      mustChangePassword: row.mustChangePassword,
    });
  }

  private key(sessionId: string): string {
    return `sess:${sessionId}`;
  }

  private async cacheGet(sessionId: string): Promise<string | null> {
    try {
      return await this.redis.get(this.key(sessionId));
    } catch (error) {
      this.log.warn({ err: error }, "session cache read failed; using database");
      return null;
    }
  }

  private async cacheSet(sessionId: string, value: string, ttlSeconds: number, onlyIfAbsent: boolean): Promise<void> {
    try {
      if (onlyIfAbsent) await this.redis.set(this.key(sessionId), value, "EX", ttlSeconds, "NX");
      else await this.redis.set(this.key(sessionId), value, "EX", ttlSeconds);
    } catch (error) {
      this.log.warn({ err: error }, "session cache write failed");
    }
  }
}
