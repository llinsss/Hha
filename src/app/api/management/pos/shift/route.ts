import { inTransaction, query } from "@/lib/server/db";
import { logAudit, logOutbox, requirePermission } from "@/lib/server/auth";

export async function GET() {
  const access = await requirePermission("pos:read");
  if (access.response) return access.response;
  const result = await query(`SELECT id,opening_float_kobo::text,opened_at FROM pos_shifts WHERE property_id=$1 AND cashier_id=$2 AND closed_at IS NULL LIMIT 1`, [access.user!.propertyId, access.user!.id]);
  return Response.json({ shift: result.rows[0] ?? null });
}

export async function POST(request: Request) {
  const access = await requirePermission("pos:write");
  if (access.response) return access.response;
  const body = await request.json();
  if (body.action === "open") {
    const float = Number(body.openingFloatKobo ?? 0);
    if (!Number.isSafeInteger(float) || float < 0) return Response.json({ error: "Opening cash float must be a non-negative whole number of kobo" }, { status: 400 });
    try {
      const row = await inTransaction(async (client) => {
        const result = await client.query<{ id: string; opened_at: Date }>("INSERT INTO pos_shifts(property_id,cashier_id,opening_float_kobo) VALUES($1,$2,$3) RETURNING id,opened_at", [access.user!.propertyId, access.user!.id, float]);
        await logAudit(client, access.user!.propertyId, access.user!.id, "pos.shift_opened", "pos_shift", result.rows[0].id, { openingFloatKobo: float });
        await logOutbox(client, access.user!.propertyId, "pos.shift_opened", result.rows[0].id);
        return result.rows[0];
      });
      return Response.json({ shift: row }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "23505") return Response.json({ error: "You already have an open shift" }, { status: 409 });
      return Response.json({ error: "Unable to open shift" }, { status: 500 });
    }
  }
  if (body.action === "close") {
    const countedCash = Number(body.countedCashKobo);
    if (!Number.isSafeInteger(countedCash) || countedCash < 0) return Response.json({ error: "Enter the counted cash in kobo" }, { status: 400 });
    try {
      const closed = await inTransaction(async (client) => {
        const shift = await client.query<{ id: string; opening_float_kobo: string }>("SELECT id,opening_float_kobo::text FROM pos_shifts WHERE property_id=$1 AND cashier_id=$2 AND closed_at IS NULL FOR UPDATE", [access.user!.propertyId, access.user!.id]);
        if (!shift.rows[0]) throw new Error("NO_OPEN_SHIFT");
        const cash = await client.query<{ total: string }>("SELECT coalesce(sum(total_kobo),0)::text AS total FROM pos_orders WHERE shift_id=$1 AND status='paid' AND payment_status='settled' AND payment_method='cash'", [shift.rows[0].id]);
        const expected = BigInt(shift.rows[0].opening_float_kobo) + BigInt(cash.rows[0].total);
        const variance = BigInt(countedCash) - expected;
        await client.query("UPDATE pos_shifts SET closing_cash_kobo=$2,expected_cash_kobo=$3,variance_kobo=$4,closed_at=now() WHERE id=$1", [shift.rows[0].id, countedCash, expected.toString(), variance.toString()]);
        await logAudit(client, access.user!.propertyId, access.user!.id, "pos.shift_closed", "pos_shift", shift.rows[0].id, { countedCashKobo: countedCash, expectedCashKobo: expected.toString(), varianceKobo: variance.toString() });
        await logOutbox(client, access.user!.propertyId, "pos.shift_closed", shift.rows[0].id, { varianceKobo: variance.toString() });
        return { id: shift.rows[0].id, expectedCashKobo: expected.toString(), varianceKobo: variance.toString() };
      });
      return Response.json({ shift: closed });
    } catch (error) {
      if (error instanceof Error && error.message === "NO_OPEN_SHIFT") return Response.json({ error: "There is no open shift" }, { status: 409 });
      return Response.json({ error: "Unable to close shift" }, { status: 500 });
    }
  }
  return Response.json({ error: "Choose open or close" }, { status: 400 });
}
