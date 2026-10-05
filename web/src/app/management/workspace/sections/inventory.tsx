"use client";

import { useState } from "react";
import { ArrowDownRight, Plus } from "lucide-react";
import { api, type StockMovementInput } from "@/lib/api";
import { money, text, toKobo } from "../format";
import { Empty, Field, InlineError, Modal, useAction, useResource, type SectionProps } from "../ui";

export function InventorySection({ notify, refreshKey, can, reference }: SectionProps) {
  const items = useResource(() => api.inventory.list(), String(refreshKey));
  const [dialog, setDialog] = useState<"item" | "movement" | null>(null);
  const action = useAction();
  const list = items.data ?? [];
  const done = async (message: string) => {
    notify(message);
    setDialog(null);
    await items.reload();
  };

  return (
    <section className="panel bookings-panel full-panel">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>Stock control</h2>
          <p>Every change to stock is recorded as a movement with its reason and staff member.</p>
        </div>
        <div className="heading-actions">
          <span className="booking-count">{list.filter((item) => item.low_stock).length} low stock</span>
          {can("inventory:write") && (
            <>
              <button className="button-secondary" onClick={() => setDialog("movement")} disabled={list.length === 0}>
                <ArrowDownRight size={15} /> Record movement
              </button>
              <button className="button-primary" onClick={() => setDialog("item")}>
                <Plus size={16} /> Add item
              </button>
            </>
          )}
        </div>
      </div>
      <InlineError message={items.error} />
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ITEM</th>
                <th>SKU</th>
                <th>ON HAND</th>
                <th>REORDER AT</th>
                <th>UNIT COST</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => (
                <tr key={item.id}>
                  <td className="booking-amount">{item.name}</td>
                  <td>{item.sku ?? "—"}</td>
                  <td>
                    {Number(item.quantity)} {item.unit}
                  </td>
                  <td>
                    {Number(item.reorder_level)} {item.unit}
                  </td>
                  <td>{money(item.cost_kobo)}</td>
                  <td>
                    <span className={`status ${item.low_stock ? "status-red" : "status-green"}`}>
                      <i />
                      {item.low_stock ? "Reorder needed" : "In stock"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !items.loading && <Empty text="No stock items yet. Add store items before configuring restaurant recipes." />
      )}

      {dialog === "item" && (
        <Modal
          title="Add inventory item"
          busy={action.busy}
          error={action.error}
          onClose={() => setDialog(null)}
          onSubmit={(values) =>
            action.run(async () => {
              await api.inventory.createItem({
                name: text(values.get("name")),
                sku: text(values.get("sku")),
                unit: text(values.get("unit")),
                quantity: Number(values.get("quantity")),
                reorderLevel: Number(values.get("reorderLevel")),
                costKobo: toKobo(values.get("cost")),
              });
              await done("Inventory item added");
            })
          }
        >
          <div className="form-row">
            <Field label="Item name">
              <input name="name" required maxLength={120} />
            </Field>
            <Field label="SKU (optional)">
              <input name="sku" maxLength={60} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Unit">
              <input name="unit" defaultValue="unit" required maxLength={20} />
            </Field>
            <Field label="Opening quantity">
              <input name="quantity" type="number" min="0" step="0.001" defaultValue="0" required />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Reorder at">
              <input name="reorderLevel" type="number" min="0" step="0.001" defaultValue="0" required />
            </Field>
            <Field label="Unit cost (₦)">
              <input name="cost" type="number" min="0" step="1" defaultValue="0" required />
            </Field>
          </div>
        </Modal>
      )}

      {dialog === "movement" && (
        <Modal
          title="Record stock movement"
          description="Stock can never go below zero."
          busy={action.busy}
          error={action.error}
          onClose={() => setDialog(null)}
          onSubmit={(values) =>
            action.run(async () => {
              await api.inventory.recordMovement({
                action: text(values.get("action")) as StockMovementInput["action"],
                itemId: text(values.get("itemId")),
                quantity: Number(values.get("quantity")),
                reason: text(values.get("reason")),
              });
              await done("Stock movement recorded");
            })
          }
        >
          <Field label="Inventory item">
            <select name="itemId" required>
              {list.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {Number(item.quantity)} {item.unit}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label="Movement">
              <select name="action">
                {reference.stockMovements.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quantity">
              <input name="quantity" type="number" step="0.001" required />
            </Field>
          </div>
          <Field label="Reason / supplier reference">
            <input name="reason" required maxLength={300} />
          </Field>
        </Modal>
      )}
    </section>
  );
}
