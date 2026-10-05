"use client";

import { useState } from "react";
import { Activity, ArrowDownRight, BedDouble, Check, CircleDollarSign, Clock3, Plus, ShieldCheck, Users, Utensils } from "lucide-react";
import { api, type Dashboard } from "@/lib/api";
import { humanize, money, timeLabel } from "../format";
import { Empty, InlineError, Metric, useResource, type SectionProps } from "../ui";
import { NewReservationModal, ReservationTable, useReservationActions } from "./reservations";

export function OverviewSection({ notify, refreshKey, can, reference, property, onOpen }: SectionProps & { onOpen: (section: string) => void }) {
  const dashboard = useResource<Dashboard>(() => api.dashboard.get(), String(refreshKey));
  const actions = useReservationActions(notify, () => void dashboard.reload(), reference);
  const [creating, setCreating] = useState(false);
  const data = dashboard.data;
  const metrics = data?.metrics ?? {};
  const occupied = Number(metrics.occupied_rooms ?? 0);
  const sellable = Number(metrics.sellable_rooms ?? 0);
  const showMoney = "room_revenue_kobo" in metrics;

  return (
    <>
      <InlineError message={dashboard.error} />
      {can("reservations:write") && (
        <div className="section-actions">
          <button className="button-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New reservation
          </button>
        </div>
      )}
      <section className="metric-grid" aria-label="Property performance">
        <Metric label="Occupancy" icon={<BedDouble size={17} />} tone="lavender" value={String(sellable ? Math.round((occupied / sellable) * 100) : 0)} unit="%" foot={`${occupied} of ${sellable} rooms`} progress={sellable ? (occupied / sellable) * 100 : 0} />
        <Metric label="Arrivals today" icon={<ArrowDownRight size={17} />} tone="peach" value={String(metrics.arrivals ?? 0)} foot={`${metrics.departures ?? 0} departures today`} />
        {showMoney && (
          <>
            <Metric
              label="Revenue today"
              icon={<CircleDollarSign size={17} />}
              tone="mint"
              value={money(BigInt(String(metrics.room_revenue_kobo ?? "0")) + BigInt(String(metrics.restaurant_revenue_kobo ?? "0")))}
              foot="Settled room + restaurant payments"
            />
            <Metric label="Restaurant sales" icon={<Utensils size={17} />} tone="butter" value={money(String(metrics.restaurant_revenue_kobo ?? "0"))} foot={`${metrics.restaurant_orders ?? 0} paid orders today`} />
          </>
        )}
      </section>

      <section className="dashboard-grid">
        <article className="panel revenue-panel">
          <div className="panel-heading">
            <div>
              <h2>Operations</h2>
              <p>Committed activity across the property</p>
            </div>
          </div>
          <div className="live-kpi-row">
            <div>
              <small>Rooms in service</small>
              <strong>{sellable}</strong>
            </div>
            <div>
              <small>Staff clocked in</small>
              <strong>{data?.staff.clocked_in ?? 0}</strong>
            </div>
            <div>
              <small>Out of service</small>
              <strong>{metrics.maintenance_rooms ?? 0}</strong>
            </div>
            <div>
              <small>Low stock alerts</small>
              <strong>{metrics.low_stock_items ?? 0}</strong>
            </div>
          </div>
          {"pending_transfers" in metrics && (
            <button className="owner-callout callout-button" onClick={() => onOpen("Payments")}>
              <ShieldCheck size={17} />
              <div>
                <strong>
                  {metrics.pending_transfers} bank transfer{Number(metrics.pending_transfers) === 1 ? "" : "s"} awaiting confirmation
                  {"open_payment_exceptions" in metrics && ` · ${metrics.open_payment_exceptions} payment exception${Number(metrics.open_payment_exceptions) === 1 ? "" : "s"}`}
                </strong>
                <span>Open the payment register to review them.</span>
              </div>
            </button>
          )}
        </article>
        <article className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <p>Latest committed changes</p>
            </div>
          </div>
          <div className="activity-list">
            {data?.activity.length ? (
              data.activity.map((item) => (
                <div className="activity-row" key={item.id}>
                  <span className="activity-dot gold" />
                  <div>
                    <strong>{humanize(item.event_type)}</strong>
                    <p>{String(item.payload.reference ?? item.entity_id)}</p>
                    <small>{timeLabel(item.created_at)}</small>
                  </div>
                </div>
              ))
            ) : (
              <Empty text="No activity recorded yet." />
            )}
          </div>
        </article>
      </section>

      {can("reservations:read") && (
        <section className="panel bookings-panel">
          <div className="panel-heading bookings-heading">
            <div>
              <h2>Arrivals and in-house stays</h2>
              <p>
                Stays from today through the next three days <span className="booking-count">{data?.reservations.length ?? 0}</span>
              </p>
            </div>
            <button className="text-link" onClick={() => onOpen("Reservations")}>
              All reservations
            </button>
          </div>
          <ReservationTable rows={data?.reservations ?? []} reference={reference} onStatus={(row, status) => void actions.changeStatus(row, status)} onPay={actions.startPayment} />
        </section>
      )}

      <section className="bottom-grid">
        <article className="panel operations-panel">
          <div className="panel-heading">
            <div>
              <h2>Today at a glance</h2>
              <p>Key operational checkpoints</p>
            </div>
            <Clock3 size={18} className="faint-icon" />
          </div>
          <div className="ops-stats">
            <div>
              <span className="ops-icon mint">
                <Check size={16} />
              </span>
              <div>
                <strong>{data?.operations.completed_housekeeping ?? 0}</strong>
                <small>Housekeeping completed</small>
              </div>
            </div>
            <div>
              <span className="ops-icon peach">
                <Users size={16} />
              </span>
              <div>
                <strong>
                  {data?.staff.clocked_in ?? 0} / {metrics.active_staff ?? 0}
                </strong>
                <small>Staff clocked in</small>
              </div>
            </div>
            <div>
              <span className="ops-icon lavender">
                <BedDouble size={16} />
              </span>
              <div>
                <strong>{data?.operations.open_housekeeping ?? 0}</strong>
                <small>Open room tasks</small>
              </div>
            </div>
          </div>
        </article>
        <article className="panel shift-panel">
          <div className="panel-heading">
            <div>
              <h2>Property</h2>
              <p>{data?.property.timezone ?? property.timezone}</p>
            </div>
          </div>
          <div className="owner-callout">
            <Activity size={17} />
            <div>
              <strong>{data?.property.name ?? property.name}</strong>
              <span>Server time {data ? timeLabel(data.serverTime) : "—"}</span>
            </div>
          </div>
        </article>
      </section>

      {actions.paymentModal}
      {creating && (
        <NewReservationModal
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void dashboard.reload();
          }}
        />
      )}
    </>
  );
}
