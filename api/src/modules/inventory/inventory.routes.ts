import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withConnection, withTransaction } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { NextCursor, PageQuery, decodeCursor, toPage } from "../../lib/pagination.js";
import { KoboInput, KoboString, Nullable, Quantity, QuantityString, StringEnum, Text, Uuid, errorResponses, toQuantityText } from "../../lib/schemas.js";
import { optionalText } from "../../lib/text.js";
import { requirePrincipal } from "../auth/principal.js";

const security = [{ bearerAuth: [] }];
type InventoryRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: string;
  reorder_level: string;
  cost_kobo: string;
  low_stock: boolean;
};

const MOVEMENT_TYPES = { receive: "purchase", adjust: "adjustment", wastage: "wastage" } as const;

function quantityText(value: number, field: string): string {
  const text = toQuantityText(value);
  if (text === null) throw Errors.unprocessable(`${field} can have at most 3 decimal places`, "VALIDATION_FAILED");
  return text;
}

/**
 * Stock is a movement ledger: every change to an item's quantity writes a
 * stock_movements row with its reason and staff member (PRD §3).
 */
const inventoryRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize("inventory:read"),
      schema: {
        tags: ["inventory"],
        summary: "Active inventory items with low-stock indicators",
        security,
        querystring: Type.Object(PageQuery, { additionalProperties: false }),
        response: {
          200: Type.Object({
            items: Type.Array(
              Type.Object({
                id: Uuid,
                name: Type.String(),
                sku: Nullable(Type.String()),
                unit: Type.String(),
                quantity: QuantityString,
                reorder_level: QuantityString,
                cost_kobo: KoboString,
                low_stock: Type.Boolean(),
              }),
            ),
            nextCursor: NextCursor,
          }),
          ...errorResponses(401, 403, 422),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const limit = request.query.limit ?? 50;
      const cursor = decodeCursor(request.query.cursor, 2);
      const rows = await withConnection(app.db, (sql) =>
        sql.rows<InventoryRow>(
          `SELECT id, name, sku, unit, quantity::text, reorder_level::text, cost_kobo::text, (quantity <= reorder_level) AS low_stock
             FROM inventory_items
            WHERE property_id = $1 AND active AND ($2::text IS NULL OR (name, id) > ($2::text, $3::uuid))
            ORDER BY name, id
            LIMIT $4`,
          [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
        ),
      );
      const page = toPage(rows, limit, (row) => [row.name, row.id]);
      return { items: page.items, nextCursor: page.nextCursor };
    },
  );

  app.post(
    "/items",
    {
      preHandler: app.authorize("inventory:write"),
      schema: {
        tags: ["inventory"],
        summary: "Create an inventory item",
        description: "Opening stock, if any, is recorded as a purchase movement.",
        security,
        body: Type.Object(
          {
            name: Text(120),
            sku: Type.Optional(Type.String({ maxLength: 60 })),
            unit: Type.Optional(Text(20)),
            quantity: Type.Optional(Quantity({ minimum: 0 })),
            reorderLevel: Type.Optional(Quantity({ minimum: 0 })),
            costKobo: Type.Optional(KoboInput),
          },
          { additionalProperties: false },
        ),
        response: { 201: Type.Object({ item: Type.Object({ id: Uuid }) }), ...errorResponses(401, 403, 409, 422) },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = request.body;
      const name = body.name.trim();
      if (!name) throw Errors.unprocessable("Enter the item name", "VALIDATION_FAILED");
      const quantity = quantityText(body.quantity ?? 0, "quantity");
      const reorderLevel = quantityText(body.reorderLevel ?? 0, "reorderLevel");
      const item = await withTransaction(app.db, async (tx) => {
        const created = await tx.one<{ id: string }>(
          `INSERT INTO inventory_items(property_id, name, sku, unit, quantity, reorder_level, cost_kobo)
           VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7) RETURNING id`,
          [principal.propertyId, name, optionalText(body.sku), optionalText(body.unit) ?? "unit", quantity, reorderLevel, body.costKobo ?? 0],
        );
        if (Number(quantity) > 0) {
          await tx.exec(
            `INSERT INTO stock_movements(property_id, item_id, movement_type, quantity_delta, reason, recorded_by)
             VALUES ($1, $2, 'purchase', $3::numeric, 'Opening stock', $4)`,
            [principal.propertyId, created.id, quantity, principal.userId],
          );
        }
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: "inventory.item_created",
          entityType: "inventory_item",
          entityId: created.id,
          details: { name, quantity },
          outbox: { reference: name },
        });
        return created;
      });
      return reply.status(201).send({ item });
    },
  );

  app.post(
    "/movements",
    {
      preHandler: app.authorize("inventory:write"),
      schema: {
        tags: ["inventory"],
        summary: "Record a stock movement",
        description: "`receive` adds stock, `wastage` removes it, `adjust` applies a signed count correction. Stock can never go negative.",
        security,
        body: Type.Object(
          {
            action: StringEnum(["receive", "adjust", "wastage"] as const),
            itemId: Uuid,
            quantity: Quantity(),
            reason: Text(300),
            reference: Type.Optional(Type.String({ maxLength: 120 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ stock: Type.Object({ itemId: Uuid, quantity: QuantityString }) }), ...errorResponses(401, 403, 404, 409, 422) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const { action, itemId, reason } = request.body;
      const magnitude = quantityText(Math.abs(request.body.quantity), "quantity");
      if (Number(magnitude) === 0) throw Errors.unprocessable("Enter a non-zero quantity", "VALIDATION_FAILED");
      if (action !== "adjust" && request.body.quantity < 0) throw Errors.unprocessable("Enter a positive quantity", "VALIDATION_FAILED");
      const delta = action === "wastage" || (action === "adjust" && request.body.quantity < 0) ? `-${magnitude}` : magnitude;
      if (!reason.trim()) throw Errors.unprocessable("Give a reason for the movement", "VALIDATION_FAILED");

      return withTransaction(app.db, async (tx) => {
        const updated = await tx.maybeOne<{ quantity: string; name: string }>(
          `UPDATE inventory_items SET quantity = quantity + $3::numeric
            WHERE id = $1 AND property_id = $2 AND active AND quantity + $3::numeric >= 0
            RETURNING quantity::text, name`,
          [itemId, principal.propertyId, delta],
        );
        if (!updated) {
          const exists = await tx.maybeOne(`SELECT 1 FROM inventory_items WHERE id = $1 AND property_id = $2 AND active`, [itemId, principal.propertyId]);
          if (!exists) throw Errors.notFound("Inventory item not found");
          throw Errors.conflict("Not enough stock for this movement", "INSUFFICIENT_STOCK");
        }
        await tx.exec(
          `INSERT INTO stock_movements(property_id, item_id, movement_type, quantity_delta, reason, reference, recorded_by)
           VALUES ($1, $2, $3, $4::numeric, $5, $6, $7)`,
          [principal.propertyId, itemId, MOVEMENT_TYPES[action], delta, reason.trim(), optionalText(request.body.reference), principal.userId],
        );
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: `inventory.${action}`,
          entityType: "inventory_item",
          entityId: itemId,
          details: { quantityDelta: delta, reason: reason.trim() },
          outbox: { type: "inventory.stock_changed", reference: updated.name },
        });
        return { stock: { itemId, quantity: updated.quantity } };
      });
    },
  );
};

export default inventoryRoutes;
