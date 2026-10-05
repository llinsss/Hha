import { randomUUID } from "node:crypto";
import { inTransaction, query } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

const paymentMethods = new Set(["cash", "pos", "bank_transfer"]);

export async function GET() {
  const access = await requirePermission("pos:read");
  if (access.response) return access.response;
  const [shift, orders] = await Promise.all([
    query("SELECT id,opening_float_kobo::text,opened_at FROM pos_shifts WHERE property_id=$1 AND cashier_id=$2 AND closed_at IS NULL LIMIT 1", [access.user!.propertyId, access.user!.id]),
    query(`SELECT o.id,o.receipt_number,o.total_kobo::text,o.payment_method,o.payment_status,o.created_at,u.full_name AS cashier FROM pos_orders o JOIN users u ON u.id=o.cashier_id
      WHERE o.property_id=$1 AND (o.created_at AT TIME ZONE 'Africa/Lagos')::date=(now() AT TIME ZONE 'Africa/Lagos')::date ORDER BY o.created_at DESC LIMIT 30`, [access.user!.propertyId]),
  ]);
  return Response.json({ shift: shift.rows[0] ?? null, orders: orders.rows });
}

export async function POST(request: Request) {
  const access = await requirePermission("pos:write");
  if (access.response) return access.response;
  try {
    const body = await request.json();
    const lines = Array.isArray(body.items) ? body.items : [];
    const method = String(body.paymentMethod ?? "");
    const paymentReference = String(body.paymentReference ?? "").trim().slice(0, 120);
    const idempotencyKey = String(body.idempotencyKey ?? "");
    if (!lines.length || lines.length > 40 || !paymentMethods.has(method) || !idempotencyKey) return Response.json({ error: "Add order items, select a payment method, and provide an idempotency key" }, { status: 400 });
    if (method === "bank_transfer" && !paymentReference) return Response.json({ error: "Enter the sender name or bank transfer reference" }, { status: 400 });
    const quantities = new Map<string, number>();
    for (const line of lines) {
      const id = String(line.menuItemId ?? "");
      const quantity = Number(line.quantity);
      if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) return Response.json({ error: "Each item needs a valid quantity" }, { status: 400 });
      quantities.set(id, (quantities.get(id) ?? 0) + quantity);
    }
    const sale = await inTransaction(async (client) => {
      const prior = await client.query<{ id: string; receipt_number: string; total_kobo: string; payment_status: string }>("SELECT id,receipt_number,total_kobo::text,payment_status FROM pos_orders WHERE property_id=$1 AND idempotency_key=$2", [access.user!.propertyId, idempotencyKey]);
      if (prior.rows[0]) return { ...prior.rows[0], duplicate: true };
      const shift = await client.query<{ id: string }>("SELECT id FROM pos_shifts WHERE property_id=$1 AND cashier_id=$2 AND closed_at IS NULL FOR UPDATE", [access.user!.propertyId, access.user!.id]);
      if (!shift.rows[0]) throw new Error("NO_OPEN_SHIFT");
      const receiptNumber = `HH-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomUUID().slice(0,8).toUpperCase()}`;
      const orderId = randomUUID();
      const itemRows: { id: string; name: string; price_kobo: string; quantity: number }[] = [];
      let subtotal = BigInt(0);
      for (const [menuId, quantity] of quantities) {
        const item = await client.query<{ id: string; name: string; price_kobo: string }>("SELECT id,name,price_kobo::text FROM menu_items WHERE id=$1 AND property_id=$2 AND active FOR SHARE", [menuId, access.user!.propertyId]);
        if (!item.rows[0]) throw new Error("MENU_ITEM_NOT_FOUND");
        itemRows.push({ ...item.rows[0], quantity });
        subtotal += BigInt(item.rows[0].price_kobo) * BigInt(quantity);
      }
      const paymentStatus = method === "bank_transfer" ? "pending" : "settled";
      await client.query(`INSERT INTO pos_orders(id,property_id,receipt_number,subtotal_kobo,discount_kobo,total_kobo,payment_method,payment_status,payment_reference,idempotency_key,cashier_id,shift_id)
        VALUES($1,$2,$3,$4,0,$4,$5,$6,nullif($7,''),$8,$9,$10)`, [orderId, access.user!.propertyId, receiptNumber, subtotal.toString(), method, paymentStatus, paymentReference, idempotencyKey, access.user!.id, shift.rows[0].id]);
      for (const item of itemRows) {
        await client.query("INSERT INTO pos_order_items(order_id,menu_item_id,item_name,quantity,unit_price_kobo,line_total_kobo) VALUES($1,$2,$3,$4,$5,$6)", [orderId, item.id, item.name, item.quantity, item.price_kobo, (BigInt(item.price_kobo) * BigInt(item.quantity)).toString()]);
        const recipes = await client.query<{ inventory_item_id: string; name: string; quantity: string }>("SELECT mr.inventory_item_id,i.name,mr.quantity::text FROM menu_recipes mr JOIN inventory_items i ON i.id=mr.inventory_item_id WHERE mr.menu_item_id=$1", [item.id]);
        for (const recipe of recipes.rows) {
          const used = Number(recipe.quantity) * item.quantity;
          const stock = await client.query("UPDATE inventory_items SET quantity=quantity-$2 WHERE id=$1 AND quantity >= $2 RETURNING id", [recipe.inventory_item_id, used]);
          if (!stock.rowCount) throw new Error(`INSUFFICIENT_STOCK:${recipe.name}`);
          await client.query("INSERT INTO stock_movements(property_id,item_id,movement_type,quantity_delta,reason,reference,recorded_by) VALUES($1,$2,'sale',$3,$4,$5,$6)", [access.user!.propertyId, recipe.inventory_item_id, -used, `Restaurant sale ${receiptNumber}`, receiptNumber, access.user!.id]);
          await logOutbox(client, access.user!.propertyId, "inventory.stock_changed", recipe.inventory_item_id, { reason: "Restaurant sale" });
        }
      }
      await logAudit(client, access.user!.propertyId, access.user!.id, "pos.order_finalized", "pos_order", orderId, { receiptNumber, totalKobo: subtotal.toString(), paymentMethod: method });
      await logOutbox(client, access.user!.propertyId, "pos.order_finalized", orderId, { receiptNumber, totalKobo: subtotal.toString() });
      if (paymentStatus === "pending") await logOutbox(client, access.user!.propertyId, "payment.pending_confirmation", orderId, { source: "restaurant", receiptNumber, amountKobo: subtotal.toString() });
      return { id: orderId, receipt_number: receiptNumber, total_kobo: subtotal.toString(), payment_status: paymentStatus, duplicate: false };
    });
    return Response.json({ order: sale }, { status: sale.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "NO_OPEN_SHIFT") return Response.json({ error: "Open a cashier shift before taking a sale" }, { status: 409 });
    if (error instanceof Error && error.message === "MENU_ITEM_NOT_FOUND") return Response.json({ error: "A menu item is unavailable" }, { status: 409 });
    if (error instanceof Error && error.message.startsWith("INSUFFICIENT_STOCK:")) return Response.json({ error: `Insufficient stock for ${error.message.split(":")[1]}` }, { status: 409 });
    console.error("POS order failed", error);
    return Response.json({ error: "Unable to finalize order" }, { status: 500 });
  }
}
