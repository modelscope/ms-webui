/**
 * i18n 运行时：LocaleProvider 挂在 SettingsProvider 内（语言与主题一样属于
 * 机器侧持久化偏好），t() 从当前语种表取值、缺译回落中文源。插值用
 * `{name}` 占位符。
 *
 * 不引第三方 i18n 库：key 类型直接从 zh.ts 推导（写错 key 编译期报错），
 * 语种表是两个纯 ts 文件，回落策略一行完成——这是全部需求。
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useSettings } from '@/settings/SettingsContext';
/* 纯静态部分（表/插值/tStatic）拆到 static.ts：api 层要在 node 里复用，不能连带 React */
import { LOCALES, TABLES, setCurrentLocale, tStatic, interpolate, type Locale, type MessageKey } from './static';

export { LOCALES, tStatic };
export type { Locale, MessageKey };

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<LocaleCtx | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { settings, update } = useSettings();
  const locale: Locale = settings.locale;
  const value = useMemo<LocaleCtx>(
    () => {
      setCurrentLocale(locale);
      return {
        locale,
        setLocale: (l) => update('locale', l),
        t: (key, vars) => interpolate(TABLES[locale][key] ?? tStatic(key), vars),
      };
    },
    [locale, update],
  );
  /* html lang 跟随（辅助技术与浏览器翻译都读它） */
  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): LocaleCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useT 必须在 LocaleProvider 里用');
  return v;
}

export type { MessageTable } from './locales/zh';
