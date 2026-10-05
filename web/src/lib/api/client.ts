import type {
  AttendanceEvent,
  ChangePasswordInput,
  CreatedPosOrder,
  Dashboard,
  EmploymentStatus,
  AvailableRoomType,
  InventoryItem,
  LiveEvent,
  MenuItemChanges,
  PaymentException,
  PaymentRegister,
  PublicBooking,
  PublicBookingInput,
  PublicPaymentStatus,
  RoomHistoryEntry,
  SettingsChanges,
  SettingsSnapshot,
  LoginInput,
  MenuItem,
  NewInventoryItemInput,
  NewMenuItemInput,
  NewPosOrderInput,
  NewReservationInput,
  NewRoomInput,
  NewStaffInput,
  PaymentSource,
  Property,
  Reference,
  PosOrder,
  Receipt,
  RecordPaymentInput,
  Reservation,
  ReservationStatus,
  Room,
  RoomStatus,
  SetupInput,
  Shift,
  Staff,
  StockMovementInput,
  User,
} from "./types";

/**
 * Everything the web app needs from the Houzz Hills API. Components depend on
 * this interface only; `src/lib/api/http.ts` implements it.
 */
export interface ApiClient {
  auth: {
    /** The signed-in user, or null. */
    session(): Promise<User | null>;
    login(input: LoginInput): Promise<User>;
    logout(): Promise<void>;
    changePassword(input: ChangePasswordInput): Promise<void>;
  };
  setup: {
    status(): Promise<{ setupRequired: boolean; setupEnabled: boolean }>;
    createOwner(input: SetupInput): Promise<void>;
  };
  dashboard: {
    get(): Promise<Dashboard>;
  };
  reservations: {
    /** Most recent stays; `q` searches guest name and reference on the server. */
    list(filters?: { q?: string }): Promise<Reservation[]>;
    create(input: NewReservationInput): Promise<Reservation>;
    /** `reason` is required (and audited) for cancellations and no-shows. */
    updateStatus(id: string, status: ReservationStatus, reason?: string): Promise<void>;
    recordPayment(id: string, input: RecordPaymentInput): Promise<{ paymentStatus: "pending" | "settled" }>;
  };
  payments: {
    register(): Promise<PaymentRegister>;
    /** Confirms a pending bank transfer (owner/manager). */
    confirm(id: string, source: PaymentSource, note?: string): Promise<void>;
    /** The register as a CSV file. */
    exportCsv(): Promise<{ filename: string; blob: Blob }>;
    exceptions(status: "open" | "resolved"): Promise<PaymentException[]>;
    resolveException(id: string, resolutionNote: string): Promise<void>;
  };
  rooms: {
    list(): Promise<Room[]>;
    create(input: NewRoomInput): Promise<{ created: number; roomIds: string[] }>;
    updateStatus(id: string, status: RoomStatus, note?: string): Promise<void>;
    history(id: string): Promise<RoomHistoryEntry[]>;
  };
  staff: {
    list(): Promise<Staff[]>;
    /** `temporaryPassword` is returned once when the server generated it. */
    create(input: NewStaffInput): Promise<{ id: string; userId: string; temporaryPassword?: string }>;
    updateStatus(id: string, status: EmploymentStatus): Promise<void>;
    /** Issues a one-time temporary password and signs the member out everywhere. */
    resetPassword(id: string): Promise<{ temporaryPassword: string }>;
  };
  attendance: {
    self(): Promise<{ clockedIn: boolean }>;
    record(eventType: AttendanceEvent): Promise<void>;
  };
  inventory: {
    list(): Promise<InventoryItem[]>;
    createItem(input: NewInventoryItemInput): Promise<{ id: string }>;
    recordMovement(input: StockMovementInput): Promise<void>;
  };
  menu: {
    list(): Promise<MenuItem[]>;
    create(input: NewMenuItemInput): Promise<{ id: string }>;
    /** Edits or archives (`active: false`) an item; past receipts keep the old values. */
    update(id: string, changes: MenuItemChanges): Promise<void>;
  };
  pos: {
    /** The current user's open cashier shift and today's orders. */
    overview(): Promise<{ shift: Shift | null; orders: PosOrder[] }>;
    createOrder(input: NewPosOrderInput): Promise<CreatedPosOrder>;
    /** Only available once the order's payment is settled. */
    receipt(orderId: string): Promise<Receipt>;
    openShift(openingFloatKobo: number): Promise<void>;
    closeShift(countedCashKobo: number): Promise<{ varianceKobo: string }>;
  };
  settings: {
    /** Owner only. Secret values are never returned. */
    get(): Promise<SettingsSnapshot>;
    update(changes: SettingsChanges): Promise<SettingsSnapshot>;
    verifyPayments(): Promise<{ provider: string }>;
  };
  events: {
    /** Live property updates; reconnects automatically. Returns a function that stops the stream. */
    subscribe(onEvent: (event: LiveEvent) => void, onStatus?: (connected: boolean) => void): () => void;
  };
  reference: {
    /** Form vocabularies and the roles the signed-in user may assign. */
    get(): Promise<Reference>;
  };
  publicBooking: {
    /** The property the public site serves. */
    property(): Promise<Property>;
    availability(query: { checkIn: string; checkOut: string; guests: number }): Promise<AvailableRoomType[]>;
    reserve(input: PublicBookingInput, idempotencyKey: string): Promise<PublicBooking>;
    paymentStatus(reference: string): Promise<PublicPaymentStatus>;
  };
}

/** Error raised by every ApiClient; `message` is safe to show to staff. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
