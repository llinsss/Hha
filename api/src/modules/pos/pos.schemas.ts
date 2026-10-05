import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { IdParams, KoboInput, KoboString, Nullable, StringEnum, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

const security = [{ bearerAuth: [] }];
export const POS_PAYMENT_METHODS = ["cash", "pos", "bank_transfer"] as const;

const Shift = Type.Object({ id: Uuid, opening_float_kobo: KoboString, opened_at: Timestamp });

export const OverviewSchema = {
  tags: ["pos"],
  summary: "Your open cashier shift and today's orders",
  security,
  querystring: Type.Object(PageQuery, { additionalProperties: false }),
  response: {
    200: Type.Object({
      shift: Nullable(Shift),
      orders: Type.Array(
        Type.Object({
          id: Uuid,
          receipt_number: Type.String(),
          total_kobo: KoboString,
          payment_method: Type.String(),
          payment_status: Type.String(),
          status: Type.String(),
          created_at: Timestamp,
          cashier: Type.String(),
        }),
      ),
      nextCursor: NextCursor,
    }),
    ...errorResponses(401, 403, 422),
  },
};

const CreatedOrder = Type.Object({ id: Uuid, receipt_number: Type.String(), total_kobo: KoboString, payment_status: Type.String(), duplicate: Type.Boolean() });

export const CreateOrderSchema = {
  tags: ["pos"],
  summary: "Finalise a restaurant sale",
  description:
    "Prices come from the menu, recipe stock is deducted atomically, and cash/POS sales settle at once. Bank transfers create a `pending_payment` order with no receipt until confirmed. Requires `Idempotency-Key` (the legacy `idempotencyKey` body field, if sent, must match); a retry returns the original order with status 200.",
  security,
  headers: Type.Object({ "idempotency-key": Type.String({ minLength: 8, maxLength: 128 }) }),
  body: Type.Object(
    {
      items: Type.Array(Type.Object({ menuItemId: Uuid, quantity: Type.Integer({ minimum: 1, maximum: 50 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 40 }),
      paymentMethod: StringEnum(POS_PAYMENT_METHODS),
      paymentReference: Type.Optional(Type.String({ maxLength: 120 })),
      idempotencyKey: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  response: { 201: Type.Object({ order: CreatedOrder }), 200: Type.Object({ order: CreatedOrder }), ...errorResponses(401, 403, 409, 422) },
};

export const ReceiptSchema = {
  tags: ["pos"],
  summary: "Receipt for a settled order",
  description: "Orders paid by transfer have no receipt until the transfer is confirmed (409).",
  security,
  params: IdParams,
  response: {
    200: Type.Object({
      receipt: Type.Object({
        id: Uuid,
        receipt_number: Type.String(),
        subtotal_kobo: KoboString,
        discount_kobo: KoboString,
        total_kobo: KoboString,
        payment_method: Type.String(),
        payment_status: Type.String(),
        payment_reference: Nullable(Type.String()),
        created_at: Timestamp,
        cashier: Type.String(),
        property_name: Type.String(),
        items: Type.Array(Type.Object({ item_name: Type.String(), quantity: Type.Integer(), unit_price_kobo: KoboString, line_total_kobo: KoboString })),
      }),
    }),
    ...errorResponses(401, 403, 404, 409),
  },
};

export const GetShiftSchema = {
  tags: ["pos"],
  summary: "Your open cashier shift",
  security,
  response: { 200: Type.Object({ shift: Nullable(Shift) }), ...errorResponses(401, 403) },
};

export const ShiftActionSchema = {
  tags: ["pos"],
  summary: "Open or close your cashier shift",
  description: "`open` with `openingFloatKobo`; `close` with `countedCashKobo`. Closing records the cash variance and per-tender totals.",
  security,
  body: Type.Object(
    {
      action: StringEnum(["open", "close"] as const),
      openingFloatKobo: Type.Optional(KoboInput),
      countedCashKobo: Type.Optional(KoboInput),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object({ shift: Shift }),
    200: Type.Object({
      shift: Type.Object({
        id: Uuid,
        expectedCashKobo: KoboString,
        varianceKobo: KoboString,
        tenders: Type.Array(Type.Object({ method: Type.String(), paymentStatus: Type.String(), orders: Type.Integer(), totalKobo: KoboString })),
      }),
    }),
    ...errorResponses(401, 403, 409, 422),
  },
};
