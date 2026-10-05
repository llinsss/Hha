"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { api, errorMessage, type PaymentMethod, type Reference, type Reservation, type ReservationStatus, type Room } from "@/lib/api";
import { dateLabel, initials, money, optionLabel, text, toKobo } from "../format";
import { Empty, Field, InlineError, Modal, useAction, useResource, type Notify, type SectionProps } from "../ui";

/** Record-payment and stay-status actions, shared by Overview and Reservations. */
export function useReservationActions(notify: Notify, onChanged: () => void, reference: Reference) {
  const [paying, setPaying] = useState<Reservation | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const action = useAction();

  const changeStatus = async (reservation: Reservation, status: ReservationStatus) => {
    let reason: string | undefined;
    if (status === "cancelled" || status === "no_show") {
      reason = window.prompt(`Reason for marking ${reservation.reference} as ${optionLabel(reference.reservationStatuses, status).toLowerCase()} (recorded in the audit log)`)?.trim();
      if (!reason) return;
    }
    try {
      await api.reservations.updateStatus(reservation.id, status, reason);
      notify(`${reservation.reference} updated`);
      onChanged();
    } catch (error) {
      notify(errorMessage(error, "Reservation update failed"));
    }
  };

  const outstanding = paying ? BigInt(paying.amount_kobo) - BigInt(paying.paid_kobo ?? "0") : 0n;
  const paymentModal = paying && (
    <Modal
      title="Record guest payment"
      description="Cash and POS terminal payments settle at once. Bank transfers wait for owner or manager confirmation."
      busy={action.busy}
      error={action.error}
      onClose={() => setPaying(null)}
      onSubmit={(values) =>
        action.run(async () => {
          const result = await api.reservations.recordPayment(paying.id, {
            amountKobo: toKobo(values.get("amount")),
            method,
            paymentReference: text(values.get("paymentReference")),
            idempotencyKey: crypto.randomUUID(),
          });
          notify(result.paymentStatus === "pending" ? `Transfer awaiting confirmation · ${paying.reference}` : `Payment recorded for ${paying.reference}`);
          setPaying(null);
          onChanged();
        })
      }
    >
      <p className="payment-reference">
        {paying.guest_name} · {paying.reference} · outstanding {money(outstanding)}
      </p>
      <div className="form-row">
        <Field label="Amount received (₦)">
          <input name="amount" type="number" min="1" step="1" defaultValue={Number(outstanding) / 100} required />
        </Field>
        <Field label="Payment method">
          <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod)}>
            {reference.staffPaymentMethods.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Bank transfer reference or sender name">
        <input name="paymentReference" maxLength={120} required={method === "bank_transfer"} />
      </Field>
    </Modal>
  );

  const startPayment = (reservation: Reservation) => {
    action.clearError();
    setMethod((reference.staffPaymentMethods[0]?.value ?? "cash") as PaymentMethod);
    setPaying(reservation);
  };
  return { changeStatus, startPayment, paymentModal };
}

/** Renders the actions the API allows for each reservation; it holds no rules of its own. */
export function ReservationTable({
  rows,
  reference,
  onStatus,
  onPay,
}: {
  rows: Reservation[];
  reference: Reference;
  onStatus: (reservation: Reservation, status: ReservationStatus) => void;
  onPay: (reservation: Reservation) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>GUEST</th>
            <th>ROOM</th>
            <th>STAY DATES</th>
            <th>BOOKING VALUE</th>
            <th>STATUS</th>
            <th>ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { next_statuses: nextStatuses, record_payment: canPay } = row.actions;
            const menu = nextStatuses.filter((status) => status !== "checked_out");
            return (
              <tr key={row.id}>
                <td>
                  <div className="guest-cell">
                    <span className="guest-avatar tone-gold">{initials(row.guest_name)}</span>
                    <div>
                      <strong>{row.guest_name}</strong>
                      <small>
                        {row.reference} · {optionLabel(reference.paymentStatuses, row.payment_status)}
                      </small>
                    </div>
                  </div>
                </td>
                <td>{row.room_number ? `${row.room_type} · ${row.room_number}` : row.room_type}</td>
                <td>
                  {dateLabel(row.check_in)} — {dateLabel(row.check_out)}
                </td>
                <td className="booking-amount">{money(row.amount_kobo)}</td>
                <td>
                  <span className={`status ${row.status === "checked_in" ? "status-green" : row.status === "confirmed" ? "status-gold" : "status-red"}`}>
                    <i />
                    {optionLabel(reference.reservationStatuses, row.status)}
                  </span>
                </td>
                <td>
                  <div className="reservation-actions">
                    {canPay && (
                      <button className="text-link" onClick={() => onPay(row)}>
                        Record payment
                      </button>
                    )}
                    {menu.length > 0 && (
                      <select className="inline-select" value="" onChange={(event) => event.target.value && onStatus(row, event.target.value as ReservationStatus)} aria-label={`Update ${row.reference}`}>
                        <option value="">Stay action</option>
                        {menu.map((status) => (
                          <option key={status} value={status}>
                            {optionLabel(reference.reservationStatuses, status)}
                          </option>
                        ))}
                      </select>
                    )}
                    {nextStatuses.includes("checked_out") && (
                      <button className="text-link" onClick={() => onStatus(row, "checked_out")}>
                        Check out
                      </button>
                    )}
                    {!canPay && nextStatuses.length === 0 && <span className="quiet-action">—</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <Empty text="No reservations in this view." />}
    </div>
  );
}

/** Staff booking for a specific room. Loads bookable rooms when opened. */
export function NewReservationModal({ notify, onClose, onCreated }: { notify: Notify; onClose: () => void; onCreated: () => void }) {
  const rooms = useResource<Room[]>(() => api.rooms.list().then((list) => list.filter((room) => room.active !== false && !["maintenance", "out_of_order"].includes(room.status))), "new-reservation");
  const action = useAction();
  return (
    <Modal
      title="Create reservation"
      description="Priced from the room rate. Overlapping stays are rejected."
      busy={action.busy}
      error={action.error || rooms.error}
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          const reservation = await api.reservations.create({
            name: text(values.get("name")),
            email: text(values.get("email")),
            phone: text(values.get("phone")),
            roomId: text(values.get("roomId")),
            checkIn: text(values.get("checkIn")),
            checkOut: text(values.get("checkOut")),
            guests: Number(values.get("guests") ?? 1),
          });
          notify(`Reservation ${reservation.reference} created`);
          onCreated();
        })
      }
    >
      <Field label="Guest full name">
        <input name="name" required maxLength={120} />
      </Field>
      <div className="form-row">
        <Field label="Email">
          <input name="email" type="email" maxLength={254} />
        </Field>
        <Field label="Phone">
          <input name="phone" type="tel" maxLength={32} />
        </Field>
      </div>
      <Field label="Room">
        <select name="roomId" required defaultValue="">
          <option value="" disabled>
            {rooms.loading ? "Loading rooms…" : "Select a room"}
          </option>
          {(rooms.data ?? []).map((room) => (
            <option key={room.id} value={room.id}>
              {room.room_number} · {room.room_type} · {money(room.nightly_rate_kobo)}/night · sleeps {room.capacity}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label="Check in">
          <input name="checkIn" type="date" required />
        </Field>
        <Field label="Check out">
          <input name="checkOut" type="date" required />
        </Field>
      </div>
      <Field label="Guests">
        <input name="guests" type="number" min="1" max="12" defaultValue="1" required />
      </Field>
    </Modal>
  );
}

export function ReservationsSection({ notify, refreshKey, can, reference }: SectionProps) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);
  const reservations = useResource(() => api.reservations.list({ q: query || undefined }), `${refreshKey}:${query}`);
  const actions = useReservationActions(notify, () => void reservations.reload(), reference);
  const rows = reservations.data ?? [];

  return (
    <>
      <section className="panel bookings-panel full-panel">
        <div className="panel-heading bookings-heading">
          <div>
            <h2>Reservations</h2>
            <p>Search stays and manage arrivals, departures and payments.</p>
          </div>
          <div className="heading-actions">
            <span className="booking-count">{rows.length} shown</span>
            {can("reservations:write") && (
              <button className="button-primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> New reservation
              </button>
            )}
          </div>
        </div>
        <div className="booking-toolbar">
          <div className="booking-tabs">
            <span className="active">{query ? `Matching “${query}”` : "Most recent"}</span>
          </div>
          <div className="booking-tools">
            <div className="table-search">
              <Search size={15} />
              <input placeholder="Search guest or reference" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search reservations" />
            </div>
          </div>
        </div>
        <InlineError message={reservations.error} />
        <ReservationTable rows={rows} reference={reference} onStatus={(row, status) => void actions.changeStatus(row, status)} onPay={actions.startPayment} />
      </section>
      {actions.paymentModal}
      {creating && (
        <NewReservationModal
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reservations.reload();
          }}
        />
      )}
    </>
  );
}
