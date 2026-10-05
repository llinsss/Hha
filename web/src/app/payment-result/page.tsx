"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";
import { api, errorMessage, type Property, type PublicPaymentStatus } from "@/lib/api";
import { applyProperty, money } from "../management/workspace/format";

const POLL_MS = 3_000;
const MAX_POLLS = 40;

/** Polls the server for the outcome; the redirect itself never confirms a payment. */
function PaymentResult() {
  const reference = useSearchParams().get("reference") ?? "";
  const [status, setStatus] = useState<PublicPaymentStatus | null>(null);
  const [error, setError] = useState(reference ? "" : "This link is missing its booking reference.");
  const [polls, setPolls] = useState(0);
  const [property, setProperty] = useState<Property | null>(null);

  useEffect(() => {
    api.publicBooking
      .property()
      .then((loaded) => {
        applyProperty(loaded);
        setProperty(loaded);
      })
      .catch(() => undefined);
  }, []);

  const settled = status?.paymentStatus === "paid" || ["confirmed", "expired", "cancelled"].includes(status?.reservationStatus ?? "");

  useEffect(() => {
    if (!reference || settled || polls >= MAX_POLLS) return;
    const timer = window.setTimeout(() => {
      api.publicBooking
        .paymentStatus(reference)
        .then((next) => {
          setStatus(next);
          setError("");
        })
        .catch((caught: unknown) => setError(errorMessage(caught, "Unable to check your payment")))
        .finally(() => setPolls((count) => count + 1));
    }, polls === 0 ? 0 : POLL_MS);
    return () => window.clearTimeout(timer);
  }, [reference, settled, polls]);

  const confirmed = status?.reservationStatus === "confirmed" && status.paymentStatus === "paid";
  const failed = status && !confirmed && ["expired", "cancelled"].includes(status.reservationStatus);

  return (
    <div className="management-auth-shell">
      <div className="auth-card">
        <div className="brand-mark">
          H<span>.</span>
        </div>
        {property && <p className="auth-eyebrow">{property.name.toUpperCase()}</p>}
        {confirmed ? (
          <>
            <CheckCircle2 size={34} className="setup-success" />
            <h1>Your stay is confirmed</h1>
            <p className="auth-copy">
              Payment of {money(status.amountKobo)} received. Keep your reference: <strong>{status.reference}</strong>
            </p>
          </>
        ) : failed ? (
          <>
            <XCircle size={34} className="result-failed" />
            <h1>Booking not completed</h1>
            <p className="auth-copy">
              {status.paymentStatus === "paid"
                ? "Your payment arrived after the room hold ended. The property will contact you; no further action is needed."
                : "The payment was not completed in time, so the room was released. You have not been charged."}{" "}
              Reference: {status.reference}
            </p>
            <Link className="button-primary auth-submit" href="/reserve">
              Start a new booking
            </Link>
          </>
        ) : (
          <>
            <Clock3 size={34} className="result-pending" />
            <h1>Confirming your payment…</h1>
            <p className="auth-copy">{polls >= MAX_POLLS ? "This is taking longer than usual. Refresh this page in a few minutes, or contact the property with your reference." : "This usually takes a few seconds. You can keep this page open."}</p>
          </>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    </div>
  );
}

export default function PaymentResultPage() {
  return (
    <Suspense>
      <PaymentResult />
    </Suspense>
  );
}
