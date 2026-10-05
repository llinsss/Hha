import { query } from "@/lib/server/db";
import { requirePermission } from "@/lib/server/auth";

export async function GET(_request: Request, context: RouteContext<"/api/management/pos/[id]">) {
  const access = await requirePermission("pos:read");
  if (access.response) return access.response;
  const { id } = await context.params;
  const order = await query(`SELECT o.id,o.receipt_number,o.subtotal_kobo::text,o.discount_kobo::text,o.total_kobo::text,o.payment_method,o.payment_status,o.payment_reference,o.created_at,
    u.full_name AS cashier,p.name AS property_name FROM pos_orders o JOIN users u ON u.id=o.cashier_id JOIN properties p ON p.id=o.property_id
    WHERE o.id=$1 AND o.property_id=$2`, [id, access.user!.propertyId]);
  if (!order.rows[0]) return Response.json({ error: "Receipt not found" }, { status: 404 });
  if (order.rows[0].payment_status !== "settled") return Response.json({ error: "Receipt is available after payment is confirmed" }, { status: 409 });
  const items = await query("SELECT item_name,quantity,unit_price_kobo::text,line_total_kobo::text FROM pos_order_items WHERE order_id=$1", [id]);
  return Response.json({ receipt: { ...order.rows[0], items: items.rows } });
}
