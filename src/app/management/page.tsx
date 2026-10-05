"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  Activity, ArrowDownRight, ArrowRight, Bell, BedDouble, CalendarDays,
  Check, ChevronDown, CircleDollarSign, Clock3, Coffee, LayoutDashboard,
  CreditCard, LogOut, Menu, MoreHorizontal, Plus, Search, Settings2, ShieldCheck, Users, Utensils, X,
} from "lucide-react";

type User = { id: string; fullName: string; email: string; role: string; mustChangePassword: boolean };
type Room = { id: string; room_number: string; room_type: string; nightly_rate_kobo: string; capacity: number; status: string; active?: boolean; stay?: { reference: string; guest: string; checkOut: string } | null };
type Reservation = { id: string; reference: string; guest_name: string; email?: string; phone?: string; room_type: string; room_number?: string; check_in: string; check_out: string; guests_count?: number; amount_kobo: string; paid_kobo?: string; status: string; payment_status: string; source?: string };
type PaymentRecord = { id: string; source: "accommodation" | "restaurant"; reference: string; guest_name: string; unit_label: string; amount_kobo: string; method: string; status: "pending" | "settled" | "failed"; payment_reference?: string; created_at: string; recorded_by?: string; confirmed_by?: string; confirmed_at?: string };
type Staff = { id: string; user_id?: string; employee_number: string; department: string; job_title: string; phone?: string; emergency_contact?: string; employment_status: string; full_name: string; email: string; role: string; last_attendance_event?: string; last_attendance_at?: string };
type InventoryItem = { id: string; name: string; sku?: string; unit: string; quantity: string; reorder_level: string; cost_kobo: string; low_stock: boolean };
type MenuItem = { id: string; name: string; category: string; price_kobo: string; recipe: { itemId: string; name: string; quantity: number }[] };
type Dashboard = { property: { name: string; timezone: string; currency: string }; metrics: Record<string, number | string>; reservations: Reservation[]; activity: { id: string; event_type: string; entity_id: string; payload: Record<string, unknown>; created_at: string }[]; operations: { open_housekeeping: number; completed_housekeeping: number }; staff: { clocked_in: number }; user: User; serverTime: string };

const navigation = [
  { label: "Overview", icon: LayoutDashboard, permission: "dashboard:read" },
  { label: "Reservations", icon: CalendarDays, permission: "reservations:read" },
  { label: "Payments", icon: CreditCard, permission: "payments:read" },
  { label: "Rooms", icon: BedDouble, permission: "rooms:read" },
  { label: "Restaurant POS", icon: Utensils, permission: "pos:read" },
  { label: "Inventory", icon: Coffee, permission: "inventory:read" },
  { label: "Team & attendance", icon: Users, permission: "staff:read" },
];
const permissions: Record<string, string[]> = {
  owner: ["*"], manager: ["dashboard:read", "reservations:read", "reservations:write", "rooms:read", "rooms:write", "staff:read", "staff:write", "attendance:read", "attendance:write", "pos:read", "pos:write", "inventory:read", "inventory:write", "menu:write", "payments:read", "payments:confirm", "reports:read"],
  front_desk: ["dashboard:read", "reservations:read", "reservations:write", "rooms:read", "rooms:write"], housekeeping: ["rooms:read", "rooms:write"],
  restaurant_cashier: ["pos:read", "pos:write"], restaurant_manager: ["pos:read", "pos:write", "inventory:read", "inventory:write", "menu:write", "staff:read", "attendance:read", "attendance:write", "reports:read"],
  storekeeper: ["inventory:read", "inventory:write"], finance: ["dashboard:read", "reservations:read", "pos:read", "payments:read", "reports:read"],
  auditor: ["dashboard:read", "reservations:read", "rooms:read", "staff:read", "attendance:read", "pos:read", "inventory:read", "reports:read"],
};
const roles = ["manager", "front_desk", "housekeeping", "restaurant_cashier", "restaurant_manager", "storekeeper", "finance", "auditor"];
const roomStatuses = ["vacant_clean", "vacant_dirty", "occupied", "inspected", "maintenance", "out_of_order"];
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";
const money = (kobo: string | number | bigint) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(Number(kobo) / 100);
const roleLabel = (role: string) => role.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const dateLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-NG", { day: "2-digit", month: "short" });
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((x) => x[0]).join("").toUpperCase();

async function api<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${url}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...init?.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload as T;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="form-field"><span>{label}</span>{children}</label>; }

export default function ManagementPage() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [databaseError, setDatabaseError] = useState(false);
  const [active, setActive] = useState("Overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<{ id: string; receipt_number: string; total_kobo: string; payment_method: string; payment_status: string; created_at: string; cashier: string }[]>([]);
  const [shift, setShift] = useState<{ id: string; opening_float_kobo: string; opened_at: string } | null>(null);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [recipeLines, setRecipeLines] = useState<{ itemId: string; quantity: string }[]>([{ itemId: "", quantity: "1" }]);
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [reservationPaymentMethod, setReservationPaymentMethod] = useState("cash");
  const [receipt, setReceipt] = useState<Record<string, unknown> | null>(null);
  const [paymentFor, setPaymentFor] = useState<Reservation | null>(null);
  const [clockedIn, setClockedIn] = useState<boolean | null>(null);
  const [clockBusy, setClockBusy] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const checkoutKey = useRef<string | null>(null);

  const notify = useCallback((message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 3000); }, []);
  const loadDashboard = useCallback(async () => {
    const data = await api<Dashboard>("/api/management/dashboard");
    setDashboard(data); setReservations(data.reservations); setLastSync(new Date()); setError("");
  }, []);
  const loadSession = useCallback(async () => {
    try {
      const session = await api<{ user: User | null }>("/api/auth/session");
      setUser(session.user);
      if (session.user) {
        const allowed = navigation.filter((item) => permissions[session.user!.role]?.includes("*") || permissions[session.user!.role]?.includes(item.permission));
        if (allowed.length) setActive(allowed[0].label);
        if (session.user.mustChangePassword) setModal("password");
        const attendance = await api<{ clockedIn: boolean }>("/api/management/attendance/self").catch(() => null);
        if (attendance) setClockedIn(attendance.clockedIn);
        try { await loadDashboard(); } catch (e) { setError(e instanceof Error ? e.message : "Unable to load dashboard"); }
      } else {
        const setup = await api<{ setupRequired: boolean }>("/api/setup"); setSetupRequired(setup.setupRequired);
      }
    } catch { setDatabaseError(true); }
    finally { setReady(true); }
  }, [loadDashboard]);

  const loadPos = useCallback(async () => {
    const [pos, menu] = await Promise.all([api<{ shift: typeof shift; orders: typeof orders }>("/api/management/pos"), api<{ menu: MenuItem[] }>("/api/management/menu")]);
    setShift(pos.shift); setOrders(pos.orders); setMenuItems(menu.menu);
    if (user && (permissions[user.role]?.includes("inventory:read") || permissions[user.role]?.includes("*"))) {
      const stock = await api<{ items: InventoryItem[] }>("/api/management/inventory"); setItems(stock.items);
    }
  }, [user]);
  const loadStaff = useCallback(async () => {
    const data = await api<{ staff: Staff[] }>("/api/management/staff"); setStaff(data.staff);
    const team = await api<{ attendance: Staff[] }>("/api/management/attendance").catch(() => ({ attendance: [] }));
    const own = data.staff.find((person) => person.user_id === user?.id);
    if (own) setClockedIn(own.last_attendance_event === "clock_in");
    if (team.attendance.length) setStaff(data.staff);
  }, [user]);
  const loadPayments = useCallback(async () => {
    const result = await api<{ payments: PaymentRecord[] }>("/api/management/payments");
    setPayments(result.payments); setLastSync(new Date());
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSession(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSession]);
  useEffect(() => {
    if (!user || !permissions[user.role]?.includes("dashboard:read") && !permissions[user.role]?.includes("*")) return;
    const stream = new EventSource(`${apiBase}/api/management/events`, { withCredentials: true });
    const update = () => {
      setLastSync(new Date());
      void loadDashboard().catch(() => undefined);
      if (active === "Reservations") void api<{ reservations: Reservation[] }>("/api/management/reservations").then((x) => setReservations(x.reservations)).catch(() => undefined);
      if (active === "Payments") void loadPayments().catch(() => undefined);
      if (active === "Rooms") void api<{ rooms: Room[] }>("/api/management/rooms").then((x) => setRooms(x.rooms)).catch(() => undefined);
      if (active === "Inventory") void api<{ items: InventoryItem[] }>("/api/management/inventory").then((x) => setItems(x.items)).catch(() => undefined);
      if (active === "Restaurant POS") void loadPos();
      if (active === "Team & attendance") void loadStaff();
    };
    const readyEvent = () => update();
    stream.addEventListener("property-update", update);
    stream.addEventListener("ready", readyEvent);
    return () => { stream.removeEventListener("property-update", update); stream.removeEventListener("ready", readyEvent); stream.close(); };
  }, [user, active, loadDashboard, loadPayments, loadPos, loadStaff]);
  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => {
      if (active === "Overview") void loadDashboard().catch((e) => setError(e.message));
      if (active === "Reservations") void api<{ reservations: Reservation[] }>("/api/management/reservations").then((x) => setReservations(x.reservations)).catch((e) => setError(e.message));
      if (active === "Payments") void loadPayments().catch((e) => setError(e.message));
      if (active === "Rooms") void api<{ rooms: Room[] }>("/api/management/rooms").then((x) => setRooms(x.rooms)).catch((e) => setError(e.message));
      if (active === "Inventory") void api<{ items: InventoryItem[] }>("/api/management/inventory").then((x) => setItems(x.items)).catch((e) => setError(e.message));
      if (active === "Restaurant POS") void loadPos().catch((e) => setError(e.message));
      if (active === "Team & attendance") void loadStaff().catch((e) => setError(e.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, user, loadDashboard, loadPayments, loadPos, loadStaff]);

  const allowedNav = useMemo(() => navigation.filter((item) => user && (permissions[user.role]?.includes("*") || permissions[user.role]?.includes(item.permission))), [user]);
  const filteredReservations = reservations.filter((r) => `${r.guest_name} ${r.reference} ${r.room_type} ${r.room_number ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const filteredPayments = payments.filter((p) => `${p.reference} ${p.guest_name} ${p.unit_label} ${p.method} ${p.status} ${p.payment_reference ?? ""}`.toLowerCase().includes(search.toLowerCase()));

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoginBusy(true); setError("");
    try { await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); setReady(false); setDatabaseError(false); await loadSession(); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to sign in"); }
    finally { setLoginBusy(false); }
  }
  async function signOut() { await api("/api/auth/logout", { method: "POST" }); setUser(null); setDashboard(null); setPassword(""); }
  async function clockAction() {
    setClockBusy(true);
    try { const next = clockedIn ? "clock_out" : "clock_in"; await api("/api/management/attendance", { method: "POST", body: JSON.stringify({ eventType: next }) }); setClockedIn(next === "clock_in"); notify(next === "clock_in" ? "You are clocked in" : "You are clocked out"); }
    catch (e) { notify(e instanceof Error ? e.message : "Attendance could not be recorded"); }
    finally { setClockBusy(false); }
  }
  async function openNewReservation() {
    try { const data = await api<{ rooms: Room[] }>("/api/management/rooms"); setRooms(data.rooms.filter((room) => room.active !== false && !["maintenance", "out_of_order"].includes(room.status))); setModal("reservation"); }
    catch (e) { notify(e instanceof Error ? e.message : "Unable to load rooms"); }
  }
  async function saveForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      if (modal === "reservation") {
        const result = await api<{ reservation: Reservation }>("/api/management/reservations", { method: "POST", body: JSON.stringify({ ...values, guests: Number(values.guests ?? 1) }) });
        notify(`Reservation ${result.reservation.reference} created`); setActive("Reservations");
      } else if (modal === "room") {
        await api("/api/management/rooms", { method: "POST", body: JSON.stringify({ roomNumber: values.roomNumber, roomType: values.roomType, nightlyRateKobo: Math.round(Number(values.rate) * 100), capacity: Number(values.capacity) }) });
        notify("Room added"); setActive("Rooms");
      } else if (modal === "staff") {
        await api("/api/management/staff", { method: "POST", body: JSON.stringify(values) });
        notify("Staff account created. They must change the temporary password when they first sign in."); setActive("Team & attendance");
      } else if (modal === "stock-item") {
        await api("/api/management/inventory", { method: "POST", body: JSON.stringify({ ...values, quantity: Number(values.quantity), reorderLevel: Number(values.reorderLevel), costKobo: Math.round(Number(values.cost) * 100) }) });
        notify("Inventory item added"); setActive("Inventory");
      } else if (modal === "stock-movement") {
        await api("/api/management/inventory", { method: "POST", body: JSON.stringify({ action: values.action, itemId: values.itemId, quantity: Number(values.quantity), reason: values.reason }) });
        notify("Stock movement recorded"); setModal(null); await api<{ items: InventoryItem[] }>("/api/management/inventory").then((x) => setItems(x.items));
      } else if (modal === "menu-item") {
        const recipeMap = new Map<string, number>();
        for (const line of recipeLines.filter((item) => item.itemId)) recipeMap.set(line.itemId, (recipeMap.get(line.itemId) ?? 0) + Number(line.quantity));
        const recipe = [...recipeMap].map(([itemId, quantity]) => ({ itemId, quantity }));
        await api("/api/management/menu", { method: "POST", body: JSON.stringify({ name: values.name, category: values.category, priceKobo: Math.round(Number(values.price) * 100), recipe }) });
        notify("Menu item added"); setModal(null); setRecipeLines([{ itemId: "", quantity: "1" }]); await loadPos();
      } else if (modal === "payment" && paymentFor) {
        const amountKobo = Math.round(Number(values.amount) * 100);
        const result = await api<{ payment: { paymentStatus: string } }>(`/api/management/reservations/${paymentFor.id}/payments`, { method: "POST", body: JSON.stringify({ amountKobo, method: values.method, paymentReference: values.paymentReference, idempotencyKey: crypto.randomUUID() }) });
        notify(result.payment.paymentStatus === "pending" ? `Transfer awaiting confirmation · ${paymentFor.reference}` : `Payment recorded for ${paymentFor.reference}`); setModal(null); setPaymentFor(null);
        setPaymentReference(""); if (["owner", "manager", "finance"].includes(user?.role ?? "")) await loadPayments();
        if (active === "Overview") await loadDashboard();
        else await api<{ reservations: Reservation[] }>("/api/management/reservations").then((x) => setReservations(x.reservations));
      } else if (modal === "shift-open") {
        await api("/api/management/pos/shift", { method: "POST", body: JSON.stringify({ action: "open", openingFloatKobo: Math.round(Number(values.openingFloat) * 100) }) });
        notify("Cashier shift opened"); setModal(null); await loadPos();
      } else if (modal === "shift-close") {
        const result = await api<{ shift: { varianceKobo: string } }>("/api/management/pos/shift", { method: "POST", body: JSON.stringify({ action: "close", countedCashKobo: Math.round(Number(values.countedCash) * 100) }) });
        notify(`Shift closed · cash variance ${money(result.shift.varianceKobo)}`); setModal(null); await loadPos();
      } else if (modal === "password") {
        await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) });
        setModal(null); setUser((old) => old ? { ...old, mustChangePassword: false } : old); notify("Password updated");
      }
      if (["reservation", "room", "staff", "stock-item"].includes(modal ?? "")) setModal(null);
      if (active === "Overview") await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save changes"); }
    finally { setBusy(false); }
  }
  async function changeReservation(reservation: Reservation, status: string) {
    try { await api(`/api/management/reservations/${reservation.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); notify(`${reservation.reference} updated`); await loadDashboard(); if (active === "Reservations") await api<{ reservations: Reservation[] }>("/api/management/reservations").then((x) => setReservations(x.reservations)); }
    catch (e) { notify(e instanceof Error ? e.message : "Reservation update failed"); }
  }
  async function confirmPayment(payment: PaymentRecord) {
    const detail = `${payment.reference} · ${money(payment.amount_kobo)} · ${payment.payment_reference || "no transfer reference"}`;
    if (!window.confirm(`Confirm that this bank transfer has arrived in the company account?\n\n${detail}\n\nThis will mark it as settled.`)) return;
    setBusy(true);
    try {
      await api(`/api/management/payments/${payment.id}`, { method: "PATCH", body: JSON.stringify({ source: payment.source }) });
      notify(`Bank transfer confirmed · ${payment.reference}`);
      await Promise.all([loadPayments(), loadDashboard()]);
    } catch (e) { notify(e instanceof Error ? e.message : "Unable to confirm transfer"); }
    finally { setBusy(false); }
  }
  async function changeRoom(room: Room, status: string) {
    try { await api(`/api/management/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); notify(`Room ${room.room_number} updated`); await api<{ rooms: Room[] }>("/api/management/rooms").then((x) => setRooms(x.rooms)); }
    catch (e) { notify(e instanceof Error ? e.message : "Room update failed"); }
  }
  async function finalizeSale() {
    const items = Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
    if (!items.length) return;
    setBusy(true);
    try {
      checkoutKey.current ??= crypto.randomUUID();
      const result = await api<{ order: { id: string; receipt_number: string; payment_status: string; duplicate: boolean } }>("/api/management/pos", { method: "POST", body: JSON.stringify({ items, paymentMethod, paymentReference: paymentReference.trim(), idempotencyKey: checkoutKey.current }) });
      checkoutKey.current = null; setCart({}); await loadPos(); setPaymentReference("");
      if (result.order.payment_status === "pending") { notify(`Transfer submitted for confirmation · ${result.order.receipt_number}`); if (["owner", "manager", "finance"].includes(user?.role ?? "")) await loadPayments(); }
      else { const data = await api<{ receipt: Record<string, unknown> }>(`/api/management/pos/${result.order.id}`); setReceipt(data.receipt); notify(`Receipt ${result.order.receipt_number} issued`); }
    } catch (e) { notify(e instanceof Error ? e.message : "Sale failed"); }
    finally { setBusy(false); }
  }

  if (!ready) return <div className="management-auth-shell"><div className="auth-card"><div className="brand-mark">H<span>.</span></div><strong>Connecting to Houzz Hills…</strong></div></div>;
  if (!user) return <div className="management-auth-shell"><form className="auth-card" onSubmit={signIn}><div className="brand-mark">H<span>.</span></div><p className="auth-eyebrow">HOUZZ HILLS KADUNA</p><h1>Welcome back</h1><p className="auth-copy">Sign in to your property workspace.</p>{databaseError && <div className="form-error">The database is not reachable. Configure the database and run migrations, then refresh.</div>}{error && <div className="form-error">{error}</div>}<Field label="Work email"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field><Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field><button className="button-primary auth-submit" disabled={loginBusy}>{loginBusy ? "Signing in…" : "Sign in securely"}</button>{setupRequired && <p className="auth-setup">First time here? <Link href="/management/setup">Set up the owner account</Link></p>}<Link className="auth-public-link" href={process.env.NEXT_PUBLIC_WEBSITE_URL || "https://houzzhills.com"}>Back to houzzhills.com <ArrowRight size={13} /></Link></form></div>;

  const roleNav = permissions[user.role] ?? [];
  const canWrite = (permission: string) => roleNav.includes("*") || roleNav.includes(permission);
  const title = active === "Overview" ? "Your property at a glance" : active;
  const today = new Intl.DateTimeFormat("en-NG", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "Africa/Lagos" }).format(new Date());
  const metrics = dashboard?.metrics ?? {};
  const occupancy = Number(metrics.occupied_rooms ?? 0), sellable = Number(metrics.sellable_rooms ?? 0);

  return <div className="management-shell">
    <aside className={`management-sidebar ${menuOpen ? "is-open" : ""}`}>
      <div className="management-brand"><div className="brand-mark">H<span>.</span></div><div><strong>HOUZZ HILLS</strong><small>PROPERTY OPERATIONS</small></div><button className="mobile-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
      <div className="property-switch"><span className="property-dot" /><div><small>PROPERTY</small><strong>{dashboard?.property.name ?? "Houzz Hills Kaduna"}</strong></div><ChevronDown size={15} /></div>
      <div className="side-label">WORKSPACE</div><nav className="management-nav">{allowedNav.map(({ label, icon: Icon }) => <button key={label} className={active === label ? "selected" : ""} onClick={() => { setError(""); setActive(label); setMenuOpen(false); setSearch(""); }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{label === "Reservations" && Number(metrics.arrivals ?? 0) > 0 && <em>{metrics.arrivals}</em>}</button>)}</nav>
      <div className="side-label tools-label">ACCOUNT</div><nav className="management-nav"><button onClick={() => setModal("password")}><Settings2 size={17} /><span>Security & password</span></button><button onClick={signOut}><LogOut size={17} /><span>Sign out</span></button></nav>
      <div className="sidebar-bottom"><div className="support-card"><ShieldCheck size={18} /><strong>Connected to property database</strong><span>{lastSync ? `Synced ${lastSync.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}` : "Live updates enabled"}</span><div className="sync-line"><i /></div></div><div className="side-user"><div className="user-avatar">{initials(user.fullName)}</div><div><strong>{user.fullName}</strong><span>{roleLabel(user.role)}</span></div><MoreHorizontal size={18} /></div></div>
    </aside>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <main className="management-main">
      <header className="management-topbar"><button className="mobile-menu" aria-label="Open menu" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{active}</strong></div><div className="topbar-actions"><div className="live-indicator"><i /> Live updates</div>{user.role !== "restaurant_cashier" && user.role !== "storekeeper" && <button className="icon-button" aria-label="Search reservations" onClick={() => document.getElementById("booking-search")?.focus()}><Search size={18} /></button>}<button className="icon-button notification-button" aria-label="Activity updates" onClick={() => notify("Activity feed is up to date")}><Bell size={18} /><i /></button><div className="top-divider" /><span className="top-role">{roleLabel(user.role)}</span>{["front_desk", "housekeeping", "restaurant_cashier", "restaurant_manager", "storekeeper"].includes(user.role) && <button className={`clock-chip ${clockedIn ? "is-clocked" : ""}`} disabled={clockBusy} onClick={clockAction}><Clock3 size={14} />{clockedIn ? "Clock out" : "Clock in"}</button>}</div></header>
      <div className="management-content">
        <div className="page-heading"><div><div className="eyebrow"><span /> {today.toUpperCase()} <span className="heading-dot">·</span> KADUNA, NG</div><h1>{active === "Overview" ? `Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${user.fullName.split(" ")[0]}` : title} {active === "Overview" && <span>☀️</span>}</h1><p>{active === "Overview" ? "Here’s what’s happening across your property today." : `Manage ${active.toLowerCase()} for ${dashboard?.property.name ?? "your property"}.`}</p></div><div className="heading-actions">{active === "Overview" && canWrite("reservations:write") && <button className="button-primary" onClick={() => void openNewReservation()}><Plus size={16} /> New reservation</button>}{active === "Reservations" && canWrite("reservations:write") && <button className="button-primary" onClick={() => void openNewReservation()}><Plus size={16} /> New reservation</button>}{active === "Rooms" && canWrite("rooms:write") && <button className="button-primary" onClick={() => setModal("room")}><Plus size={16} /> Add room</button>}{active === "Team & attendance" && canWrite("staff:write") && <button className="button-primary" onClick={() => setModal("staff")}><Plus size={16} /> Onboard staff</button>}{active === "Inventory" && canWrite("inventory:write") && <><button className="button-secondary" onClick={() => setModal("stock-movement")}><ArrowDownRight size={15} /> Record movement</button><button className="button-primary" onClick={() => setModal("stock-item")}><Plus size={16} /> Add item</button></>}{active === "Restaurant POS" && canWrite("menu:write") && <button className="button-secondary" onClick={() => { setRecipeLines([{ itemId: "", quantity: "1" }]); setModal("menu-item"); }}><Plus size={15} /> Add menu item</button>}</div></div>
        {error && <div className="inline-error"><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}

        {active === "Overview" && <>
          <section className="metric-grid" aria-label="Property performance">
            <Metric label="Occupancy" icon={<BedDouble size={17} />} tone="lavender" value={`${sellable ? Math.round(occupancy / sellable * 100) : 0}`} unit="%" foot={`${occupancy} of ${sellable} rooms`} progress={sellable ? occupancy / sellable * 100 : 0} />
            {user.role !== "front_desk" && <>
            <Metric label="Revenue today" icon={<CircleDollarSign size={17} />} tone="mint" value={money(BigInt(String(metrics.room_revenue_kobo ?? "0")) + BigInt(String(metrics.restaurant_revenue_kobo ?? "0")))} foot="Settled room + restaurant sales" />
            <Metric label="Arrivals today" icon={<ArrowDownRight size={17} />} tone="peach" value={String(metrics.arrivals ?? 0)} foot={`${metrics.departures ?? 0} departures today`} />
            <Metric label="Restaurant sales" icon={<Utensils size={17} />} tone="butter" value={money(String(metrics.restaurant_revenue_kobo ?? "0"))} foot={`${metrics.restaurant_orders ?? 0} paid orders today`} />
            </>}
          </section>
          <section className="dashboard-grid"><article className="panel revenue-panel"><div className="panel-heading"><div><h2>Live operations</h2><p>Current confirmed activity from the property database</p></div><span className="live-pill"><i /> LIVE</span></div><div className="live-kpi-row"><div><small>Rooms in service</small><strong>{sellable}</strong></div><div><small>Staff clocked in</small><strong>{dashboard?.staff.clocked_in ?? 0}</strong></div><div><small>Rooms in maintenance</small><strong>{metrics.maintenance_rooms ?? 0}</strong></div><div><small>Low stock alerts</small><strong>{metrics.low_stock_items ?? 0}</strong></div></div><div className="owner-callout"><ShieldCheck size={17} /><div><strong>Live data, one source of truth</strong><span>Bookings, receipts, attendance, and stock changes refresh as they are committed.</span></div></div></article><article className="panel activity-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Latest committed changes</p></div></div><div className="activity-list">{dashboard?.activity.length ? dashboard.activity.slice(0, 6).map((item) => <div className="activity-row" key={item.id}><span className="activity-dot gold" /><div><strong>{item.event_type.replaceAll(".", " · ").replaceAll("_", " ")}</strong><p>{String(item.payload?.reference ?? item.entity_id)}</p><small>{new Date(item.created_at).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}</small></div></div>) : <Empty text="No activity recorded yet. New bookings, sales, and team actions will appear here." />}</div></article></section>
          <ReservationPanel rows={dashboard?.reservations ?? []} onAll={() => setActive("Reservations")} onStatus={changeReservation} onPay={(r) => { setPaymentFor(r); setPaymentReference(""); setReservationPaymentMethod("cash"); setModal("payment"); }} canWrite={canWrite("reservations:write")} />
          <section className="bottom-grid"><article className="panel operations-panel"><div className="panel-heading"><div><h2>Today at a glance</h2><p>Key operational checkpoints</p></div><Clock3 size={18} className="faint-icon" /></div><div className="ops-stats"><div><span className="ops-icon mint"><Check size={16} /></span><div><strong>{dashboard?.operations.completed_housekeeping ?? 0}</strong><small>Housekeeping completed</small></div></div><div><span className="ops-icon peach"><Users size={16} /></span><div><strong>{dashboard?.staff.clocked_in ?? 0} / {metrics.active_staff ?? 0}</strong><small>Staff clocked in</small></div></div><div><span className="ops-icon lavender"><BedDouble size={16} /></span><div><strong>{dashboard?.operations.open_housekeeping ?? 0}</strong><small>Open room tasks</small></div></div></div></article><article className="panel shift-panel"><div className="panel-heading"><div><h2>Property pulse</h2><p>Current state · Africa/Lagos</p></div><span className="live-pill"><i /> CONNECTED</span></div><div className="owner-callout"><Activity size={17} /><div><strong>{dashboard?.property.name ?? "Houzz Hills Kaduna"}</strong><span>Database time {dashboard?.serverTime ? new Date(dashboard.serverTime).toLocaleTimeString("en-NG", { timeZone: "Africa/Lagos" }) : "—"} WAT</span></div></div></article></section>
        </>}

        {active === "Reservations" && <section className="panel bookings-panel full-panel"><div className="panel-heading bookings-heading"><div><h2>Reservations</h2><p>Search stays and manage guest arrival and payment state.</p></div><div className="booking-count">{reservations.length} records</div></div><div className="booking-toolbar"><div className="booking-tabs"><span className="active">All reservations</span></div><div className="booking-tools"><div className="table-search"><Search size={15} /><input id="booking-search" placeholder="Search guest, reference, room" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div></div><ReservationTable rows={filteredReservations} onStatus={changeReservation} onPay={(r) => { setPaymentFor(r); setPaymentReference(""); setReservationPaymentMethod("cash"); setModal("payment"); }} canWrite={canWrite("reservations:write")} /></section>}

        {active === "Payments" && <PaymentRegister payments={filteredPayments} search={search} onSearch={setSearch} canConfirm={canWrite("payments:confirm")} onConfirm={confirmPayment} busy={busy} />}

        {active === "Rooms" && <section className="panel bookings-panel full-panel"><div className="panel-heading bookings-heading"><div><h2>Room inventory</h2><p>Room readiness, room rate, and active guest stay.</p></div><div className="booking-count">{rooms.length} rooms</div></div>{rooms.length ? <div className="table-scroll"><table><thead><tr><th>ROOM</th><th>TYPE</th>{user.role !== "housekeeping" && <th>RATE / NIGHT</th>}<th>{user.role === "housekeeping" ? "TURNOVER" : "GUEST / STAY"}</th><th>STATUS</th><th>UPDATE</th></tr></thead><tbody>{rooms.map((room) => <tr key={room.id}><td className="booking-amount">{room.room_number}</td><td>{room.room_type} · Sleeps {room.capacity}</td>{user.role !== "housekeeping" && <td>{money(room.nightly_rate_kobo ?? "0")}</td>}<td>{room.stay ? user.role === "housekeeping" ? `Due ${dateLabel(room.stay.checkOut)}` : `${room.stay.guest} · ${room.stay.reference}` : "—"}</td><td><span className={`status status-${room.status === "vacant_clean" || room.status === "inspected" ? "green" : room.status === "maintenance" || room.status === "out_of_order" ? "red" : "gold"}`}><i />{room.status.replaceAll("_", " ")}</span></td><td><select className="inline-select" value={room.status} onChange={(e) => void changeRoom(room, e.target.value)} aria-label={`Update room ${room.room_number}`}>{roomStatuses.filter((s) => user.role !== "housekeeping" || ["vacant_clean", "vacant_dirty", "inspected"].includes(s)).map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select></td></tr>)}</tbody></table></div> : <Empty text="No rooms yet. Add your real room numbers, categories, nightly rates, and capacities to begin taking reservations." />}</section>}

        {active === "Team & attendance" && <><section className="panel bookings-panel full-panel"><div className="panel-heading bookings-heading"><div><h2>Team & attendance</h2><p>Staff accounts, job assignments, and latest clock event.</p></div><div className="booking-count">{staff.length} team members</div></div>{staff.length ? <div className="table-scroll"><table><thead><tr><th>STAFF MEMBER</th><th>EMPLOYEE ID</th><th>DEPARTMENT</th><th>ROLE</th><th>LAST EVENT</th><th>EMPLOYMENT</th>{canWrite("staff:write") && <th>UPDATE</th>}</tr></thead><tbody>{staff.map((person) => <tr key={person.id}><td><div className="guest-cell"><span className="guest-avatar tone-blue">{initials(person.full_name)}</span><div><strong>{person.full_name}</strong><small>{person.email} · {person.job_title}{person.phone ? ` · ${person.phone}` : ""}</small></div></div></td><td>{person.employee_number}</td><td>{person.department}</td><td>{roleLabel(person.role)}</td><td>{person.last_attendance_event?.replace("clock_", "Clock ") ?? "No clock event"}{person.last_attendance_at ? ` · ${new Date(person.last_attendance_at).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}` : ""}</td><td><span className={`status ${person.employment_status === "active" ? "status-green" : "status-gold"}`}><i />{person.employment_status.replaceAll("_", " ")}</span></td>{canWrite("staff:write") && <td><select className="inline-select" value={person.employment_status} onChange={(e) => void api(`/api/management/staff/${person.id}`, { method: "PATCH", body: JSON.stringify({ employmentStatus: e.target.value }) }).then(() => loadStaff()).catch((err) => notify(err.message))} aria-label={`Update ${person.full_name}`}><option value="active">active</option><option value="on_leave">on leave</option><option value="terminated">terminate</option></select></td>}</tr>)}</tbody></table></div> : <Empty text="No staff have been onboarded. Add a staff profile and role to enable secure sign-in and attendance." />}</section><section className="panel operations-panel attendance-self"><div className="panel-heading"><div><h2>Your attendance</h2><p>Clock events are stored against your staff account.</p></div><Clock3 size={18} className="faint-icon" /></div><button className="button-primary" onClick={() => void clockAction()} disabled={clockBusy}><Clock3 size={15} />{clockedIn ? "Clock out" : "Clock in"}</button></section></>}

        {active === "Inventory" && <section className="panel bookings-panel full-panel"><div className="panel-heading bookings-heading"><div><h2>Stock control</h2><p>Inventory is a movement ledger; each count change records its reason and staff member.</p></div><div className="booking-count">{items.filter((item) => item.low_stock).length} low stock</div></div>{items.length ? <div className="table-scroll"><table><thead><tr><th>ITEM</th><th>SKU</th><th>ON HAND</th><th>REORDER AT</th><th>UNIT COST</th><th>STATUS</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td className="booking-amount">{item.name}</td><td>{item.sku || "—"}</td><td>{item.quantity} {item.unit}</td><td>{item.reorder_level} {item.unit}</td><td>{money(item.cost_kobo)}</td><td><span className={`status ${item.low_stock ? "status-red" : "status-green"}`}><i />{item.low_stock ? "Reorder needed" : "In stock"}</span></td></tr>)}</tbody></table></div> : <Empty text="No stock items yet. Add your real store items before configuring restaurant recipes." />}</section>}

        {active === "Restaurant POS" && <div className="pos-layout"><section className="panel pos-menu-panel"><div className="panel-heading"><div><h2>Restaurant menu</h2><p>Tap an item to add it to the current order.</p></div><div className={`booking-count ${shift ? "shift-open" : ""}`}>{shift ? "Shift open" : "No active shift"}</div></div>{!shift && <div className="pos-shift-guard"><Clock3 size={17} /><span>Open a cashier shift before recording restaurant sales.</span><button className="button-primary" onClick={() => setModal("shift-open")}>Open shift</button></div>}{menuItems.length ? <div className="pos-menu-grid">{menuItems.map((item) => <button className="pos-menu-item" key={item.id} disabled={!shift} onClick={() => setCart((current) => ({ ...current, [item.id]: (current[item.id] ?? 0) + 1 }))}><span>{item.category}</span><strong>{item.name}</strong><b>{money(item.price_kobo)}</b></button>)}</div> : <Empty text="The restaurant menu is empty. A manager can add items after stock has been configured." />}</section><section className="panel pos-cart-panel"><div className="panel-heading"><div><h2>Current order</h2><p>Receipt issued after successful payment.</p></div><span className="booking-count">{Object.values(cart).reduce((a, b) => a + b, 0)} items</span></div><div className="pos-cart-lines">{Object.entries(cart).filter(([, q]) => q > 0).map(([id, quantity]) => { const item = menuItems.find((m) => m.id === id)!; return <div className="pos-cart-line" key={id}><div><strong>{item.name}</strong><small>{quantity} × {money(item.price_kobo)}</small></div><b>{money(BigInt(item.price_kobo) * BigInt(quantity))}</b><button aria-label={`Remove one ${item.name}`} onClick={() => setCart((current) => ({ ...current, [id]: Math.max(0, current[id] - 1) }))}>−</button></div>; })}{!Object.values(cart).some(Boolean) && <Empty text="No items in this order yet." />}</div><div className="pos-checkout"><Field label="Payment method"><select value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value); setPaymentReference(""); }}><option value="cash">Cash</option><option value="pos">Card / POS terminal</option><option value="bank_transfer">Bank transfer</option></select></Field>{paymentMethod === "bank_transfer" && <Field label="Transfer reference or sender name"><input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} maxLength={120} required /></Field>}<div className="pos-total"><span>Total due</span><strong>{money(menuItems.reduce((sum, item) => sum + BigInt(item.price_kobo) * BigInt(cart[item.id] ?? 0), BigInt(0)))}</strong></div><button className="button-primary" disabled={busy || !shift || !Object.values(cart).some(Boolean) || paymentMethod === "bank_transfer" && !paymentReference.trim()} onClick={() => void finalizeSale()}><Check size={15} />{busy ? "Saving…" : paymentMethod === "bank_transfer" ? "Record transfer for confirmation" : "Take payment & issue receipt"}</button>{shift && <button className="text-link shift-close-link" onClick={() => setModal("shift-close")}>Close cashier shift</button>}</div></section><section className="panel bookings-panel pos-orders"><div className="panel-heading"><div><h2>Today’s receipts</h2><p>Recent restaurant orders from all cashiers.</p></div></div>{orders.length ? <div className="table-scroll"><table><thead><tr><th>RECEIPT</th><th>TIME</th><th>CASHIER</th><th>METHOD</th><th>TOTAL</th><th /></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td className="booking-amount">{order.receipt_number}</td><td>{new Date(order.created_at).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}</td><td>{order.cashier}</td><td>{order.payment_method}</td><td>{money(order.total_kobo)}</td><td><button className="text-link" disabled={order.payment_status === "pending"} onClick={() => void api<{ receipt: Record<string, unknown> }>(`/api/management/pos/${order.id}`).then((x) => setReceipt(x.receipt))}>{order.payment_status === "pending" ? "Awaiting confirmation" : "Receipt"}</button></td></tr>)}</tbody></table></div> : <Empty text="No restaurant orders have been finalized today." />}</section></div>}

        <footer className="management-footer"><span>© {new Date().getFullYear()} {dashboard?.property.name ?? "Houzz Hills Kaduna"}</span><span><span className="footer-status"><i /> {lastSync ? "Live data synced" : "Connecting"}</span><b>·</b> {lastSync ? `Updated ${lastSync.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}` : "Waiting for data"}</span></footer>
      </div>
      </main>
    {modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && modal !== "password") setModal(null); }}><form className="management-modal" onSubmit={saveForm}><div className="modal-heading"><div><h2>{modal === "reservation" ? "Create reservation" : modal === "room" ? "Add a room" : modal === "staff" ? "Onboard staff member" : modal === "stock-item" ? "Add inventory item" : modal === "stock-movement" ? "Record stock movement" : modal === "menu-item" ? "Add restaurant menu item" : modal === "shift-open" ? "Open cashier shift" : modal === "shift-close" ? "Close cashier shift" : modal === "payment" ? "Record guest payment" : "Change password"}</h2><p>{modal === "password" ? "Choose a new password to secure your account." : "Changes are recorded in the property audit log."}</p></div>{modal !== "password" && <button type="button" className="modal-close" aria-label="Close" onClick={() => setModal(null)}><X size={18} /></button>}</div>{error && <div className="form-error">{error}</div>}
      {modal === "reservation" && <><Field label="Guest full name"><input name="name" required /></Field><div className="form-row"><Field label="Email"><input name="email" type="email" /></Field><Field label="Phone"><input name="phone" type="tel" /></Field></div><Field label="Room"><select name="roomId" required defaultValue=""><option value="" disabled>Select a room</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.room_number} · {room.room_type} · {money(room.nightly_rate_kobo)}/night</option>)}</select></Field><div className="form-row"><Field label="Check in"><input name="checkIn" type="date" required /></Field><Field label="Check out"><input name="checkOut" type="date" required /></Field></div><Field label="Guests"><input name="guests" type="number" min="1" max="12" defaultValue="1" required /></Field></>}
      {modal === "room" && <><div className="form-row"><Field label="Room number"><input name="roomNumber" required placeholder="e.g. 204" /></Field><Field label="Room category"><input name="roomType" required placeholder="e.g. Executive Suite" /></Field></div><div className="form-row"><Field label="Nightly rate (₦)"><input name="rate" type="number" min="0" step="1" required /></Field><Field label="Guest capacity"><input name="capacity" type="number" min="1" max="12" defaultValue="2" required /></Field></div></>}
      {modal === "staff" && <><div className="form-row"><Field label="Full name"><input name="fullName" required /></Field><Field label="Work email"><input name="email" type="email" required /></Field></div><div className="form-row"><Field label="Employee number"><input name="employeeNumber" required /></Field><Field label="Department"><input name="department" required placeholder="Front desk" /></Field></div><div className="form-row"><Field label="Job title"><input name="jobTitle" required /></Field><Field label="Role"><select name="role" required>{roles.filter((r) => user.role === "owner" || !["manager", "finance", "auditor"].includes(r)).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}</select></Field></div><div className="form-row"><Field label="Phone"><input name="phone" type="tel" /></Field><Field label="Emergency contact"><input name="emergencyContact" /></Field></div><div className="form-row"><Field label="Start date"><input name="startDate" type="date" /></Field><Field label="Temporary password (12+ characters)"><input name="temporaryPassword" type="password" minLength={12} required /></Field></div><p className="modal-help">Give this password to the staff member securely. The account requires a password change at first sign-in.</p></>}
      {modal === "stock-item" && <><div className="form-row"><Field label="Item name"><input name="name" required /></Field><Field label="SKU (optional)"><input name="sku" /></Field></div><div className="form-row"><Field label="Unit"><input name="unit" defaultValue="unit" required /></Field><Field label="Starting quantity"><input name="quantity" type="number" min="0" step="0.001" defaultValue="0" required /></Field></div><div className="form-row"><Field label="Reorder at"><input name="reorderLevel" type="number" min="0" step="0.001" defaultValue="0" required /></Field><Field label="Unit cost (₦)"><input name="cost" type="number" min="0" step="1" defaultValue="0" required /></Field></div></>}
      {modal === "stock-movement" && <><Field label="Inventory item"><select name="itemId" required>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.quantity} {item.unit}</option>)}</select></Field><div className="form-row"><Field label="Movement"><select name="action"><option value="receive">Receive stock</option><option value="adjust">Count adjustment (+/-)</option><option value="wastage">Record wastage</option></select></Field><Field label="Quantity"><input name="quantity" type="number" step="0.001" required /></Field></div><Field label="Reason / supplier reference"><input name="reason" required /></Field></>}
      {modal === "menu-item" && <><div className="form-row"><Field label="Item name"><input name="name" required /></Field><Field label="Category"><input name="category" required placeholder="Breakfast" /></Field></div><Field label="Price (₦)"><input name="price" type="number" min="0" step="1" required /></Field><div className="recipe-editor"><div className="recipe-editor-heading"><strong>Recipe stock usage</strong><button type="button" className="text-link" onClick={() => setRecipeLines((current) => [...current, { itemId: "", quantity: "1" }])}><Plus size={13} /> Add ingredient</button></div>{recipeLines.map((line, index) => <div className="form-row recipe-row" key={index}><Field label="Inventory item"><select value={line.itemId} onChange={(e) => setRecipeLines((current) => current.map((item, i) => i === index ? { ...item, itemId: e.target.value } : item))}><option value="">No stock deduction</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.unit}</option>)}</select></Field><Field label="Quantity per order"><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={(e) => setRecipeLines((current) => current.map((item, i) => i === index ? { ...item, quantity: e.target.value } : item))} /></Field>{recipeLines.length > 1 && <button type="button" className="recipe-remove" aria-label="Remove ingredient" onClick={() => setRecipeLines((current) => current.filter((_, i) => i !== index))}><X size={15}/></button>}</div>)}</div><p className="modal-help">Each ingredient is deducted atomically from stock whenever this menu item is sold.</p></>}
      {modal === "payment" && paymentFor && <><p className="payment-reference">{paymentFor.guest_name} · {paymentFor.reference} · outstanding {money(BigInt(paymentFor.amount_kobo) - BigInt(paymentFor.paid_kobo ?? "0"))}</p><div className="form-row"><Field label="Amount received (₦)"><input name="amount" type="number" min="1" step="1" defaultValue={Number(BigInt(paymentFor.amount_kobo) - BigInt(paymentFor.paid_kobo ?? "0")) / 100} required /></Field><Field label="Payment method"><select name="method" value={reservationPaymentMethod} onChange={(event) => setReservationPaymentMethod(event.target.value)}><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="pos">POS terminal</option><option value="online">Online</option></select></Field></div><Field label="Bank transfer reference or sender name"><input name="paymentReference" maxLength={120} required={reservationPaymentMethod === "bank_transfer"} /></Field></>}
      {modal === "shift-open" && <Field label="Opening cash float (₦)"><input name="openingFloat" type="number" min="0" step="1" defaultValue="0" required /></Field>}
      {modal === "shift-close" && <><Field label="Counted cash at handover (₦)"><input name="countedCash" type="number" min="0" step="1" required /></Field><p className="modal-help">Cash variance is calculated against opening float plus cash orders and recorded for manager review.</p></>}
      {modal === "password" && <><Field label="Current password"><input name="currentPassword" type="password" required /></Field><Field label="New password (12+ characters)"><input name="newPassword" type="password" minLength={12} required /></Field></>}
      <div className="modal-actions"><button type="button" className="button-secondary" onClick={() => modal !== "password" && setModal(null)}>Cancel</button><button className="button-primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button></div></form></div>}
    {receipt && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setReceipt(null); }}><div className="management-modal receipt-modal"><div className="modal-heading"><div><h2>Restaurant receipt</h2><p>{String(receipt.receipt_number)}</p></div><button className="modal-close" onClick={() => setReceipt(null)}><X size={18} /></button></div><div className="receipt-paper"><h3>{String(receipt.property_name)}</h3><p>RECEIPT · {String(receipt.receipt_number)}</p>{(receipt.items as { item_name: string; quantity: number; unit_price_kobo: string; line_total_kobo: string }[]).map((item, i) => <div className="receipt-line" key={i}><span>{item.quantity} × {item.item_name}</span><b>{money(item.line_total_kobo)}</b></div>)}<div className="receipt-total"><span>TOTAL · {String(receipt.payment_method).toUpperCase()}</span><strong>{money(String(receipt.total_kobo))}</strong></div><small>{new Date(String(receipt.created_at)).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })} WAT · Served by {String(receipt.cashier)}</small><small>Thank you for dining with us.</small></div><div className="modal-actions"><button className="button-secondary" onClick={() => setReceipt(null)}>Close</button><button className="button-primary" onClick={() => window.print()}>Print receipt</button></div></div></div>}
    {notice && <div role="status" className="management-toast"><Check size={16} />{notice}</div>}
  </div>;
}

function Metric({ label, icon, tone, value, unit, foot, progress }: { label: string; icon: ReactNode; tone: string; value: string; unit?: string; foot: string; progress?: number }) {
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-value metric-text-value">{value}{unit && <span className="metric-unit">{unit}</span>}</div><div className="metric-foot">{progress !== undefined && <div className="occupancy-track"><i style={{ width: `${progress}%` }} /></div>}<span>{foot}</span></div></article>;
}
function Empty({ text }: { text: string }) { return <div className="empty-state">{text}</div>; }
function PaymentRegister({ payments, search, onSearch, canConfirm, onConfirm, busy }: { payments: PaymentRecord[]; search: string; onSearch: (value: string) => void; canConfirm: boolean; onConfirm: (payment: PaymentRecord) => void; busy: boolean }) {
  const pending = payments.filter((payment) => payment.status === "pending");
  const collected = payments.filter((payment) => payment.status === "settled").reduce((sum, payment) => sum + BigInt(payment.amount_kobo), BigInt(0));
  return <>
    <section className="payment-summary-grid">
      <article><span>Transfers awaiting confirmation</span><strong>{pending.length}</strong><small>{money(pending.reduce((sum, payment) => sum + BigInt(payment.amount_kobo), BigInt(0)).toString())} to verify</small></article>
      <article><span>Payments recorded</span><strong>{payments.length}</strong><small>Accommodation and restaurant</small></article>
      <article><span>Settled value shown</span><strong>{money(collected)}</strong><small>Across recent records</small></article>
    </section>
    <section className="panel bookings-panel full-panel payment-register">
      <div className="panel-heading bookings-heading"><div><h2>Payment register</h2><p>Review every room and restaurant payment. Confirm bank transfers only after they appear in the company account.</p></div><div className="booking-count">{payments.length} recent records</div></div>
      <div className="booking-toolbar"><div className="booking-tabs"><span className="active">All payments</span><span>{pending.length} awaiting confirmation</span></div><div className="booking-tools"><div className="table-search"><Search size={15} /><input id="booking-search" placeholder="Search guest, unit, reference, method" value={search} onChange={(event) => onSearch(event.target.value)} /></div></div></div>
      <div className="table-scroll"><table><thead><tr><th>PAYMENT</th><th>GUEST / UNIT</th><th>METHOD / REFERENCE</th><th>RECORDED BY</th><th>DATE</th><th>AMOUNT</th><th>STATUS / ACTION</th></tr></thead><tbody>{payments.map((payment) => <tr key={`${payment.source}-${payment.id}`}>
        <td><div className="guest-cell"><span className={`guest-avatar ${payment.source === "restaurant" ? "tone-blue" : "tone-gold"}`}>{payment.source === "restaurant" ? <Utensils size={14} /> : <BedDouble size={14} />}</span><div><strong>{payment.reference}</strong><small>{payment.source === "restaurant" ? "Restaurant" : "Accommodation"}</small></div></div></td>
        <td><strong className="payment-person">{payment.guest_name}</strong><small className="payment-unit">{payment.unit_label}</small></td>
        <td><span className="payment-method">{payment.method.replaceAll("_", " ")}</span><small className="payment-unit">{payment.payment_reference || "—"}</small></td>
        <td>{payment.recorded_by || "Online"}{payment.confirmed_by && <small className="payment-unit">Confirmed by {payment.confirmed_by}</small>}</td>
        <td>{new Date(payment.created_at).toLocaleString("en-NG", { timeZone: "Africa/Lagos", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
        <td className="booking-amount">{money(payment.amount_kobo)}</td>
        <td><div className="payment-status-action"><span className={`status ${payment.status === "settled" ? "status-green" : payment.status === "pending" ? "status-gold" : "status-red"}`}><i />{payment.status === "pending" ? "pending confirmation" : payment.status}</span>{payment.status === "pending" && canConfirm && <button className="payment-confirm-button" disabled={busy} onClick={() => onConfirm(payment)}><Check size={13} />Confirm transfer</button>}</div></td>
      </tr>)}</tbody></table>{payments.length === 0 && <Empty text="No payments match this search yet. New payments will appear here as they are recorded." />}</div>
    </section>
  </>;
}
function ReservationPanel({ rows, onAll, onStatus, onPay, canWrite }: { rows: Reservation[]; onAll: () => void; onStatus: (r: Reservation, status: string) => void; onPay: (r: Reservation) => void; canWrite: boolean }) {
  return <section className="panel bookings-panel"><div className="panel-heading bookings-heading"><div><h2>Today’s reservations</h2><p>Live guest arrivals and upcoming stays <span className="booking-count">{rows.length} records</span></p></div><button className="text-link" onClick={onAll}>All reservations <ArrowRight size={14} /></button></div><ReservationTable rows={rows.slice(0, 6)} onStatus={onStatus} onPay={onPay} canWrite={canWrite} /></section>;
}
function ReservationTable({ rows, onStatus, onPay, canWrite }: { rows: Reservation[]; onStatus: (r: Reservation, status: string) => void; onPay: (r: Reservation) => void; canWrite: boolean }) {
  return <div className="table-scroll"><table><thead><tr><th>GUEST</th><th>ROOM</th><th>STAY DATES</th><th>BOOKING VALUE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td><div className="guest-cell"><span className="guest-avatar tone-gold">{initials(r.guest_name)}</span><div><strong>{r.guest_name}</strong><small>{r.reference} · {r.payment_status.replaceAll("_", " ")}</small></div></div></td><td>{r.room_number ? `${r.room_type} · ${r.room_number}` : r.room_type}</td><td>{dateLabel(r.check_in)} — {dateLabel(r.check_out)}</td><td className="booking-amount">{money(r.amount_kobo)}</td><td><span className={`status ${r.status === "checked_in" ? "status-green" : r.status === "pending_payment" ? "status-red" : "status-gold"}`}><i />{r.status.replaceAll("_", " ")}</span></td><td><div className="reservation-actions">{canWrite && ["unpaid", "part_paid"].includes(r.payment_status) && !["cancelled", "checked_out", "no_show"].includes(r.status) && <button className="text-link" onClick={() => onPay(r)}>Record payment</button>}{canWrite && r.status === "confirmed" && <select className="inline-select" value="" onChange={(e) => e.target.value && onStatus(r, e.target.value)} aria-label={`Update ${r.reference}`}><option value="">Stay action</option><option value="checked_in">Check in</option><option value="cancelled">Cancel</option><option value="no_show">No show</option></select>}{canWrite && r.status === "checked_in" && <button className="text-link" onClick={() => onStatus(r, "checked_out")}>Check out</button>}{(!canWrite || (r.status !== "confirmed" && r.status !== "checked_in" && !["unpaid", "part_paid"].includes(r.payment_status))) && <span className="quiet-action">{r.source === "public_website" ? "Website" : "—"}</span>}</div></td></tr>)}</tbody></table>{rows.length === 0 && <Empty text="No reservations in this view. New public bookings will appear here as soon as they are committed." />}</div>;
}
