import { getSessionUser } from "@/lib/server/auth";
import { query } from "@/lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  if (user.mustChangePassword) return Response.json({ error: "Change your temporary password first" }, { status: 403 });
  const url = new URL(request.url);
  const requestedCursor = Number(request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? "");
  let cursor = Number.isFinite(requestedCursor) && requestedCursor > 0 ? requestedCursor : 0;
  if (!cursor) {
    const latest = await query<{ id: string }>("SELECT COALESCE(max(id),0)::text AS id FROM outbox_events WHERE property_id=$1", [user.propertyId]);
    cursor = Number(latest.rows[0]?.id ?? 0);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ cursor, at: new Date().toISOString() })}\n\n`));
      try {
        while (!request.signal.aborted) {
          const events = await query<{ id: string; event_type: string; entity_id: string; payload: unknown; created_at: Date }>(
            "SELECT id::text,event_type,entity_id,payload,created_at FROM outbox_events WHERE property_id=$1 AND id>$2 ORDER BY id LIMIT 100", [user.propertyId, cursor],
          );
          const allowAll = ["owner", "manager", "finance", "auditor"].includes(user.role);
          const allowedTypes: Record<string, string[]> = {
            front_desk: ["reservation.created", "reservation.confirmed", "reservation.status_changed", "payment.settled", "room.status_changed"],
            housekeeping: ["room.status_changed", "housekeeping.task_created", "housekeeping.task_updated"],
            restaurant_cashier: ["pos.order_finalized", "pos.shift_opened", "pos.shift_closed"],
            restaurant_manager: ["pos.order_finalized", "pos.shift_opened", "pos.shift_closed", "inventory.stock_changed", "menu.item_created"],
            storekeeper: ["inventory.stock_changed", "inventory.item_created"],
          };
          for (const event of events.rows) {
            cursor = Number(event.id);
            if (!allowAll && !(allowedTypes[user.role] ?? []).includes(event.event_type)) continue;
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: property-update\ndata: ${JSON.stringify({ type: event.event_type, entityId: event.entity_id, payload: event.payload, at: event.created_at })}\n\n`));
          }
          if (events.rowCount === 0) controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
          await new Promise((resolve) => setTimeout(resolve, 1800));
        }
      } catch {
        // Client reconnects with Last-Event-ID; committed outbox events are replayed.
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { /* request abort stops the polling loop */ },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
