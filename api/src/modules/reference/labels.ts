/**
 * Human-readable labels for the API's vocabularies. Clients render these
 * instead of keeping their own copies, so wording and allowed values have a
 * single source.
 */
export type Option = { value: string; label: string };

const options = (entries: Record<string, string>): Option[] => Object.entries(entries).map(([value, label]) => ({ value, label }));

export const ROOM_STATUS_LABELS = {
  vacant_clean: "Vacant · clean",
  vacant_dirty: "Vacant · dirty",
  occupied: "Occupied",
  inspected: "Inspected",
  maintenance: "Maintenance",
  out_of_order: "Out of order",
} as const;

export const RESERVATION_STATUS_LABELS = {
  hold: "Hold",
  pending_payment: "Awaiting payment",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  checked_out: "Checked out",
  cancelled: "Cancelled",
  no_show: "No show",
  expired: "Expired",
} as const;

export const PAYMENT_STATUS_LABELS = { unpaid: "Unpaid", pending: "Pending confirmation", part_paid: "Part paid", paid: "Paid" } as const;

export const EXCEPTION_TITLES: Record<string, string> = {
  late_success: "Paid after the hold expired",
  amount_mismatch: "Amount does not match",
  currency_mismatch: "Wrong currency",
  overpayment: "Overpayment",
  verification_failed: "Provider did not confirm",
  unknown_reference: "Unknown reference",
  missing_local_record: "No matching booking",
  unresolved_bank_transfer: "Transfer still unconfirmed",
};

export const REFERENCE = {
  roomStatuses: options(ROOM_STATUS_LABELS),
  reservationStatuses: options(RESERVATION_STATUS_LABELS),
  paymentStatuses: options(PAYMENT_STATUS_LABELS),
  paymentMethods: options({ cash: "Cash", pos: "POS terminal", bank_transfer: "Bank transfer", online: "Online checkout" }),
  staffPaymentMethods: options({ cash: "Cash", pos: "POS terminal", bank_transfer: "Bank transfer" }),
  posPaymentMethods: options({ cash: "Cash", pos: "Card / POS terminal", bank_transfer: "Bank transfer" }),
  employmentStatuses: options({ active: "Active", on_leave: "On leave", terminated: "Terminated" }),
  stockMovements: options({ receive: "Receive stock", adjust: "Count adjustment (+/−)", wastage: "Record wastage" }),
  paymentProviders: options({ none: "Off (no online payment)", paystack: "Paystack", flutterwave: "Flutterwave" }),
  exceptionKinds: options(EXCEPTION_TITLES),
};
