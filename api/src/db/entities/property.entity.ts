import { EntitySchema } from "typeorm";

export interface Property {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  createdAt: Date;
}

export const PropertyEntity = new EntitySchema<Property>({
  name: "Property",
  tableName: "properties",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    name: { type: "text" },
    timezone: { type: "text", default: "Africa/Lagos" },
    currency: { type: "char", length: 3, default: "NGN" },
    createdAt: { type: "timestamptz", name: "created_at", createDate: true },
  },
});
