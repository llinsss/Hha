import { can } from "../permissions";
import { ApiError, type ApiClient } from "./client";
import {
  PROPERTY,
  createSampleState,
  lagosDate,
  type SampleOrder,
  type SampleReservation,
  type SampleRoomPayment,
  type SampleState,
  type SampleUser,
} from "./sample-data";
import type {
  Dashboard,
  InventoryItem,
  MenuItem,
  PaymentRecord,
  PosOrder,
  Reservation,
  ReservationPaymentStatus,
  ReservationStatus,
  Room,
  RoomStatus,
  Staff,
  User,
} from "./types";

/**
 * ApiClient that runs entirely in the browser on sample data. It makes no
 * network requests. It applies the same business rules the backend will
 * (permissions, overlaps, pending transfers, stock deduction, idempotency), so
 * the UI behaves realistically. State survives reloads within the tab
 * (sessionStorage) and resets when the tab closes.
 */

const STORAGE_KEY = "houzzhills.sample.v1";
const LATENCY_MS = 120;
const ACTIVE_STAYS: readonly ReservationStatus[] = ["hold", "pending_payment", "confirmed", "checked_in"];

type Store = { state: SampleState; sessionUserId: string | null };

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    const saved = typeof window === "undefined" ? null : window.sessionStorage.getItem(STORAGE_KEY);
    if (saved) store = JSON.parse(saved) as Store;
  } catch {
    store = null;
  }
  store ??= { state: createSampleState(), sessionUserId: null };
  return store;
}

function save(): void {
  try {
    if (store && typeof window !== "undefined") window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or blocked: sample data simply resets on reload.
  }
}

/** Simulated network round-trip; results are deep copies so callers cannot mutate the store. */
async function respond<T>(work: () => T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  const result = work();
  save();
  return result === undefined ? result : structuredClone(result);
}

const id = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();
const isToday = (iso: string) => lagosDate(0, new Date(iso)) === lagosDate();
const qty = (value: number) => String(Number(value.toFixed(3)));
function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

function currentUser(): SampleUser {
  const { state, sessionUserId } = load();
  const user = state.users.find((entry) => entry.id === sessionUserId);
  return user ?? fail(401, "UNAUTHORIZED", "Your session has ended. Sign in again.");
}

function authorize(permission?: string): SampleUser {
  const user = currentUser();
  if (user.mustChangePassword) fail(403, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password before using the workspace");
  if (permission && !can(user.role, permission)) fail(403, "FORBIDDEN", "You do not have access to this action");
  return user;
}

function log(eventType: string, entityId: string, reference: unknown): void {
  load().state.activity.unshift({ id: id("a"), eventType, entityId, payload: { reference }, createdAt: now() });
}

function toUser(user: SampleUser): User {
  return { id: user.id, fullName: user.fullName, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword };
}

// ---- Derived views (what the API would compute) ----

function settledPaid(reservationId: string): number {
  return load()
    .state.roomPayments.filter((payment) => payment.reservationId === reservationId && payment.status === "settled")
    .reduce((sum, payment) => sum + payment.amountKobo, 0);
}

function paymentStatusOf(reservation: SampleReservation): ReservationPaymentStatus {
  const { roomPayments } = load().state;
  if (roomPayments.some((payment) => payment.reservationId === reservation.id && payment.status === "pending")) return "pending";
  const paid = settledPaid(reservation.id);
  if (paid >= reservation.amountKobo) return "paid";
  return paid > 0 ? "part_paid" : "unpaid";
}

function toReservation(reservation: SampleReservation): Reservation {
  const room = load().state.rooms.find((entry) => entry.id === reservation.roomId);
  return {
    id: reservation.id,
    reference: reservation.reference,
    guest_name: reservation.guestName,
    email: reservation.email,
    phone: reservation.phone,
    room_id: reservation.roomId,
    room_type: room?.roomType ?? "Room",
    room_number: room?.roomNumber,
    check_in: reservation.checkIn,
    check_out: reservation.checkOut,
    guests_count: reservation.guests,
    amount_kobo: String(reservation.amountKobo),
    paid_kobo: String(settledPaid(reservation.id)),
    status: reservation.status,
    payment_status: reservation.paymentStatus,
    source: reservation.source,
  };
}

function toRoom(roomId: string): Room {
  const { rooms, reservations } = load().state;
  const room = rooms.find((entry) => entry.id === roomId) ?? fail(404, "NOT_FOUND", "Room not found");
  const stay = reservations.find((entry) => entry.roomId === room.id && entry.status === "checked_in");
  return {
    id: room.id,
    room_number: room.roomNumber,
    room_type: room.roomType,
    nightly_rate_kobo: String(room.rateKobo),
    capacity: room.capacity,
    status: room.status,
    active: room.active,
    stay: stay ? { reference: stay.reference, guest: stay.guestName, checkOut: stay.checkOut } : null,
  };
}

function toStaff(): Staff[] {
  const { staff, users } = load().state;
  return staff.flatMap((profile) => {
    const user = users.find((entry) => entry.id === profile.userId);
    if (!user) return [];
    return [{
      id: profile.id,
      user_id: user.id,
      employee_number: profile.employeeNumber,
      department: profile.department,
      job_title: profile.jobTitle,
      phone: profile.phone,
      emergency_contact: profile.emergencyContact,
      employment_status: profile.employmentStatus,
      full_name: user.fullName,
      email: user.email,
      role: user.role,
      last_attendance_event: profile.lastEvent,
      last_attendance_at: profile.lastEventAt,
    }];
  });
}

function toInventory(): InventoryItem[] {
  return load().state.stock.map((item) => ({
    id: item.id,
    name: item.name,
    sku: item.sku,
    unit: item.unit,
    quantity: qty(item.quantity),
    reorder_level: qty(item.reorderLevel),
    cost_kobo: String(item.costKobo),
    low_stock: item.quantity <= item.reorderLevel,
  }));
}

function toMenu(): MenuItem[] {
  const { menu, stock } = load().state;
  return menu.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    price_kobo: String(item.priceKobo),
    recipe: item.recipe.map((line) => ({ itemId: line.itemId, name: stock.find((entry) => entry.id === line.itemId)?.name ?? "Unknown item", quantity: line.quantity })),
  }));
}

function userName(userId: string): string {
  return load().state.users.find((entry) => entry.id === userId)?.fullName ?? "Staff";
}

function toOrder(order: SampleOrder): PosOrder {
  return {
    id: order.id,
    receipt_number: order.receiptNumber,
    total_kobo: String(order.totalKobo),
    payment_method: order.paymentMethod,
    payment_status: order.paymentStatus,
    created_at: order.createdAt,
    cashier: userName(order.cashierId),
  };
}

function toPayments(): PaymentRecord[] {
  const { roomPayments, reservations, rooms, orders } = load().state;
  const accommodation = roomPayments.map((payment): PaymentRecord => {
    const reservation = reservations.find((entry) => entry.id === payment.reservationId);
    const room = rooms.find((entry) => entry.id === reservation?.roomId);
    return {
      id: payment.id,
      source: "accommodation",
      reference: reservation?.reference ?? "—",
      guest_name: reservation?.guestName ?? "Guest",
      unit_label: room ? `${room.roomType} · ${room.roomNumber}` : "Accommodation",
      amount_kobo: String(payment.amountKobo),
      method: payment.method,
      status: payment.status,
      payment_reference: payment.paymentReference,
      created_at: payment.createdAt,
      recorded_by: payment.recordedBy,
      confirmed_by: payment.confirmedBy,
      confirmed_at: payment.confirmedAt,
    };
  });
  const restaurant = orders.map((order): PaymentRecord => ({
    id: order.id,
    source: "restaurant",
    reference: order.receiptNumber,
    guest_name: "Restaurant guest",
    unit_label: "Restaurant",
    amount_kobo: String(order.totalKobo),
    method: order.paymentMethod,
    status: order.paymentStatus,
    payment_reference: order.paymentReference,
    created_at: order.createdAt,
    recorded_by: userName(order.cashierId),
    confirmed_by: order.confirmedBy,
    confirmed_at: order.confirmedAt,
  }));
  return [...accommodation, ...restaurant].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function openShiftFor(userId: string) {
  return load().state.shifts.find((shift) => shift.cashierId === userId && !shift.closedAt) ?? null;
}

function referenceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `HH-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

const recordedPayments = new Map<string, "pending" | "settled">();

export function createSampleClient(): ApiClient {
  return {
    mode: "sample",

    auth: {
      session: () =>
        respond(() => {
          const { state, sessionUserId } = load();
          const user = state.users.find((entry) => entry.id === sessionUserId);
          return user ? toUser(user) : null;
        }),
      login: ({ email, password }) =>
        respond(() => {
          const { state } = load();
          const user = state.users.find((entry) => entry.email === email.trim().toLowerCase());
          const profile = state.staff.find((entry) => entry.userId === user?.id);
          if (!user || user.password !== password || profile?.employmentStatus === "terminated") fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
          load().sessionUserId = user!.id;
          return toUser(user!);
        }),
      logout: () =>
        respond(() => {
          load().sessionUserId = null;
        }),
      changePassword: ({ currentPassword, newPassword }) =>
        respond(() => {
          const user = currentUser();
          if (user.password !== currentPassword) fail(403, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
          if (newPassword.length < 12) fail(422, "VALIDATION_FAILED", "Use a password of at least 12 characters");
          if (newPassword === currentPassword) fail(422, "PASSWORD_REUSED", "Choose a password different from the current one");
          user.password = newPassword;
          user.mustChangePassword = false;
        }),
    },

    setup: {
      status: () => respond(() => ({ setupRequired: false })),
      createOwner: ({ fullName, email, password }) =>
        respond(() => {
          const { state } = load();
          const normalised = email.trim().toLowerCase();
          if (state.users.some((entry) => entry.email === normalised)) fail(409, "CONFLICT", "An account with this email already exists");
          if (password.length < 12) fail(422, "VALIDATION_FAILED", "Use a password of at least 12 characters");
          state.users.push({ id: id("u"), fullName, email: normalised, role: "owner", mustChangePassword: false, password });
        }),
    },

    dashboard: {
      get: () =>
        respond((): Dashboard => {
          const user = authorize("dashboard:read");
          const { state } = load();
          const today = lagosDate();
          const sellable = state.rooms.filter((room) => room.active && !["maintenance", "out_of_order"].includes(room.status));
          const settledOrdersToday = state.orders.filter((order) => order.paymentStatus === "settled" && isToday(order.createdAt));
          const roomRevenue = state.roomPayments.filter((payment) => payment.status === "settled" && isToday(payment.confirmedAt ?? payment.createdAt)).reduce((sum, payment) => sum + payment.amountKobo, 0);
          return {
            property: { ...PROPERTY },
            metrics: {
              sellable_rooms: sellable.length,
              occupied_rooms: state.rooms.filter((room) => room.status === "occupied").length,
              arrivals: state.reservations.filter((entry) => entry.checkIn === today && entry.status === "confirmed").length,
              departures: state.reservations.filter((entry) => entry.checkOut === today && entry.status === "checked_in").length,
              room_revenue_kobo: String(roomRevenue),
              restaurant_revenue_kobo: String(settledOrdersToday.reduce((sum, order) => sum + order.totalKobo, 0)),
              restaurant_orders: settledOrdersToday.length,
              maintenance_rooms: state.rooms.filter((room) => room.status === "maintenance" || room.status === "out_of_order").length,
              low_stock_items: state.stock.filter((item) => item.quantity <= item.reorderLevel).length,
              active_staff: state.staff.filter((profile) => profile.employmentStatus === "active").length,
            },
            reservations: state.reservations
              .filter((entry) => entry.checkOut >= today && ACTIVE_STAYS.includes(entry.status))
              .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
              .map(toReservation),
            activity: state.activity.slice(0, 20).map((entry) => ({ id: entry.id, event_type: entry.eventType, entity_id: entry.entityId, payload: entry.payload, created_at: entry.createdAt })),
            operations: {
              open_housekeeping: state.rooms.filter((room) => room.status === "vacant_dirty").length,
              completed_housekeeping: state.rooms.filter((room) => room.status === "inspected").length,
            },
            staff: { clocked_in: state.staff.filter((profile) => profile.lastEvent === "clock_in").length },
            user: toUser(user),
            serverTime: now(),
          };
        }),
    },

    reservations: {
      list: () =>
        respond(() => {
          authorize("reservations:read");
          return [...load().state.reservations].sort((a, b) => b.checkIn.localeCompare(a.checkIn)).map(toReservation);
        }),
      create: (input) =>
        respond(() => {
          authorize("reservations:write");
          const { state } = load();
          const room = state.rooms.find((entry) => entry.id === input.roomId) ?? fail(422, "VALIDATION_FAILED", "Select a room");
          if (!room.active || ["maintenance", "out_of_order"].includes(room.status)) fail(409, "ROOM_UNAVAILABLE", `Room ${room.roomNumber} is not available for booking`);
          if (!input.checkIn || !input.checkOut || input.checkOut <= input.checkIn) fail(422, "VALIDATION_FAILED", "Check-out must be after check-in");
          if (input.guests < 1 || input.guests > room.capacity) fail(422, "VALIDATION_FAILED", `Room ${room.roomNumber} sleeps up to ${room.capacity} guests`);
          const clash = state.reservations.some((entry) => entry.roomId === room.id && ACTIVE_STAYS.includes(entry.status) && input.checkIn < entry.checkOut && input.checkOut > entry.checkIn);
          if (clash) fail(409, "ROOM_UNAVAILABLE", `Room ${room.roomNumber} is already booked for those dates`);
          const nights = Math.round((Date.parse(input.checkOut) - Date.parse(input.checkIn)) / 86_400_000);
          const reservation: SampleReservation = {
            id: id("b"),
            reference: referenceCode(),
            guestName: input.name.trim(),
            email: input.email?.trim() || undefined,
            phone: input.phone?.trim() || undefined,
            roomId: room.id,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            guests: input.guests,
            amountKobo: room.rateKobo * nights,
            status: "confirmed",
            paymentStatus: "unpaid",
            source: "staff",
          };
          state.reservations.push(reservation);
          log("reservation.created", reservation.id, reservation.reference);
          return toReservation(reservation);
        }),
      updateStatus: (reservationId, status, reason) =>
        respond(() => {
          authorize("reservations:write");
          if ((status === "cancelled" || status === "no_show") && (reason?.trim().length ?? 0) < 3) fail(422, "REASON_REQUIRED", "Give a reason for this change");
          const { state } = load();
          const reservation = state.reservations.find((entry) => entry.id === reservationId) ?? fail(404, "NOT_FOUND", "Reservation not found");
          const allowed: Partial<Record<ReservationStatus, readonly ReservationStatus[]>> = {
            confirmed: ["checked_in", "cancelled", "no_show"],
            checked_in: ["checked_out"],
          };
          if (!allowed[reservation.status]?.includes(status)) fail(409, "INVALID_TRANSITION", `A ${reservation.status.replaceAll("_", " ")} reservation cannot be marked ${status.replaceAll("_", " ")}`);
          reservation.status = status;
          const room = state.rooms.find((entry) => entry.id === reservation.roomId);
          if (room && status === "checked_in") room.status = "occupied";
          if (room && status === "checked_out") room.status = "vacant_dirty";
          log(`reservation.${status}`, reservation.id, reservation.reference);
        }),
      recordPayment: (reservationId, input) =>
        respond(() => {
          const user = authorize("reservations:write");
          const previous = recordedPayments.get(input.idempotencyKey);
          if (previous) return { paymentStatus: previous };
          const { state } = load();
          const reservation = state.reservations.find((entry) => entry.id === reservationId) ?? fail(404, "NOT_FOUND", "Reservation not found");
          const outstanding = reservation.amountKobo - settledPaid(reservation.id);
          if (!Number.isInteger(input.amountKobo) || input.amountKobo <= 0) fail(422, "VALIDATION_FAILED", "Enter the amount received");
          if (input.amountKobo > outstanding) fail(422, "OVERPAYMENT", "The amount is more than the outstanding balance");
          if (!["cash", "pos", "bank_transfer"].includes(input.method)) fail(422, "VALIDATION_FAILED", "Choose cash, POS terminal or bank transfer");
          if (input.method === "bank_transfer" && !input.paymentReference?.trim()) fail(422, "VALIDATION_FAILED", "Enter the transfer reference or sender name");
          const payment: SampleRoomPayment = {
            id: id("p"),
            reservationId: reservation.id,
            amountKobo: input.amountKobo,
            method: input.method,
            status: input.method === "bank_transfer" ? "pending" : "settled",
            paymentReference: input.paymentReference?.trim() || undefined,
            createdAt: now(),
            recordedBy: user.fullName,
          };
          state.roomPayments.push(payment);
          reservation.paymentStatus = paymentStatusOf(reservation);
          log(payment.status === "pending" ? "payment.pending" : "payment.settled", payment.id, reservation.reference);
          const paymentStatus = payment.status === "pending" ? "pending" : "settled";
          recordedPayments.set(input.idempotencyKey, paymentStatus);
          return { paymentStatus };
        }),
    },

    payments: {
      list: () =>
        respond(() => {
          authorize("payments:read");
          return toPayments();
        }),
      confirm: (paymentId, source) =>
        respond(() => {
          const user = authorize("payments:confirm");
          const { state } = load();
          if (source === "accommodation") {
            const payment = state.roomPayments.find((entry) => entry.id === paymentId) ?? fail(404, "NOT_FOUND", "Payment not found");
            if (payment.status !== "pending") fail(409, "NOT_PENDING", "Only pending transfers can be confirmed");
            Object.assign(payment, { status: "settled", confirmedBy: user.fullName, confirmedAt: now() });
            const reservation = state.reservations.find((entry) => entry.id === payment.reservationId);
            if (reservation) reservation.paymentStatus = paymentStatusOf(reservation);
            log("payment.confirmed", payment.id, reservation?.reference);
          } else {
            const order = state.orders.find((entry) => entry.id === paymentId) ?? fail(404, "NOT_FOUND", "Order not found");
            if (order.paymentStatus !== "pending") fail(409, "NOT_PENDING", "Only pending transfers can be confirmed");
            Object.assign(order, { paymentStatus: "settled", confirmedBy: user.fullName, confirmedAt: now() });
            log("payment.confirmed", order.id, order.receiptNumber);
          }
        }),
    },

    rooms: {
      list: () =>
        respond(() => {
          authorize("rooms:read");
          return load().state.rooms.map((room) => toRoom(room.id));
        }),
      create: (input) =>
        respond(() => {
          authorize("rooms:write");
          const { state } = load();
          const roomNumber = input.roomNumber.trim();
          if (state.rooms.some((room) => room.roomNumber === roomNumber)) fail(409, "UNIQUE_VIOLATION", `Room ${roomNumber} already exists`);
          if (!Number.isInteger(input.nightlyRateKobo) || input.nightlyRateKobo < 0) fail(422, "VALIDATION_FAILED", "Enter a valid nightly rate");
          const room = { id: id("r"), roomNumber, roomType: input.roomType.trim(), rateKobo: input.nightlyRateKobo, capacity: input.capacity, status: "vacant_clean" as RoomStatus, active: true };
          state.rooms.push(room);
          log("room.created", room.id, `Room ${roomNumber}`);
          return { created: 1, roomIds: [room.id] };
        }),
      updateStatus: (roomId, status) =>
        respond(() => {
          const user = authorize("rooms:write");
          if (user.role === "housekeeping" && !["vacant_clean", "vacant_dirty", "inspected"].includes(status)) fail(403, "FORBIDDEN", "Housekeeping can only set cleaning states");
          const room = load().state.rooms.find((entry) => entry.id === roomId) ?? fail(404, "NOT_FOUND", "Room not found");
          room.status = status;
          log("room.status_changed", room.id, `Room ${room.roomNumber}`);
        }),
    },

    staff: {
      list: () =>
        respond(() => {
          authorize("staff:read");
          return toStaff();
        }),
      create: (input) =>
        respond(() => {
          const actor = authorize("staff:write");
          const { state } = load();
          const email = input.email.trim().toLowerCase();
          if (actor.role !== "owner" && ["owner", "manager", "finance", "auditor"].includes(input.role)) fail(403, "FORBIDDEN", "Only the owner can assign this role");
          if (state.users.some((entry) => entry.email === email)) fail(409, "UNIQUE_VIOLATION", "A user with this email already exists");
          if (state.staff.some((entry) => entry.employeeNumber === input.employeeNumber.trim())) fail(409, "UNIQUE_VIOLATION", "This employee number is already in use");
          if (input.temporaryPassword.length < 12) fail(422, "VALIDATION_FAILED", "Temporary passwords need at least 12 characters");
          const user: SampleUser = { id: id("u"), fullName: input.fullName.trim(), email, role: input.role, mustChangePassword: true, password: input.temporaryPassword };
          const profile = {
            id: id("s"),
            userId: user.id,
            employeeNumber: input.employeeNumber.trim(),
            department: input.department.trim(),
            jobTitle: input.jobTitle.trim(),
            phone: input.phone?.trim() || undefined,
            emergencyContact: input.emergencyContact?.trim() || undefined,
            employmentStatus: "active" as const,
          };
          state.users.push(user);
          state.staff.push(profile);
          log("staff.created", profile.id, user.fullName);
          return { id: profile.id, userId: user.id };
        }),
      updateStatus: (staffId, status) =>
        respond(() => {
          authorize("staff:write");
          const profile = load().state.staff.find((entry) => entry.id === staffId) ?? fail(404, "NOT_FOUND", "Staff member not found");
          profile.employmentStatus = status;
          log("staff.status_changed", profile.id, userName(profile.userId));
        }),
    },

    attendance: {
      self: () =>
        respond(() => {
          const user = authorize();
          const profile = load().state.staff.find((entry) => entry.userId === user.id);
          return { clockedIn: profile?.lastEvent === "clock_in" };
        }),
      record: (eventType) =>
        respond(() => {
          const user = authorize();
          const profile = load().state.staff.find((entry) => entry.userId === user.id) ?? fail(422, "NO_STAFF_PROFILE", "Your account has no staff profile for attendance");
          if (profile.employmentStatus !== "active") fail(409, "NOT_ACTIVE", "Only active staff can clock in or out");
          if (profile.lastEvent === eventType || (!profile.lastEvent && eventType === "clock_out")) {
            fail(409, "INVALID_TRANSITION", eventType === "clock_in" ? "You are already clocked in" : "You are not clocked in");
          }
          profile.lastEvent = eventType;
          profile.lastEventAt = now();
          log(`attendance.${eventType}`, profile.id, user.fullName);
        }),
    },

    inventory: {
      list: () =>
        respond(() => {
          authorize("inventory:read");
          return toInventory();
        }),
      createItem: (input) =>
        respond(() => {
          authorize("inventory:write");
          const { state } = load();
          const sku = input.sku?.trim() || undefined;
          if (sku && state.stock.some((item) => item.sku === sku)) fail(409, "UNIQUE_VIOLATION", `SKU ${sku} is already in use`);
          if (input.quantity < 0 || input.reorderLevel < 0 || input.costKobo < 0) fail(422, "VALIDATION_FAILED", "Quantities and cost cannot be negative");
          const item = { id: id("i"), name: input.name.trim(), sku, unit: input.unit.trim() || "unit", quantity: input.quantity, reorderLevel: input.reorderLevel, costKobo: input.costKobo };
          state.stock.push(item);
          log("inventory.item_created", item.id, item.name);
          return { id: item.id };
        }),
      recordMovement: ({ action, itemId, quantity, reason }) =>
        respond(() => {
          authorize("inventory:write");
          const item = load().state.stock.find((entry) => entry.id === itemId) ?? fail(404, "NOT_FOUND", "Inventory item not found");
          if (!Number.isFinite(quantity) || quantity === 0) fail(422, "VALIDATION_FAILED", "Enter a non-zero quantity");
          if (action !== "adjust" && quantity < 0) fail(422, "VALIDATION_FAILED", "Enter a positive quantity");
          if (!reason.trim()) fail(422, "VALIDATION_FAILED", "Enter a reason or supplier reference");
          const delta = action === "wastage" ? -quantity : quantity;
          if (item.quantity + delta < 0) fail(422, "INSUFFICIENT_STOCK", `Only ${qty(item.quantity)} ${item.unit} of ${item.name} on hand`);
          item.quantity = Number((item.quantity + delta).toFixed(3));
          log(`inventory.${action}`, item.id, item.name);
        }),
    },

    menu: {
      list: () =>
        respond(() => {
          authorize("pos:read");
          return toMenu();
        }),
      create: (input) =>
        respond(() => {
          authorize("menu:write");
          const { state } = load();
          if (!Number.isInteger(input.priceKobo) || input.priceKobo < 0) fail(422, "VALIDATION_FAILED", "Enter a valid price");
          for (const line of input.recipe) {
            if (!state.stock.some((item) => item.id === line.itemId)) fail(422, "VALIDATION_FAILED", "A recipe ingredient no longer exists");
            if (!(line.quantity > 0)) fail(422, "VALIDATION_FAILED", "Recipe quantities must be greater than zero");
          }
          const item = { id: id("m"), name: input.name.trim(), category: input.category.trim(), priceKobo: input.priceKobo, recipe: input.recipe };
          state.menu.push(item);
          log("menu.item_created", item.id, item.name);
          return { id: item.id };
        }),
    },

    pos: {
      overview: () =>
        respond(() => {
          const user = authorize("pos:read");
          const { state } = load();
          const shift = openShiftFor(user.id);
          return {
            shift: shift ? { id: shift.id, opening_float_kobo: String(shift.openingFloatKobo), opened_at: shift.openedAt } : null,
            orders: state.orders.filter((order) => isToday(order.createdAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toOrder),
          };
        }),
      createOrder: (input) =>
        respond(() => {
          const user = authorize("pos:write");
          const { state } = load();
          const existing = state.orders.find((order) => order.idempotencyKey === input.idempotencyKey);
          if (existing) return { id: existing.id, receipt_number: existing.receiptNumber, payment_status: existing.paymentStatus, duplicate: true };
          const shift = openShiftFor(user.id) ?? fail(409, "NO_OPEN_SHIFT", "Open a cashier shift before recording sales");
          if (input.items.length === 0) fail(422, "VALIDATION_FAILED", "Add at least one item");
          if (input.paymentMethod === "bank_transfer" && !input.paymentReference?.trim()) fail(422, "VALIDATION_FAILED", "Enter the transfer reference or sender name");

          const lines = input.items.map(({ menuItemId, quantity }) => {
            const item = state.menu.find((entry) => entry.id === menuItemId) ?? fail(422, "VALIDATION_FAILED", "A menu item is no longer available");
            if (!Number.isInteger(quantity) || quantity < 1) fail(422, "VALIDATION_FAILED", "Quantities must be whole numbers");
            return { item, quantity };
          });
          const usage = new Map<string, number>();
          for (const { item, quantity } of lines) for (const part of item.recipe) usage.set(part.itemId, (usage.get(part.itemId) ?? 0) + part.quantity * quantity);
          for (const [itemId, needed] of usage) {
            const stockItem = state.stock.find((entry) => entry.id === itemId);
            if (stockItem && stockItem.quantity < needed) fail(409, "INSUFFICIENT_STOCK", `Not enough ${stockItem.name} in stock`);
          }
          // All checks passed: apply atomically.
          for (const [itemId, needed] of usage) {
            const stockItem = state.stock.find((entry) => entry.id === itemId);
            if (stockItem) stockItem.quantity = Number((stockItem.quantity - needed).toFixed(3));
          }
          const todaysCount = state.orders.filter((order) => isToday(order.createdAt)).length;
          const order: SampleOrder = {
            id: id("o"),
            receiptNumber: `R-${lagosDate().replaceAll("-", "")}-${String(todaysCount + 1).padStart(4, "0")}`,
            lines: lines.map(({ item, quantity }) => ({ menuItemId: item.id, name: item.name, quantity, unitPriceKobo: item.priceKobo })),
            totalKobo: lines.reduce((sum, { item, quantity }) => sum + item.priceKobo * quantity, 0),
            paymentMethod: input.paymentMethod,
            paymentStatus: input.paymentMethod === "bank_transfer" ? "pending" : "settled",
            paymentReference: input.paymentReference?.trim() || undefined,
            cashierId: user.id,
            shiftId: shift.id,
            createdAt: now(),
            idempotencyKey: input.idempotencyKey,
          };
          state.orders.push(order);
          log("pos.order_created", order.id, order.receiptNumber);
          return { id: order.id, receipt_number: order.receiptNumber, payment_status: order.paymentStatus, duplicate: false };
        }),
      receipt: (orderId) =>
        respond(() => {
          authorize("pos:read");
          const order = load().state.orders.find((entry) => entry.id === orderId) ?? fail(404, "NOT_FOUND", "Order not found");
          if (order.paymentStatus !== "settled") fail(409, "PAYMENT_PENDING", "A receipt is available once the transfer is confirmed");
          return {
            receipt_number: order.receiptNumber,
            property_name: PROPERTY.name,
            items: order.lines.map((line) => ({ item_name: line.name, quantity: line.quantity, unit_price_kobo: String(line.unitPriceKobo), line_total_kobo: String(line.unitPriceKobo * line.quantity) })),
            payment_method: order.paymentMethod,
            total_kobo: String(order.totalKobo),
            created_at: order.createdAt,
            cashier: userName(order.cashierId),
          };
        }),
      openShift: (openingFloatKobo) =>
        respond(() => {
          const user = authorize("pos:write");
          if (openShiftFor(user.id)) fail(409, "SHIFT_ALREADY_OPEN", "You already have an open shift");
          if (!Number.isInteger(openingFloatKobo) || openingFloatKobo < 0) fail(422, "VALIDATION_FAILED", "Enter a valid opening float");
          const shift = { id: id("sh"), cashierId: user.id, openingFloatKobo, openedAt: now() };
          load().state.shifts.push(shift);
          log("pos.shift_opened", shift.id, user.fullName);
        }),
      closeShift: (countedCashKobo) =>
        respond(() => {
          const user = authorize("pos:write");
          const shift = openShiftFor(user.id) ?? fail(409, "NO_OPEN_SHIFT", "You have no open shift");
          if (!Number.isInteger(countedCashKobo) || countedCashKobo < 0) fail(422, "VALIDATION_FAILED", "Enter the counted cash");
          const cashSales = load().state.orders.filter((order) => order.shiftId === shift.id && order.paymentMethod === "cash" && order.paymentStatus === "settled").reduce((sum, order) => sum + order.totalKobo, 0);
          const variance = countedCashKobo - (shift.openingFloatKobo + cashSales);
          shift.closedAt = now();
          log("pos.shift_closed", shift.id, user.fullName);
          return { varianceKobo: String(variance) };
        }),
    },
  };
}
