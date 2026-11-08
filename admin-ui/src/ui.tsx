import { type ReactNode, useEffect, useState } from "react";
import { useI18n } from "./i18n";

/** Date formatters following the current language. */
export function useFormat() {
  const { t, locale } = useI18n();
  const formatDate = (ts: number | null | undefined): string => {
    if (!ts) return "—";
    return new Date(ts).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  };
  const formatRelative = (ts: number | null | undefined): string => {
    if (!ts) return t("never");
    const diff = Math.round((Date.now() - ts) / 1000);
    if (diff < 60) return t("just now");
    if (diff < 3600) return t("{n} min ago", { n: Math.floor(diff / 60) });
    if (diff < 86400) return t("{n} h ago", { n: Math.floor(diff / 3600) });
    return t("{n} d ago", { n: Math.floor(diff / 86400) });
  };
  return { formatDate, formatRelative };
}

export function StatusDot({ ok, title }: { ok: boolean | undefined; title?: string }) {
  const state = ok === undefined ? "unknown" : ok ? "ok" : "error";
  return <span className={`dot dot-${state}`} title={title} aria-label={title} />;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "error" | "info"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label={t("Close")}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button-small"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? t("Copied ✓") : (label ?? t("Copy"))}
    </button>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code-block">
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton value={code} />
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <div className="banner banner-error" role="alert">
      {t(error)}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}
