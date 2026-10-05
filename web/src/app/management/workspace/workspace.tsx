"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, BedDouble, CalendarDays, Check, Clock3, Coffee, CreditCard, KeyRound, LayoutDashboard, LogOut, Menu, Settings2, Users, Utensils, X } from "lucide-react";
import { api, errorMessage, type Permission, type Property, type Reference, type User } from "@/lib/api";
import { applyProperty, initials, longDateLabel, optionLabel, propertyHour, text } from "./format";
import { Field, Modal, useAction } from "./ui";
import { InventorySection } from "./sections/inventory";
import { OverviewSection } from "./sections/overview";
import { PaymentsSection } from "./sections/payments";
import { PosSection } from "./sections/pos";
import { ReservationsSection } from "./sections/reservations";
import { RoomsSection } from "./sections/rooms";
import { SettingsSection } from "./sections/settings";
import { TeamSection } from "./sections/team";

const NAVIGATION: ReadonlyArray<{ label: string; icon: typeof LayoutDashboard; permission: Permission; description: string }> = [
  { label: "Overview", icon: LayoutDashboard, permission: "dashboard:read", description: "Here’s what’s happening across your property today." },
  { label: "Reservations", icon: CalendarDays, permission: "reservations:read", description: "Stays, arrivals, departures and guest payments." },
  { label: "Payments", icon: CreditCard, permission: "payments:read", description: "The payment register, transfer confirmation and exceptions." },
  { label: "Rooms", icon: BedDouble, permission: "rooms:read", description: "Room readiness and current stays." },
  { label: "Restaurant POS", icon: Utensils, permission: "pos:read", description: "Restaurant sales, receipts and cashier shifts." },
  { label: "Inventory", icon: Coffee, permission: "inventory:read", description: "Store items and the stock movement ledger." },
  { label: "Team & attendance", icon: Users, permission: "staff:read", description: "Staff accounts and attendance." },
  { label: "Settings", icon: Settings2, permission: "settings:manage", description: "Online payments and booking rules. Visible to the owner only." },
];
const LIVE_REFRESH_DEBOUNCE_MS = 600;
const WEBSITE_URL = process.env.NEXT_PUBLIC_WEBSITE_URL ?? "https://houzzhills.com";

function SignIn({ property, setupRequired, onSignedIn }: { property: Property | null; setupRequired: boolean; onSignedIn: (user: User) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      onSignedIn(await api.auth.login({ email: text(values.get("email")), password: String(values.get("password") ?? "") }));
    } catch (caught) {
      setError(errorMessage(caught, "Unable to sign in"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="management-auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <div className="brand-mark">
          H<span>.</span>
        </div>
        {property && <p className="auth-eyebrow">{property.name.toUpperCase()}</p>}
        <h1>Welcome back</h1>
        <p className="auth-copy">Sign in to your property workspace.</p>
        {error && <div className="form-error">{error}</div>}
        <Field label="Work email">
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required />
        </Field>
        <button className="button-primary auth-submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in securely"}
        </button>
        {setupRequired && (
          <p className="auth-setup">
            First time here? <Link href="/management/setup">Set up the owner account</Link>
          </p>
        )}
        <Link className="auth-public-link" href={WEBSITE_URL}>
          Back to the public website <ArrowRight size={13} />
        </Link>
      </form>
    </div>
  );
}

function PasswordDialog({ required, onClose, onChanged }: { required: boolean; onClose?: () => void; onChanged: () => void }) {
  const action = useAction();
  return (
    <Modal
      title={required ? "Choose your own password" : "Change password"}
      description={required ? "Your account uses a temporary password. Replace it to continue." : "Your other devices will be signed out."}
      busy={action.busy}
      error={action.error}
      onClose={onClose}
      onSubmit={(values) =>
        action.run(async () => {
          await api.auth.changePassword({ currentPassword: String(values.get("currentPassword") ?? ""), newPassword: String(values.get("newPassword") ?? "") });
          onChanged();
        })
      }
    >
      <Field label="Current password">
        <input name="currentPassword" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password (12+ characters)">
        <input name="newPassword" type="password" autoComplete="new-password" minLength={12} maxLength={256} required />
      </Field>
    </Modal>
  );
}

export function Workspace() {
  const [user, setUser] = useState<User | null>(null);
  const [property, setProperty] = useState<Property | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "offline">("loading");
  const [setupRequired, setSetupRequired] = useState(false);
  const [active, setActive] = useState("Overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [clockedIn, setClockedIn] = useState<boolean | null>(null);
  const [live, setLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  }, []);
  const can = useCallback((permission: Permission) => user?.permissions.includes(permission) ?? false, [user]);
  const allowed = useMemo(() => NAVIGATION.filter((item) => user?.permissions.includes(item.permission)), [user]);

  const enter = useCallback(async (signedIn: User | null) => {
    if (!signedIn) {
      const setup = await api.setup.status();
      setSetupRequired(setup.setupRequired);
      setUser(null);
      setState("signed-out");
      return;
    }
    if (!signedIn.mustChangePassword) {
      const [loadedProperty, loadedReference] = await Promise.all([api.publicBooking.property(), api.reference.get()]);
      applyProperty(loadedProperty);
      setProperty(loadedProperty);
      setReference(loadedReference);
    }
    setUser(signedIn);
    setActive(NAVIGATION.find((item) => signedIn.permissions.includes(item.permission))?.label ?? "Overview");
    setState("ready");
    if (!signedIn.mustChangePassword) {
      // Only staff with an attendance profile get a clock state; others see no clock control.
      setClockedIn((await api.attendance.self().catch(() => null))?.clockedIn ?? null);
    }
  }, []);

  useEffect(() => {
    // The property is shown on the sign-in screen; it does not exist until setup is done.
    api.publicBooking
      .property()
      .then((loaded) => {
        applyProperty(loaded);
        setProperty(loaded);
      })
      .catch(() => undefined);
    api.auth.session().then(enter, () => setState("offline"));
  }, [enter]);

  // Live updates: committed changes from any user refresh the open section.
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    let timer: number | undefined;
    const stop = api.events.subscribe(
      () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setRefreshKey((key) => key + 1), LIVE_REFRESH_DEBOUNCE_MS);
      },
      (connected) => setLive(connected),
    );
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [user]);

  const signOut = async () => {
    await api.auth.logout().catch(() => undefined);
    setClockedIn(null);
    setLive(false);
    await enter(null).catch(() => setState("offline"));
  };

  const clock = async () => {
    try {
      const next = clockedIn ? "clock_out" : "clock_in";
      await api.attendance.record(next);
      setClockedIn(next === "clock_in");
      notify(next === "clock_in" ? "You are clocked in" : "You are clocked out");
    } catch (error) {
      notify(errorMessage(error, "Attendance could not be recorded"));
    }
  };

  if (state === "loading") {
    return (
      <div className="management-auth-shell">
        <div className="auth-card">
          <div className="brand-mark">
            H<span>.</span>
          </div>
          <strong>Connecting…</strong>
        </div>
      </div>
    );
  }
  if (state === "offline") {
    return (
      <div className="management-auth-shell">
        <div className="auth-card">
          <div className="brand-mark">
            H<span>.</span>
          </div>
          <div className="form-error">The service is not reachable right now. Check your connection and try again.</div>
          <button className="button-primary auth-submit" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (state === "signed-out" || !user) return <SignIn property={property} setupRequired={setupRequired} onSignedIn={(signedIn) => void enter(signedIn).catch(() => setState("offline"))} />;

  if (user.mustChangePassword) {
    return (
      <div className="management-auth-shell">
        <PasswordDialog required onChanged={() => void api.auth.session().then(enter).catch(() => setState("offline"))} />
      </div>
    );
  }

  if (!property || !reference) {
    return (
      <div className="management-auth-shell">
        <div className="auth-card">
          <strong>Loading your workspace…</strong>
        </div>
      </div>
    );
  }

  const current = allowed.find((item) => item.label === active) ?? allowed[0];
  const sectionProps = { user, notify, refreshKey, can, reference, property };
  const hour = propertyHour();

  return (
    <div className="management-shell">
      <aside className={`management-sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="management-brand">
          <div className="brand-mark">
            H<span>.</span>
          </div>
          <div>
            <strong>{property.name.toUpperCase()}</strong>
            <small>PROPERTY OPERATIONS</small>
          </div>
          <button className="mobile-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="side-label">WORKSPACE</div>
        <nav className="management-nav">
          {allowed.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={current?.label === label ? "selected" : ""}
              onClick={() => {
                setActive(label);
                setMenuOpen(false);
              }}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="side-label tools-label">ACCOUNT</div>
        <nav className="management-nav">
          <button onClick={() => setPasswordOpen(true)}>
            <KeyRound size={17} />
            <span>Change password</span>
          </button>
          <button onClick={() => void signOut()}>
            <LogOut size={17} />
            <span>Sign out</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="side-user">
            <div className="user-avatar">{initials(user.fullName)}</div>
            <div>
              <strong>{user.fullName}</strong>
              <span>{optionLabel(reference.roles, user.role)}</span>
            </div>
          </div>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
      <main className="management-main">
        <header className="management-topbar">
          <button className="mobile-menu" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <b>/</b>
            <strong>{current?.label}</strong>
          </div>
          <div className="topbar-actions">
            <div className={`live-indicator ${live ? "" : "is-offline"}`}>
              <i /> {live ? "Live" : "Reconnecting"}
            </div>
            <div className="top-divider" />
            <span className="top-role">{optionLabel(reference.roles, user.role)}</span>
            {clockedIn !== null && (
              <button className={`clock-chip ${clockedIn ? "is-clocked" : ""}`} onClick={() => void clock()}>
                <Clock3 size={14} />
                {clockedIn ? "Clock out" : "Clock in"}
              </button>
            )}
          </div>
        </header>
        <div className="management-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> {longDateLabel().toUpperCase()} <span className="heading-dot">·</span> {property.name.toUpperCase()}
              </div>
              <h1>{current?.label === "Overview" ? `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${user.fullName.split(" ")[0] ?? ""}` : current?.label}</h1>
              <p>{current?.description}</p>
            </div>
          </div>
          {current?.label === "Overview" && <OverviewSection {...sectionProps} onOpen={setActive} />}
          {current?.label === "Reservations" && <ReservationsSection {...sectionProps} />}
          {current?.label === "Payments" && <PaymentsSection {...sectionProps} />}
          {current?.label === "Rooms" && <RoomsSection {...sectionProps} />}
          {current?.label === "Restaurant POS" && <PosSection {...sectionProps} />}
          {current?.label === "Inventory" && <InventorySection {...sectionProps} />}
          {current?.label === "Team & attendance" && <TeamSection {...sectionProps} clockedIn={clockedIn} onClock={() => void clock()} />}
          {current?.label === "Settings" && <SettingsSection {...sectionProps} />}
          <footer className="management-footer">
            <span>
              © {new Date().getFullYear()} {property.name}
            </span>
            <span>
              <span className="footer-status">
                <i /> {live ? "Live updates on" : "Live updates reconnecting"}
              </span>
            </span>
          </footer>
        </div>
      </main>
      {passwordOpen && (
        <PasswordDialog
          required={false}
          onClose={() => setPasswordOpen(false)}
          onChanged={() => {
            setPasswordOpen(false);
            notify("Password updated");
          }}
        />
      )}
      {notice && (
        <div role="status" className="management-toast">
          <Check size={16} />
          {notice}
        </div>
      )}
    </div>
  );
}
