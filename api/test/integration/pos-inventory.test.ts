import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, seedProperty, signedIn } from "../helpers.js";

const M = "/api/v1/management";

describe.skipIf(!integration)("inventory, menu and restaurant POS", () => {
  let app: App;
  let propertyId: string;
  let manager: Awaited<ReturnType<typeof signedIn>>;
  let cashier: Awaited<ReturnType<typeof signedIn>>;
  let eggs: string;
  let breakfast: string;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
    [manager, cashier] = await Promise.all([signedIn(app, propertyId, "restaurant_manager"), signedIn(app, propertyId, "restaurant_cashier")]);
  });
  afterAll(async () => {
    await app?.close();
  });

  const stockOf = async (id: string) => (await app.db.query("SELECT quantity::text FROM inventory_items WHERE id = $1", [id]))[0].quantity as string;
  const sell = (items: Array<{ menuItemId: string; quantity: number }>, extra: Record<string, unknown> = {}, key: string = randomUUID()) =>
    app.inject({ method: "POST", url: `${M}/pos`, headers: { ...cashier.headers, "idempotency-key": key }, payload: { items, paymentMethod: "cash", ...extra } });

  it("keeps stock as a movement ledger and never lets it go negative", async () => {
    const created = await app.inject({ method: "POST", url: `${M}/inventory/items`, headers: manager.headers, payload: { name: "Eggs", sku: `EGG-${randomUUID().slice(0, 6)}`, unit: "piece", quantity: 10, reorderLevel: 4, costKobo: 15_000 } });
    expect(created.statusCode).toBe(201);
    eggs = created.json<{ item: { id: string } }>().item.id;
    const move = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${M}/inventory/movements`, headers: manager.headers, payload: { itemId: eggs, reason: "Count", ...payload } });

    expect((await move({ action: "receive", quantity: 2.5 })).json()).toEqual({ stock: { itemId: eggs, quantity: "12.500" } });
    expect((await move({ action: "wastage", quantity: 0.5 })).json()).toEqual({ stock: { itemId: eggs, quantity: "12.000" } });
    expect((await move({ action: "adjust", quantity: -2 })).json()).toEqual({ stock: { itemId: eggs, quantity: "10.000" } });
    expect((await move({ action: "wastage", quantity: 11 })).json()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect((await move({ action: "receive", quantity: -1 })).statusCode).toBe(422);
    expect((await move({ action: "receive", quantity: 0.0001 })).statusCode).toBe(422);
    expect((await move({ action: "receive", quantity: 1, itemId: randomUUID() })).statusCode).toBe(404);
    const movements = await app.db.query("SELECT movement_type, quantity_delta::text FROM stock_movements WHERE item_id = $1 ORDER BY created_at", [eggs]);
    expect(movements.map((row: { movement_type: string }) => row.movement_type)).toEqual(["purchase", "purchase", "wastage", "adjustment"]);
    expect((await app.inject({ method: "POST", url: `${M}/inventory/items`, headers: cashier.headers, payload: { name: "X" } })).statusCode).toBe(403);
  });

  it("manages menu items with recipes, updates and archiving", async () => {
    const created = await app.inject({ method: "POST", url: `${M}/menu`, headers: manager.headers, payload: { name: "Breakfast", category: "Breakfast", priceKobo: 650_000, recipe: [{ itemId: eggs, quantity: 2 }] } });
    breakfast = created.json<{ item: { id: string } }>().item.id;
    expect((await app.inject({ method: "POST", url: `${M}/menu`, headers: manager.headers, payload: { name: "Bad", category: "X", priceKobo: 1, recipe: [{ itemId: randomUUID(), quantity: 1 }] } })).json()).toMatchObject({ code: "RECIPE_ITEM_NOT_FOUND" });
    expect((await app.inject({ method: "POST", url: `${M}/menu`, headers: manager.headers, payload: { name: "Bad", category: "X", priceKobo: 1, recipe: [{ itemId: eggs, quantity: 0 }] } })).statusCode).toBe(422);
    const menu = await app.inject({ url: `${M}/menu`, headers: cashier.headers });
    expect(menu.json<{ menu: Array<{ id: string; recipe: unknown[] }> }>().menu.find((item) => item.id === breakfast)?.recipe).toEqual([{ itemId: eggs, name: "Eggs", quantity: 2 }]);
    expect((await app.inject({ method: "PATCH", url: `${M}/menu/${breakfast}`, headers: manager.headers, payload: {} })).statusCode).toBe(422);
    expect((await app.inject({ method: "PATCH", url: `${M}/menu/${breakfast}`, headers: manager.headers, payload: { priceKobo: 700_000 } })).json()).toEqual({ item: { id: breakfast, active: true } });
  });

  it("requires an open shift, deducts recipe stock atomically and replays retries", async () => {
    expect((await sell([{ menuItemId: breakfast, quantity: 1 }])).json()).toMatchObject({ code: "NO_OPEN_SHIFT" });
    const open = await app.inject({ method: "POST", url: `${M}/pos/shift`, headers: cashier.headers, payload: { action: "open", openingFloatKobo: 1_000_000 } });
    expect(open.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${M}/pos/shift`, headers: cashier.headers, payload: { action: "open", openingFloatKobo: 0 } })).json()).toMatchObject({ code: "SHIFT_ALREADY_OPEN" });

    const key = randomUUID();
    const sale = await sell([{ menuItemId: breakfast, quantity: 1 }, { menuItemId: breakfast, quantity: 1 }], {}, key);
    expect(sale.statusCode).toBe(201);
    expect(sale.json()).toMatchObject({ order: { total_kobo: "1400000", payment_status: "settled", duplicate: false } });
    expect(await stockOf(eggs)).toBe("6.000");
    const retry = await sell([{ menuItemId: breakfast, quantity: 1 }, { menuItemId: breakfast, quantity: 1 }], {}, key);
    expect(retry.json()).toEqual(sale.json());
    expect(await stockOf(eggs)).toBe("6.000");

    const tooMany = await sell([{ menuItemId: breakfast, quantity: 4 }]);
    expect(tooMany.json()).toMatchObject({ statusCode: 409, code: "INSUFFICIENT_STOCK", message: "Insufficient stock for Eggs" });
    expect(await stockOf(eggs)).toBe("6.000");

    const receipt = await app.inject({ url: `${M}/pos/${sale.json<{ order: { id: string } }>().order.id}`, headers: cashier.headers });
    expect(receipt.json()).toMatchObject({ receipt: { total_kobo: "1400000", items: [{ item_name: "Breakfast", quantity: 2, unit_price_kobo: "700000", line_total_kobo: "1400000" }] } });
  });

  it("holds transfer sales as pending_payment with no receipt until confirmed", async () => {
    expect((await sell([{ menuItemId: breakfast, quantity: 1 }], { paymentMethod: "bank_transfer" })).json()).toMatchObject({ code: "TRANSFER_REFERENCE_REQUIRED" });
    const sale = await sell([{ menuItemId: breakfast, quantity: 1 }], { paymentMethod: "bank_transfer", paymentReference: "Opay 0801" });
    const order = sale.json<{ order: { id: string; payment_status: string } }>().order;
    expect(order.payment_status).toBe("pending");
    expect((await app.db.query("SELECT status FROM pos_orders WHERE id = $1", [order.id]))[0].status).toBe("pending_payment");
    expect((await app.inject({ url: `${M}/pos/${order.id}`, headers: cashier.headers })).json()).toMatchObject({ code: "PAYMENT_PENDING" });

    const owner = await signedIn(app, propertyId, "owner");
    const confirmed = await app.inject({ method: "PATCH", url: `${M}/payments/${order.id}`, headers: owner.headers, payload: { source: "restaurant" } });
    expect(confirmed.json()).toEqual({ ok: true });
    expect((await app.db.query("SELECT status, payment_status FROM pos_orders WHERE id = $1", [order.id]))[0]).toEqual({ status: "paid", payment_status: "settled" });
    expect((await app.inject({ url: `${M}/pos/${order.id}`, headers: cashier.headers })).statusCode).toBe(200);
  });

  it("closes the shift with cash variance and per-tender totals", async () => {
    const overview = await app.inject({ url: `${M}/pos`, headers: cashier.headers });
    expect(overview.json<{ shift: unknown; orders: unknown[] }>().orders.length).toBeGreaterThanOrEqual(2);
    const closed = await app.inject({ method: "POST", url: `${M}/pos/shift`, headers: cashier.headers, payload: { action: "close", countedCashKobo: 2_300_000 } });
    expect(closed.statusCode).toBe(200);
    const shift = closed.json<{ shift: { expectedCashKobo: string; varianceKobo: string; tenders: Array<{ method: string; paymentStatus: string; totalKobo: string }> } }>().shift;
    expect(shift.expectedCashKobo).toBe("2400000");
    expect(shift.varianceKobo).toBe("-100000");
    expect(shift.tenders).toEqual(expect.arrayContaining([expect.objectContaining({ method: "bank_transfer", paymentStatus: "settled", totalKobo: "700000" })]));
    expect((await app.inject({ url: `${M}/pos/shift`, headers: cashier.headers })).json()).toEqual({ shift: null });
  });

  it("keeps past receipts unchanged when a menu item is archived", async () => {
    await app.inject({ method: "POST", url: `${M}/pos/shift`, headers: cashier.headers, payload: { action: "open", openingFloatKobo: 0 } });
    const sale = await sell([{ menuItemId: breakfast, quantity: 1 }]);
    await app.inject({ method: "PATCH", url: `${M}/menu/${breakfast}`, headers: manager.headers, payload: { active: false, priceKobo: 900_000 } });
    expect((await app.inject({ url: `${M}/menu`, headers: cashier.headers })).json<{ menu: Array<{ id: string }> }>().menu.some((item) => item.id === breakfast)).toBe(false);
    expect((await sell([{ menuItemId: breakfast, quantity: 1 }])).json()).toMatchObject({ code: "MENU_ITEM_UNAVAILABLE" });
    const receipt = await app.inject({ url: `${M}/pos/${sale.json<{ order: { id: string } }>().order.id}`, headers: cashier.headers });
    expect(receipt.json()).toMatchObject({ receipt: { items: [{ unit_price_kobo: "700000" }] } });
  });
});
