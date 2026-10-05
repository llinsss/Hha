/**
 * Data contracts shared by the workspace UI and every ApiClient implementation.
 * Field names mirror the backend payloads (snake_case rows, integer kobo as
 * strings).
 */

export type Role =
  | "owner"
  | "manager"
  | "front_desk"
  | "housekeeping"
  | "restaurant_cashier"
  | "restaurant_manager"
  | "storekeeper"
  | "finance"
  | "auditor";

export type Permission =
  | "dashboard:read"
  | "reservations:read"
  | "reservations:write"
  | "rooms:read"
  | "rooms:write"
  | "rooms:create"
  | "staff:read"
  | "staff:write"
  | "attendance:read"
  | "attendance:write"
  | "pos:read"
  | "pos:write"
  | "inventory:read"
  | "inventory:write"
  | "menu:write"
  | "payments:read"
  | "payments:confirm"
  | "reports:read"
  | "settings:manage";

/** `permissions` comes from the API, which owns the role table and enforces every one. */
export type User = { id: string; fullName: string; email: string; role: Role; mustChangePassword: boolean; permissions: Permission[] };

export type Property = { name: string; timezone: string; currency: string };

export type Option = { value: string; label: string };
/** Labels and allowed values served by the API for building forms. */
export type Reference = {
  roles: Option[];
  assignableRoles: Option[];
  roomStatuses: Option[];
  reservationStatuses: Option[];
  paymentStatuses: Option[];
  paymentMethods: Option[];
  staffPaymentMethods: Option[];
  posPaymentMethods: Option[];
  employmentStatuses: Option[];
  stockMovements: Option[];
  paymentProviders: Option[];
  exceptionKinds: Option[];
};

export type RoomStatus = "vacant_clean" | "vacant_dirty" | "occupied" | "inspected" | "maintenance" | "out_of_order";
export type Room = {
  id: string;
  room_number: string;
  room_type: string;
  nightly_rate_kobo: string;
  capacity: number;
  status: RoomStatus;
  active?: boolean;
  stay?: { reference?: string; guest?: string; checkOut: string } | null;
  /** States the signed-in user may set next (from the API's transition rules). */
  next_statuses: RoomStatus[];
};

export type ReservationStatus = "hold" | "pending_payment" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show" | "expired";
export type ReservationPaymentStatus = "unpaid" | "pending" | "part_paid" | "paid";
export type Reservation = {
  id: string;
  reference: string;
  guest_name: string;
  email?: string;
  phone?: string;
  room_id?: string;
  room_type: string;
  room_number?: string;
  check_in: string;
  check_out: string;
  guests_count?: number;
  amount_kobo: string;
  paid_kobo?: string;
  status: ReservationStatus;
  payment_status: ReservationPaymentStatus;
  source?: string;
  /** What the signed-in user may do now, decided by the API. */
  actions: { next_statuses: ReservationStatus[]; record_payment: boolean };
};

export type PaymentSource = "accommodation" | "restaurant";
export type PaymentStatus = "pending" | "settled" | "failed";
export type PaymentMethod = "cash" | "pos" | "bank_transfer";
export type PaymentRecord = {
  id: string;
  source: PaymentSource;
  reference: string;
  guest_name: string;
  unit_label: string;
  amount_kobo: string;
  method: string;
  status: PaymentStatus;
  payment_reference?: string;
  created_at: string;
  recorded_by?: string;
  confirmed_by?: string;
  confirmed_at?: string;
};

export type EmploymentStatus = "active" | "on_leave" | "terminated";
export type AttendanceEvent = "clock_in" | "clock_out";
export type Staff = {
  id: string;
  user_id?: string;
  employee_number: string;
  department: string;
  job_title: string;
  phone?: string;
  emergency_contact?: string;
  employment_status: EmploymentStatus;
  full_name: string;
  email: string;
  role: Role;
  last_attendance_event?: AttendanceEvent;
  last_attendance_at?: string;
  /** Whether the signed-in user may change this member's status or reset their password. */
  can_manage: boolean;
};

export type InventoryItem = {
  id: string;
  name: string;
  sku?: string;
  unit: string;
  quantity: string;
  reorder_level: string;
  cost_kobo: string;
  low_stock: boolean;
};

export type MenuItem = {
  id: string;
  name: string;
  category: string;
  price_kobo: string;
  recipe: { itemId: string; name: string; quantity: number }[];
};

export type ActivityEvent = { id: string; event_type: string; entity_id: string; payload: Record<string, unknown>; created_at: string };

export type Dashboard = {
  property: { name: string; timezone: string; currency: string };
  metrics: Record<string, number | string>;
  reservations: Reservation[];
  activity: ActivityEvent[];
  operations: { open_housekeeping: number; completed_housekeeping: number };
  staff: { clocked_in: number };
  user: User;
  serverTime: string;
};

export type Shift = { id: string; opening_float_kobo: string; opened_at: string };
export type PosOrder = {
  id: string;
  receipt_number: string;
  total_kobo: string;
  payment_method: PaymentMethod;
  payment_status: "pending" | "settled";
  created_at: string;
  cashier: string;
};
export type Receipt = {
  receipt_number: string;
  property_name: string;
  items: { item_name: string; quantity: number; unit_price_kobo: string; line_total_kobo: string }[];
  payment_method: PaymentMethod;
  total_kobo: string;
  created_at: string;
  cashier: string;
};

// ---- Request inputs ----

export type LoginInput = { email: string; password: string };
export type ChangePasswordInput = { currentPassword: string; newPassword: string };
export type SetupInput = { propertyName: string; fullName: string; email: string; password: string; setupSecret?: string };
export type NewReservationInput = { name: string; email?: string; phone?: string; roomId: string; checkIn: string; checkOut: string; guests: number };
export type RecordPaymentInput = { amountKobo: number; method: PaymentMethod; paymentReference?: string; idempotencyKey: string };
export type NewRoomInput = { roomNumber: string; roomType: string; nightlyRateKobo: number; capacity: number };
export type NewStaffInput = {
  fullName: string;
  email: string;
  employeeNumber: string;
  department: string;
  jobTitle: string;
  role: Role;
  phone?: string;
  emergencyContact?: string;
  startDate?: string;
  /** Omit to have the server generate one (returned once). */
  temporaryPassword?: string;
};
export type NewInventoryItemInput = { name: string; sku?: string; unit: string; quantity: number; reorderLevel: number; costKobo: number };
export type StockMovementInput = { action: "receive" | "adjust" | "wastage"; itemId: string; quantity: number; reason: string };
export type NewMenuItemInput = { name: string; category: string; priceKobo: number; recipe: { itemId: string; quantity: number }[] };
export type NewPosOrderInput = {
  items: { menuItemId: string; quantity: number }[];
  paymentMethod: PaymentMethod;
  paymentReference?: string;
  idempotencyKey: string;
};
export type CreatedPosOrder = { id: string; receipt_number: string; payment_status: "pending" | "settled"; duplicate: boolean };

// ---- Owner settings ----

export type SettingView = {
  key: string;
  group: "payments" | "booking";
  label: string;
  description: string;
  type: "string" | "enum" | "integer";
  secret: boolean;
  value: string | number | null;
  configured: boolean;
  hint: string | null;
  readable: boolean;
  default: string | number | null;
  options: Option[] | null;
  /** For provider credentials: the provider they belong to. */
  provider: string | null;
  minimum: number | null;
  maximum: number | null;
  updatedAt: string;
  updatedBy: string | null;
};
export type SettingsSnapshot = { settings: SettingView[]; environment: { publicWebUrl: string | null; webhookUrl: string | null } };
export type SettingsChanges = Record<string, string | number | null>;

// ---- Payment exceptions & register ----

export type PaymentException = {
  id: string;
  kind: string;
  title: string;
  status: "open" | "resolved";
  reservation_id: string | null;
  reservation_reference: string | null;
  payment_id: string | null;
  pos_order_id: string | null;
  provider: string | null;
  provider_reference: string | null;
  expected_amount_kobo: string | null;
  received_amount_kobo: string | null;
  details: Record<string, unknown>;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};
export type PaymentTotals = { count: number; settledKobo: string; pendingKobo: string; failedKobo: string };
export type PaymentRegister = { payments: PaymentRecord[]; totals: PaymentTotals };

export type RoomHistoryEntry = { action: string; from: string | null; to: string | null; note: string | null; actor: string | null; at: string };
export type MenuItemChanges = Partial<{ name: string; category: string; priceKobo: number; active: boolean }>;

// ---- Live updates ----

export type LiveEvent = { id: string; type: string; entityId: string; reference: string | null; at: string };

// ---- Public booking ----

export type AvailableRoomType = { room_type: string; nightly_rate_kobo: string; capacity: number; available_count: number };
export type PublicBookingInput = { name: string; email: string; phone?: string; roomType: string; checkIn: string; checkOut: string; guests: number; notes?: string };
export type PublicBooking = {
  reservation: { id: string; reference: string; amountKobo: string; currency: "NGN"; status: "pending_payment"; holdExpiresAt: string };
  checkoutUrl: string;
};
export type PublicPaymentStatus = { reference: string; paymentStatus: string; reservationStatus: string; amountKobo: string };
