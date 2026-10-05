"use client";

import { useRef, useState } from "react";
import { Archive, Check, Clock3, Pencil, Plus, X } from "lucide-react";
import { api, errorMessage, type InventoryItem, type MenuItem, type PaymentMethod, type Receipt } from "@/lib/api";
import { dateTimeLabel, money, optionLabel, text, timeLabel, toKobo } from "../format";
import { Empty, Field, InlineError, Modal, useAction, useResource, type SectionProps } from "../ui";

type Dialog = { kind: "shift-open" } | { kind: "shift-close" } | { kind: "menu-new" } | { kind: "menu-edit"; item: MenuItem };

function ReceiptModal({ receipt, methodLabel, onClose }: { receipt: Receipt; methodLabel: string; onClose: () => void }) {
  return (
    <Modal title="Restaurant receipt" description={receipt.receipt_number} onClose={onClose}>
      <div className="receipt-paper">
        <h3>{receipt.property_name}</h3>
        <p>RECEIPT · {receipt.receipt_number}</p>
        {receipt.items.map((item, index) => (
          <div className="receipt-line" key={index}>
            <span>
              {item.quantity} × {item.item_name}
            </span>
            <b>{money(item.line_total_kobo)}</b>
          </div>
        ))}
        <div className="receipt-total">
          <span>TOTAL · {methodLabel.toUpperCase()}</span>
          <strong>{money(receipt.total_kobo)}</strong>
        </div>
        <small>
          {dateTimeLabel(receipt.created_at)} · Served by {receipt.cashier}
        </small>
        <small>Thank you for dining with us.</small>
      </div>
      <button type="button" className="button-primary" onClick={() => window.print()}>
        Print receipt
      </button>
    </Modal>
  );
}

function RecipeEditor({ stock, lines, onChange }: { stock: InventoryItem[]; lines: { itemId: string; quantity: string }[]; onChange: (lines: { itemId: string; quantity: string }[]) => void }) {
  return (
    <div className="recipe-editor">
      <div className="recipe-editor-heading">
        <strong>Recipe stock usage</strong>
        <button type="button" className="text-link" onClick={() => onChange([...lines, { itemId: "", quantity: "1" }])}>
          <Plus size={13} /> Add ingredient
        </button>
      </div>
      {lines.map((line, index) => (
        <div className="form-row recipe-row" key={index}>
          <Field label="Inventory item">
            <select value={line.itemId} onChange={(event) => onChange(lines.map((entry, i) => (i === index ? { ...entry, itemId: event.target.value } : entry)))}>
              <option value="">No stock deduction</option>
              {stock.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.unit}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity per order">
            <input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => onChange(lines.map((entry, i) => (i === index ? { ...entry, quantity: event.target.value } : entry)))} />
          </Field>
          {lines.length > 1 && (
            <button type="button" className="recipe-remove" aria-label="Remove ingredient" onClick={() => onChange(lines.filter((_, i) => i !== index))}>
              <X size={15} />
            </button>
          )}
        </div>
      ))}
      <p className="modal-help">Each ingredient is deducted from stock whenever this item is sold.</p>
    </div>
  );
}

function recipeFrom(lines: { itemId: string; quantity: string }[]) {
  const merged = new Map<string, number>();
  for (const line of lines.filter((entry) => entry.itemId)) merged.set(line.itemId, (merged.get(line.itemId) ?? 0) + Number(line.quantity));
  return [...merged].map(([itemId, quantity]) => ({ itemId, quantity }));
}

export function PosSection({ notify, refreshKey, can, reference }: SectionProps) {
  const overview = useResource(() => api.pos.overview(), String(refreshKey));
  const menu = useResource(() => api.menu.list(), String(refreshKey));
  const stock = useResource(() => (can("inventory:read") ? api.inventory.list() : Promise.resolve([])), String(refreshKey));
  const [cart, setCart] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [transferReference, setTransferReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [recipe, setRecipe] = useState([{ itemId: "", quantity: "1" }]);
  const checkoutKey = useRef<string | null>(null);
  const action = useAction();

  const shift = overview.data?.shift ?? null;
  const orders = overview.data?.orders ?? [];
  const items = menu.data ?? [];
  const lines = Object.entries(cart).filter(([, quantity]) => quantity > 0);
  const total = items.reduce((sum, item) => sum + BigInt(item.price_kobo) * BigInt(cart[item.id] ?? 0), 0n);
  const reloadAll = async () => {
    await Promise.all([overview.reload(), menu.reload(), stock.reload()]);
  };

  const showReceipt = async (orderId: string) => {
    try {
      setReceipt(await api.pos.receipt(orderId));
    } catch (error) {
      notify(errorMessage(error, "Receipt unavailable"));
    }
  };

  const checkout = async () => {
    if (!lines.length) return;
    setBusy(true);
    try {
      // The same key is reused if this sale is retried after a network failure.
      checkoutKey.current ??= crypto.randomUUID();
      const order = await api.pos.createOrder({
        items: lines.map(([menuItemId, quantity]) => ({ menuItemId, quantity })),
        paymentMethod: method,
        paymentReference: transferReference.trim(),
        idempotencyKey: checkoutKey.current,
      });
      checkoutKey.current = null;
      setCart({});
      setTransferReference("");
      await reloadAll();
      if (order.payment_status === "pending") notify(`Transfer submitted for confirmation · ${order.receipt_number}`);
      else {
        notify(`Receipt ${order.receipt_number} issued`);
        await showReceipt(order.id);
      }
    } catch (error) {
      notify(errorMessage(error, "Sale failed"));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (item: MenuItem) => {
    if (!window.confirm(`Archive ${item.name}? It disappears from the till; past receipts are unchanged.`)) return;
    try {
      await api.menu.update(item.id, { active: false });
      notify(`${item.name} archived`);
      await menu.reload();
    } catch (error) {
      notify(errorMessage(error, "Unable to archive item"));
    }
  };

  const closeDialog = () => {
    action.clearError();
    setDialog(null);
  };

  return (
    <>
      <InlineError message={overview.error || menu.error} />
      <div className="pos-layout">
        <section className="panel pos-menu-panel">
          <div className="panel-heading">
            <div>
              <h2>Restaurant menu</h2>
              <p>Tap an item to add it to the current order.</p>
            </div>
            <div className="heading-actions">
              <span className={`booking-count ${shift ? "shift-open" : ""}`}>{shift ? `Shift open since ${timeLabel(shift.opened_at)}` : "No active shift"}</span>
              {can("menu:write") && (
                <button
                  className="button-secondary"
                  onClick={() => {
                    setRecipe([{ itemId: "", quantity: "1" }]);
                    setDialog({ kind: "menu-new" });
                  }}
                >
                  <Plus size={15} /> Menu item
                </button>
              )}
            </div>
          </div>
          {!shift && can("pos:write") && (
            <div className="pos-shift-guard">
              <Clock3 size={17} />
              <span>Open a cashier shift before recording sales.</span>
              <button className="button-primary" onClick={() => setDialog({ kind: "shift-open" })}>
                Open shift
              </button>
            </div>
          )}
          {items.length ? (
            <div className="pos-menu-grid">
              {items.map((item) => (
                <div className="pos-menu-tile" key={item.id}>
                  <button className="pos-menu-item" disabled={!shift || !can("pos:write")} onClick={() => setCart((current) => ({ ...current, [item.id]: (current[item.id] ?? 0) + 1 }))}>
                    <span>{item.category}</span>
                    <strong>{item.name}</strong>
                    <b>{money(item.price_kobo)}</b>
                  </button>
                  {can("menu:write") && (
                    <div className="pos-menu-tools">
                      <button aria-label={`Edit ${item.name}`} onClick={() => setDialog({ kind: "menu-edit", item })}>
                        <Pencil size={12} />
                      </button>
                      <button aria-label={`Archive ${item.name}`} onClick={() => void archive(item)}>
                        <Archive size={12} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            !menu.loading && <Empty text="The menu is empty. A manager can add items once stock is configured." />
          )}
        </section>

        <section className="panel pos-cart-panel">
          <div className="panel-heading">
            <div>
              <h2>Current order</h2>
              <p>Receipt issued after successful payment.</p>
            </div>
            <span className="booking-count">{lines.reduce((sum, [, quantity]) => sum + quantity, 0)} items</span>
          </div>
          <div className="pos-cart-lines">
            {lines.map(([id, quantity]) => {
              const item = items.find((entry) => entry.id === id);
              if (!item) return null;
              return (
                <div className="pos-cart-line" key={id}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {quantity} × {money(item.price_kobo)}
                    </small>
                  </div>
                  <b>{money(BigInt(item.price_kobo) * BigInt(quantity))}</b>
                  <button aria-label={`Remove one ${item.name}`} onClick={() => setCart((current) => ({ ...current, [id]: Math.max(0, (current[id] ?? 0) - 1) }))}>
                    −
                  </button>
                </div>
              );
            })}
            {lines.length === 0 && <Empty text="No items in this order yet." />}
          </div>
          <div className="pos-checkout">
            <Field label="Payment method">
              <select
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value as PaymentMethod);
                  setTransferReference("");
                }}
              >
                {reference.posPaymentMethods.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            {method === "bank_transfer" && (
              <Field label="Transfer reference or sender name">
                <input value={transferReference} onChange={(event) => setTransferReference(event.target.value)} maxLength={120} required />
              </Field>
            )}
            <div className="pos-total">
              <span>Total due</span>
              <strong>{money(total)}</strong>
            </div>
            <button className="button-primary" disabled={busy || !shift || !lines.length || (method === "bank_transfer" && !transferReference.trim())} onClick={() => void checkout()}>
              <Check size={15} />
              {busy ? "Saving…" : method === "bank_transfer" ? "Record transfer for confirmation" : "Take payment & issue receipt"}
            </button>
            {shift && (
              <button className="text-link shift-close-link" onClick={() => setDialog({ kind: "shift-close" })}>
                Close cashier shift
              </button>
            )}
          </div>
        </section>

        <section className="panel bookings-panel pos-orders">
          <div className="panel-heading">
            <div>
              <h2>Today’s orders</h2>
              <p>Orders from all cashiers today.</p>
            </div>
          </div>
          {orders.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>RECEIPT</th>
                    <th>TIME</th>
                    <th>CASHIER</th>
                    <th>METHOD</th>
                    <th>TOTAL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td className="booking-amount">{order.receipt_number}</td>
                      <td>{timeLabel(order.created_at)}</td>
                      <td>{order.cashier}</td>
                      <td>{optionLabel(reference.posPaymentMethods, order.payment_method)}</td>
                      <td>{money(order.total_kobo)}</td>
                      <td>
                        <button className="text-link" disabled={order.payment_status === "pending"} onClick={() => void showReceipt(order.id)}>
                          {order.payment_status === "pending" ? "Awaiting confirmation" : "Receipt"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty text="No restaurant orders today." />
          )}
        </section>
      </div>

      {receipt && <ReceiptModal receipt={receipt} methodLabel={optionLabel(reference.posPaymentMethods, receipt.payment_method)} onClose={() => setReceipt(null)} />}

      {dialog?.kind === "shift-open" && (
        <Modal
          title="Open cashier shift"
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              await api.pos.openShift(toKobo(values.get("openingFloat")));
              notify("Cashier shift opened");
              closeDialog();
              await overview.reload();
            })
          }
        >
          <Field label="Opening cash float (₦)">
            <input name="openingFloat" type="number" min="0" step="1" defaultValue="0" required />
          </Field>
        </Modal>
      )}

      {dialog?.kind === "shift-close" && (
        <Modal
          title="Close cashier shift"
          description="The cash variance against the opening float plus cash sales is recorded for manager review."
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              const result = await api.pos.closeShift(toKobo(values.get("countedCash")));
              notify(`Shift closed · cash variance ${money(result.varianceKobo)}`);
              closeDialog();
              await overview.reload();
            })
          }
        >
          <Field label="Counted cash at handover (₦)">
            <input name="countedCash" type="number" min="0" step="1" required />
          </Field>
        </Modal>
      )}

      {dialog?.kind === "menu-new" && (
        <Modal
          title="Add menu item"
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              await api.menu.create({ name: text(values.get("name")), category: text(values.get("category")), priceKobo: toKobo(values.get("price")), recipe: recipeFrom(recipe) });
              notify("Menu item added");
              closeDialog();
              await menu.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Item name">
              <input name="name" required maxLength={120} />
            </Field>
            <Field label="Category">
              <input name="category" required maxLength={60} placeholder="Breakfast" />
            </Field>
          </div>
          <Field label="Price (₦)">
            <input name="price" type="number" min="0" step="1" required />
          </Field>
          <RecipeEditor stock={stock.data ?? []} lines={recipe} onChange={setRecipe} />
        </Modal>
      )}

      {dialog?.kind === "menu-edit" && (
        <Modal
          title={`Edit ${dialog.item.name}`}
          description="Past receipts keep the name and price at the time of sale."
          busy={action.busy}
          error={action.error}
          onClose={closeDialog}
          onSubmit={(values) =>
            action.run(async () => {
              await api.menu.update(dialog.item.id, { name: text(values.get("name")), category: text(values.get("category")), priceKobo: toKobo(values.get("price")) });
              notify(`${text(values.get("name"))} updated`);
              closeDialog();
              await menu.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Item name">
              <input name="name" required maxLength={120} defaultValue={dialog.item.name} />
            </Field>
            <Field label="Category">
              <input name="category" required maxLength={60} defaultValue={dialog.item.category} />
            </Field>
          </div>
          <Field label="Price (₦)">
            <input name="price" type="number" min="0" step="1" required defaultValue={Number(dialog.item.price_kobo) / 100} />
          </Field>
        </Modal>
      )}
    </>
  );
}
