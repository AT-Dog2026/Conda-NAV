import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import zhCN from './zh-CN';
import enUS from './en-US';

const messages = { 'zh-CN': zhCN, 'en-US': enUS };

const I18nContext = createContext({
  locale: 'zh-CN',
  setLocale: () => {},
  t: () => '',
});

export function I18nProvider({ children }) {
  const [locale, setLocale] = useState(() => {
    return localStorage.getItem('conda-nav-locale') || 'zh-CN';
  });

  const changeLocale = useCallback((lang) => {
    setLocale(lang);
    localStorage.setItem('conda-nav-locale', lang);
  }, []);

  // t('app.title') → 返回对应翻译，支持 {key} 插值
  const t = useCallback((keyPath, params = {}) => {
    const msg = messages[locale] || zhCN;
    const keys = keyPath.split('.');
    let result = keys.reduce((obj, k) => obj?.[k], msg);
    if (result === undefined || result === null) return keyPath;
    // 数组直接返回（如 footer.tips）
    if (Array.isArray(result)) return result;
    if (typeof result !== 'string') return keyPath;
    // 替换 {n} {ms} 等插值变量
    return result.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale: changeLocale, t }), [locale, changeLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
