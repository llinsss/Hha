import type {
  AttendanceEvent,
  ChangePasswordInput,
  CreatedPosOrder,
  Dashboard,
  EmploymentStatus,
  InventoryItem,
  LoginInput,
  MenuItem,
  NewInventoryItemInput,
  NewMenuItemInput,
  NewPosOrderInput,
  NewReservationInput,
  NewRoomInput,
  NewStaffInput,
  PaymentRecord,
  PaymentSource,
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
 * Everything the workspace UI needs from the backend. Components depend on this
 * interface only; `src/lib/api/index.ts` decides which implementation backs it.
 */
export interface ApiClient {
  /** "sample": in-browser sample data, no network. "http": the Houzz Hills API. */
  readonly mode: "sample" | "http";

  auth: {
    /** The signed-in user, or null. */
    session(): Promise<User | null>;
    login(input: LoginInput): Promise<User>;
    logout(): Promise<void>;
    changePassword(input: ChangePasswordInput): Promise<void>;
  };
  setup: {
    status(): Promise<{ setupRequired: boolean }>;
    createOwner(input: SetupInput): Promise<void>;
  };
  dashboard: {
    get(): Promise<Dashboard>;
  };
  reservations: {
    list(): Promise<Reservation[]>;
    create(input: NewReservationInput): Promise<Reservation>;
    /** `reason` is required (and audited) for cancellations and no-shows. */
    updateStatus(id: string, status: ReservationStatus, reason?: string): Promise<void>;
    recordPayment(id: string, input: RecordPaymentInput): Promise<{ paymentStatus: "pending" | "settled" }>;
  };
  payments: {
    list(): Promise<PaymentRecord[]>;
    /** Confirms a pending bank transfer (owner/manager). */
    confirm(id: string, source: PaymentSource): Promise<void>;
  };
  rooms: {
    list(): Promise<Room[]>;
    create(input: NewRoomInput): Promise<{ created: number; roomIds: string[] }>;
    updateStatus(id: string, status: RoomStatus): Promise<void>;
  };
  staff: {
    list(): Promise<Staff[]>;
    /** `temporaryPassword` is returned once when the server generated it. */
    create(input: NewStaffInput): Promise<{ id: string; userId: string; temporaryPassword?: string }>;
    updateStatus(id: string, status: EmploymentStatus): Promise<void>;
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
