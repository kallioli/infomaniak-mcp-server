import { useEffect, useMemo, useState } from "react";
import { api, type Category } from "../api";
import { useI18n } from "../i18n";
import { ErrorBanner } from "../ui";

export function CategoriesPage() {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Category[]>("GET", "/categories").then((list) => {
      const off = new Set(list.filter((c) => !c.enabled).map((c) => c.name));
      setCategories(list);
      setDisabled(off);
      setSaved(off);
    }, (e) => setError(e.message));
  }, []);

  const dirty = useMemo(() => disabled.size !== saved.size || [...disabled].some((c) => !saved.has(c)), [disabled, saved]);

  if (!categories) return <ErrorBanner error={error} />;

  const toggle = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setDisabled(next);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ disabled: string[] }>("PUT", "/categories", { disabled: [...disabled] });
      setSaved(new Set(res.disabled));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enabledOps = categories.filter((c) => !disabled.has(c.name)).reduce((n, c) => n + c.count, 0);
  const totalOps = categories.reduce((n, c) => n + c.count, 0);

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{t("Tool exposure")}</h1>
          <p>
            {t("Infomaniak API categories visible to MCP clients, whatever their authentication method. Each token can then be restricted further.")}
          </p>
        </div>
        <div className="inline">
          <button className="button" onClick={() => setDisabled(new Set())}>
            {t("Enable all")}
          </button>
          <button className="button button-primary" onClick={save} disabled={!dirty || busy}>
            {busy ? t("Saving…") : dirty ? t("Save") : t("Saved")}
          </button>
        </div>
      </header>
      <ErrorBanner error={error} />

      <div className="banner banner-info">
        <strong>{enabledOps.toLocaleString(locale)}</strong> {t("of {total} operations exposed", { total: totalOps.toLocaleString(locale) })} ·{" "}
        {t("{enabled} of {count} categories enabled.", { enabled: categories.length - disabled.size, count: categories.length })}{" "}
        {t("Changes apply as soon as they are saved, without a restart.")}
      </div>

      <div className="category-grid">
        {categories.map((c) => {
          const on = !disabled.has(c.name);
          return (
            <div key={c.name} className={`category-card ${on ? "on" : "off"}`}>
              <div className="category-head">
                <label className="switch">
                  <input type="checkbox" checked={on} onChange={() => toggle(c.name)} aria-label={t("Expose {name}", { name: c.name })} />
                  <span className="switch-track" />
                </label>
                <div className="category-title">
                  <strong>{c.name}</strong>
                  <span className="muted">{t("{count} operations", { count: c.count })}</span>
                </div>
                <button className="icon-button" onClick={() => setExpanded(expanded === c.name ? null : c.name)} aria-expanded={expanded === c.name} aria-label={t("Details")}>
                  {expanded === c.name ? "▴" : "▾"}
                </button>
              </div>
              {expanded === c.name && (
                <ul className="tag-list">
                  {c.tags.map((tag) => (
                    <li key={tag.tag}>
                      <span>{tag.tag === c.name ? t("(general)") : tag.tag.slice(c.name.length + 3)}</span>
                      <span className="muted">{tag.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
