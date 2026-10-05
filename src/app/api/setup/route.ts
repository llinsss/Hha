import { timingSafeEqual } from "node:crypto";
import { hashPassword } from "@/lib/server/auth";
import { inTransaction, query } from "@/lib/server/db";

export async function GET() {
  try {
    const result = await query<{ count: string }>("SELECT count(*)::text AS count FROM users");
    return Response.json({ setupRequired: result.rows[0]?.count === "0", setupEnabled: Boolean(process.env.SETUP_SECRET) });
  } catch {
    return Response.json({ error: "Database is not ready" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const host = request.headers.get("host") ?? "";
    const hostname = new URL(`http://${host}`).hostname;
    const localDevelopment = process.env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
    const configured = process.env.SETUP_SECRET;
    const supplied = request.headers.get("x-setup-secret") ?? "";
    const authorizedBySecret = Boolean(configured) && Buffer.byteLength(supplied) === Buffer.byteLength(configured!) && timingSafeEqual(Buffer.from(supplied), Buffer.from(configured!));
    if (!localDevelopment && !authorizedBySecret) {
      return Response.json({ error: "Setup authorization failed" }, { status: 403 });
    }
    const body = await request.json();
    const propertyName = String(body.propertyName ?? "Houzz Hills Kaduna").trim();
    const fullName = String(body.fullName ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!fullName || !email.includes("@") || password.length < 12) return Response.json({ error: "Provide your name, a valid email, and a password of at least 12 characters" }, { status: 400 });
    const passwordHash = await hashPassword(password);
    const user = await inTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(8142026)");
      const exists = await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM users) AS exists");
      if (exists.rows[0]?.exists) throw new Error("SETUP_COMPLETE");
      const property = await client.query<{ id: string }>("INSERT INTO properties(name) VALUES($1) RETURNING id", [propertyName]);
      const created = await client.query<{ id: string }>("INSERT INTO users(property_id,email,full_name,password_hash,role) VALUES($1,$2,$3,$4,'owner') RETURNING id", [property.rows[0].id, email, fullName, passwordHash]);
      return { id: created.rows[0].id };
    });
    return Response.json({ ok: true, userId: user.id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "SETUP_COMPLETE") return Response.json({ error: "Initial setup is already complete" }, { status: 409 });
    console.error("initial setup error", error);
    return Response.json({ error: "Unable to create the owner account" }, { status: 500 });
  }
}
