"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { errorMessage, type Permission, type Property, type Reference, type User } from "@/lib/api";

export type Notify = (message: string) => void;

/** What every workspace section receives from the shell. */
export type SectionProps = {
  user: User;
  notify: Notify;
  /** Changes whenever live updates report a committed change; sections reload on it. */
  refreshKey: number;
  /** Whether the API granted the signed-in user this permission. */
  can: (permission: Permission) => boolean;
  /** Labels and allowed values from the API. */
  reference: Reference;
  property: Property;
};

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="form-field">
      <span>{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

export function InlineError({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="inline-error" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export function Metric({ label, icon, tone, value, unit, foot, progress }: { label: string; icon: ReactNode; tone: string; value: string; unit?: string; foot: string; progress?: number }) {
  return (
    <article className="metric-card">
      <div className="metric-top">
        <span>{label}</span>
        <span className={`metric-icon ${tone}`}>{icon}</span>
      </div>
      <div className="metric-value metric-text-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>
      <div className="metric-foot">
        {progress !== undefined && (
          <div className="occupancy-track">
            <i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </div>
        )}
        <span>{foot}</span>
      </div>
    </article>
  );
}

type ModalProps = {
  title: string;
  description?: string;
  submitLabel?: string;
  busy?: boolean;
  error?: string;
  /** Omit for read-only dialogs. */
  onSubmit?: (values: FormData) => unknown;
  onClose?: () => void;
  wide?: boolean;
  children: ReactNode;
};

/** Form dialog. Without `onClose` it cannot be dismissed (e.g. the temporary-password gate). */
export function Modal({ title, description, submitLabel = "Save changes", busy, error, onSubmit, onClose, wide, children }: ModalProps) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit?.(new FormData(event.currentTarget));
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <form className={`management-modal ${wide ? "modal-wide" : ""}`} onSubmit={submit} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {onClose && (
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        {children}
        <div className="modal-actions">
          {onClose && (
            <button type="button" className="button-secondary" onClick={onClose}>
              {onSubmit ? "Cancel" : "Close"}
            </button>
          )}
          {onSubmit && (
            <button className="button-primary" disabled={busy}>
              {busy ? "Saving…" : submitLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

export type Resource<T> = { data: T | null; error: string; loading: boolean; reload: () => Promise<void> };

/**
 * Loads data from the API and reloads whenever `key` changes (filters, live
 * updates). Errors are kept separately so stale data stays visible.
 */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: "", loading: true });
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const reload = useCallback(async () => {
    try {
      const data = await loader.current();
      setState({ data, error: "", loading: false });
    } catch (error) {
      setState((current) => ({ ...current, error: errorMessage(error, "Unable to load data"), loading: false }));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, key]);
  return { ...state, reload };
}

/** Runs a form action with busy/error state shared by a dialog. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (work: () => Promise<void>, fallback = "Unable to save changes") => {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError("") };
}

/** Triggers a browser download of a Blob. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
