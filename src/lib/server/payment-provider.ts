import { createHmac, timingSafeEqual } from "node:crypto";

type CheckoutInput = { email: string; amountKobo: number; reference: string; callbackUrl: string; name: string };
type CheckoutResult = { url: string; providerReference: string };

const provider = () => process.env.PAYMENT_PROVIDER?.toLowerCase() || "paystack";

export function configuredPaymentProvider() {
  const selected = provider();
  if (!["paystack", "flutterwave"].includes(selected)) throw new Error("UNSUPPORTED_PAYMENT_PROVIDER");
  return selected;
}

export function assertPaymentProviderConfigured() {
  const selected = configuredPaymentProvider();
  if (selected === "paystack" && !process.env.PAYSTACK_SECRET_KEY) throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
  if (selected === "flutterwave" && !process.env.FLUTTERWAVE_SECRET_KEY) throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
}

export async function startHostedCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const selected = configuredPaymentProvider();
  if (selected === "paystack") {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, amount: input.amountKobo, currency: "NGN", reference: input.reference, callback_url: input.callbackUrl, metadata: { guest_name: input.name, reservation_reference: input.reference } }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await response.json();
    if (!response.ok || !data.status || !data.data?.authorization_url) throw new Error("CHECKOUT_INITIALIZATION_FAILED");
    return { url: data.data.authorization_url, providerReference: data.data.reference ?? input.reference };
  }
  const secret = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secret) throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
  const response = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tx_ref: input.reference, amount: input.amountKobo / 100, currency: "NGN", redirect_url: input.callbackUrl, customer: { email: input.email, name: input.name }, customizations: { title: "Houzz Hills Kaduna", description: `Reservation ${input.reference}` } }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok || data.status !== "success" || !data.data?.link) throw new Error("CHECKOUT_INITIALIZATION_FAILED");
  return { url: data.data.link, providerReference: input.reference };
}

export function validProviderWebhook(raw: string, headers: Headers) {
  const selected = configuredPaymentProvider();
  if (selected === "paystack") {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const received = headers.get("x-paystack-signature") ?? "";
    if (!secret || !received) return false;
    const expected = createHmac("sha512", secret).update(raw).digest("hex");
    return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  }
  const secret = process.env.FLUTTERWAVE_WEBHOOK_HASH;
  const received = headers.get("verif-hash") ?? "";
  if (!secret || !received) return false;
  const a = Buffer.from(received); const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyProviderTransaction(reference: string) {
  const selected = configuredPaymentProvider();
  if (selected === "paystack") {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(12_000) });
    const body = await response.json();
    if (!response.ok || !body.status || !body.data) throw new Error("PROVIDER_VERIFICATION_FAILED");
    const item = body.data;
    return { provider: selected, reference: String(item.reference), status: String(item.status), amountKobo: Number(item.amount), currency: String(item.currency), eventId: `paystack:${item.id}` };
  }
  const secret = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secret) throw new Error("PAYMENT_PROVIDER_NOT_CONFIGURED");
  const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(reference)}/verify`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(12_000) });
  const body = await response.json();
  if (!response.ok || body.status !== "success" || !body.data) throw new Error("PROVIDER_VERIFICATION_FAILED");
  const item = body.data;
  return { provider: selected, reference: String(item.tx_ref), status: String(item.status), amountKobo: Math.round(Number(item.amount) * 100), currency: String(item.currency), eventId: `flutterwave:${item.id}` };
}
