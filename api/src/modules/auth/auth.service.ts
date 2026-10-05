import type { FastifyInstance } from "fastify";
import { UserEntity } from "../../db/entities/index.js";
import { recordAudit } from "../../lib/audit.js";
import { sha256Hex } from "../../lib/crypto.js";
import { AppError, Errors } from "../../lib/errors.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../../lib/password.js";
import { isRole } from "../../lib/permissions.js";
import type { IssuedSession, Principal, SessionMeta } from "./session.service.js";

export type LoginResult = Readonly<{ principal: Principal; accessToken: string; session: IssuedSession }>;

export type RefreshResult = Readonly<{
  principal: Principal;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}>;

export class AuthService {
  constructor(private readonly app: FastifyInstance) {}

  signAccessToken(principal: Principal): string {
    return this.app.jwt.sign({ sub: principal.userId, sid: principal.sessionId });
  }

  async login(emailInput: string, password: string, meta: SessionMeta): Promise<LoginResult> {
    const email = emailInput.trim().toLowerCase();
    const lockKey = `login:fail:${sha256Hex(`${email}|${meta.ipAddress}`)}`;
    await this.assertNotLocked(lockKey);

    const user = await this.app.db
      .getRepository(UserEntity)
      .createQueryBuilder("u")
      .addSelect("u.passwordHash")
      .where("u.email = :email", { email })
      .getOne();

    // Always run scrypt so response time does not reveal whether the account exists.
    const passwordValid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordValid || !user.active || !isRole(user.role)) {
      await this.recordFailure(lockKey);
      throw Errors.unauthorized("Email or password is incorrect", "INVALID_CREDENTIALS");
    }
    await this.clearFailures(lockKey);

    const session = await this.app.db.transaction(async (manager) => {
      const issued = await this.app.sessions.create(manager, user.id, meta);
      await recordAudit(manager, {
        propertyId: user.propertyId,
        actorId: user.id,
        action: "auth.login",
        entityType: "user",
        entityId: user.id,
        details: { sessionId: issued.sessionId, ip: meta.ipAddress },
      });
      return issued;
    });

    const principal: Principal = Object.freeze({
      userId: user.id,
      sessionId: session.sessionId,
      propertyId: user.propertyId,
      role: user.role,
      email: user.email,
      fullName: user.fullName,
      mustChangePassword: user.mustChangePassword,
    });
    return { principal, accessToken: this.signAccessToken(principal), session };
  }

  async refresh(refreshToken: string | undefined, meta: SessionMeta): Promise<RefreshResult> {
    const rotation = await this.app.sessions.rotate(refreshToken, meta);
    return { ...rotation, accessToken: this.signAccessToken(rotation.principal) };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    await this.app.sessions.revokeByRefreshToken(refreshToken, "logout");
  }

  async changePassword(principal: Principal, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.app.db
      .getRepository(UserEntity)
      .createQueryBuilder("u")
      .addSelect("u.passwordHash")
      .where("u.id = :id AND u.active", { id: principal.userId })
      .getOne();
    if (!user) throw Errors.unauthorized("Session is no longer valid", "SESSION_REVOKED");
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw Errors.forbidden("Current password is incorrect", "INVALID_CURRENT_PASSWORD");
    }
    if (currentPassword === newPassword) throw Errors.unprocessable("Choose a password different from the current one", "PASSWORD_REUSED");

    const passwordHash = await hashPassword(newPassword);
    await this.app.db.transaction(async (manager) => {
      await manager.update(UserEntity, { id: user.id }, { passwordHash, mustChangePassword: false });
      const revoked = await this.app.sessions.revokeAllForUser(manager, user.id, "password_changed", principal.sessionId);
      await recordAudit(manager, {
        propertyId: user.propertyId,
        actorId: user.id,
        action: "auth.password_changed",
        entityType: "user",
        entityId: user.id,
        details: { otherSessionsRevoked: revoked },
      });
    });
    await this.app.sessions.refreshCache(principal.sessionId);
  }

  private async assertNotLocked(key: string): Promise<void> {
    const { loginMaxFailures } = this.app.config.rateLimit;
    try {
      const [failures, ttl] = await Promise.all([this.app.redis.get(key), this.app.redis.ttl(key)]);
      if (Number(failures ?? 0) >= loginMaxFailures) {
        const minutes = Math.max(1, Math.ceil(Math.max(ttl, 0) / 60));
        throw Errors.tooManyRequests(`Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, "LOGIN_LOCKED");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.app.log.warn({ err: error }, "login lockout check unavailable");
    }
  }

  private async recordFailure(key: string): Promise<void> {
    try {
      // SET NX EX first so the counter always carries a TTL (INCR keeps it), even if the process dies mid-way.
      await this.app.redis
        .multi()
        .set(key, "0", "EX", this.app.config.rateLimit.loginLockoutSeconds, "NX")
        .incr(key)
        .exec();
    } catch (error) {
      this.app.log.warn({ err: error }, "login failure counter unavailable");
    }
  }

  private async clearFailures(key: string): Promise<void> {
    try {
      await this.app.redis.del(key);
    } catch (error) {
      this.app.log.warn({ err: error }, "login failure counter unavailable");
    }
  }
}
