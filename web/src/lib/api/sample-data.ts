import type {
  AttendanceEvent,
  EmploymentStatus,
  PaymentMethod,
  PaymentStatus,
  ReservationPaymentStatus,
  ReservationStatus,
  Role,
  RoomStatus,
} from "./types";

/**
 * Seed data for sample mode. It is fictional and generated relative to today,
 * so the workspace always shows arrivals, in-house guests and departures.
 * Amounts are integer kobo (₦1 = 100 kobo).
 */

export const SAMPLE_PASSWORD = "houzzhills-demo";
export const PROPERTY = { name: "Houzz Hills Kaduna", timezone: "Africa/Lagos", currency: "NGN" } as const;

export type SampleUser = { id: string; fullName: string; email: string; role: Role; mustChangePassword: boolean; password: string };
export type SampleRoom = { id: string; roomNumber: string; roomType: string; rateKobo: number; capacity: number; status: RoomStatus; active: boolean };
export type SampleReservation = {
  id: string;
  reference: string;
  guestName: string;
  email?: string;
  phone?: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  amountKobo: number;
  status: ReservationStatus;
  paymentStatus: ReservationPaymentStatus;
  source: "staff" | "public_website";
};
export type SampleRoomPayment = {
  id: string;
  reservationId: string;
  amountKobo: number;
  method: PaymentMethod | "online";
  status: PaymentStatus;
  paymentReference?: string;
  createdAt: string;
  recordedBy?: string;
  confirmedBy?: string;
  confirmedAt?: string;
};
export type SampleStaff = {
  id: string;
  userId: string;
  employeeNumber: string;
  department: string;
  jobTitle: string;
  phone?: string;
  emergencyContact?: string;
  employmentStatus: EmploymentStatus;
  lastEvent?: AttendanceEvent;
  lastEventAt?: string;
};
export type SampleStockItem = { id: string; name: string; sku?: string; unit: string; quantity: number; reorderLevel: number; costKobo: number };
export type SampleMenuItem = { id: string; name: string; category: string; priceKobo: number; recipe: { itemId: string; quantity: number }[] };
export type SampleOrder = {
  id: string;
  receiptNumber: string;
  lines: { menuItemId: string; name: string; quantity: number; unitPriceKobo: number }[];
  totalKobo: number;
  paymentMethod: PaymentMethod;
  paymentStatus: "pending" | "settled";
  paymentReference?: string;
  cashierId: string;
  shiftId: string;
  createdAt: string;
  idempotencyKey: string;
  confirmedBy?: string;
  confirmedAt?: string;
};
export type SampleShift = { id: string; cashierId: string; openingFloatKobo: number; openedAt: string; closedAt?: string };
export type SampleActivity = { id: string; eventType: string; entityId: string; payload: Record<string, unknown>; createdAt: string };

export type SampleState = {
  users: SampleUser[];
  rooms: SampleRoom[];
  reservations: SampleReservation[];
  roomPayments: SampleRoomPayment[];
  staff: SampleStaff[];
  stock: SampleStockItem[];
  menu: SampleMenuItem[];
  orders: SampleOrder[];
  shifts: SampleShift[];
  activity: SampleActivity[];
};

/** YYYY-MM-DD in the property's timezone, offset by `days`. */
export function lagosDate(days = 0, from = new Date()): string {
  const shifted = new Date(from.getTime() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: PROPERTY.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
}

/** ISO timestamp for today at the given Lagos (UTC+1) wall-clock time. */
function todayAt(hours: number, minutes = 0, days = 0): string {
  return new Date(`${lagosDate(days)}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00+01:00`).toISOString();
}

const naira = (amount: number) => amount * 100;

export function createSampleState(): SampleState {
  const users: SampleUser[] = [
    { id: "u-owner", fullName: "Amina Bello", email: "owner@houzzhills.demo", role: "owner", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-manager", fullName: "Tunde Okafor", email: "manager@houzzhills.demo", role: "manager", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-frontdesk", fullName: "Hauwa Musa", email: "frontdesk@houzzhills.demo", role: "front_desk", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-housekeeping", fullName: "Grace Danjuma", email: "housekeeping@houzzhills.demo", role: "housekeeping", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-cashier", fullName: "Ibrahim Sani", email: "cashier@houzzhills.demo", role: "restaurant_cashier", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-restaurant", fullName: "Chiamaka Eze", email: "restaurant@houzzhills.demo", role: "restaurant_manager", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-store", fullName: "Yusuf Abdullahi", email: "store@houzzhills.demo", role: "storekeeper", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-finance", fullName: "Ngozi Adeyemi", email: "finance@houzzhills.demo", role: "finance", mustChangePassword: false, password: SAMPLE_PASSWORD },
    { id: "u-auditor", fullName: "Samuel Garba", email: "auditor@houzzhills.demo", role: "auditor", mustChangePassword: false, password: SAMPLE_PASSWORD },
  ];

  const rooms: SampleRoom[] = [
    { id: "r-101", roomNumber: "101", roomType: "Standard Studio", rateKobo: naira(45_000), capacity: 2, status: "occupied", active: true },
    { id: "r-102", roomNumber: "102", roomType: "Standard Studio", rateKobo: naira(45_000), capacity: 2, status: "vacant_clean", active: true },
    { id: "r-103", roomNumber: "103", roomType: "Standard Studio", rateKobo: naira(45_000), capacity: 2, status: "vacant_dirty", active: true },
    { id: "r-104", roomNumber: "104", roomType: "Standard Studio", rateKobo: naira(45_000), capacity: 2, status: "maintenance", active: true },
    { id: "r-201", roomNumber: "201", roomType: "Executive Suite", rateKobo: naira(75_000), capacity: 3, status: "occupied", active: true },
    { id: "r-202", roomNumber: "202", roomType: "Executive Suite", rateKobo: naira(75_000), capacity: 3, status: "inspected", active: true },
    { id: "r-203", roomNumber: "203", roomType: "Executive Suite", rateKobo: naira(75_000), capacity: 3, status: "vacant_clean", active: true },
    { id: "r-301", roomNumber: "301", roomType: "Two-Bedroom Apartment", rateKobo: naira(150_000), capacity: 5, status: "occupied", active: true },
  ];

  const stay = (roomId: string, nights: number) => (rooms.find((room) => room.id === roomId)?.rateKobo ?? 0) * nights;
  const reservations: SampleReservation[] = [
    { id: "b-1", reference: "HH-7KQ2M4", guestName: "Fatima Abubakar", email: "fatima@example.com", phone: "+234 803 555 0101", roomId: "r-101", checkIn: lagosDate(-2), checkOut: lagosDate(1), guests: 2, amountKobo: stay("r-101", 3), status: "checked_in", paymentStatus: "paid", source: "public_website" },
    { id: "b-2", reference: "HH-3XW9PA", guestName: "Emeka Nwosu", email: "emeka@example.com", phone: "+234 806 555 0144", roomId: "r-201", checkIn: lagosDate(-1), checkOut: lagosDate(2), guests: 1, amountKobo: stay("r-201", 3), status: "checked_in", paymentStatus: "part_paid", source: "staff" },
    { id: "b-3", reference: "HH-9LD5TR", guestName: "The Ogunleye Family", email: "ogunleye@example.com", phone: "+234 802 555 0177", roomId: "r-301", checkIn: lagosDate(-3), checkOut: lagosDate(0), guests: 4, amountKobo: stay("r-301", 3), status: "checked_in", paymentStatus: "paid", source: "staff" },
    { id: "b-4", reference: "HH-2PN8VC", guestName: "Zainab Lawal", email: "zainab@example.com", phone: "+234 809 555 0122", roomId: "r-102", checkIn: lagosDate(0), checkOut: lagosDate(2), guests: 2, amountKobo: stay("r-102", 2), status: "confirmed", paymentStatus: "unpaid", source: "staff" },
    { id: "b-5", reference: "HH-6RB4KE", guestName: "David Adeleke", email: "david@example.com", phone: "+234 701 555 0190", roomId: "r-202", checkIn: lagosDate(0), checkOut: lagosDate(3), guests: 2, amountKobo: stay("r-202", 3), status: "confirmed", paymentStatus: "pending", source: "staff" },
    { id: "b-6", reference: "HH-8TC1JM", guestName: "Blessing Okoro", email: "blessing@example.com", roomId: "r-203", checkIn: lagosDate(1), checkOut: lagosDate(4), guests: 3, amountKobo: stay("r-203", 3), status: "confirmed", paymentStatus: "paid", source: "public_website" },
    { id: "b-7", reference: "HH-4HV7SG", guestName: "Musa Ibrahim", phone: "+234 813 555 0155", roomId: "r-103", checkIn: lagosDate(3), checkOut: lagosDate(5), guests: 1, amountKobo: stay("r-103", 2), status: "confirmed", paymentStatus: "unpaid", source: "staff" },
  ];

  const roomPayments: SampleRoomPayment[] = [
    { id: "p-1", reservationId: "b-1", amountKobo: stay("r-101", 3), method: "online", status: "settled", paymentReference: "PSK-88213450", createdAt: todayAt(14, 5, -3) },
    { id: "p-2", reservationId: "b-2", amountKobo: naira(100_000), method: "pos", status: "settled", createdAt: todayAt(15, 40, -1), recordedBy: "Hauwa Musa" },
    { id: "p-3", reservationId: "b-3", amountKobo: stay("r-301", 3), method: "cash", status: "settled", createdAt: todayAt(12, 10, -3), recordedBy: "Hauwa Musa" },
    { id: "p-4", reservationId: "b-5", amountKobo: stay("r-202", 3), method: "bank_transfer", status: "pending", paymentReference: "D. Adeleke · GTB transfer", createdAt: todayAt(9, 25), recordedBy: "Hauwa Musa" },
    { id: "p-5", reservationId: "b-6", amountKobo: stay("r-203", 3), method: "online", status: "settled", paymentReference: "PSK-88219077", createdAt: todayAt(8, 2) },
  ];

  const staff: SampleStaff[] = [
    { id: "s-manager", userId: "u-manager", employeeNumber: "HH-001", department: "Management", jobTitle: "General Manager", phone: "+234 803 555 0201", employmentStatus: "active", lastEvent: "clock_in", lastEventAt: todayAt(7, 52) },
    { id: "s-frontdesk", userId: "u-frontdesk", employeeNumber: "HH-014", department: "Front desk", jobTitle: "Front Desk Officer", phone: "+234 803 555 0202", employmentStatus: "active", lastEvent: "clock_in", lastEventAt: todayAt(7, 58) },
    { id: "s-housekeeping", userId: "u-housekeeping", employeeNumber: "HH-022", department: "Housekeeping", jobTitle: "Room Attendant", employmentStatus: "active", lastEvent: "clock_in", lastEventAt: todayAt(8, 3) },
    { id: "s-cashier", userId: "u-cashier", employeeNumber: "HH-031", department: "Restaurant", jobTitle: "Cashier", employmentStatus: "active", lastEvent: "clock_out", lastEventAt: todayAt(22, 10, -1) },
    { id: "s-restaurant", userId: "u-restaurant", employeeNumber: "HH-030", department: "Restaurant", jobTitle: "Restaurant Manager", employmentStatus: "active", lastEvent: "clock_in", lastEventAt: todayAt(9, 0) },
    { id: "s-store", userId: "u-store", employeeNumber: "HH-040", department: "Stores", jobTitle: "Storekeeper", employmentStatus: "on_leave" },
    { id: "s-finance", userId: "u-finance", employeeNumber: "HH-050", department: "Finance", jobTitle: "Accountant", employmentStatus: "active" },
  ];

  const stock: SampleStockItem[] = [
    { id: "i-eggs", name: "Eggs", sku: "EGG-30", unit: "piece", quantity: 84, reorderLevel: 60, costKobo: naira(150) },
    { id: "i-bread", name: "Sliced bread", sku: "BRD-01", unit: "loaf", quantity: 4, reorderLevel: 6, costKobo: naira(1_200) },
    { id: "i-coffee", name: "Coffee beans", sku: "COF-1KG", unit: "kg", quantity: 2.5, reorderLevel: 1, costKobo: naira(18_000) },
    { id: "i-chicken", name: "Chicken (portion)", sku: "CHK-PRT", unit: "portion", quantity: 18, reorderLevel: 20, costKobo: naira(2_500) },
    { id: "i-rice", name: "Parboiled rice", sku: "RIC-50", unit: "kg", quantity: 32, reorderLevel: 10, costKobo: naira(1_400) },
    { id: "i-water", name: "Bottled water 75cl", sku: "WTR-75", unit: "bottle", quantity: 96, reorderLevel: 48, costKobo: naira(250) },
  ];

  const menu: SampleMenuItem[] = [
    { id: "m-breakfast", name: "Full breakfast", category: "Breakfast", priceKobo: naira(6_500), recipe: [{ itemId: "i-eggs", quantity: 2 }, { itemId: "i-bread", quantity: 0.25 }] },
    { id: "m-omelette", name: "Spanish omelette", category: "Breakfast", priceKobo: naira(4_000), recipe: [{ itemId: "i-eggs", quantity: 3 }] },
    { id: "m-jollof", name: "Jollof rice & chicken", category: "Mains", priceKobo: naira(8_500), recipe: [{ itemId: "i-rice", quantity: 0.3 }, { itemId: "i-chicken", quantity: 1 }] },
    { id: "m-coffee", name: "Americano", category: "Drinks", priceKobo: naira(2_500), recipe: [{ itemId: "i-coffee", quantity: 0.02 }] },
    { id: "m-water", name: "Bottled water", category: "Drinks", priceKobo: naira(500), recipe: [{ itemId: "i-water", quantity: 1 }] },
    { id: "m-chapman", name: "Chapman", category: "Drinks", priceKobo: naira(3_000), recipe: [] },
  ];

  const shifts: SampleShift[] = [{ id: "sh-1", cashierId: "u-restaurant", openingFloatKobo: naira(20_000), openedAt: todayAt(9, 5) }];
  const line = (menuItemId: string, quantity: number) => {
    const item = menu.find((entry) => entry.id === menuItemId);
    return { menuItemId, name: item?.name ?? "", quantity, unitPriceKobo: item?.priceKobo ?? 0 };
  };
  const order = (n: number, lines: SampleOrder["lines"], method: PaymentMethod, at: string, status: "pending" | "settled" = "settled", paymentReference?: string): SampleOrder => ({
    id: `o-${n}`,
    receiptNumber: `R-${lagosDate().replaceAll("-", "")}-${String(n).padStart(4, "0")}`,
    lines,
    totalKobo: lines.reduce((sum, entry) => sum + entry.unitPriceKobo * entry.quantity, 0),
    paymentMethod: method,
    paymentStatus: status,
    paymentReference,
    cashierId: "u-restaurant",
    shiftId: "sh-1",
    createdAt: at,
    idempotencyKey: `seed-${n}`,
  });
  const orders: SampleOrder[] = [
    order(1, [line("m-breakfast", 2), line("m-coffee", 2)], "pos", todayAt(9, 20)),
    order(2, [line("m-omelette", 1), line("m-water", 1)], "cash", todayAt(10, 5)),
    order(3, [line("m-jollof", 3), line("m-chapman", 3)], "bank_transfer", todayAt(13, 15), "pending", "Room 201 · Emeka N."),
  ];

  const activity: SampleActivity[] = [
    { id: "a-1", eventType: "payment.pending", entityId: "p-4", payload: { reference: "HH-6RB4KE" }, createdAt: todayAt(9, 25) },
    { id: "a-2", eventType: "pos.order_created", entityId: "o-1", payload: { reference: orders[0]?.receiptNumber }, createdAt: todayAt(9, 20) },
    { id: "a-3", eventType: "attendance.clock_in", entityId: "s-restaurant", payload: { reference: "Chiamaka Eze" }, createdAt: todayAt(9, 0) },
    { id: "a-4", eventType: "payment.settled", entityId: "p-5", payload: { reference: "HH-8TC1JM" }, createdAt: todayAt(8, 2) },
    { id: "a-5", eventType: "attendance.clock_in", entityId: "s-housekeeping", payload: { reference: "Grace Danjuma" }, createdAt: todayAt(8, 3) },
  ];

  return { users, rooms, reservations, roomPayments, staff, stock, menu, orders, shifts, activity };
}
