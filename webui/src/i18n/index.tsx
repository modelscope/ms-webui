/**
 * i18n 运行时：LocaleProvider 挂在 SettingsProvider 内（语言与主题一样属于
 * 机器侧持久化偏好），t() 从当前语种表取值、缺译回落中文源。插值用
 * `{name}` 占位符。
 *
 * 不引第三方 i18n 库：key 类型直接从 zh.ts 推导（写错 key 编译期报错），
 * 语种表是两个纯 ts 文件，回落策略一行完成——这是全部需求。
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { zh } from './locales/zh';
import { en } from './locales/en';
import { useSettings } from '@/settings/SettingsContext';

export type Locale = 'zh' | 'en';
export type MessageKey = keyof typeof zh;

/** 语言菜单元数据：label 恒以该语言自身书写（业界惯例），不参与翻译 */
export const LOCALES: ReadonlyArray<{ value: Locale; label: string; short: string }> = [
  { value: 'zh', label: '简体中文', short: '中' },
  { value: 'en', label: 'English', short: 'EN' },
];

const TABLES: Record<Locale, Partial<Record<MessageKey, string>>> = { zh, en };

/*
 * 组件树外的语种镜像：LocaleProvider 渲染时同步，供 api 层等纯模块取翻译。
 * 请求都在 Provider 挂载之后才发出，镜像必然已初始化；挂在渲染期而非 effect 里，
 * 是为了首帧内同步发出的请求也能拿到正确语种。
 */
let currentLocale: Locale = 'zh';

/** 组件树外（api 层错误消息、启动期 provider 等）用的翻译 */
export function tStatic(key: MessageKey, vars?: Record<string, string | number>): string {
  return interpolate(TABLES[currentLocale][key] ?? zh[key], vars);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

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
      currentLocale = locale;
      return {
        locale,
        setLocale: (l) => update('locale', l),
        t: (key, vars) => interpolate(TABLES[locale][key] ?? zh[key], vars),
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
