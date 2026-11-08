import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, type Connection, type Organisation } from "../api";
import { useI18n } from "../i18n";
import { Badge, EmptyState, ErrorBanner, Modal, StatusDot, useFormat } from "../ui";

interface FormState {
  name: string;
  description: string;
  token: string;
  readOnly: boolean;
  defaultAccountId: number | null;
}

/** Picks the organisation used when the AI does not name one; options come live from Infomaniak. */
export function OrganisationSelect({ connectionId, value, onChange }: { connectionId: string; value: number | null; onChange: (v: number | null) => void }) {
  const { t } = useI18n();
  const [organisations, setOrganisations] = useState<Organisation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Organisation[]>("GET", `/connections/${connectionId}/accounts`).then(setOrganisations, (e) => setError(e.message));
  }, [connectionId]);

  const known = organisations?.some((o) => o.id === value);
  return (
    <label className="field">
      <span>{t("Default organisation")}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={!organisations && !error}>
        <option value="">{t("None (the AI sets account_id when needed)")}</option>
        {organisations?.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} — {o.id}
          </option>
        ))}
        {value !== null && !known && <option value={value}>{t("Organisation {id}", { id: value })}</option>}
      </select>
      <small>
        {error
          ? t("List unavailable: {error}", { error: t(error) })
          : !organisations
            ? t("Loading organisations…")
            : t("Injected into the account_id / account parameters of calls that do not specify one.")}
      </small>
    </label>
  );
}

function ConnectionForm({ initial, onClose, onSaved }: { initial?: Connection; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    token: "",
    readOnly: initial?.readOnly ?? false,
    defaultAccountId: initial?.defaultAccountId ?? null,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, token: form.token || undefined };
      if (initial) await api("PATCH", `/connections/${initial.id}`, body);
      else {
        const created = await api<Connection>("POST", "/connections", body);
        await api("POST", `/connections/${created.id}/test`);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial ? t("Edit “{name}”", { name: initial.name }) : t("New Infomaniak connection")}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="button button-primary" form="connection-form" disabled={busy}>
            {busy ? t("Saving…") : initial ? t("Save") : t("Create and test")}
          </button>
        </>
      }
    >
      <form id="connection-form" className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <label className="field">
          <span>{t("Name")}</span>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("My company, Customer A…")} required autoFocus />
        </label>
        <label className="field">
          <span>{t("Description")}</span>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t("Optional")} />
        </label>
        <label className="field">
          <span>{t("Infomaniak API token")}</span>
          <input
            type="password"
            autoComplete="off"
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value })}
            placeholder={initial ? t("Leave empty to keep ••••{hint}", { hint: initial.tokenHint }) : t("Paste the token")}
            required={!initial}
          />
          <small>
            {t("Create it in the")}{" "}
            <a href="https://manager.infomaniak.com/v3/ng/accounts/token/list" target="_blank" rel="noreferrer">
              {t("Infomaniak Manager")}
            </a>{" "}
            {t("with the required scopes. It is encrypted at rest and never shown again.")}
          </small>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={form.readOnly} onChange={(e) => setForm({ ...form, readOnly: e.target.checked })} />
          <span>
            {t("Read-only")}
            <small>{t("All MCP tokens of this connection will only be able to make GET requests.")}</small>
          </span>
        </label>
        {initial ? (
          <OrganisationSelect connectionId={initial.id} value={form.defaultAccountId} onChange={(defaultAccountId) => setForm({ ...form, defaultAccountId })} />
        ) : (
          <p className="hint">{t("The default organisation can be chosen after creation, by editing the connection.")}</p>
        )}
      </form>
    </Modal>
  );
}

export function ConnectionsPage() {
  const { t } = useI18n();
  const { formatRelative } = useFormat();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Connection | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Connection[]>("GET", "/connections").then(setConnections, (e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const test = async (c: Connection) => {
    setTesting(c.id);
    try {
      await api("POST", `/connections/${c.id}/test`);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const remove = async (c: Connection) => {
    if (!window.confirm(t("Delete the connection “{name}”?", { name: c.name }))) return;
    try {
      await api("DELETE", `/connections/${c.id}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("Infomaniak connections")}</h1>
          <p>{t("Infomaniak API tokens used by the server on behalf of MCP tokens.")}</p>
        </div>
        <button className="button button-primary" onClick={() => setEditing("new")}>
          {t("+ New connection")}
        </button>
      </header>
      <ErrorBanner error={error} />

      {connections && !connections.length && (
        <EmptyState title={t("No connections")}>
          <p>{t("Add an Infomaniak API token (per account or per client) to be able to issue MCP tokens.")}</p>
          <button className="button button-primary" onClick={() => setEditing("new")}>
            {t("Add a connection")}
          </button>
        </EmptyState>
      )}

      {connections && connections.length > 0 && (
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>{t("Connection")}</th>
                <th>{t("Token")}</th>
                <th>{t("Access")}</th>
                <th>{t("Default organisation")}</th>
                <th>{t("Last test")}</th>
                <th>{t("MCP tokens")}</th>
                <th aria-label={t("Actions")} />
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.description && <div className="muted">{c.description}</div>}
                  </td>
                  <td>
                    <code>••••{c.tokenHint}</code>
                  </td>
                  <td>{c.readOnly ? <Badge tone="info">{t("Read-only")}</Badge> : <Badge>{t("Read/write")}</Badge>}</td>
                  <td>{c.defaultAccountId ? <code>{c.defaultAccountId}</code> : <span className="muted">—</span>}</td>
                  <td>
                    <div className="inline">
                      <StatusDot ok={c.lastCheck?.ok} />
                      <span>{c.lastCheck ? c.lastCheck.detail : t("Never tested")}</span>
                    </div>
                    {c.lastCheck && <div className="muted">{formatRelative(c.lastCheck.at)}</div>}
                  </td>
                  <td>{c.tokenCount}</td>
                  <td className="actions">
                    <button className="button button-small" onClick={() => test(c)} disabled={testing === c.id}>
                      {testing === c.id ? t("Testing…") : t("Test")}
                    </button>
                    <button className="button button-small" onClick={() => setEditing(c)}>
                      {t("Edit")}
                    </button>
                    <button className="button button-small button-danger" onClick={() => remove(c)} disabled={c.tokenCount > 0} title={c.tokenCount ? t("Delete its MCP tokens first") : undefined}>
                      {t("Delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ConnectionForm
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}
