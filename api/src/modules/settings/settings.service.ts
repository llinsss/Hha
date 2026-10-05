import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import type { DataSource } from "typeorm";
import { withConnection, withTransaction } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { open, seal } from "../../lib/secret-box.js";
import type { Principal } from "../auth/session.service.js";
import {
  SETTINGS,
  definitionOf,
  type GlobalSettings,
  type PaymentProviderName,
  type SettingDefinition,
  type SettingGroup,
  type SettingKey,
} from "./settings.registry.js";

type Row = { key: string; value: string | null; is_secret: boolean; updated_at: Date; updated_by: string | null };

export type SettingView = {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingDefinition["type"];
  secret: boolean;
  /** Current value for non-secret settings; always null for secrets. */
  value: string | number | null;
  /** Secrets only: whether a value is stored, and its last four characters. */
  configured: boolean;
  hint: string | null;
  /** False when a stored secret cannot be decrypted with the current key. */
  readable: boolean;
  default: string | number | null;
  options: Array<{ value: string; label: string }> | null;
  /** For provider credentials: which provider they belong to. */
  provider: string | null;
  minimum: number | null;
  maximum: number | null;
  updatedAt: Date;
  updatedBy: string | null;
};

export type SettingsChange = Partial<Record<SettingKey, string | number | null>>;

const VERSION_KEY = "settings:version";
/** Without Redis, replicas converge within this window. */
const CACHE_TTL_MS = 30_000;

/**
 * Owner-managed global settings. Values are cached per process and refreshed
 * whenever the shared version in Redis changes, so an update on one replica is
 * visible on every replica on its next request.
 */
export class SettingsService {
  private cache: { version: string | null; loadedAt: number; settings: GlobalSettings } | null = null;

  constructor(
    private readonly db: DataSource,
    private readonly redis: Redis,
    private readonly key: Buffer,
    private readonly log: FastifyBaseLogger,
  ) {}

  async current(): Promise<GlobalSettings> {
    let version: string | null = null;
    try {
      version = await this.redis.get(VERSION_KEY);
    } catch (error) {
      this.log.warn({ err: error }, "settings version unavailable; using cache TTL");
    }
    const cached = this.cache;
    if (cached && cached.version === version && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.settings;
    const rows = await withConnection(this.db, (sql) => sql.rows<Row>(`SELECT key, value, is_secret, updated_at, updated_by FROM settings`));
    const settings = this.toSettings(rows);
    this.cache = { version, loadedAt: Date.now(), settings };
    return settings;
  }

  async list(): Promise<SettingView[]> {
    const rows = await withConnection(this.db, (sql) =>
      sql.rows<Row & { updated_by_name: string | null }>(
        `SELECT s.key, s.value, s.is_secret, s.updated_at, s.updated_by, u.full_name AS updated_by_name
           FROM settings s LEFT JOIN users u ON u.id = s.updated_by`,
      ),
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return (SETTINGS as readonly SettingDefinition[]).map((definition) => {
      const row = byKey.get(definition.key);
      const secretValue = definition.secret && row?.value ? open(this.key, row.value, definition.key) : null;
      return {
        key: definition.key,
        group: definition.group,
        label: definition.label,
        description: definition.description,
        type: definition.type,
        secret: definition.secret,
        value: definition.secret ? null : this.decode(definition, row?.value ?? null),
        configured: definition.secret ? Boolean(row?.value) : true,
        hint: secretValue ? `••••${secretValue.slice(-4)}` : null,
        readable: !definition.secret || !row?.value || secretValue !== null,
        default: definition.type === "string" ? null : definition.default,
        options: definition.type === "enum" ? definition.values.map((value) => ({ value, label: definition.labels[value] ?? value })) : null,
        provider: definition.type === "string" ? (definition.provider ?? null) : null,
        minimum: definition.type === "integer" ? definition.minimum : null,
        maximum: definition.type === "integer" ? definition.maximum : null,
        updatedAt: row?.updated_at ?? new Date(0),
        updatedBy: row?.updated_by_name ?? null,
      };
    });
  }

  /**
   * Applies changes atomically. A secret set to a string replaces it; null
   * clears it. A non-secret set to null resets it to its default. The result
   * must leave the selected payment provider fully configured.
   */
  async update(principal: Principal, changes: SettingsChange, environment: { publicWebUrl: string | null }): Promise<void> {
    const entries = Object.entries(changes) as Array<[SettingKey, string | number | null]>;
    if (entries.length === 0) throw Errors.unprocessable("No settings to change", "VALIDATION_FAILED");
    const stored = new Map<SettingKey, string | null>();
    for (const [key, value] of entries) {
      const definition = definitionOf(key);
      if (!definition) throw Errors.unprocessable(`Unknown setting ${key}`, "UNKNOWN_SETTING");
      stored.set(key, this.encode(definition, value));
    }

    await withTransaction(this.db, async (tx) => {
      const rows = await tx.rows<Row>(`SELECT key, value, is_secret, updated_at, updated_by FROM settings ORDER BY key FOR UPDATE`);
      const next = rows.map((row) => (stored.has(row.key as SettingKey) ? { ...row, value: stored.get(row.key as SettingKey) ?? null } : row));
      this.assertConsistent(this.toSettings(next), environment, stored.has("payments.provider"));
      for (const [key, value] of stored) {
        await tx.exec(`UPDATE settings SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1`, [key, value, principal.userId]);
      }
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "settings.updated",
        entityType: "settings",
        entityId: "global",
        // Secret values never reach the audit log.
        details: Object.fromEntries(entries.map(([key, value]) => [key, definitionOf(key)?.secret ? (value === null ? "cleared" : "replaced") : value])),
        outbox: false,
      });
    });
    this.cache = null;
    try {
      await this.redis.incr(VERSION_KEY);
    } catch (error) {
      this.log.warn({ err: error }, "settings version bump failed; other replicas refresh within the cache TTL");
    }
  }

  private assertConsistent(settings: GlobalSettings, environment: { publicWebUrl: string | null }, providerChanged: boolean): void {
    if (settings.provider === "none") return;
    if (providerChanged && !environment.publicWebUrl) {
      throw Errors.unprocessable("Online payments need PUBLIC_WEB_URL to be configured on the server first", "PUBLIC_WEB_URL_MISSING");
    }
    if (settings.provider === "paystack" && !settings.paystackSecretKey) {
      throw Errors.unprocessable("Add the Paystack secret key before enabling Paystack", "PROVIDER_NOT_CONFIGURED");
    }
    if (settings.provider === "flutterwave" && (!settings.flutterwaveSecretKey || !settings.flutterwaveWebhookHash)) {
      throw Errors.unprocessable("Add the Flutterwave secret key and webhook hash before enabling Flutterwave", "PROVIDER_NOT_CONFIGURED");
    }
  }

  private encode(definition: SettingDefinition, value: string | number | null): string | null {
    if (value === null) return definition.type === "string" ? null : String(definition.default);
    if (definition.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < definition.minimum || value > definition.maximum) {
        throw Errors.unprocessable(`${definition.label} must be a whole number from ${definition.minimum} to ${definition.maximum}`, "VALIDATION_FAILED");
      }
      return String(value);
    }
    if (typeof value !== "string") throw Errors.unprocessable(`${definition.label} must be text`, "VALIDATION_FAILED");
    const text = value.trim();
    if (definition.type === "enum") {
      if (!definition.values.includes(text)) throw Errors.unprocessable(`${definition.label} must be one of ${definition.values.join(", ")}`, "VALIDATION_FAILED");
      return text;
    }
    if (text.length < definition.minLength || text.length > definition.maxLength || (definition.pattern && !definition.pattern.test(text))) {
      throw Errors.unprocessable(`${definition.label} must be ${definition.patternHint ?? `${definition.minLength}–${definition.maxLength} characters`}`, "VALIDATION_FAILED");
    }
    return definition.secret ? seal(this.key, text, definition.key) : text;
  }

  private decode(definition: SettingDefinition, raw: string | null): string | number | null {
    if (definition.type === "integer") {
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isInteger(parsed) && parsed >= definition.minimum && parsed <= definition.maximum ? parsed : definition.default;
    }
    if (definition.type === "enum") return raw !== null && definition.values.includes(raw) ? raw : definition.default;
    return raw;
  }

  private toSettings(rows: readonly Row[]): GlobalSettings {
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    const secret = (key: SettingKey): string | null => {
      const sealed = byKey.get(key);
      if (!sealed) return null;
      const value = open(this.key, sealed, key);
      if (value === null) this.log.error({ key }, "stored secret setting cannot be decrypted; check SETTINGS_ENCRYPTION_KEY");
      return value;
    };
    const integer = (key: SettingKey) => {
      const definition = definitionOf(key);
      return definition ? Number(this.decode(definition, byKey.get(key) ?? null)) : 0;
    };
    const provider = byKey.get("payments.provider");
    return Object.freeze({
      provider: (["paystack", "flutterwave"].includes(provider ?? "") ? provider : "none") as PaymentProviderName,
      paystackSecretKey: secret("payments.paystack_secret_key"),
      flutterwaveSecretKey: secret("payments.flutterwave_secret_key"),
      flutterwaveWebhookHash: secret("payments.flutterwave_webhook_hash"),
      holdMinutes: integer("booking.hold_minutes"),
      maxStayNights: integer("booking.max_stay_nights"),
      horizonDays: integer("booking.horizon_days"),
      bankTransferReviewHours: integer("payments.bank_transfer_review_hours"),
    });
  }
}
