import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, type Category, type Connection, type Dashboard, type McpToken } from "../api";
import { CategoryPicker, ConnectionPicker } from "../pickers";
import { useI18n } from "../i18n";
import { Badge, CodeBlock, EmptyState, ErrorBanner, Modal, useFormat } from "../ui";

const STATUS: Record<McpToken["status"], { label: string; tone: "ok" | "warn" | "error" }> = {
  active: { label: "Active", tone: "ok" },
  expired: { label: "Expired", tone: "warn" },
  revoked: { label: "Revoked", tone: "error" },
};

function toDateInput(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface FormState {
  name: string;
  connectionIds: string[];
  defaultConnectionId: string;
  readOnly: boolean;
  allowedIps: string;
  categories: string[] | null;
  expires: string;
}

function TokenForm({
  initial,
  connections,
  categories,
  onClose,
  onSaved,
}: {
  initial?: McpToken;
  connections: Connection[];
  categories: Category[];
  onClose: () => void;
  onSaved: (secret?: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>({
    name: initial?.name ?? "",
    connectionIds: initial?.connectionIds ?? (connections[0] ? [connections[0].id] : []),
    defaultConnectionId: initial?.defaultConnectionId ?? connections[0]?.id ?? "",
    readOnly: initial?.readOnly ?? true,
    allowedIps: initial?.allowedIps.join("\n") ?? "",
    categories: initial?.categories ?? null,
    expires: toDateInput(initial?.expiresAt ?? null),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.connectionIds.length) {
      setError("Select at least one connection.");
      return;
    }
    if (form.categories && !form.categories.length) {
      setError("Select at least one category, or “All exposed categories”.");
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      name: form.name,
      connectionIds: form.connectionIds,
      defaultConnectionId: form.defaultConnectionId,
      readOnly: form.readOnly,
      allowedIps: form.allowedIps.split(/[\s,]+/).filter(Boolean),
      categories: form.categories,
      // End of the chosen day, local time.
      expiresAt: form.expires ? new Date(`${form.expires}T23:59:59`).getTime() : null,
    };
    try {
      if (initial) {
        await api("PATCH", `/tokens/${initial.id}`, body);
        onSaved();
      } else {
        const created = await api<{ secret: string }>("POST", "/tokens", body);
        onSaved(created.secret);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial ? t("Edit “{name}”", { name: initial.name }) : t("New MCP token")}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="button button-primary" form="token-form" disabled={busy}>
            {busy ? t("Saving…") : initial ? t("Save") : t("Generate token")}
          </button>
        </>
      }
    >
      <form id="token-form" className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <label className="field">
          <span>{t("Name")}</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("Claude Code – laptop")} required autoFocus />
        </label>
        <fieldset className="field">
          <legend>{t("Infomaniak connections")}</legend>
          <ConnectionPicker
            connections={connections}
            value={form.connectionIds}
            defaultId={form.defaultConnectionId}
            onChange={(connectionIds, defaultConnectionId) => setForm({ ...form, connectionIds, defaultConnectionId })}
          />
          <small>{t("The AI switches between connections with the “connection” parameter; if none is given, the default connection is used.")}</small>
        </fieldset>
        <label className="checkbox">
          <input type="checkbox" checked={form.readOnly} onChange={(e) => setForm({ ...form, readOnly: e.target.checked })} />
          <span>
            {t("Read-only")}
            <small>{t("The write tool (POST/PUT/PATCH/DELETE) is not exposed to this token.")}</small>
          </span>
        </label>
        <fieldset className="field">
          <legend>{t("Allowed API categories")}</legend>
          <CategoryPicker categories={categories} value={form.categories} onChange={(categories) => setForm({ ...form, categories })} />
        </fieldset>
        <div className="form-row">
          <label className="field">
            <span>{t("Allowed IP addresses")}</span>
            <textarea rows={3} value={form.allowedIps} onChange={(e) => setForm({ ...form, allowedIps: e.target.value })} placeholder={t("One per line, e.g. 203.0.113.4\n10.0.0.0/8")} />
            <small>{t("Empty = all. IPv4/IPv6 and CIDR ranges.")}</small>
          </label>
          <label className="field">
            <span>{t("Expiry")}</span>
            <input type="date" value={form.expires} min={toDateInput(Date.now())} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
            <small>{t("Empty = never expires.")}</small>
          </label>
        </div>
      </form>
    </Modal>
  );
}

function SecretModal({ secret, mcpUrl, onClose }: { secret: string; mcpUrl: string; onClose: () => void }) {
  const { t } = useI18n();
  const claudeCode = `claude mcp add --transport http infomaniak ${mcpUrl} \\\n  --header "Authorization: Bearer ${secret}"`;
  const json = JSON.stringify(
    { mcpServers: { infomaniak: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${secret}` } } } },
    null,
    2,
  );
  return (
    <Modal
      title={t("MCP token created")}
      onClose={onClose}
      footer={
        <button className="button button-primary" onClick={onClose}>
          {t("I have copied the token")}
        </button>
      }
    >
      <div className="banner banner-warn">{t("Copy this token now: it will never be shown again.")}</div>
      <CodeBlock code={secret} />
      <h3>Claude Code</h3>
      <CodeBlock code={claudeCode} />
      <h3>{t("JSON configuration (Cursor, VS Code, Claude Desktop…)")}</h3>
      <CodeBlock code={json} />
    </Modal>
  );
}

export function TokensPage() {
  const { t } = useI18n();
  const { formatDate, formatRelative } = useFormat();
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [mcpUrl, setMcpUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpToken | "new" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api<McpToken[]>("GET", "/tokens"),
      api<Connection[]>("GET", "/connections"),
      api<Category[]>("GET", "/categories"),
      api<Dashboard>("GET", "/dashboard"),
    ]).then(([t, c, cat, d]) => {
      setTokens(t);
      setConnections(c);
      setCategories(cat);
      setMcpUrl(d.mcpUrl);
    }, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const noConnection = connections.length === 0;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("MCP tokens")}</h1>
          <p>{t("Tokens handed to MCP clients. Each one acts through an Infomaniak connection, with its own restrictions.")}</p>
        </div>
        <button className="button button-primary" onClick={() => setEditing("new")} disabled={noConnection} title={noConnection ? t("Create a connection first") : undefined}>
          {t("+ New token")}
        </button>
      </header>
      <ErrorBanner error={error} />

      {tokens && !tokens.length && (
        <EmptyState title={t("No MCP tokens")}>
          {noConnection ? (
            <p>
              {t("Start by")} <a href="#/connections">{t("adding an Infomaniak connection")}</a>.
            </p>
          ) : (
            <button className="button button-primary" onClick={() => setEditing("new")}>
              {t("Generate a token")}
            </button>
          )}
        </EmptyState>
      )}

      {tokens && tokens.length > 0 && (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>{t("Token")}</th>
                <th>{t("Connections")}</th>
                <th>{t("Permissions")}</th>
                <th>{t("Restrictions")}</th>
                <th>{t("Last used")}</th>
                <th aria-label={t("Actions")} />
              </tr>
            </thead>
            <tbody>
              {tokens.map((tk) => (
                <tr key={tk.id} className={tk.status === "active" ? "" : "row-muted"}>
                  <td>
                    <div className="inline">
                      <strong>{tk.name}</strong>
                      <Badge tone={STATUS[tk.status].tone}>{t(STATUS[tk.status].label)}</Badge>
                    </div>
                    <code className="muted">{tk.tokenPrefix}…</code>
                  </td>
                  <td>
                    {tk.connections.map((c) => (
                      <div key={c.id} className={c.id === tk.defaultConnectionId ? "" : "muted"}>
                        {c.name ?? "—"}
                        {c.id === tk.defaultConnectionId && tk.connections.length > 1 && <span title={t("Default connection")}> ★</span>}
                      </div>
                    ))}
                  </td>
                  <td>
                    {tk.readOnly ? <Badge tone="info">{t("Read-only")}</Badge> : <Badge>{t("Read/write")}</Badge>}
                    <div className="chips-inline">
                      {tk.categories === null ? (
                        <span className="muted">{t("All categories")}</span>
                      ) : (
                        tk.categories.map((c) => (
                          <span key={c} className="chip chip-small">
                            {c}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="muted">
                    <div>{t("IP: {ips}", { ips: tk.allowedIps.length ? tk.allowedIps.join(", ") : t("all") })}</div>
                    <div>{t("Expires: {date}", { date: tk.expiresAt ? formatDate(tk.expiresAt) : t("never") })}</div>
                  </td>
                  <td className="muted">
                    {formatRelative(tk.lastUsedAt)}
                    {tk.lastUsedIp && <div>{tk.lastUsedIp}</div>}
                  </td>
                  <td className="actions">
                    {tk.status !== "revoked" && (
                      <button className="button button-small" onClick={() => setEditing(tk)}>
                        {t("Edit")}
                      </button>
                    )}
                    {tk.status !== "revoked" ? (
                      <button
                        className="button button-small button-danger"
                        onClick={() =>
                          window.confirm(t("Revoke “{name}”? Clients using it will lose access immediately.", { name: tk.name })) &&
                          act(() => api("POST", `/tokens/${tk.id}/revoke`))
                        }
                      >
                        {t("Revoke")}
                      </button>
                    ) : (
                      <button
                        className="button button-small"
                        onClick={() => window.confirm(t("Permanently delete “{name}”?", { name: tk.name })) && act(() => api("DELETE", `/tokens/${tk.id}`))}
                      >
                        {t("Delete")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <TokenForm
          initial={editing === "new" ? undefined : editing}
          connections={connections}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={(newSecret) => {
            setEditing(null);
            if (newSecret) setSecret(newSecret);
            load();
          }}
        />
      )}
      {secret && <SecretModal secret={secret} mcpUrl={mcpUrl} onClose={() => setSecret(null)} />}
    </>
  );
}
