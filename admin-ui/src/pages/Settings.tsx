import { type ReactNode, useEffect, useState } from "react";
import { api, type SettingsView } from "../api";
import { AccessFields, OAuthFields, SecurityFields, type SettingsDraft, draftFrom, patchFrom } from "../settings-forms";
import { useI18n } from "../i18n";
import { Badge, ErrorBanner } from "../ui";

type Section = "access" | "security" | "oauth";

function SettingsCard({
  title,
  section,
  view,
  onSaved,
  badge,
  children,
}: {
  title: string;
  section: Section;
  view: SettingsView;
  onSaved: (view: SettingsView) => void;
  badge?: ReactNode;
  children: (draft: SettingsDraft, setDraft: (d: SettingsDraft) => void) => ReactNode;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => draftFrom(view));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const patch = patchFrom(draft, view, [section]);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<SettingsView>("PUT", "/settings", patch);
      setDraft(draftFrom(next));
      onSaved(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <h2>{title}</h2>
        {badge}
      </div>
      <ErrorBanner error={error} />
      {children(draft, (d) => {
        setDraft(d);
        setSaved(false);
      })}
      <div className="card-actions">
        <button className="button button-primary" onClick={save} disabled={!dirty || busy}>
          {busy ? t("Saving…") : saved ? t("Saved ✓") : t("Save")}
        </button>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const { t } = useI18n();
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SettingsView>("GET", "/settings").then(setView, (e) => setError(e.message));
  }, []);

  if (!view) return <ErrorBanner error={error} />;
  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("Settings")}</h1>
          <p>
            {t(
              "Stored in the database and applied without a restart. A defined environment variable takes precedence, and the matching field is then locked.",
            )}
          </p>
        </div>
      </header>
      <SettingsCard title={t("Public access")} section="access" view={view} onSaved={setView}>
        {(draft, setDraft) => <AccessFields view={view} draft={draft} onChange={setDraft} />}
      </SettingsCard>
      <SettingsCard title={t("Security")} section="security" view={view} onSaved={setView}>
        {(draft, setDraft) => <SecurityFields view={view} draft={draft} onChange={setDraft} />}
      </SettingsCard>
      <SettingsCard
        title={t("OAuth “Sign in with Infomaniak”")}
        section="oauth"
        view={view}
        onSaved={setView}
        badge={view.oauthActive ? <Badge tone="ok">{t("Active")}</Badge> : <Badge>{t("Inactive")}</Badge>}
      >
        {(draft, setDraft) => <OAuthFields view={{ ...view, values: { ...view.values } }} draft={draft} onChange={setDraft} />}
      </SettingsCard>
    </>
  );
}
