"use client";

import { useState } from "react";
import { AlertTriangle, BedDouble, Check, Download, Search, Utensils } from "lucide-react";
import { api, errorMessage, type PaymentException, type PaymentRecord } from "@/lib/api";
import { dateTimeLabel, humanize, money, optionLabel, text } from "../format";
import { Empty, Field, InlineError, Modal, download, useAction, useResource, type SectionProps } from "../ui";

function ExceptionsPanel({ notify, refreshKey }: Pick<SectionProps, "notify" | "refreshKey">) {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [resolving, setResolving] = useState<PaymentException | null>(null);
  const exceptions = useResource(() => api.payments.exceptions(status), `${refreshKey}:${status}`);
  const action = useAction();
  const rows = exceptions.data ?? [];

  return (
    <section className="panel bookings-panel full-panel">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>Payment exceptions</h2>
          <p>Payments that need a decision. Resolving records what you did; it never confirms a stay or issues a refund.</p>
        </div>
      </div>
      <div className="booking-toolbar">
        <div className="booking-tabs">
          {(["open", "resolved"] as const).map((value) => (
            <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>
              {value === "open" ? "Open" : "Resolved"}
            </button>
          ))}
        </div>
      </div>
      <InlineError message={exceptions.error} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>ISSUE</th>
              <th>REFERENCE</th>
              <th>EXPECTED / RECEIVED</th>
              <th>DETECTED</th>
              <th>{status === "open" ? "ACTION" : "RESOLUTION"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <span className="status status-red">
                    <AlertTriangle size={11} />
                    {row.title}
                  </span>
                </td>
                <td>
                  {row.reservation_reference ?? row.provider_reference ?? "—"}
                  {row.provider && <small className="payment-unit">{row.provider}</small>}
                </td>
                <td>
                  {row.expected_amount_kobo ? money(row.expected_amount_kobo) : "—"} / {row.received_amount_kobo ? money(row.received_amount_kobo) : "—"}
                </td>
                <td>{dateTimeLabel(row.detected_at)}</td>
                <td>
                  {status === "open" ? (
                    <button className="text-link" onClick={() => setResolving(row)}>
                      Resolve
                    </button>
                  ) : (
                    <>
                      {row.resolution_note}
                      <small className="payment-unit">
                        {row.resolved_by ?? "System"} · {row.resolved_at ? dateTimeLabel(row.resolved_at) : ""}
                      </small>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty text={status === "open" ? "No open payment exceptions." : "No resolved exceptions yet."} />}
      </div>
      {resolving && (
        <Modal
          title="Resolve payment exception"
          description={`${resolving.title} · ${resolving.reservation_reference ?? resolving.provider_reference ?? ""}`}
          submitLabel="Mark resolved"
          busy={action.busy}
          error={action.error}
          onClose={() => setResolving(null)}
          onSubmit={(values) =>
            action.run(async () => {
              await api.payments.resolveException(resolving.id, text(values.get("note")));
              notify("Exception resolved");
              setResolving(null);
              await exceptions.reload();
            })
          }
        >
          <Field label="What was done (recorded in the audit log)">
            <textarea name="note" required minLength={5} maxLength={1000} rows={4} />
          </Field>
        </Modal>
      )}
    </section>
  );
}

export function PaymentsSection({ notify, refreshKey, can, reference }: SectionProps) {
  const register = useResource(() => api.payments.register(), String(refreshKey));
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const payments = register.data?.payments ?? [];
  const totals = register.data?.totals;
  const filtered = payments.filter((payment) =>
    `${payment.reference} ${payment.guest_name} ${payment.unit_label} ${payment.method} ${payment.status} ${payment.payment_reference ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const pending = payments.filter((payment) => payment.status === "pending");

  const confirm = async (payment: PaymentRecord) => {
    const detail = `${payment.reference} · ${money(payment.amount_kobo)} · ${payment.payment_reference ?? "no transfer reference"}`;
    const note = window.prompt(`Confirm this bank transfer has arrived in the company account?\n\n${detail}\n\nOptional note for the audit log:`);
    if (note === null) return;
    setBusy(true);
    try {
      await api.payments.confirm(payment.id, payment.source, note.trim() || undefined);
      notify(`Bank transfer confirmed · ${payment.reference}`);
      await register.reload();
    } catch (error) {
      notify(errorMessage(error, "Unable to confirm transfer"));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    try {
      const file = await api.payments.exportCsv();
      download(file.blob, file.filename);
    } catch (error) {
      notify(errorMessage(error, "Export failed"));
    }
  };

  return (
    <>
      <section className="payment-summary-grid">
        <article>
          <span>Settled</span>
          <strong>{money(totals?.settledKobo)}</strong>
          <small>{totals?.count ?? 0} records in the register</small>
        </article>
        <article>
          <span>Awaiting confirmation</span>
          <strong>{money(totals?.pendingKobo)}</strong>
          <small>{pending.length} transfer{pending.length === 1 ? "" : "s"} in this view · not counted as revenue</small>
        </article>
        <article>
          <span>Failed or abandoned</span>
          <strong>{money(totals?.failedKobo)}</strong>
          <small>Unfinished online checkouts</small>
        </article>
      </section>
      <section className="panel bookings-panel full-panel payment-register">
        <div className="panel-heading bookings-heading">
          <div>
            <h2>Payment register</h2>
            <p>Every room and restaurant payment. Confirm bank transfers only after they appear in the company account.</p>
          </div>
          <button className="button-secondary" onClick={() => void exportCsv()}>
            <Download size={15} /> Export CSV
          </button>
        </div>
        <div className="booking-toolbar">
          <div className="booking-tabs">
            <span className="active">Most recent</span>
          </div>
          <div className="booking-tools">
            <div className="table-search">
              <Search size={15} />
              <input placeholder="Search guest, reference, method" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search payments" />
            </div>
          </div>
        </div>
        <InlineError message={register.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>PAYMENT</th>
                <th>GUEST / UNIT</th>
                <th>METHOD / REFERENCE</th>
                <th>RECORDED BY</th>
                <th>DATE</th>
                <th>AMOUNT</th>
                <th>STATUS / ACTION</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((payment) => (
                <tr key={`${payment.source}-${payment.id}`}>
                  <td>
                    <div className="guest-cell">
                      <span className={`guest-avatar ${payment.source === "restaurant" ? "tone-blue" : "tone-gold"}`}>{payment.source === "restaurant" ? <Utensils size={14} /> : <BedDouble size={14} />}</span>
                      <div>
                        <strong>{payment.reference}</strong>
                        <small>{payment.source === "restaurant" ? "Restaurant" : "Accommodation"}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong className="payment-person">{payment.guest_name}</strong>
                    <small className="payment-unit">{payment.unit_label}</small>
                  </td>
                  <td>
                    <span className="payment-method">{optionLabel(reference.paymentMethods, payment.method)}</span>
                    <small className="payment-unit">{payment.payment_reference ?? "—"}</small>
                  </td>
                  <td>
                    {payment.recorded_by ?? "Online"}
                    {payment.confirmed_by && <small className="payment-unit">Confirmed by {payment.confirmed_by}</small>}
                  </td>
                  <td>{dateTimeLabel(payment.created_at)}</td>
                  <td className="booking-amount">{money(payment.amount_kobo)}</td>
                  <td>
                    <div className="payment-status-action">
                      <span className={`status ${payment.status === "settled" ? "status-green" : payment.status === "pending" ? "status-gold" : "status-red"}`}>
                        <i />
                        {payment.status === "pending" ? "pending confirmation" : humanize(payment.status)}
                      </span>
                      {payment.status === "pending" && payment.method === "bank_transfer" && can("payments:confirm") && (
                        <button className="payment-confirm-button" disabled={busy} onClick={() => void confirm(payment)}>
                          <Check size={13} />
                          Confirm transfer
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <Empty text="No payments match this view." />}
        </div>
      </section>
      {can("payments:confirm") && <ExceptionsPanel notify={notify} refreshKey={refreshKey} />}
    </>
  );
}
