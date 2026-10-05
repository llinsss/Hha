/**
 * Role → permission table (authoritative). Carried over from the removed legacy
 * Next.js API and mirrored, for display only, in web/src/lib/permissions.ts.
 * Change both together.
 */
export const ROLES = [
  "owner",
  "manager",
  "front_desk",
  "housekeeping",
  "restaurant_cashier",
  "restaurant_manager",
  "storekeeper",
  "finance",
  "auditor",
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard:read",
  "reservations:read",
  "reservations:write",
  "rooms:read",
  "rooms:write",
  "staff:read",
  "staff:write",
  "attendance:read",
  "attendance:write",
  "pos:read",
  "pos:write",
  "inventory:read",
  "inventory:write",
  "menu:write",
  "payments:read",
  "payments:confirm",
  "reports:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  owner: new Set(ALL),
  manager: new Set<Permission>(["dashboard:read", "reservations:read", "reservations:write", "rooms:read", "rooms:write", "staff:read", "staff:write", "attendance:read", "attendance:write", "pos:read", "pos:write", "inventory:read", "inventory:write", "menu:write", "payments:read", "payments:confirm", "reports:read"]),
  front_desk: new Set<Permission>(["dashboard:read", "reservations:read", "reservations:write", "rooms:read", "rooms:write"]),
  housekeeping: new Set<Permission>(["rooms:read", "rooms:write"]),
  restaurant_cashier: new Set<Permission>(["pos:read", "pos:write"]),
  restaurant_manager: new Set<Permission>(["pos:read", "pos:write", "inventory:read", "inventory:write", "menu:write", "staff:read", "attendance:read", "attendance:write", "reports:read"]),
  storekeeper: new Set<Permission>(["inventory:read", "inventory:write"]),
  finance: new Set<Permission>(["dashboard:read", "pos:read", "payments:read", "reports:read"]),
  auditor: new Set<Permission>(["dashboard:read", "reservations:read", "rooms:read", "staff:read", "attendance:read", "pos:read", "inventory:read", "reports:read"]),
});

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
