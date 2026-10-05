import { EntitySchema } from "typeorm";
import type { Role } from "../../lib/permissions.js";

export interface User {
  id: string;
  propertyId: string;
  email: string;
  fullName: string;
  passwordHash: string;
  mustChangePassword: boolean;
  role: Role;
  active: boolean;
  createdAt: Date;
}

export const UserEntity = new EntitySchema<User>({
  name: "User",
  tableName: "users",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    propertyId: { type: "uuid", name: "property_id" },
    email: { type: "text", unique: true },
    fullName: { type: "text", name: "full_name" },
    // Never selected implicitly: callers must opt in with `addSelect`/`select`.
    passwordHash: { type: "text", name: "password_hash", select: false },
    mustChangePassword: { type: "boolean", name: "must_change_password", default: false },
    role: { type: "text" },
    active: { type: "boolean", default: true },
    createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  },
});
