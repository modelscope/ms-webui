/**
 * i18n 的纯静态部分：语种表、插值与 tStatic。
 *
 * 从 index.tsx 拆出——api 层错误消息要在 node（server 侧 headless runner）里
 * 也能取翻译，不能连带 React 上下文一起 import。LocaleProvider 侧复用同一
 * 份表与插值，语言镜像 setCurrentLocale 仍由 Provider 渲染期同步。
 */
import { zh } from './locales/zh';
import { en } from './locales/en';

export type Locale = 'zh' | 'en';
export type MessageKey = keyof typeof zh;

/** 语言菜单元数据：label 恒以该语言自身书写（业界惯例），不参与翻译 */
export const LOCALES: ReadonlyArray<{ value: Locale; label: string; short: string }> = [
  { value: 'zh', label: '简体中文', short: '中' },
  { value: 'en', label: 'English', short: 'EN' },
];

/** 语种表：en 缺译回落 zh 源文案（index.tsx 的 t() 与 tStatic 共用） */
export const TABLES: Record<Locale, Partial<Record<MessageKey, string>>> = { zh, en };

/*
 * 组件树外的语种镜像：LocaleProvider 渲染时同步，供 api 层等纯模块取翻译。
 * 请求都在 Provider 挂载之后才发出，镜像必然已初始化；挂在渲染期而非 effect 里，
 * 是为了首帧内同步发出的请求也能拿到正确语种。node 侧无人同步，恒中文——
 * headless 回合的消息文本本来就用中文。
 */
let currentLocale: Locale = 'zh';

/** LocaleProvider 侧同步语种镜像用 */
export function setCurrentLocale(l: Locale): void {
  currentLocale = l;
}

/** 组件树外（api 层错误消息、启动期 provider、node 侧 runner）用的翻译 */
export function tStatic(key: MessageKey, vars?: Record<string, string | number>): string {
  return interpolate(TABLES[currentLocale][key] ?? zh[key], vars);
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
