import { createHash } from "node:crypto";
import { createSession, verifyPassword } from "@/lib/server/auth";
import { query } from "@/lib/server/db";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password) return Response.json({ error: "Email and password are required" }, { status: 400 });
    const clientIp = request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const fingerprint = createHash("sha256").update(`${email}:${clientIp}`).digest("hex");
    const attempt = await query<{ attempts: number; blocked: boolean }>(`INSERT INTO login_attempts(fingerprint,attempts) VALUES($1,1)
      ON CONFLICT(fingerprint) DO UPDATE SET
        attempts=CASE WHEN login_attempts.window_started_at < now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,
        window_started_at=CASE WHEN login_attempts.window_started_at < now()-interval '15 minutes' THEN now() ELSE login_attempts.window_started_at END,
        blocked_until=CASE WHEN login_attempts.window_started_at < now()-interval '15 minutes' THEN null
          WHEN login_attempts.blocked_until>now() THEN login_attempts.blocked_until
          WHEN login_attempts.attempts>=7 THEN now()+interval '15 minutes' ELSE login_attempts.blocked_until END
      RETURNING attempts,(blocked_until>now()) AS blocked`, [fingerprint]);
    if (attempt.rows[0]?.blocked) return Response.json({ error: "Too many sign-in attempts. Try again in 15 minutes." }, { status: 429 });
    const found = await query<{ id: string; password_hash: string; active: boolean }>(
      "SELECT id,password_hash,active FROM users WHERE email=$1 ORDER BY created_at LIMIT 1", [email],
    );
    const user = found.rows[0];
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      return Response.json({ error: "Email or password is incorrect" }, { status: 401 });
    }
    await query("DELETE FROM login_attempts WHERE fingerprint=$1", [fingerprint]);
    await createSession(user.id);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("login error", error);
    return Response.json({ error: "Unable to sign in. Check the database connection." }, { status: 503 });
  }
}
