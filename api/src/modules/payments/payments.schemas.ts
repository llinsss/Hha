import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { IdParams, IsoDate, KoboString, Nullable, StringEnum, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

const security = [{ bearerAuth: [] }];

export const RegisterFilters = {
  source: Type.Optional(StringEnum(["accommodation", "restaurant"] as const)),
  status: Type.Optional(StringEnum(["pending", "settled", "failed"] as const)),
  method: Type.Optional(StringEnum(["cash", "pos", "bank_transfer", "online"] as const)),
  from: Type.Optional(IsoDate),
  to: Type.Optional(IsoDate),
  q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
};

const PaymentRecord = Type.Object({
  id: Uuid,
  source: Type.String(),
  reference: Type.String(),
  guest_name: Type.String(),
  unit_label: Type.String(),
  amount_kobo: KoboString,
  method: Type.String(),
  status: Type.String(),
  payment_reference: Nullable(Type.String()),
  created_at: Timestamp,
  recorded_by: Nullable(Type.String()),
  confirmed_by: Nullable(Type.String()),
  confirmed_at: Nullable(Timestamp),
});

export const ListPaymentsSchema = {
  tags: ["payments"],
  summary: "Payment register (accommodation and restaurant)",
  description:
    "Newest first. `from`/`to` filter by Africa/Lagos business date (inclusive). `totals` cover every record matching the filters, with pending amounts kept separate from settled revenue.",
  security,
  querystring: Type.Object({ ...RegisterFilters, ...PageQuery }, { additionalProperties: false }),
  response: {
    200: Type.Object({
      payments: Type.Array(PaymentRecord),
      nextCursor: NextCursor,
      totals: Type.Object({ count: Type.Integer(), settledKobo: KoboString, pendingKobo: KoboString, failedKobo: KoboString }),
    }),
    ...errorResponses(401, 403, 422),
  },
};

export const ExportPaymentsSchema = {
  tags: ["payments"],
  summary: "Export the payment register as CSV",
  description: "Same filters as the register. At most 10,000 rows; narrow the date range for more.",
  security,
  querystring: Type.Object(RegisterFilters, { additionalProperties: false }),
  produces: ["text/csv"],
  response: { 200: Type.String({ description: "text/csv" }), ...errorResponses(401, 403, 422) },
};

export const ConfirmPaymentSchema = {
  tags: ["payments"],
  summary: "Confirm a pending bank transfer",
  description: "Only after the owner or manager has verified the money in the company account. Audited with the optional note.",
  security,
  params: IdParams,
  body: Type.Object(
    {
      source: StringEnum(["accommodation", "restaurant"] as const),
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ ok: Type.Literal(true) }), ...errorResponses(401, 403, 404, 409, 422) },
};

export const EXCEPTION_KINDS = [
  "late_success",
  "amount_mismatch",
  "currency_mismatch",
  "overpayment",
  "verification_failed",
  "unknown_reference",
  "missing_local_record",
  "unresolved_bank_transfer",
] as const;

const PaymentException = Type.Object({
  id: Uuid,
  kind: Type.String(),
  title: Type.String(),
  status: Type.String(),
  reservation_id: Nullable(Uuid),
  reservation_reference: Nullable(Type.String()),
  payment_id: Nullable(Uuid),
  pos_order_id: Nullable(Uuid),
  provider: Nullable(Type.String()),
  provider_reference: Nullable(Type.String()),
  expected_amount_kobo: Nullable(KoboString),
  received_amount_kobo: Nullable(KoboString),
  details: Type.Object({}, { additionalProperties: true }),
  detected_at: Timestamp,
  resolved_at: Nullable(Timestamp),
  resolved_by: Nullable(Type.String()),
  resolution_note: Nullable(Type.String()),
});

export const ListExceptionsSchema = {
  tags: ["payments"],
  summary: "Payment exception queue",
  description:
    "Late successes, amount/currency mismatches, overpayments, provider verification failures, unknown references and unresolved bank transfers. Resolving an exception records a decision only: it never confirms a stay or issues a refund.",
  security,
  querystring: Type.Object(
    { status: Type.Optional(StringEnum(["open", "resolved"] as const)), kind: Type.Optional(StringEnum(EXCEPTION_KINDS)), ...PageQuery },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ exceptions: Type.Array(PaymentException), nextCursor: NextCursor }), ...errorResponses(401, 403, 422) },
};

export const ResolveExceptionSchema = {
  tags: ["payments"],
  summary: "Resolve a payment exception with the action taken",
  security,
  params: IdParams,
  body: Type.Object({ resolutionNote: Type.String({ minLength: 5, maxLength: 1000 }) }, { additionalProperties: false }),
  response: { 200: Type.Object({ exception: PaymentException }), ...errorResponses(401, 403, 404, 409, 422) },
};
