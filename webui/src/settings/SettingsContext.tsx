import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PRESET_SYSTEM_PROMPTS, type SystemPromptsState } from '@/store/systemPrompts';

/**
 * 全局偏好设置。
 *
 * 这是项目里第一个全局状态——在此之前所有状态都是页面自己的 useState。
 * 引入它的理由很具体：tips 条的开关要在设置页里改、在 footbar 上生效，
 * 两个组件隔着整个组件树，靠 props 传不过去。
 *
 * 持久化在机器侧（~/.swift/webui-settings.json，与 models.json 同目录），
 * 经 /api/settings 全量读写：偏好要在 webui 停止、换浏览器之后仍然可用，
 * localStorage 给不了这个保证。写是乐观的——本地先改、防抖后 POST，
 * 服务端写失败只影响下次启动回读，不回滚本次会话。
 *
 * 展览模式（多用户共用机器）例外：机器侧文件是共享面，读写都会串到别人
 * 会话里，所以展览模式下这份状态退化为纯内存——默认值起步，改动随浏览器
 * 会话消失，POST 一律不发（服务端同样对 POST 返回 403 双保险）。
 */

/** 对话默认采样参数（新建会话滑杆的初始值；会话内手调不受影响） */
export interface ChatDefaults {
  temperature: number;
  topP: number;
  maxTokens: number;
  /** 思考档位，与 ChatPage 的 THINKING_VALUES 同一取值集 */
  thinking: 'off' | 'mid' | 'high';
}

/* 本地定义的联合（与 i18n 的 Locale 同构）：SettingsContext 不 import i18n，
 * 避免 provider 层之间的模块环 */
export type UiLocale = 'zh' | 'en';
export type UiTheme = 'light' | 'dark' | 'system';

export interface Settings {
  /** 底部显示轮换 tips */
  tipsEnabled: boolean;
  /** 界面语言（i18n：中/英，缺省中文） */
  locale: UiLocale;
  /** 界面主题：浅色 / 深色 / 跟随系统（缺省跟随系统） */
  theme: UiTheme;
  /** tips 轮换间隔（秒） */
  tipsInterval: number;
  /** tips 只显示自己看得懂的：关掉后不出现涉及具体算法细节的条目 */
  tipsBeginnerOnly: boolean;
  /** 节点和整图上的 AI 入口 */
  aiEnabled: boolean;
  /**
   * AI 改动是否需要人工确认。
   * 默认开，且强烈建议别关——图形是唯一事实来源，
   * AI 静默改图会让「谁把 lr 调成 1e-3 的」变成查不出来的事。
   */
  aiConfirmBeforeApply: boolean;
  /** 节点跑完自动弹出输出面板 */
  autoOpenOutput: boolean;
  /**
   * 任务执行器 spawn 的 python 解释器。null = 服务端默认
   * （SWIFT_PYTHON 环境变量或内置路径）；填了就以它为准。
   */
  pythonPath: string | null;
  /** 对话默认采样参数 */
  chatDefaults: ChatDefaults;
  /**
   * ModelScope 个人访问令牌（PAT）：research 对话的默认模型与 tinker 服务
   * 的鉴权凭据。本地模式存本机设置文件；展览模式只留浏览器会话内存。
   */
  msToken: string;
  /** system 提示词库与两个绑定（对话基础 / 研究模式） */
  systemPrompts: SystemPromptsState;
}

const DEFAULTS: Settings = {
  tipsEnabled: true,
  tipsInterval: 12,
  tipsBeginnerOnly: false,
  locale: 'zh',
  theme: 'system',
  aiEnabled: true,
  aiConfirmBeforeApply: true,
  autoOpenOutput: false,
  msToken: '',
  pythonPath: null,
  chatDefaults: { temperature: 0.7, topP: 0.8, maxTokens: 8192, thinking: 'mid' },
  systemPrompts: PRESET_SYSTEM_PROMPTS,
};

/** 旧 localStorage 键：迁移用（读一次即弃，机器侧成为唯一事实源） */
const LEGACY_STORAGE_KEY = 'swift-webui.settings.v1';

/** 服务端文件可能是部分字段（老版本/手写）：逐层合并 + 悬空绑定回落 */
function mergeSaved(saved: unknown): Settings {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return DEFAULTS;
  const s = saved as Partial<Settings>;
  const chatDefaults: ChatDefaults = { ...DEFAULTS.chatDefaults, ...(s.chatDefaults ?? {}) };
  let systemPrompts: SystemPromptsState =
    s.systemPrompts && Array.isArray(s.systemPrompts.prompts) && s.systemPrompts.prompts.length
      ? { ...DEFAULTS.systemPrompts, ...s.systemPrompts }
      : DEFAULTS.systemPrompts;
  if (!systemPrompts.prompts.some((p) => p.id === systemPrompts.baseId)) {
    systemPrompts = { ...systemPrompts, baseId: systemPrompts.prompts[0].id };
  }
  if (!systemPrompts.prompts.some((p) => p.id === systemPrompts.researchId)) {
    systemPrompts = { ...systemPrompts, researchId: systemPrompts.prompts[0].id };
  }
  /* 枚举字段独立清洗（旧文件可能没有 / 手写文件可能有非法值） */
  const locale: UiLocale = s.locale === 'en' ? 'en' : 'zh';
  const theme: UiTheme =
    s.theme === 'light' || s.theme === 'dark' || s.theme === 'system' ? s.theme : 'system';
  const msToken = typeof s.msToken === 'string' ? s.msToken : '';
  return { ...DEFAULTS, ...s, locale, theme, msToken, chatDefaults, systemPrompts };
}

interface SettingsCtx {
  settings: Settings;
  /** 改一个字段（嵌套字段传整个子对象） */
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  /** 恢复默认（含提示词库回预设） */
  reset: () => void;
  /** 服务端设置是否已加载完成（ChatPage 用它做一次性的默认值同步） */
  loaded: boolean;
  /**
   * 本次会话里临时把 tips 关掉（footbar 上那个叉）。
   * 跟 settings.tipsEnabled 分开：叉掉是「这次别烦我」，
   * 设置里关掉是「以后都别出现」，刷新页面后前者恢复、后者保持。
   */
  tipsDismissed: boolean;
  dismissTips: () => void;
  /** 启动模式（服务端 GET /api/mode 单点判定）；expo = 展览（多用户共用机器） */
  mode: 'normal' | 'expo';
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [tipsDismissed, setTipsDismissed] = useState(false);
  /* null = 模式还没探明（boot 中），此时不渲染应用壳 */
  const [mode, setMode] = useState<'normal' | 'expo' | null>(null);

  /*
   * boot：拉启动模式（服务端 SWIFT_WEBUI_MODE 的唯一转述）。拉不到当
   * normal——连服务端都没响应时谈模式区分没有意义。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let m: 'normal' | 'expo' = 'normal';
      try {
        const res = await fetch('/api/mode');
        if (res.ok && (await res.json()).mode === 'expo') m = 'expo';
      } catch {
        /* 拉不到当 normal */
      }
      if (!cancelled) setMode(m);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * mount 拉取。展览模式跳过——服务端只会给空对象（默认值），读了也只会把
   * 机器残留带进会话；这里直接以默认值进入 loaded 态，改动全在内存。
   * 迁移：服务端还没有文件（空对象）而旧 localStorage 有值时，把旧值并进去
   * ——随后的防抖 POST 会把它落到机器侧，localStorage 从此退役。
   */
  useEffect(() => {
    /* mode 未探明前不拉——expo 下先按 normal 读了机器侧文件会把共享配置带进会话 */
    if (!mode) return;
    if (mode === 'expo') {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((saved: unknown) => {
        if (cancelled) return;
        let next = mergeSaved(saved);
        const hasFile = saved && typeof saved === 'object' && Object.keys(saved).length > 0;
        if (!hasFile) {
          try {
            const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
            if (legacy) next = mergeSaved({ ...JSON.parse(legacy) });
          } catch {
            /* 旧数据坏/不可用：直接用默认 */
          }
        }
        setSettings(next);
        setLoaded(true);
      })
      .catch(() => {
        /* 服务端不可达：先用默认跑起来，本次会话的改动会在恢复后 POST */
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  /* 防抖写回服务端：滑杆类控件连发 update，逐次 POST 只会打爆中间件 */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!loaded || mode === 'expo') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }).catch(() => {
        /* 写失败：本次会话仍生效，下次启动回读到旧值——设置页会显示真实态 */
      });
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [settings, loaded, mode]);

  const update = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) =>
      setSettings((s) => ({ ...s, [key]: value })),
    [],
  );

  const reset = useCallback(() => setSettings(DEFAULTS), []);
  const dismissTips = useCallback(() => setTipsDismissed(true), []);

  const value = useMemo(
    () => ({ settings, update, reset, loaded, tipsDismissed, dismissTips, mode: mode ?? 'normal' }),
    [settings, update, reset, loaded, tipsDismissed, dismissTips, mode],
  );

  /* boot 探明模式前不渲染应用壳（一次本地请求，避免expo 语义闪变） */
  if (mode === null) return null;

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSettings 必须在 SettingsProvider 里用');
  return v;
}

export { DEFAULTS as DEFAULT_SETTINGS };
