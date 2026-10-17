import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { LANGUAGE_KEY, translate, type Language } from "./locale.ts";

interface I18n {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (text: string, english?: string) => string;
}
const Context = createContext<I18n | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try { return localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "zh"; } catch { return "zh"; }
  });
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* preference is optional */ }
  }, [language]);
  const value = useMemo<I18n>(() => ({ language, setLanguage, t: (text, english) => translate(text, language, english) }), [language]);
  return <Context value={value}>{children}</Context>;
}

export function useI18n(): I18n {
  const context = useContext(Context);
  if (!context) throw new Error("LanguageProvider is required");
  return context;
}

export function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <div className="language-switch" role="group" aria-label="Language / 界面语言">
    <button type="button" lang="zh-CN" aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>中文</button>
    <button type="button" lang="en" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>EN</button>
  </div>;
}
