import { type ReactNode, useState } from "react";
import type { SettingKey, SettingsPatch, SettingsView } from "./api";
import { useI18n } from "./i18n";
import { CodeBlock } from "./ui";

/** Form state shared by the onboarding and the settings page; only changed fields are sent. */
export interface SettingsDraft {
  publicUrl: string;
  trustProxy: string;
  readOnly: boolean;
  maxResponseChars: string;
  oauthEnabled: boolean;
  oauthClientId: string;
  /** Empty keeps the stored secret. */
  oauthClientSecret: string;
  oauthScopes: string;
}

export function draftFrom(view: SettingsView): SettingsDraft {
  const v = view.values;
  return {
    publicUrl: v.publicUrl ?? "",
    trustProxy: v.trustProxy ?? "",
    readOnly: v.readOnly,
    maxResponseChars: String(v.maxResponseChars),
    oauthEnabled: Boolean(v.oauthClientId),
    oauthClientId: v.oauthClientId ?? "",
    oauthClientSecret: "",
    oauthScopes: v.oauthScopes.join(" "),
  };
}

/** The changes between a draft and the stored settings, leaving out settings fixed by the environment. */
export function patchFrom(draft: SettingsDraft, view: SettingsView, sections: ("access" | "security" | "oauth")[]): SettingsPatch {
  const v = view.values;
  const free = (key: SettingKey) => !view.locked[key];
  const patch: SettingsPatch = {};
  if (sections.includes("access")) {
    if (free("publicUrl") && draft.publicUrl.trim() !== (v.publicUrl ?? "")) patch.publicUrl = draft.publicUrl.trim() || null;
    if (free("trustProxy") && draft.trustProxy.trim() !== (v.trustProxy ?? "")) patch.trustProxy = draft.trustProxy.trim() || null;
  }
  if (sections.includes("security")) {
    if (free("readOnly") && draft.readOnly !== v.readOnly) patch.readOnly = draft.readOnly;
    if (free("maxResponseChars") && Number(draft.maxResponseChars) !== v.maxResponseChars) patch.maxResponseChars = Number(draft.maxResponseChars);
  }
  if (sections.includes("oauth")) {
    const clientId = draft.oauthEnabled ? draft.oauthClientId.trim() : "";
    if (free("oauthClientId") && clientId !== (v.oauthClientId ?? "")) patch.oauthClientId = clientId || null;
    if (free("oauthClientSecret") && draft.oauthEnabled && draft.oauthClientSecret.trim()) patch.oauthClientSecret = draft.oauthClientSecret.trim();
    const scopes = draft.oauthScopes.split(/[\s,]+/).filter(Boolean);
    if (free("oauthScopes") && draft.oauthEnabled && scopes.join(" ") !== v.oauthScopes.join(" ")) {
      // Back to the defaults: clear the stored list.
      patch.oauthScopes = scopes.join(" ") === view.defaults.oauthScopes.join(" ") ? null : scopes;
    }
  }
  return patch;
}

function Locked({ variable }: { variable?: string }) {
  const { t } = useI18n();
  if (!variable) return null;
  return <small className="locked">🔒 {t("Set by the environment variable {variable}", { variable })}</small>;
}

function Field({ label, hint, locked, children }: { label: string; hint?: ReactNode; locked?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {locked ? <Locked variable={locked} /> : hint && <small>{hint}</small>}
    </label>
  );
}

interface SectionProps {
  view: SettingsView;
  draft: SettingsDraft;
  onChange: (draft: SettingsDraft) => void;
}

export function AccessFields({ view, draft, onChange }: SectionProps) {
  const { t } = useI18n();
  return (
    <div className="form-row">
      <Field
        label={t("Public URL of the MCP server")}
        locked={view.locked.publicUrl}
        hint={t("HTTPS origin through which clients reach the server, e.g. https://mcp.example.com. Required for OAuth and claude.ai; optional for local use.")}
      >
        <input value={draft.publicUrl} disabled={Boolean(view.locked.publicUrl)} onChange={(e) => onChange({ ...draft, publicUrl: e.target.value })} placeholder="https://mcp.example.com" />
      </Field>
      <TrustProxyField view={view} value={draft.trustProxy} onChange={(trustProxy) => onChange({ ...draft, trustProxy })} />
    </div>
  );
}

/** Common setups as presets; anything else (named ranges, CIDRs) goes through "Custom". */
const PROXY_PRESETS = [
  { value: "", label: "No reverse proxy" },
  { value: "1", label: "1 reverse proxy (Caddy, nginx, Traefik…)" },
  { value: "2", label: "2 proxies (e.g. CDN + reverse proxy)" },
];
const CUSTOM = "custom";

function TrustProxyField({ view, value, onChange }: { view: SettingsView; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const [custom, setCustom] = useState(() => !PROXY_PRESETS.some((p) => p.value === value));
  const locked = Boolean(view.locked.trustProxy);
  return (
    <Field
      label={t("Trusted reverse proxy")}
      locked={view.locked.trustProxy}
      hint={
        custom
          ? t("Express “trust proxy” value: a hop count, loopback / uniquelocal, or IPs and CIDR ranges separated by commas.")
          : t("Lets the server see the real client IP behind the proxy (used by token IP restrictions).")
      }
    >
      <select
        value={custom ? CUSTOM : value}
        disabled={locked}
        onChange={(e) => {
          const next = e.target.value;
          setCustom(next === CUSTOM);
          if (next !== CUSTOM) onChange(next);
        }}
      >
        {PROXY_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {t(p.label)}
          </option>
        ))}
        <option value={CUSTOM}>{t("Custom…")}</option>
      </select>
      {custom && (
        <input value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} placeholder="loopback, 10.0.0.0/8" autoFocus={!value} />
      )}
    </Field>
  );
}

export function SecurityFields({ view, draft, onChange }: SectionProps) {
  const { t } = useI18n();
  return (
    <div className="form">
      <label className="checkbox">
        <input type="checkbox" checked={draft.readOnly} disabled={Boolean(view.locked.readOnly)} onChange={(e) => onChange({ ...draft, readOnly: e.target.checked })} />
        <span>
          {t("Read-only for the whole server")}
          <small>{t("No client can modify any Infomaniak resource, whatever its permissions. Recommended to start with.")}</small>
          <Locked variable={view.locked.readOnly} />
        </span>
      </label>
      <Field
        label={t("Maximum response size (characters)")}
        locked={view.locked.maxResponseChars}
        hint={t("Longer responses are truncated to preserve the AI's context.")}
      >
        <input
          type="number"
          min={1000}
          max={1000000}
          step={1000}
          value={draft.maxResponseChars}
          disabled={Boolean(view.locked.maxResponseChars)}
          onChange={(e) => onChange({ ...draft, maxResponseChars: e.target.value })}
        />
      </Field>
    </div>
  );
}

export function OAuthFields({ view, draft, onChange }: SectionProps) {
  const { t } = useI18n();
  const lockedId = view.locked.oauthClientId;
  const callback = draft.publicUrl.trim() ? `${draft.publicUrl.trim().replace(/\/+$/, "")}/oauth/callback` : view.callbackUrl;
  return (
    <div className="form">
      <label className="checkbox">
        <input type="checkbox" checked={draft.oauthEnabled} disabled={Boolean(lockedId)} onChange={(e) => onChange({ ...draft, oauthEnabled: e.target.checked })} />
        <span>
          {t("Enable “Sign in with Infomaniak”")}
          <small>{t("For claude.ai, Claude Desktop and clients that discover authentication on their own.")}</small>
          <Locked variable={lockedId} />
        </span>
      </label>
      {draft.oauthEnabled && (
        <>
          <div className="steps-hint">
            <p>{t("1. In the Infomaniak Manager, create an OAuth application with this redirect URL:")}</p>
            {callback ? <CodeBlock code={callback} /> : <p className="banner banner-warn">{t("Enter the server's public URL first.")}</p>}
            <p>{t("2. Paste the application's client ID and secret here.")}</p>
          </div>
          <div className="form-row">
            <Field label={t("Client ID")} locked={lockedId}>
              <input value={draft.oauthClientId} disabled={Boolean(lockedId)} onChange={(e) => onChange({ ...draft, oauthClientId: e.target.value })} autoComplete="off" />
            </Field>
            <Field
              label={t("Client secret")}
              locked={view.locked.oauthClientSecret}
              hint={view.oauthClientSecretSet ? t("Saved and encrypted. Leave empty to keep it.") : t("Encrypted in the database, never shown again.")}
            >
              <input
                type="password"
                value={draft.oauthClientSecret}
                disabled={Boolean(view.locked.oauthClientSecret)}
                onChange={(e) => onChange({ ...draft, oauthClientSecret: e.target.value })}
                placeholder={view.oauthClientSecretSet ? "••••••••" : ""}
                autoComplete="off"
              />
            </Field>
          </div>
          <Field
            label={t("Scopes requested from Infomaniak")}
            locked={view.locked.oauthScopes}
            hint={t("Space-separated. openid and email are required for OAuth access rules.")}
          >
            <textarea rows={2} value={draft.oauthScopes} disabled={Boolean(view.locked.oauthScopes)} onChange={(e) => onChange({ ...draft, oauthScopes: e.target.value })} />
          </Field>
        </>
      )}
    </div>
  );
}
