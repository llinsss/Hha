import { EntitySchema } from "typeorm";

export interface AuditEvent {
  id: string;
  propertyId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export const AuditEventEntity = new EntitySchema<AuditEvent>({
  name: "AuditEvent",
  tableName: "audit_events",
  columns: {
    // bigserial: kept as string to avoid precision loss beyond 2^53.
    id: { type: "bigint", primary: true, generated: "increment" },
    propertyId: { type: "uuid", name: "property_id" },
    actorId: { type: "uuid", name: "actor_id", nullable: true },
    action: { type: "text" },
    entityType: { type: "text", name: "entity_type" },
    entityId: { type: "text", name: "entity_id" },
    details: { type: "jsonb", default: () => "'{}'::jsonb" },
    createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  },
});
