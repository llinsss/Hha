import type { EntityManager, QueryDeepPartialEntity } from "typeorm";
import type { AuditEvent } from "../db/entities/index.js";
import { AuditEventEntity } from "../db/entities/index.js";

export type AuditInput = {
  propertyId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
};

/** Writes an audit row using the caller's transaction so it commits atomically with the change. */
export async function recordAudit(manager: EntityManager, input: AuditInput): Promise<void> {
  const row: QueryDeepPartialEntity<AuditEvent> = {
    propertyId: input.propertyId,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    // jsonb column: TypeORM's deep-partial type does not model free-form objects.
    details: (input.details ?? {}) as QueryDeepPartialEntity<AuditEvent>["details"],
  };
  await manager.insert(AuditEventEntity, row);
}
