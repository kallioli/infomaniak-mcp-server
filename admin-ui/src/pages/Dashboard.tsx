import { useEffect, useState } from "react";
import { api, type Dashboard } from "../api";
import { type Translate, useI18n } from "../i18n";
import { Badge, CodeBlock, ErrorBanner, StatusDot, useFormat } from "../ui";

function formatUptime(seconds: number, t: Translate): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? t("{d} d {h} h", { d, h }) : h ? t("{h} h {m} min", { h, m }) : t("{m} min", { m });
}

export function DashboardPage() {
  const { t, locale } = useI18n();
  const { formatRelative } = useFormat();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Dashboard>("GET", "/dashboard").then(setData, (e) => setError(e.message));
  }, []);

  if (!data) return <ErrorBanner error={error} />;
  const totalTokens = data.tokens.active + data.tokens.expired + data.tokens.revoked;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("Dashboard")}</h1>
          <p>{t("Overview of the Infomaniak MCP server.")}</p>
        </div>
        <Badge tone="ok">
          <StatusDot ok /> {t("Online · v{version}", { version: data.version })}
        </Badge>
      </header>

      <section className="stats">
        <div className="stat">
          <span className="stat-label">{t("API operations")}</span>
          <strong className="stat-value">{data.catalog.operations.toLocaleString(locale)}</strong>
          <span className="stat-sub">{t("Catalog from {date}", { date: new Date(data.catalog.generatedAt).toLocaleDateString(locale) })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t("Exposed categories")}</span>
          <strong className="stat-value">
            {data.categories.enabled}
            <small> / {data.categories.total}</small>
          </strong>
          <a className="stat-sub link" href="#/categories">
            {t("Manage exposure →")}
          </a>
        </div>
        <div className="stat">
          <span className="stat-label">{t("Active MCP tokens")}</span>
          <strong className="stat-value">
            {data.tokens.active}
            <small> / {totalTokens}</small>
          </strong>
          <span className="stat-sub">
            {t("{expired} expired · {revoked} revoked", { expired: data.tokens.expired, revoked: data.tokens.revoked })}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t("Uptime")}</span>
          <strong className="stat-value">{formatUptime(data.uptimeSeconds, t)}</strong>
          <span className="stat-sub">{t("since last start")}</span>
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>{t("Infomaniak connections")}</h2>
          {data.connections.length ? (
            <ul className="status-list">
              {data.connections.map((c) => (
                <li key={c.id}>
                  <StatusDot ok={c.lastCheck?.ok} title={c.lastCheck?.detail ?? t("Never tested")} />
                  <strong>{c.name}</strong>
                  <span className="muted">
                    {c.lastCheck ? `${c.lastCheck.detail} · ${formatRelative(c.lastCheck.at)}` : t("Never tested")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {t("No connections.")} <a href="#/connections">{t("Add an Infomaniak API token")}</a> {t("to issue MCP tokens.")}
            </p>
          )}
        </section>

        <section className="card">
          <h2>{t("MCP authentication")}</h2>
          <ul className="check-list">
            <li className={data.auth.managedTokens ? "on" : "off"}>{t("MCP tokens managed here (imkt_ prefix)")}</li>
            <li className={data.auth.oauth ? "on" : "off"}>
              {t("OAuth “Sign in with Infomaniak”")} {data.auth.oauth && <a href="#/oauth">{t("(access rules)")}</a>}
            </li>
            <li className={data.auth.passthrough ? "on" : "off"}>{t("Infomaniak API token passed by the client")}</li>
            <li className={data.auth.apiKeys ? "on" : "off"}>{t("Static API keys (MCP_API_KEYS)")}</li>
          </ul>
          {data.readOnly && <Badge tone="warn">{t("Global read-only mode (INFOMANIAK_READ_ONLY)")}</Badge>}
        </section>
      </div>

      <section className="card">
        <h2>{t("MCP endpoint")}</h2>
        <p className="muted">{t("Enter it in your MCP client, with an MCP token in the Authorization header.")}</p>
        <CodeBlock code={data.mcpUrl} />
      </section>
    </>
  );
}
