/**
 * Global settings managed by the owner (PRD: payment provider and keys belong
 * to Houzz Hills, not to the deployment). Each definition declares its type,
 * default, validation and whether it is a secret. Secrets are encrypted at
 * rest and never returned to any client.
 */
export type SettingGroup = "payments" | "booking";

type Base = { key: string; group: SettingGroup; label: string; description: string };
export type StringSetting = Base & {
  type: "string";
  secret: boolean;
  /** The payment provider a credential belongs to, so clients show it with that provider. */
  provider?: string;
  pattern?: RegExp;
  patternHint?: string;
  minLength: number;
  maxLength: number;
};
export type EnumSetting = Base & { type: "enum"; secret: false; values: readonly string[]; labels: Readonly<Record<string, string>>; default: string };
export type IntegerSetting = Base & { type: "integer"; secret: false; minimum: number; maximum: number; default: number };
export type SettingDefinition = StringSetting | EnumSetting | IntegerSetting;

export const PAYMENT_PROVIDERS = ["none", "paystack", "flutterwave"] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const SETTINGS = [
  {
    key: "payments.provider",
    group: "payments",
    type: "enum",
    secret: false,
    values: PAYMENT_PROVIDERS,
    labels: { none: "Off (no online payment)", paystack: "Paystack", flutterwave: "Flutterwave" },
    default: "none",
    label: "Online payment provider",
    description: "Hosted checkout for public bookings. Choose none to disable online booking.",
  },
  {
    key: "payments.paystack_secret_key",
    group: "payments",
    type: "string",
    secret: true,
    provider: "paystack",
    pattern: /^sk_(test|live)_[A-Za-z0-9]{8,}$/,
    patternHint: "a Paystack secret key (sk_test_… or sk_live_…)",
    minLength: 16,
    maxLength: 200,
    label: "Paystack secret key",
    description: "Dashboard → Settings → API Keys & Webhooks. Also signs Paystack webhooks.",
  },
  {
    key: "payments.flutterwave_secret_key",
    group: "payments",
    type: "string",
    secret: true,
    provider: "flutterwave",
    pattern: /^FLWSECK(_TEST)?-[A-Za-z0-9-]{8,}$/,
    patternHint: "a Flutterwave secret key (FLWSECK-… or FLWSECK_TEST-…)",
    minLength: 16,
    maxLength: 200,
    label: "Flutterwave secret key",
    description: "Dashboard → Settings → API Keys.",
  },
  {
    key: "payments.flutterwave_webhook_hash",
    group: "payments",
    type: "string",
    secret: true,
    provider: "flutterwave",
    minLength: 16,
    maxLength: 200,
    label: "Flutterwave webhook secret hash",
    description: "Dashboard → Settings → Webhooks → Secret hash. Must match exactly.",
  },
  {
    key: "booking.hold_minutes",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 5,
    maximum: 120,
    default: 20,
    label: "Checkout hold (minutes)",
    description: "How long a room is held while a guest pays online.",
  },
  {
    key: "booking.max_stay_nights",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 1,
    maximum: 365,
    default: 90,
    label: "Maximum stay (nights)",
    description: "Longest stay accepted from the website or staff.",
  },
  {
    key: "booking.horizon_days",
    group: "booking",
    type: "integer",
    secret: false,
    minimum: 1,
    maximum: 730,
    default: 365,
    label: "Booking horizon (days)",
    description: "How far ahead check-in dates can be booked.",
  },
  {
    key: "payments.bank_transfer_review_hours",
    group: "payments",
    type: "integer",
    secret: false,
    minimum: 1,
    maximum: 720,
    default: 48,
    label: "Transfer review window (hours)",
    description: "Pending bank transfers older than this are queued as payment exceptions.",
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS)[number]["key"];

export const SETTING_KEYS: readonly SettingKey[] = SETTINGS.map((setting) => setting.key);

export function definitionOf(key: string): SettingDefinition | undefined {
  return (SETTINGS as readonly SettingDefinition[]).find((setting) => setting.key === key);
}

/** The typed, decrypted settings the server works with. */
export type GlobalSettings = Readonly<{
  provider: PaymentProviderName;
  paystackSecretKey: string | null;
  flutterwaveSecretKey: string | null;
  flutterwaveWebhookHash: string | null;
  holdMinutes: number;
  maxStayNights: number;
  horizonDays: number;
  bankTransferReviewHours: number;
}>;
