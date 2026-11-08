import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fr } from "./locales/fr";

export type Lang = "en" | "fr";

const STORAGE_KEY = "infomaniak-mcp-admin.lang";
const DICTIONARIES: Record<Lang, Record<string, string> | null> = { en: null, fr };
const LOCALES: Record<Lang, string> = { en: "en-GB", fr: "fr-CH" };

export type Translate = (text: string, vars?: Record<string, string | number>) => string;

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translates an English source string; {name} placeholders are filled from vars. */
  t: Translate;
  /** Locale for dates and numbers. */
  locale: string;
}

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "fr") return stored;
  } catch {
    // Storage unavailable (private mode…): fall back to the browser language.
  }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted; the choice still applies to this page.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18n>(() => {
    const dictionary = DICTIONARIES[lang];
    const t: Translate = (text, vars) => {
      let out = dictionary?.[text] ?? text;
      if (dictionary && !(text in dictionary) && import.meta.env.DEV) console.warn(`[i18n] missing ${lang}: ${text}`);
      if (vars) for (const [key, v] of Object.entries(vars)) out = out.replaceAll(`{${key}}`, String(v));
      return out;
    };
    return { lang, setLang, t, locale: LOCALES[lang] };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}

/** EN | FR switch. */
export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useI18n();
  return (
    <div className={`lang-toggle ${className}`} role="group" aria-label="Language">
      {(["en", "fr"] as const).map((l) => (
        <button key={l} type="button" className={l === lang ? "active" : ""} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
