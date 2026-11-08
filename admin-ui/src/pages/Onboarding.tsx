import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, type Connection, type Dashboard, type OAuthOverview, type SettingsView } from "../api";
import { AccessFields, OAuthFields, SecurityFields, type SettingsDraft, draftFrom, patchFrom } from "../settings-forms";
import { CodeBlock, ErrorBanner, StatusDot } from "../ui";
import { LanguageToggle, useI18n } from "../i18n";
import { Logo } from "../Logo";
import { OrganisationSelect } from "./Connections";

const STEPS = [
  { id: "admin", label: "Admin account" },
  { id: "access", label: "Access & security" },
  { id: "connection", label: "Infomaniak connection" },
  { id: "oauth", label: "OAuth" },
  { id: "token", label: "MCP token" },
  { id: "done", label: "Done" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

function StepFrame({
  title,
  intro,
  error,
  children,
  onBack,
  onSkip,
  primary,
}: {
  title: string;
  intro: ReactNode;
  error?: string | null;
  children: ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  primary: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="wizard-step">
      <h1>{title}</h1>
      <div className="wizard-intro">{intro}</div>
      <ErrorBanner error={error ?? null} />
      {children}
      <footer className="wizard-actions">
        {onBack && (
          <button type="button" className="button button-ghost" onClick={onBack}>
            {t("← Back")}
          </button>
        )}
        <span className="spacer" />
        {onSkip && (
          <button type="button" className="button" onClick={onSkip}>
            {t("Skip this step")}
          </button>
        )}
        {primary}
      </footer>
    </section>
  );
}

function AdminStep({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/setup/admin", { setupCode, password });
      onDone();
    } catch (err) {
      const message = (err as Error).message;
      setError(message === "Invalid setup code." ? "Incorrect setup code." : message);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <StepFrame
        title={t("Welcome 👋")}
        intro={
          <p>
            {t("Let's configure your Infomaniak MCP server. To begin, enter the")} <strong>{t("setup code")}</strong>{" "}
            {t("shown in the server logs")} (<code>podman logs infomaniak-mcp-server</code>) {t("and choose the admin password.")}
          </p>
        }
        error={error}
        primary={
          <button className="button button-primary" disabled={busy}>
            {busy ? t("Creating…") : t("Create admin account")}
          </button>
        }
      >
        <div className="form">
          <label className="field">
            <span>{t("Setup code")}</span>
            <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoFocus autoComplete="off" required placeholder={t("e.g. 3f9a1c2b7d04")} />
          </label>
          <div className="form-row">
            <label className="field">
              <span>{t("Admin password")}</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required />
              <small>{t("At least 12 characters.")}</small>
            </label>
            <label className="field">
              <span>{t("Confirm password")}</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
          </div>
        </div>
      </StepFrame>
    </form>
  );
}

function SettingsStep({
  sections,
  title,
  intro,
  extra,
  onBack,
  onDone,
}: {
  sections: ("access" | "security" | "oauth")[];
  title: string;
  intro: ReactNode;
  extra?: (view: SettingsView) => ReactNode;
  onBack?: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SettingsView>("GET", "/settings").then((v) => {
      setView(v);
      setDraft(draftFrom(v));
    }, (e) => setError(e.message));
  }, []);

  const save = async () => {
    if (!view || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const patch = patchFrom(draft, view, sections);
      if (Object.keys(patch).length) await api("PUT", "/settings", patch);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title={title}
      intro={intro}
      error={error}
      onBack={onBack}
      primary={
        <button className="button button-primary" onClick={save} disabled={busy || !draft}>
          {busy ? t("Saving…") : t("Continue")}
        </button>
      }
    >
      {view && draft && (
        <>
          {sections.includes("access") && <AccessFields view={view} draft={draft} onChange={setDraft} />}
          {sections.includes("security") && (
            <>
              <h3>{t("Security")}</h3>
              <SecurityFields view={view} draft={draft} onChange={setDraft} />
            </>
          )}
          {sections.includes("oauth") && <OAuthFields view={view} draft={draft} onChange={setDraft} />}
          {extra?.(view)}
        </>
      )}
    </StepFrame>
  );
}

function ConnectionStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [created, setCreated] = useState<Connection | null>(null);
  const [defaultAccountId, setDefaultAccountId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Connection[]>("GET", "/connections").then(setConnections, (e) => setError(e.message));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const connection = await api<Connection>("POST", "/connections", { name, token });
      setCreated(await api<Connection>("POST", `/connections/${connection.id}/test`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (created && defaultAccountId !== created.defaultAccountId) {
      try {
        await api("PATCH", `/connections/${created.id}`, { defaultAccountId });
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    onDone();
  };

  const existing = connections?.length ? connections : null;
  return (
    <StepFrame
      title={t("First Infomaniak connection")}
      intro={
        <p>
          {t("A connection is an Infomaniak API token the server uses on behalf of MCP tokens (your company, a client…). Create the token in the")}{" "}
          <a href="https://manager.infomaniak.com/v3/ng/accounts/token/list" target="_blank" rel="noreferrer">
            {t("Infomaniak Manager")}
          </a>{" "}
          {t("with at least the")} <code>accounts</code>
          {t(" scope, plus those of the products to manage")} (<code>domain</code>, <code>dns</code>, <code>drive</code>,{" "}
          <code>mail</code>…).
        </p>
      }
      error={error}
      onBack={onBack}
      onSkip={!created && !existing ? onDone : undefined}
      primary={
        created || existing ? (
          <button className="button button-primary" onClick={finish}>
            {t("Continue")}
          </button>
        ) : (
          <button className="button button-primary" form="wizard-connection" disabled={busy}>
            {busy ? t("Testing…") : t("Create and test")}
          </button>
        )
      }
    >
      {existing && !created && (
        <ul className="status-list">
          {existing.map((c) => (
            <li key={c.id}>
              <StatusDot ok={c.lastCheck?.ok} />
              <strong>{c.name}</strong>
              <span className="muted">{c.lastCheck?.detail ?? t("Never tested")}</span>
            </li>
          ))}
        </ul>
      )}
      {!existing && !created && (
        <form id="wizard-connection" className="form" onSubmit={create}>
          <div className="form-row">
            <label className="field">
              <span>{t("Name")}</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("My company, Customer A…")} required autoFocus />
            </label>
            <label className="field">
              <span>{t("Infomaniak API token")}</span>
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
              <small>{t("Encrypted at rest, never shown again.")}</small>
            </label>
          </div>
        </form>
      )}
      {created && (
        <div className="form">
          <div className={`banner ${created.lastCheck?.ok ? "banner-info" : "banner-error"}`}>
            <StatusDot ok={created.lastCheck?.ok} /> <strong>{created.name}</strong>: {created.lastCheck?.detail}
          </div>
          {created.lastCheck?.ok && <OrganisationSelect connectionId={created.id} value={defaultAccountId} onChange={setDefaultAccountId} />}
          {!created.lastCheck?.ok && <p className="hint">{t("You can fix the token later in “Infomaniak connections”.")}</p>}
        </div>
      )}
    </StepFrame>
  );
}

function TokenStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [mcpUrl, setMcpUrl] = useState("");
  const [name, setName] = useState("Claude Code");
  const [readOnly, setReadOnly] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<Connection[]>("GET", "/connections"), api<Dashboard>("GET", "/dashboard")]).then(([c, d]) => {
      setConnections(c);
      setMcpUrl(d.mcpUrl);
    }, (e) => setError(e.message));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!connections?.length) return;
    setBusy(true);
    setError(null);
    try {
      const ids = connections.map((c) => c.id);
      const res = await api<{ secret: string }>("POST", "/tokens", { name, readOnly, connectionIds: ids, defaultConnectionId: ids[0] });
      setSecret(res.secret);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const none = connections !== null && !connections.length;
  return (
    <StepFrame
      title={t("First MCP token")}
      intro={<p>{t("The token you will paste into Claude Code (or another MCP client). It grants access to your Infomaniak connections.")}</p>}
      error={error}
      onBack={onBack}
      onSkip={!secret ? onDone : undefined}
      primary={
        secret || none ? (
          <button className="button button-primary" onClick={onDone}>
            {t("Continue")}
          </button>
        ) : (
          <button className="button button-primary" form="wizard-token" disabled={busy || !connections}>
            {busy ? t("Generating…") : t("Generate token")}
          </button>
        )
      }
    >
      {none && <p className="banner banner-info">{t("No Infomaniak connections: you can create your tokens later from the “MCP tokens” page.")}</p>}
      {!none && !secret && (
        <form id="wizard-token" className="form" onSubmit={create}>
          <label className="field">
            <span>{t("Name")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            <span>
              {t("Read-only")}
              <small>{t("Ideal for a first try. Finer restrictions (categories, IP, expiry) are available in “MCP tokens”.")}</small>
            </span>
          </label>
        </form>
      )}
      {secret && (
        <>
          <div className="banner banner-warn">{t("Copy this token now: it will never be shown again.")}</div>
          <CodeBlock code={secret} />
          <h3>Claude Code</h3>
          <CodeBlock code={`claude mcp add --transport http infomaniak ${mcpUrl} \\\n  --header "Authorization: Bearer ${secret}"`} />
        </>
      )}
    </StepFrame>
  );
}

export function Onboarding({ needsAdmin, onFinished }: { needsAdmin: boolean; onFinished: () => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<StepId>(needsAdmin ? "admin" : "access");
  const [busy, setBusy] = useState(false);
  const steps = STEPS.filter((s) => needsAdmin || s.id !== "admin");
  const index = steps.findIndex((s) => s.id === step);
  const go = (offset: number) => setStep(steps[Math.max(0, index + offset)].id);
  // No way back from the first step shown (the admin account, once created, is not a step to return to).
  const back = index > 0 && steps[index - 1].id !== "admin" ? () => go(-1) : undefined;

  const finish = async () => {
    setBusy(true);
    await api("POST", "/setup/complete");
    onFinished();
  };

  return (
    <div className="wizard">
      <header className="wizard-header">
        <Logo className="brand-mark" size={56} />
        <div>
          <h1>Infomaniak MCP Server</h1>
          <p>
            {t("Initial setup · step {current} of {total} · everything can be changed later.", { current: index + 1, total: steps.length })}
          </p>
        </div>
        <LanguageToggle />
      </header>
      <ol className="wizard-progress" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
        {steps.map((s, i) => (
          <li key={s.id} className={i < index ? "done" : i === index ? "current" : ""}>
            <span className="wizard-dot">{i < index ? "✓" : i + 1}</span>
            <span className="wizard-label">{t(s.label)}</span>
          </li>
        ))}
      </ol>
      <div className="wizard-card">
        {step === "admin" && <AdminStep onDone={() => go(1)} />}
        {step === "access" && (
          <SettingsStep
            sections={["access", "security"]}
            title={t("Access & security")}
            intro={<p>{t("These settings are stored in the database and can be changed at any time in “Settings”, without a restart.")}</p>}
            onBack={back}
            onDone={() => go(1)}
          />
        )}
        {step === "connection" && <ConnectionStep onBack={() => go(-1)} onDone={() => go(1)} />}
        {step === "oauth" && (
          <SettingsStep
            sections={["oauth"]}
            title={t("Sign in with Infomaniak (OAuth)")}
            intro={
              <p>
                {t(
                  "Optional. Lets claude.ai and Claude Desktop users sign in with their Infomaniak account, with no token to copy. Who gets what is then configured in “OAuth access”.",
                )}
              </p>
            }
            extra={() => <OAuthPolicyHint />}
            onBack={() => go(-1)}
            onDone={() => go(1)}
          />
        )}
        {step === "token" && <TokenStep onBack={() => go(-1)} onDone={() => go(1)} />}
        {step === "done" && (
          <StepFrame
            title={t("All set 🎉")}
            intro={
              <ul className="check-list">
                <li className="on">{t("The MCP server is configured; everything can still be changed from the portal.")}</li>
                <li className="on">{t("Add more connections (clients, organisations) in “Infomaniak connections”.")}</li>
                <li className="on">{t("Restrict the exposed API categories in “Tool exposure”.")}</li>
              </ul>
            }
            onBack={() => go(-1)}
            primary={
              <button className="button button-primary" onClick={finish} disabled={busy}>
                {t("Open the dashboard")}
              </button>
            }
          >
            {null}
          </StepFrame>
        )}
      </div>
    </div>
  );
}

function OAuthPolicyHint() {
  const { t } = useI18n();
  const [overview, setOverview] = useState<OAuthOverview | null>(null);
  useEffect(() => {
    api<OAuthOverview>("GET", "/oauth").then(setOverview, () => undefined);
  }, []);
  if (!overview) return null;
  return (
    <p className="hint">
      {t("By default, a person who signs in acts with their own Infomaniak login only{status}. To give them your shared connections, create a rule in “OAuth access”.", {
        status: overview.defaultPolicy === "deny" ? t(" (currently: denied without a rule)") : "",
      })}
    </p>
  );
}
