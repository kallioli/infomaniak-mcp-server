import { type FormEvent, useEffect, useState } from "react";
import { type AuthState, api, setUnauthorizedHandler } from "./api";
import { CategoriesPage } from "./pages/Categories";
import { ConnectionsPage } from "./pages/Connections";
import { DashboardPage } from "./pages/Dashboard";
import { OAuthPage } from "./pages/OAuth";
import { Onboarding } from "./pages/Onboarding";
import { SettingsPage } from "./pages/Settings";
import { TokensPage } from "./pages/Tokens";
import { LanguageToggle, useI18n } from "./i18n";
import { Logo } from "./Logo";
import { ErrorBanner } from "./ui";

const PAGES = [
  { id: "dashboard", label: "Dashboard", icon: "◧", component: DashboardPage },
  { id: "connections", label: "Infomaniak connections", icon: "⇄", component: ConnectionsPage },
  { id: "tokens", label: "MCP tokens", icon: "⚿", component: TokensPage },
  { id: "oauth", label: "OAuth access", icon: "⚷", component: OAuthPage },
  { id: "categories", label: "Tool exposure", icon: "▦", component: CategoriesPage },
  { id: "settings", label: "Settings", icon: "⚙", component: SettingsPage },
] as const;

type PageId = (typeof PAGES)[number]["id"];

function currentPage(): PageId {
  const id = window.location.hash.replace(/^#\/?/, "");
  return (PAGES.find((p) => p.id === id)?.id ?? "dashboard") as PageId;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/auth/login", { password });
      onLogin();
    } catch (err) {
      setError((err as Error).message === "Invalid password." ? "Incorrect password." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <LanguageToggle className="corner-toggle" />
      <form className="login-card" onSubmit={submit}>
        <div className="brand brand-large">
          <Logo className="brand-mark" size={44} />
          <div>
            <strong>Infomaniak MCP Server</strong>
            <span>{t("Admin portal")}</span>
          </div>
        </div>
        <ErrorBanner error={error} />
        <label className="field">
          <span>{t("Admin password")}</span>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="button button-primary button-block" disabled={busy || !password}>
          {busy ? t("Signing in…") : t("Sign in")}
        </button>
        <p className="hint">{t("The password chosen during initial setup (or set by ADMIN_PASSWORD).")}</p>
      </form>
    </div>
  );
}

export function App() {
  const { t } = useI18n();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [page, setPage] = useState<PageId>(currentPage);

  const refresh = () =>
    api<AuthState>("GET", "/auth/me").then(setAuth, () => setAuth({ authenticated: false, needsSetup: false, setupCompleted: true }));
  const setAuthenticated = (authenticated: boolean) => (authenticated ? refresh() : setAuth((a) => a && { ...a, authenticated: false }));

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthenticated(false));
    refresh();
    const onHash = () => setPage(currentPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (auth === null) return <div className="splash">{t("Loading…")}</div>;
  // First launch: the onboarding creates the admin account, then walks through the essential settings.
  if (auth.needsSetup) return <Onboarding needsAdmin onFinished={refresh} />;
  if (!auth.authenticated) return <Login onLogin={() => setAuthenticated(true)} />;
  if (!auth.setupCompleted) return <Onboarding needsAdmin={false} onFinished={refresh} />;

  const Page = PAGES.find((p) => p.id === page)!.component;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo className="brand-mark" size={34} />
          <div>
            <strong>Infomaniak MCP Server</strong>
            <span>{t("Administration")}</span>
          </div>
        </div>
        <nav>
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={p.id === page ? "nav-link active" : "nav-link"}>
              <span className="nav-icon" aria-hidden>
                {p.icon}
              </span>
              {t(p.label)}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <LanguageToggle />
          <button
            className="button button-ghost logout"
            onClick={async () => {
              await api("POST", "/auth/logout");
              setAuthenticated(false);
            }}
          >
            {t("Sign out")}
          </button>
        </div>
      </aside>
      <main className="content">
        <Page />
      </main>
    </div>
  );
}
