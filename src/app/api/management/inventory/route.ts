import { inTransaction, query } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function GET() {
  const access = await requirePermission("inventory:read");
  if (access.response) return access.response;
  const result = await query(`SELECT id,name,sku,unit,quantity::text,reorder_level::text,cost_kobo::text,
    (quantity<=reorder_level) AS low_stock FROM inventory_items WHERE property_id=$1 AND active ORDER BY name`, [access.user!.propertyId]);
  return Response.json({ items: result.rows });
}

export async function POST(request: Request) {
  const access = await requirePermission("inventory:write");
  if (access.response) return access.response;
  try {
    const body = await request.json();
    if (body.action === "receive" || body.action === "adjust" || body.action === "wastage") {
      const itemId = String(body.itemId ?? "");
      const quantity = Number(body.quantity);
      const reason = String(body.reason ?? "").trim();
      const delta = body.action === "receive" ? Math.abs(quantity) : body.action === "wastage" ? -Math.abs(quantity) : quantity;
      if (!itemId || !Number.isFinite(delta) || delta === 0 || !reason) return Response.json({ error: "Select an item, enter a non-zero quantity and give a reason" }, { status: 400 });
      const result = await inTransaction(async (client) => {
        const updated = await client.query<{ quantity: string }>("UPDATE inventory_items SET quantity=quantity+$3 WHERE id=$1 AND property_id=$2 AND quantity+$3>=0 RETURNING quantity::text", [itemId, access.user!.propertyId, delta]);
        if (!updated.rows[0]) throw new Error("ITEM_NOT_FOUND_OR_STOCK");
        await client.query("INSERT INTO stock_movements(property_id,item_id,movement_type,quantity_delta,reason,recorded_by) VALUES($1,$2,$3,$4,$5,$6)", [access.user!.propertyId, itemId, body.action === "receive" ? "purchase" : body.action === "wastage" ? "wastage" : "adjustment", delta, reason, access.user!.id]);
        await logAudit(client, access.user!.propertyId, access.user!.id, `inventory.${body.action}`, "inventory_item", itemId, { quantityDelta: delta, reason });
        await logOutbox(client, access.user!.propertyId, "inventory.stock_changed", itemId, { quantity: updated.rows[0].quantity });
        return updated.rows[0];
      });
      return Response.json({ stock: result });
    }
    const name = String(body.name ?? "").trim();
    const unit = String(body.unit ?? "unit").trim();
    const quantity = Number(body.quantity ?? 0);
    const reorderLevel = Number(body.reorderLevel ?? 0);
    const costKobo = Number(body.costKobo ?? 0);
    if (!name || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(reorderLevel) || reorderLevel < 0 || !Number.isSafeInteger(costKobo) || costKobo < 0) return Response.json({ error: "Enter a name and valid stock, reorder level, and unit cost" }, { status: 400 });
    const item = await inTransaction(async (client) => {
      const created = await client.query<{ id: string }>(`INSERT INTO inventory_items(property_id,name,sku,unit,quantity,reorder_level,cost_kobo)
        VALUES($1,$2,nullif($3,''),$4,$5,$6,$7) RETURNING id`, [access.user!.propertyId, name, String(body.sku ?? "").trim(), unit, quantity, reorderLevel, costKobo]);
      if (quantity) await client.query("INSERT INTO stock_movements(property_id,item_id,movement_type,quantity_delta,reason,recorded_by) VALUES($1,$2,'purchase',$3,'Initial stock', $4)", [access.user!.propertyId, created.rows[0].id, quantity, access.user!.id]);
      await logAudit(client, access.user!.propertyId, access.user!.id, "inventory.item_created", "inventory_item", created.rows[0].id);
      await logOutbox(client, access.user!.propertyId, "inventory.item_created", created.rows[0].id, { name });
      return created.rows[0];
    });
    return Response.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && (error as Error & { code?: string }).code === "23505") return Response.json({ error: "That SKU is already in use" }, { status: 409 });
    if (error instanceof Error && error.message === "ITEM_NOT_FOUND_OR_STOCK") return Response.json({ error: "Item not found or insufficient stock" }, { status: 409 });
    return Response.json({ error: "Unable to update inventory" }, { status: 500 });
  }
}
