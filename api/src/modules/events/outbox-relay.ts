import type { FastifyBaseLogger } from "fastify";
import type { DataSource } from "typeorm";
import { withConnection } from "../../db/sql.js";

export type OutboxEvent = Readonly<{ id: bigint; propertyId: string; type: string; entityId: string; reference: string | null; at: Date }>;
type Listener = (event: OutboxEvent) => void;

type Row = { id: string; property_id: string; event_type: string; entity_id: string; reference: string | null; created_at: Date };

const POLL_INTERVAL_MS = 1_000;
const BATCH = 500;
/**
 * bigserial ids are allocated at insert time but become visible at commit, so
 * a lower id can appear after a higher one. A gap is held open this long before
 * it is treated as a rolled-back insert and skipped.
 */
const GAP_WAIT_MS = 5_000;

export function toOutboxEvent(row: Row): OutboxEvent {
  return { id: BigInt(row.id), propertyId: row.property_id, type: row.event_type, entityId: row.entity_id, reference: row.reference, at: row.created_at };
}

export const OUTBOX_EVENT_SELECT = `SELECT id::text, property_id, event_type, entity_id, payload->>'reference' AS reference, created_at FROM outbox_events`;

/**
 * One poller per process fans committed outbox events out to every open
 * stream, so the database sees one query per second regardless of how many
 * staff are connected. It only runs while someone is listening.
 */
export class OutboxRelay {
  private readonly listeners = new Set<Listener>();
  private cursor: bigint | null = null;
  private gapSince: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly db: DataSource,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Starts delivery after the current head; returns that head and an unsubscribe function. */
  async subscribe(listener: Listener): Promise<{ head: bigint; unsubscribe: () => void }> {
    if (this.cursor === null) {
      const head = await withConnection(this.db, (sql) => sql.one<{ id: string }>(`SELECT coalesce(max(id), 0)::text AS id FROM outbox_events`));
      this.cursor ??= BigInt(head.id);
    }
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
      this.timer.unref();
    }
    return {
      head: this.cursor,
      unsubscribe: () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) this.stop();
      },
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.cursor = null;
    this.gapSince = null;
  }

  close(): void {
    this.listeners.clear();
    this.stop();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.cursor === null) return;
    this.polling = true;
    try {
      const rows = await withConnection(this.db, (sql) => sql.rows<Row>(`${OUTBOX_EVENT_SELECT} WHERE id > $1 ORDER BY id LIMIT $2`, [String(this.cursor), BATCH]));
      for (const row of rows) {
        if (this.cursor === null) return;
        const event = toOutboxEvent(row);
        if (event.id !== this.cursor + 1n) {
          this.gapSince ??= Date.now();
          if (Date.now() - this.gapSince < GAP_WAIT_MS) break;
        }
        this.gapSince = null;
        this.cursor = event.id;
        for (const listener of this.listeners) listener(event);
      }
    } catch (error) {
      this.log.warn({ err: error }, "outbox poll failed");
    } finally {
      this.polling = false;
    }
  }
}
