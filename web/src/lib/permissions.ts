import type { Role } from "./api/types";

/**
 * Role → permission table, mirroring api/src/lib/permissions.ts (the backend is
 * authoritative). The UI uses it only to decide what to show; the API enforces it.
 */
const table: Record<Role, readonly string[]> = {
  owner: ["*"],
  manager: ["dashboard:read", "reservations:read", "reservations:write", "rooms:read", "rooms:write", "staff:read", "staff:write", "attendance:read", "attendance:write", "pos:read", "pos:write", "inventory:read", "inventory:write", "menu:write", "payments:read", "payments:confirm", "reports:read"],
  front_desk: ["dashboard:read", "reservations:read", "reservations:write", "rooms:read", "rooms:write"],
  housekeeping: ["rooms:read", "rooms:write"],
  restaurant_cashier: ["pos:read", "pos:write"],
  restaurant_manager: ["pos:read", "pos:write", "inventory:read", "inventory:write", "menu:write", "staff:read", "attendance:read", "attendance:write", "reports:read"],
  storekeeper: ["inventory:read", "inventory:write"],
  finance: ["dashboard:read", "pos:read", "payments:read", "reports:read"],
  auditor: ["dashboard:read", "reservations:read", "rooms:read", "staff:read", "attendance:read", "pos:read", "inventory:read", "reports:read"],
};

export function can(role: Role | undefined, permission: string): boolean {
  if (!role) return false;
  const granted = table[role];
  return granted.includes("*") || granted.includes(permission);
}
