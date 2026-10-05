import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import type { PoolClient } from "pg";
import { query } from "@/lib/server/db";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "hh_session";
const SESSION_DAYS = 7;

export type Role = "owner" | "manager" | "front_desk" | "housekeeping" | "restaurant_cashier" | "restaurant_manager" | "storekeeper" | "finance" | "auditor";
export type SessionUser = { id: string; propertyId: string; fullName: string; email: string; role: Role; mustChangePassword: boolean };

export const rolePermissions: Record<Role, string[]> = {
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

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [salt, stored] = encoded.split(":");
  if (!salt || !stored) return false;
  const expected = Buffer.from(stored, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function digest(token: string) { return createHash("sha256").update(token).digest("hex"); }

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", [userId, digest(token), expiresAt]);
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) await query("DELETE FROM sessions WHERE token_hash=$1", [digest(token)]);
  jar.delete(COOKIE_NAME);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const result = await query<SessionUser & { property_id: string; full_name: string }>(
    `SELECT u.id,u.property_id AS "propertyId",u.full_name AS "fullName",u.email,u.role,u.must_change_password AS "mustChangePassword"
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`, [digest(token)],
  );
  return result.rows[0] ?? null;
}

export async function requirePermission(permission: string) {
  const user = await getSessionUser();
  if (!user) return { user: null, response: Response.json({ error: "Authentication required" }, { status: 401 }) };
  if (user.mustChangePassword && permission !== "auth:password_change") return { user: null, response: Response.json({ error: "Change your temporary password before using the workspace" }, { status: 403 }) };
  const granted = rolePermissions[user.role] ?? [];
  if (!granted.includes("*") && !granted.includes(permission)) {
    return { user: null, response: Response.json({ error: "You do not have access to this action" }, { status: 403 }) };
  }
  return { user, response: null };
}

export function logAudit(client: PoolClient, propertyId: string, actorId: string | null, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}) {
  return client.query(
    "INSERT INTO audit_events(property_id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)",
    [propertyId, actorId, action, entityType, entityId, JSON.stringify(details)],
  );
}

export function logOutbox(client: PoolClient, propertyId: string, eventType: string, entityId: string, payload: Record<string, unknown> = {}) {
  return client.query(
    "INSERT INTO outbox_events(property_id,event_type,entity_id,payload) VALUES($1,$2,$3,$4)",
    [propertyId, eventType, entityId, JSON.stringify(payload)],
  );
}
