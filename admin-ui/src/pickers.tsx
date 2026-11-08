import type { Category, Connection } from "./api";
import { useI18n } from "./i18n";

export function CategoryPicker({ categories, value, onChange }: { categories: Category[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { t } = useI18n();
  const all = value === null;
  const selected = new Set(value ?? []);
  return (
    <div className="category-picker">
      <label className="checkbox">
        <input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? null : categories.filter((c) => c.enabled).map((c) => c.name))} />
        <span>
          {t("All exposed categories")}
          <small>{t("Follows the settings of the “Tool exposure” page.")}</small>
        </span>
      </label>
      {!all && (
        <div className="chip-grid">
          {categories.map((c) => (
            <label key={c.name} className={`chip ${selected.has(c.name) ? "chip-on" : ""} ${c.enabled ? "" : "chip-disabled"}`} title={c.enabled ? undefined : t("Disabled globally")}>
              <input
                type="checkbox"
                checked={selected.has(c.name)}
                disabled={!c.enabled}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(c.name);
                  else next.delete(c.name);
                  onChange([...next]);
                }}
              />
              {c.name} <small>{c.count}</small>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Connections a token may use, with the one used when the AI does not choose. */
export function ConnectionPicker({
  connections,
  value,
  defaultId,
  onChange,
}: {
  connections: Connection[];
  value: string[];
  defaultId: string;
  onChange: (ids: string[], defaultId: string) => void;
}) {
  const { t } = useI18n();
  const selected = new Set(value);
  return (
    <div className="connection-picker">
      {connections.map((c) => (
        <div key={c.id} className={`connection-option ${selected.has(c.id) ? "on" : ""}`}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={(e) => {
                const next = e.target.checked ? [...value, c.id] : value.filter((id) => id !== c.id);
                // Keep a valid default: the first remaining connection if the default was removed.
                onChange(next, next.includes(defaultId) ? defaultId : (next[0] ?? ""));
              }}
            />
            <span>
              {c.name}
              <small>
                {c.readOnly ? t("Read-only") : t("Read/write")}
                {c.defaultAccountId ? ` · ${t("organisation {id}", { id: c.defaultAccountId })}` : ""}
              </small>
            </span>
          </label>
          <label className={`default-radio ${selected.has(c.id) ? "" : "hidden-radio"}`}>
            <input type="radio" name="default-connection" checked={defaultId === c.id} disabled={!selected.has(c.id)} onChange={() => onChange(value, c.id)} />
            {t("Default")}
          </label>
        </div>
      ))}
    </div>
  );
}
