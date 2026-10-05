"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { api, errorMessage } from "@/lib/api";

const WEBSITE_URL = process.env.NEXT_PUBLIC_WEBSITE_URL ?? "https://houzzhills.com";

/** One-time creation of the property and owner account. The server closes setup once any user exists. */
export default function SetupPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function setup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const fields = new FormData(event.currentTarget);
    const value = (name: string) => String(fields.get(name) ?? "").trim();
    try {
      await api.setup.createOwner({
        propertyName: value("propertyName"),
        fullName: value("fullName"),
        email: value("email"),
        password: String(fields.get("password") ?? ""),
        ...(value("setupSecret") ? { setupSecret: value("setupSecret") } : {}),
      });
      setDone(true);
    } catch (caught) {
      setError(errorMessage(caught, "Unable to set up the owner account"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="management-auth-shell">
      <div className="auth-card setup-card">
        <div className="brand-mark">
          H<span>.</span>
        </div>
        {done ? (
          <>
            <ShieldCheck size={34} className="setup-success" />
            <h1>Owner account created</h1>
            <p className="auth-copy">Sign in with your owner credentials, then add rooms, staff, menu items and stock, and configure online payments in Settings.</p>
            <Link className="button-primary auth-submit" href="/management">
              Continue to sign in <ArrowRight size={15} />
            </Link>
          </>
        ) : (
          <>
            <h1>Set up your property</h1>
            <p className="auth-copy">Create the first owner account. Setup closes automatically once it exists.</p>
            {error && <div className="form-error">{error}</div>}
            <form onSubmit={(event) => void setup(event)}>
              <label className="form-field">
                <span>Setup key (from the server&apos;s SETUP_SECRET)</span>
                <input name="setupSecret" type="password" autoComplete="off" />
              </label>
              <label className="form-field">
                <span>Property name</span>
                <input name="propertyName" required maxLength={120} placeholder="As guests should see it" />
              </label>
              <label className="form-field">
                <span>Your full name</span>
                <input name="fullName" autoComplete="name" required maxLength={120} />
              </label>
              <label className="form-field">
                <span>Email address</span>
                <input name="email" type="email" autoComplete="email" required maxLength={254} />
              </label>
              <label className="form-field">
                <span>Create a password (12+ characters)</span>
                <input name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" required />
              </label>
              <button className="button-primary auth-submit" disabled={busy}>
                {busy ? "Creating account…" : "Create owner account"}
              </button>
            </form>
          </>
        )}
        <Link className="auth-public-link" href={WEBSITE_URL}>
          Back to public website <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
