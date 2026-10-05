import type { Sql } from "../db/sql.js";
import { hasPermission, type Permission, type Role } from "./permissions.js";

export type EventInput = {
  propertyId: string;
  /** Null for system actors (payment provider, scheduler, public guest). */
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /** Audit-only detail. Never sent to clients through the event stream. */
  details?: Record<string, unknown>;
  /** Outbox notification for the staff workspace; defaults to `action`. Set false for audit-only events. */
  outbox?: { type?: string; reference?: string } | false;
};

/**
 * Writes the audit row and the outbox notification in one statement, inside the
 * caller's transaction, so both commit or roll back with the change itself
 * (PRD §9). Outbox payloads carry only an optional reference: clients refetch
 * through authorised endpoints rather than trusting event contents.
 */
export async function recordEvent(tx: Sql, input: EventInput): Promise<void> {
  const outbox = input.outbox === false ? null : { type: input.outbox?.type ?? input.action, reference: input.outbox?.reference };
  await tx.exec(
    `WITH audit AS (
       INSERT INTO audit_events(property_id, actor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     )
     INSERT INTO outbox_events(property_id, event_type, entity_id, payload)
     SELECT $1, $7::text, $5, $8::jsonb WHERE $7::text IS NOT NULL`,
    [
      input.propertyId,
      input.actorId,
      input.action,
      input.entityType,
      input.entityId,
      JSON.stringify(input.details ?? {}),
      outbox?.type ?? null,
      JSON.stringify(outbox?.reference ? { reference: outbox.reference } : {}),
    ],
  );
}

/** Which permission(s) let a role see an outbox event type. First matching prefix wins. */
const EVENT_VISIBILITY: ReadonlyArray<readonly [prefix: string, permissions: readonly Permission[]]> = [
  ["payment_exception.", ["payments:confirm"]],
  ["payment.", ["payments:read", "reservations:read"]],
  ["reservation.", ["reservations:read"]],
  ["room.", ["rooms:read"]],
  ["housekeeping.", ["rooms:read"]],
  ["pos.", ["pos:read"]],
  ["menu.", ["pos:read"]],
  ["inventory.", ["inventory:read"]],
  ["staff.", ["staff:read"]],
  ["attendance.", ["staff:read", "attendance:read"]],
];

export function canSeeEvent(role: Role, eventType: string): boolean {
  const rule = EVENT_VISIBILITY.find(([prefix]) => eventType.startsWith(prefix));
  return rule !== undefined && rule[1].some((permission) => hasPermission(role, permission));
}
