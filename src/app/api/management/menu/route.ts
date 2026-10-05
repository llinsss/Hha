import { inTransaction, query } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function GET() {
  const access = await requirePermission("pos:read");
  if (access.response) return access.response;
  const result = await query("SELECT id,name,category,price_kobo::text FROM menu_items WHERE property_id=$1 AND active ORDER BY category,name", [access.user!.propertyId]);
  return Response.json({ menu: result.rows });
}

export async function POST(request: Request) {
  const access = await requirePermission("menu:write");
  if (access.response) return access.response;
  const body = await request.json();
  const name = String(body.name ?? "").trim();
  const category = String(body.category ?? "").trim();
  const price = Number(body.priceKobo);
  if (!name || !category || !Number.isSafeInteger(price) || price < 0) return Response.json({ error: "Provide an item name, category, and price in kobo" }, { status: 400 });
  try {
    const item = await inTransaction(async (client) => {
      const created = await client.query<{ id: string }>("INSERT INTO menu_items(property_id,name,category,price_kobo) VALUES($1,$2,$3,$4) RETURNING id", [access.user!.propertyId, name, category, price]);
      if (Array.isArray(body.recipe)) {
        for (const ingredient of body.recipe) {
          const quantity = Number(ingredient.quantity);
          if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("INVALID_RECIPE");
          const linked = await client.query("INSERT INTO menu_recipes(menu_item_id,inventory_item_id,quantity) SELECT $1,id,$3 FROM inventory_items WHERE id=$2 AND property_id=$4", [created.rows[0].id, String(ingredient.itemId), quantity, access.user!.propertyId]);
          if (!linked.rowCount) throw new Error("RECIPE_ITEM_NOT_FOUND");
        }
      }
      await logAudit(client, access.user!.propertyId, access.user!.id, "menu.item_created", "menu_item", created.rows[0].id, { name, priceKobo: price });
      await logOutbox(client, access.user!.propertyId, "menu.item_created", created.rows[0].id, { name });
      return created.rows[0];
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_RECIPE") return Response.json({ error: "Recipe quantities must be greater than zero" }, { status: 400 });
    if (error instanceof Error && error.message === "RECIPE_ITEM_NOT_FOUND") return Response.json({ error: "A recipe stock item could not be found" }, { status: 400 });
    return Response.json({ error: "Unable to create menu item" }, { status: 500 });
  }
}
