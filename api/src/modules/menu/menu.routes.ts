import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withConnection, withTransaction, type Sql } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { NextCursor, PageQuery, decodeCursor, toPage } from "../../lib/pagination.js";
import { IdParams, KoboInput, KoboString, Quantity, Text, Uuid, errorResponses, toQuantityText } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";

const security = [{ bearerAuth: [] }];

const RecipeInput = Type.Array(Type.Object({ itemId: Uuid, quantity: Quantity({ exclusiveMinimum: 0 }) }, { additionalProperties: false }), { maxItems: 30 });

type MenuRow = {
  id: string;
  name: string;
  category: string;
  price_kobo: string;
  recipe: { itemId: string; name: string; quantity: number }[];
};

/** Validates recipe lines and replaces the item's recipe. */
async function writeRecipe(tx: Sql, propertyId: string, menuItemId: string, recipe: { itemId: string; quantity: number }[]): Promise<void> {
  const ids = recipe.map((line) => line.itemId);
  if (new Set(ids).size !== ids.length) throw Errors.unprocessable("List each recipe ingredient once", "VALIDATION_FAILED");
  const quantities = recipe.map((line) => {
    const text = toQuantityText(line.quantity);
    if (text === null || Number(text) <= 0) throw Errors.unprocessable("Recipe quantities must be greater than zero with at most 3 decimals", "VALIDATION_FAILED");
    return text;
  });
  if (ids.length > 0) {
    const found = await tx.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM inventory_items WHERE id = ANY($1::uuid[]) AND property_id = $2 AND active`,
      [ids, propertyId],
    );
    if (found.count !== ids.length) throw Errors.unprocessable("A recipe stock item could not be found", "RECIPE_ITEM_NOT_FOUND");
  }
  await tx.exec(`DELETE FROM menu_recipes WHERE menu_item_id = $1`, [menuItemId]);
  if (ids.length > 0) {
    await tx.exec(
      `INSERT INTO menu_recipes(menu_item_id, inventory_item_id, quantity)
       SELECT $1, * FROM unnest($2::uuid[], $3::numeric[])`,
      [menuItemId, ids, quantities],
    );
  }
}

/**
 * Restaurant menu. Sales snapshot item name and price onto each order line, so
 * edits and archiving never change past receipts.
 */
const menuRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize("pos:read"),
      schema: {
        tags: ["menu"],
        summary: "Active menu items with prices and recipes",
        security,
        querystring: Type.Object(PageQuery, { additionalProperties: false }),
        response: {
          200: Type.Object({
            menu: Type.Array(
              Type.Object({
                id: Uuid,
                name: Type.String(),
                category: Type.String(),
                price_kobo: KoboString,
                recipe: Type.Array(Type.Object({ itemId: Uuid, name: Type.String(), quantity: Type.Number() })),
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
      const limit = request.query.limit ?? 100;
      const cursor = decodeCursor(request.query.cursor, 3);
      const rows = await withConnection(app.db, (sql) =>
        sql.rows<MenuRow>(
          `SELECT m.id, m.name, m.category, m.price_kobo::text,
                  coalesce((SELECT json_agg(json_build_object('itemId', i.id, 'name', i.name, 'quantity', mr.quantity::float8) ORDER BY i.name)
                              FROM menu_recipes mr JOIN inventory_items i ON i.id = mr.inventory_item_id
                             WHERE mr.menu_item_id = m.id), '[]'::json) AS recipe
             FROM menu_items m
            WHERE m.property_id = $1 AND m.active
              AND ($2::text IS NULL OR (m.category, m.name, m.id) > ($2::text, $3::text, $4::uuid))
            ORDER BY m.category, m.name, m.id
            LIMIT $5`,
          [principal.propertyId, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, limit + 1],
        ),
      );
      const page = toPage(rows, limit, (row) => [row.category, row.name, row.id]);
      return { menu: page.items, nextCursor: page.nextCursor };
    },
  );

  app.post(
    "/",
    {
      preHandler: app.authorize("menu:write"),
      schema: {
        tags: ["menu"],
        summary: "Create a menu item with an optional stock recipe",
        security,
        body: Type.Object({ name: Text(120), category: Text(60), priceKobo: KoboInput, recipe: Type.Optional(RecipeInput) }, { additionalProperties: false }),
        response: { 201: Type.Object({ item: Type.Object({ id: Uuid }) }), ...errorResponses(401, 403, 422) },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const name = request.body.name.trim();
      const category = request.body.category.trim();
      if (!name || !category) throw Errors.unprocessable("Enter the item name and category", "VALIDATION_FAILED");
      const item = await withTransaction(app.db, async (tx) => {
        const created = await tx.one<{ id: string }>(
          `INSERT INTO menu_items(property_id, name, category, price_kobo) VALUES ($1, $2, $3, $4) RETURNING id`,
          [principal.propertyId, name, category, request.body.priceKobo],
        );
        await writeRecipe(tx, principal.propertyId, created.id, request.body.recipe ?? []);
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: "menu.item_created",
          entityType: "menu_item",
          entityId: created.id,
          details: { name, priceKobo: request.body.priceKobo },
          outbox: { reference: name },
        });
        return created;
      });
      return reply.status(201).send({ item });
    },
  );

  app.patch(
    "/:id",
    {
      preHandler: app.authorize("menu:write"),
      schema: {
        tags: ["menu"],
        summary: "Update or archive a menu item",
        description: "Set `active: false` to archive. Past receipts keep the name and price at the time of sale.",
        security,
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Text(120)),
            category: Type.Optional(Text(60)),
            priceKobo: Type.Optional(KoboInput),
            active: Type.Optional(Type.Boolean()),
            recipe: Type.Optional(RecipeInput),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: Type.Object({ item: Type.Object({ id: Uuid, active: Type.Boolean() }) }), ...errorResponses(401, 403, 404, 422) },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request);
      const body = request.body;
      const name = body.name?.trim();
      const category = body.category?.trim();
      if (name === "" || category === "") throw Errors.unprocessable("Name and category cannot be blank", "VALIDATION_FAILED");
      return withTransaction(app.db, async (tx) => {
        const updated = await tx.maybeOne<{ active: boolean; name: string }>(
          `UPDATE menu_items
              SET name = coalesce($3, name), category = coalesce($4, category), price_kobo = coalesce($5, price_kobo), active = coalesce($6, active)
            WHERE id = $1 AND property_id = $2
            RETURNING active, name`,
          [request.params.id, principal.propertyId, name ?? null, category ?? null, body.priceKobo ?? null, body.active ?? null],
        );
        if (!updated) throw Errors.notFound("Menu item not found");
        if (body.recipe) await writeRecipe(tx, principal.propertyId, request.params.id, body.recipe);
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: body.active === false ? "menu.item_archived" : "menu.item_updated",
          entityType: "menu_item",
          entityId: request.params.id,
          details: { changes: body },
          outbox: { reference: updated.name },
        });
        return { item: { id: request.params.id, active: updated.active } };
      });
    },
  );
};

export default menuRoutes;
