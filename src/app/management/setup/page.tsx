"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

export default function SetupPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const productionSetup = process.env.NODE_ENV === "production";

  async function setup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const fields = new FormData(event.currentTarget);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (productionSetup) headers["x-setup-secret"] = String(fields.get("setupSecret"));
      const response = await fetch(`${apiBase}/api/setup`, { method: "POST", credentials: "include", headers, body: JSON.stringify({ propertyName: fields.get("propertyName"), fullName: fields.get("fullName"), email: fields.get("email"), password: fields.get("password") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Initial setup could not be completed");
      setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to set up the owner account"); }
    finally { setBusy(false); }
  }

  return <div className="management-auth-shell"><div className="auth-card setup-card"><div className="brand-mark">H<span>.</span></div><p className="auth-eyebrow">HOUZZ HILLS KADUNA</p>{done ? <><ShieldCheck size={34} className="setup-success"/><h1>Owner account created</h1><p className="auth-copy">Sign in with your new owner credentials to add rooms, staff, menu items, and stock.</p><Link className="button-primary auth-submit" href="/management">Continue to sign in <ArrowRight size={15}/></Link></> : <><h1>Set up your property</h1><p className="auth-copy">Create the first owner account. Setup closes automatically after the account is created.</p>{error && <div className="form-error">{error}</div>}<form onSubmit={setup}>{productionSetup && <label className="form-field"><span>Production setup key</span><input name="setupSecret" type="password" autoComplete="off" required /></label>}<label className="form-field"><span>Property name</span><input name="propertyName" defaultValue="Houzz Hills Kaduna" required /></label><label className="form-field"><span>Your full name</span><input name="fullName" autoComplete="name" required /></label><label className="form-field"><span>Email address</span><input name="email" type="email" autoComplete="email" required /></label><label className="form-field"><span>Create a password (12+ characters)</span><input name="password" type="password" minLength={12} autoComplete="new-password" required /></label><button className="button-primary auth-submit" disabled={busy}>{busy ? "Creating account…" : "Create owner account"}</button></form></>}<Link className="auth-public-link" href={process.env.NEXT_PUBLIC_WEBSITE_URL || "https://houzzhills.com"}>Back to public website <ArrowRight size={13}/></Link></div></div>;
}
