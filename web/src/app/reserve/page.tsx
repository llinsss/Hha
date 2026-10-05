"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BedDouble, CalendarDays, Users } from "lucide-react";
import { api, errorMessage, type AvailableRoomType, type Property } from "@/lib/api";
import { applyProperty, money, propertyDate } from "../management/workspace/format";

type Search = { checkIn: string; checkOut: string; guests: number };

function nights(search: Search): number {
  return Math.round((Date.parse(search.checkOut) - Date.parse(search.checkIn)) / 86_400_000);
}

/** Public booking: availability, guest details, then the provider's hosted checkout. */
export default function ReservePage() {
  const [property, setProperty] = useState<Property | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [results, setResults] = useState<AvailableRoomType[] | null>(null);
  const [chosen, setChosen] = useState<AvailableRoomType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per booking attempt, so a double-click or retry never creates a second booking or charge.
  const attemptKey = useRef<string | null>(null);

  // Name, timezone and currency come from the API; dates default to the property's tomorrow.
  useEffect(() => {
    api.publicBooking
      .property()
      .then((loaded) => {
        applyProperty(loaded);
        setProperty(loaded);
        setSearch({ checkIn: propertyDate(1), checkOut: propertyDate(3), guests: 2 });
      })
      .catch((caught: unknown) => setError(errorMessage(caught, "Online booking is not available right now")));
  }, []);

  const find = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!search) return;
    setError("");
    setChosen(null);
    if (nights(search) < 1) {
      setError("Check-out must be after check-in.");
      return;
    }
    setBusy(true);
    try {
      setResults(await api.publicBooking.availability(search));
    } catch (caught) {
      setError(errorMessage(caught, "Unable to check availability"));
    } finally {
      setBusy(false);
    }
  };

  const book = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chosen || !search) return;
    const values = new FormData(event.currentTarget);
    const field = (name: string) => String(values.get(name) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      attemptKey.current ??= crypto.randomUUID();
      const booking = await api.publicBooking.reserve(
        {
          name: field("name"),
          email: field("email"),
          ...(field("phone") ? { phone: field("phone") } : {}),
          roomType: chosen.room_type,
          checkIn: search.checkIn,
          checkOut: search.checkOut,
          guests: search.guests,
          ...(field("notes") ? { notes: field("notes") } : {}),
        },
        attemptKey.current,
      );
      window.location.assign(booking.checkoutUrl);
    } catch (caught) {
      setError(errorMessage(caught, "We could not start your booking"));
      setBusy(false);
    }
  };

  return (
    <div className="public-shell">
      <header className="public-header">
        <div className="brand-mark">
          H<span>.</span>
        </div>
        <div>
          <strong>{property?.name ?? ""}</strong>
          <small>Book online</small>
        </div>
      </header>
      <main className="public-main">
        <h1>Book your stay</h1>
        <p className="auth-copy">Choose your dates, pick a room and pay securely online. Your room is held while you pay.</p>
        {error && <div className="form-error">{error}</div>}
        {!search && !error && <div className="empty-state">Loading…</div>}

        {search && (
        <form className="public-card search-card" onSubmit={(event) => void find(event)}>
          <label className="form-field">
            <span>
              <CalendarDays size={13} /> Check in
            </span>
            <input type="date" min={propertyDate(0)} value={search.checkIn} onChange={(event) => setSearch({ ...search, checkIn: event.target.value })} required />
          </label>
          <label className="form-field">
            <span>
              <CalendarDays size={13} /> Check out
            </span>
            <input type="date" min={search.checkIn} value={search.checkOut} onChange={(event) => setSearch({ ...search, checkOut: event.target.value })} required />
          </label>
          <label className="form-field">
            <span>
              <Users size={13} /> Guests
            </span>
            <input type="number" min={1} max={12} value={search.guests} onChange={(event) => setSearch({ ...search, guests: Number(event.target.value) })} required />
          </label>
          <button className="button-primary" disabled={busy}>
            {busy && !chosen ? "Checking…" : "Check availability"}
          </button>
        </form>
        )}

        {results && search && (
          <section className="room-results">
            {results.length === 0 && <div className="empty-state">No rooms are free for those dates. Try different dates or contact the property.</div>}
            {results.map((type) => (
              <article key={type.room_type} className={`public-card room-option ${chosen?.room_type === type.room_type ? "selected" : ""}`}>
                <div>
                  <h2>
                    <BedDouble size={16} /> {type.room_type}
                  </h2>
                  <p>
                    Sleeps up to {type.capacity} · {type.available_count} available
                  </p>
                </div>
                <div className="room-price">
                  <strong>{money(BigInt(type.nightly_rate_kobo) * BigInt(nights(search)))}</strong>
                  <small>
                    {money(type.nightly_rate_kobo)} × {nights(search)} night{nights(search) === 1 ? "" : "s"}
                  </small>
                  <button className="button-secondary" onClick={() => setChosen(type)} type="button">
                    {chosen?.room_type === type.room_type ? "Selected" : "Select"}
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}

        {chosen && search && (
          <form className="public-card guest-card" onSubmit={(event) => void book(event)}>
            <h2>Your details</h2>
            <div className="form-row">
              <label className="form-field">
                <span>Full name</span>
                <input name="name" autoComplete="name" required maxLength={120} />
              </label>
              <label className="form-field">
                <span>Email (for your receipt)</span>
                <input name="email" type="email" autoComplete="email" required maxLength={254} />
              </label>
            </div>
            <div className="form-row">
              <label className="form-field">
                <span>Phone</span>
                <input name="phone" type="tel" autoComplete="tel" maxLength={32} pattern="[+0-9 ()\-]*" />
              </label>
              <label className="form-field">
                <span>Notes (optional)</span>
                <input name="notes" maxLength={2000} />
              </label>
            </div>
            <button className="button-primary auth-submit" disabled={busy}>
              {busy ? "Opening secure checkout…" : "Continue to secure payment"} <ArrowRight size={15} />
            </button>
            <p className="modal-help">You will pay the full stay of {money(BigInt(chosen.nightly_rate_kobo) * BigInt(nights(search)))} on the payment provider&apos;s page. Bookings are non-refundable.</p>
          </form>
        )}
      </main>
    </div>
  );
}
