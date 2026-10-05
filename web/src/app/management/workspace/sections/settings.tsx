"use client";

import { useState } from "react";
import { AlertTriangle, CreditCard, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { api, errorMessage, type SettingView, type SettingsChanges, type SettingsSnapshot } from "@/lib/api";
import { dateTimeLabel } from "../format";
import { Field, InlineError, useResource, type SectionProps } from "../ui";

function SettingInput({ setting, value, onChange, clear, onClear }: { setting: SettingView; value: string; onChange: (value: string) => void; clear: boolean; onClear: (clear: boolean) => void }) {
  if (setting.secret) {
    return (
      <Field
        label={setting.label}
        hint={!setting.readable ? "The saved value cannot be decrypted with the server's key. Enter it again." : setting.configured ? `Saved ${setting.hint ?? ""}. Leave blank to keep it.` : "Not set."}
      >
        <input type="password" autoComplete="off" spellCheck={false} value={value} disabled={clear} onChange={(event) => onChange(event.target.value)} placeholder={setting.configured ? "Enter a new value to replace it" : "Paste the key"} />
        {setting.configured && (
          <label className="checkbox-line">
            <input type="checkbox" checked={clear} onChange={(event) => onClear(event.target.checked)} /> Remove the saved value
          </label>
        )}
      </Field>
    );
  }
  if (setting.type === "integer") {
    return (
      <Field label={setting.label} hint={`${setting.description} Default ${String(setting.default)}.`}>
        <input type="number" min={setting.minimum ?? undefined} max={setting.maximum ?? undefined} step="1" required value={value} onChange={(event) => onChange(event.target.value)} />
      </Field>
    );
  }
  return null;
}

function SettingsForm({ snapshot, notify, onSaved }: { snapshot: SettingsSnapshot; notify: SectionProps["notify"]; onSaved: () => void }) {
  const byKey = new Map(snapshot.settings.map((setting) => [setting.key, setting]));
  const providerSetting = byKey.get("payments.provider");
  const providerOptions = providerSetting?.options ?? [];
  const providerLabel = (value: string) => providerOptions.find((option) => option.value === value)?.label ?? value;
  const initialProvider = String(providerSetting?.value ?? "none");
  const [provider, setProvider] = useState(initialProvider);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(snapshot.settings.filter((setting) => setting.type === "integer").map((setting) => [setting.key, String(setting.value ?? setting.default ?? "")])),
  );
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verifyResult, setVerifyResult] = useState("");

  const secrets = snapshot.settings.filter((setting) => setting.secret);
  const integers = snapshot.settings.filter((setting) => setting.type === "integer");
  const unreadable = secrets.filter((setting) => !setting.readable);

  const save = async () => {
    const changes: SettingsChanges = {};
    if (provider !== initialProvider) changes["payments.provider"] = provider;
    for (const setting of secrets) {
      if (cleared[setting.key]) changes[setting.key] = null;
      else if (values[setting.key]?.trim()) changes[setting.key] = values[setting.key]!.trim();
    }
    for (const setting of integers) {
      const next = Number(values[setting.key]);
      if (next !== setting.value) changes[setting.key] = next;
    }
    if (Object.keys(changes).length === 0) {
      notify("Nothing to save");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.settings.update(changes);
      notify("Settings saved");
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to save settings"));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setVerifyResult("");
    try {
      const result = await api.settings.verifyPayments();
      setVerifyResult(`${providerLabel(result.provider)} accepted the saved key.`);
    } catch (caught) {
      setVerifyResult(errorMessage(caught, "Verification failed"));
    }
  };

  return (
    <>
      <InlineError message={error} onDismiss={() => setError("")} />
      {unreadable.length > 0 && (
        <div className="inline-error" role="alert">
          <span>
            <AlertTriangle size={13} /> {unreadable.map((setting) => setting.label).join(", ")} cannot be decrypted. Re-enter {unreadable.length === 1 ? "it" : "them"} below; online payments stay off until then.
          </span>
        </div>
      )}
      <section className="settings-grid">
        <article className="panel settings-card">
          <div className="panel-heading">
            <div>
              <h2>
                <CreditCard size={16} /> Online payments
              </h2>
              <p>Hosted checkout for website bookings. Keys are encrypted on the server and never shown again.</p>
            </div>
          </div>
          <fieldset className="provider-choice">
            <legend>Provider</legend>
            {providerOptions.map((option) => (
              <label key={option.value} className={provider === option.value ? "selected" : ""}>
                <input type="radio" name="provider" value={option.value} checked={provider === option.value} onChange={() => setProvider(option.value)} />
                {option.label}
              </label>
            ))}
          </fieldset>
          {secrets
            // Credentials for the selected provider, plus any saved ones so they can be cleared.
            .filter((setting) => setting.provider === provider || (setting.configured && setting.provider !== null))
            .map((setting) => (
              <SettingInput
                key={setting.key}
                setting={setting}
                value={values[setting.key] ?? ""}
                onChange={(value) => setValues((current) => ({ ...current, [setting.key]: value }))}
                clear={Boolean(cleared[setting.key])}
                onClear={(clear) => setCleared((current) => ({ ...current, [setting.key]: clear }))}
              />
            ))}
          <div className="webhook-url">
            <span>Webhook URL for the provider dashboard</span>
            {snapshot.environment.webhookUrl ? (
              <div className="secret-reveal">
                <code>{snapshot.environment.webhookUrl}</code>
                <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(snapshot.environment.webhookUrl ?? "")}>
                  Copy
                </button>
              </div>
            ) : (
              <small>PUBLIC_WEB_URL is not configured on the server, so online payments cannot be enabled yet.</small>
            )}
          </div>
          {initialProvider !== "none" && (
            <div className="verify-row">
              <button type="button" className="button-secondary" onClick={() => void verify()}>
                <ShieldCheck size={15} /> Check saved key with {providerLabel(initialProvider)}
              </button>
              {verifyResult && <span>{verifyResult}</span>}
            </div>
          )}
        </article>

        <article className="panel settings-card">
          <div className="panel-heading">
            <div>
              <h2>
                <SlidersHorizontal size={16} /> Booking and payment rules
              </h2>
              <p>Apply to staff and website bookings immediately.</p>
            </div>
          </div>
          {integers.map((setting) => (
            <SettingInput
              key={setting.key}
              setting={setting}
              value={values[setting.key] ?? ""}
              onChange={(value) => setValues((current) => ({ ...current, [setting.key]: value }))}
              clear={false}
              onClear={() => undefined}
            />
          ))}
        </article>
      </section>
      <div className="settings-footer">
        <small>
          Last changed{" "}
          {(() => {
            const latest = [...snapshot.settings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            return latest ? `${dateTimeLabel(latest.updatedAt)}${latest.updatedBy ? ` by ${latest.updatedBy}` : ""}` : "never";
          })()}
        </small>
        <button className="button-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}

export function SettingsSection({ notify }: SectionProps) {
  const [version, setVersion] = useState(0);
  const snapshot = useResource(() => api.settings.get(), String(version));
  if (!snapshot.data) return <InlineError message={snapshot.error} />;
  return (
    <SettingsForm
      key={version}
      snapshot={snapshot.data}
      notify={notify}
      onSaved={() => setVersion((current) => current + 1)}
    />
  );
}
