import { randomBytes } from "node:crypto";
import { inTransaction, query } from "@/lib/server/db";
import { logOutbox } from "@/lib/server/auth";
import { assertPaymentProviderConfigured, startHostedCheckout } from "@/lib/server/payment-provider";

function validDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function POST(request: Request) {
  try {
    assertPaymentProviderConfigured();
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const phone = String(body.phone ?? "").trim();
    const roomType = String(body.roomType ?? "").trim();
    const checkIn = body.checkIn;
    const checkOut = body.checkOut;
    const guests = Number(body.guests ?? 1);
    const notes = String(body.notes ?? "").trim().slice(0, 2000);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !roomType || !validDate(checkIn) || !validDate(checkOut) || !Number.isInteger(guests) || guests < 1 || guests > 12) {
      return Response.json({ error: "Name, valid email, room type, dates, and guest count are required" }, { status: 400 });
    }
    if (new Date(`${checkOut}T00:00:00Z`) <= new Date(`${checkIn}T00:00:00Z`) || (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000 > 90) {
      return Response.json({ error: "Choose a valid stay of 1 to 90 nights" }, { status: 400 });
    }
    const kadunaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (checkIn < kadunaToday) return Response.json({ error: "Check-in must be today or a future date" }, { status: 400 });
    const properties = await query<{ id: string }>("SELECT id FROM properties ORDER BY created_at LIMIT 1");
    if (!properties.rows[0]) return Response.json({ error: "Bookings are not configured yet" }, { status: 503 });
    const propertyId = properties.rows[0].id;
    const booking = await inTransaction(async (client) => {
      const roomResult = await client.query<{ id: string; nightly_rate_kobo: string }>(
        `SELECT ro.id,ro.nightly_rate_kobo::text FROM rooms ro
         WHERE ro.property_id=$1 AND ro.active=true AND ro.room_type=$2 AND ro.capacity >= $3 AND ro.status IN ('vacant_clean','inspected')
         AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.room_id=ro.id AND r.status IN ('hold','pending_payment','confirmed','checked_in')
           AND (r.status NOT IN ('hold','pending_payment') OR r.hold_expires_at IS NULL OR r.hold_expires_at>now())
           AND r.check_in < $5::date AND r.check_out > $4::date)
         ORDER BY ro.room_number LIMIT 1 FOR UPDATE OF ro SKIP LOCKED`,
        [propertyId, roomType, guests, checkIn, checkOut],
      );
      const room = roomResult.rows[0];
      if (!room) throw new Error("ROOM_UNAVAILABLE");
      let guestResult = email
        ? await client.query<{ id: string }>("SELECT id FROM guests WHERE property_id=$1 AND lower(email)=lower($2) LIMIT 1 FOR UPDATE", [propertyId, email])
        : { rows: [] as { id: string }[] };
      if (!guestResult.rows[0] && phone) guestResult = await client.query("SELECT id FROM guests WHERE property_id=$1 AND phone=$2 LIMIT 1 FOR UPDATE", [propertyId, phone]);
      let guestId = guestResult.rows[0]?.id;
      if (guestId) await client.query("UPDATE guests SET full_name=$2,email=coalesce(nullif($3,''),email),phone=coalesce(nullif($4,''),phone) WHERE id=$1", [guestId, name, email, phone]);
      else guestId = (await client.query<{ id: string }>("INSERT INTO guests(property_id,full_name,email,phone) VALUES($1,$2,nullif($3,''),nullif($4,'')) RETURNING id", [propertyId, name, email, phone])).rows[0].id;
      const nights = (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000;
      const amount = BigInt(room.nightly_rate_kobo) * BigInt(nights);
      if (amount <= 0 || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PRICE_NOT_PAYABLE");
      const reference = `HH-${Date.now().toString(36).toUpperCase()}-${randomBytes(16).toString("hex").toUpperCase()}`;
      const reservation = await client.query<{ id: string }>(
        `INSERT INTO reservations(property_id,guest_id,reference,room_id,room_type,check_in,check_out,guests_count,amount_kobo,status,source,payment_status,notes)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_payment','public_website','pending',$10) RETURNING id`,
        [propertyId, guestId, reference, room.id, roomType, checkIn, checkOut, guests, amount.toString(), notes],
      );
      await client.query("UPDATE reservations SET hold_expires_at=now()+interval '20 minutes' WHERE id=$1", [reservation.rows[0].id]);
      await client.query(`INSERT INTO payments(property_id,reservation_id,amount_kobo,method,status,provider,provider_reference,idempotency_key)
        VALUES($1,$2,$3,'online','pending',null,$4,$5)`, [propertyId, reservation.rows[0].id, amount.toString(), reference, `online:${reference}`]);
      await logOutbox(client, propertyId, "reservation.created", reservation.rows[0].id, { reference, source: "public_website" });
      return { id: reservation.rows[0].id, reference, amountKobo: amount.toString(), currency: "NGN", guestEmail: email, guestName: name };
    });
    const origin = process.env.APP_URL || new URL(request.url).origin;
    let checkout: Awaited<ReturnType<typeof startHostedCheckout>>;
    try {
      checkout = await startHostedCheckout({ email: booking.guestEmail, name: booking.guestName, amountKobo: Number(booking.amountKobo), reference: booking.reference, callbackUrl: `${origin}/payment-result?reference=${encodeURIComponent(booking.reference)}` });
    } catch (error) {
      await query("UPDATE payments SET status='failed' WHERE reservation_id=$1 AND method='online' AND status='pending'", [booking.id]);
      await query("UPDATE reservations SET status='expired',payment_status='unpaid',updated_at=now() WHERE id=$1 AND status='pending_payment'", [booking.id]);
      if (error instanceof Error && ["PAYMENT_PROVIDER_NOT_CONFIGURED", "UNSUPPORTED_PAYMENT_PROVIDER"].includes(error.message)) throw error;
      throw new Error("CHECKOUT_INITIALIZATION_FAILED");
    }
    await query("UPDATE payments SET provider=$2,provider_reference=$3 WHERE reservation_id=$1 AND idempotency_key=$4", [booking.id, process.env.PAYMENT_PROVIDER?.toLowerCase() || "paystack", checkout.providerReference, `online:${booking.reference}`]);
    return Response.json({ reservation: { id: booking.id, reference: booking.reference, amountKobo: booking.amountKobo, currency: "NGN", status: "pending_payment" }, checkoutUrl: checkout.url }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ROOM_UNAVAILABLE") return Response.json({ error: "That room type is unavailable for the selected dates" }, { status: 409 });
    if (error instanceof Error && error.message === "PRICE_NOT_PAYABLE") return Response.json({ error: "This suite is not currently available for online payment. Please contact the property." }, { status: 503 });
    if (error instanceof Error && ["PAYMENT_PROVIDER_NOT_CONFIGURED", "UNSUPPORTED_PAYMENT_PROVIDER"].includes(error.message)) return Response.json({ error: "Online payment is temporarily unavailable. Please contact the property to book." }, { status: 503 });
    if (error instanceof Error && error.message === "CHECKOUT_INITIALIZATION_FAILED") return Response.json({ error: "We could not open secure checkout. Please try again or contact the property." }, { status: 502 });
    console.error("public reservation failed", error);
    return Response.json({ error: "Unable to create reservation" }, { status: 500 });
  }
}
