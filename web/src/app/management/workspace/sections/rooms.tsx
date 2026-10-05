"use client";

import { useState } from "react";
import { History, Plus } from "lucide-react";
import { api, errorMessage, type Reference, type Room, type RoomStatus } from "@/lib/api";
import { dateLabel, dateTimeLabel, humanize, money, optionLabel, text, toKobo } from "../format";
import { Empty, Field, InlineError, Modal, useAction, useResource, type SectionProps } from "../ui";

function tone(status: string): string {
  if (status === "vacant_clean" || status === "inspected") return "status-green";
  if (status === "maintenance" || status === "out_of_order") return "status-red";
  return "status-gold";
}

function HistoryModal({ room, reference, onClose }: { room: Room; reference: Reference; onClose: () => void }) {
  const history = useResource(() => api.rooms.history(room.id), room.id);
  return (
    <Modal title={`Room ${room.room_number} history`} description="Latest 100 state changes" onClose={onClose}>
      <InlineError message={history.error} />
      <div className="activity-list">
        {(history.data ?? []).map((entry, index) => (
          <div className="activity-row" key={`${entry.at}-${index}`}>
            <span className="activity-dot gold" />
            <div>
              <strong>
                {entry.from && entry.to ? `${optionLabel(reference.roomStatuses, entry.from)} → ${optionLabel(reference.roomStatuses, entry.to)}` : humanize(entry.action)}
              </strong>
              <p>
                {entry.actor ?? "System"}
                {entry.note ? ` · ${entry.note}` : ""}
              </p>
              <small>{dateTimeLabel(entry.at)}</small>
            </div>
          </div>
        ))}
        {history.data?.length === 0 && <Empty text="No changes recorded yet." />}
      </div>
    </Modal>
  );
}

export function RoomsSection({ notify, refreshKey, can, reference }: SectionProps) {
  const rooms = useResource(() => api.rooms.list(), String(refreshKey));
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<Room | null>(null);
  const action = useAction();
  const list = rooms.data ?? [];
  // The API withholds rates and guest details from roles that may not see them.
  const showRates = list.some((room) => room.nightly_rate_kobo !== null);

  const change = async (room: Room, status: RoomStatus) => {
    try {
      await api.rooms.updateStatus(room.id, status);
      notify(`Room ${room.room_number} updated`);
      await rooms.reload();
    } catch (error) {
      notify(errorMessage(error, "Room update failed"));
    }
  };

  return (
    <section className="panel bookings-panel full-panel">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>Room inventory</h2>
          <p>Readiness, nightly rate and current stay. Rooms become occupied through check-in.</p>
        </div>
        <div className="heading-actions">
          <span className="booking-count">{list.length} rooms</span>
          {can("rooms:create") && (
            <button className="button-primary" onClick={() => setAdding(true)}>
              <Plus size={16} /> Add room
            </button>
          )}
        </div>
      </div>
      <InlineError message={rooms.error} />
      {list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>ROOM</th>
                <th>TYPE</th>
                {showRates && <th>RATE / NIGHT</th>}
                <th>{showRates ? "GUEST / STAY" : "TURNOVER"}</th>
                <th>STATUS</th>
                <th>UPDATE</th>
              </tr>
            </thead>
            <tbody>
              {list.map((room) => (
                <tr key={room.id}>
                  <td className="booking-amount">{room.room_number}</td>
                  <td>
                    {room.room_type} · sleeps {room.capacity}
                  </td>
                  {showRates && <td>{money(room.nightly_rate_kobo)}</td>}
                  <td>{room.stay ? (room.stay.guest ? `${room.stay.guest} · ${room.stay.reference ?? ""}` : `Due ${dateLabel(room.stay.checkOut)}`) : "—"}</td>
                  <td>
                    <span className={`status ${tone(room.status)}`}>
                      <i />
                      {optionLabel(reference.roomStatuses, room.status)}
                    </span>
                  </td>
                  <td>
                    <div className="reservation-actions">
                      {room.next_statuses.length > 0 && (
                        <select className="inline-select" value="" onChange={(event) => event.target.value && void change(room, event.target.value as RoomStatus)} aria-label={`Update room ${room.room_number}`}>
                          <option value="">Set status</option>
                          {room.next_statuses.map((status) => (
                            <option key={status} value={status}>
                              {optionLabel(reference.roomStatuses, status)}
                            </option>
                          ))}
                        </select>
                      )}
                      <button className="icon-text-button" onClick={() => setViewing(room)} aria-label={`History for room ${room.room_number}`}>
                        <History size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !rooms.loading && <Empty text="No rooms yet. Add room numbers, categories, nightly rates and capacities to start taking reservations." />
      )}
      {viewing && <HistoryModal room={viewing} reference={reference} onClose={() => setViewing(null)} />}
      {adding && (
        <Modal
          title="Add a room"
          busy={action.busy}
          error={action.error}
          onClose={() => setAdding(false)}
          onSubmit={(values) =>
            action.run(async () => {
              await api.rooms.create({
                roomNumber: text(values.get("roomNumber")),
                roomType: text(values.get("roomType")),
                nightlyRateKobo: toKobo(values.get("rate")),
                capacity: Number(values.get("capacity")),
              });
              notify("Room added");
              setAdding(false);
              await rooms.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Room number">
              <input name="roomNumber" required maxLength={20} placeholder="e.g. 204" />
            </Field>
            <Field label="Room category">
              <input name="roomType" required maxLength={80} placeholder="e.g. Executive Suite" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Nightly rate (₦)">
              <input name="rate" type="number" min="0" step="1" required />
            </Field>
            <Field label="Guest capacity">
              <input name="capacity" type="number" min="1" max="12" defaultValue="2" required />
            </Field>
          </div>
        </Modal>
      )}
    </section>
  );
}
