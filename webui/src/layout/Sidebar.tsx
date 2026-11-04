import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Boxes,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  FlaskConical,
  Globe,
  KeyRound,
  MessageSquare,
  Network,
  Package,
  Plug,
  Rocket,
  Search,
  SquareTerminal,
  Workflow,
  Zap,
} from 'lucide-react';
import { cn } from 'cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ModuleKey } from '@/theme/modules';
import { MODULES, NAV_GROUPS, moduleOf } from '@/theme/modules';
import { features } from '@/config/features';
import { useSettings } from '@/settings/SettingsContext';
import { useRecent } from '@/store/recent';
import { LOCALES, useT, type MessageKey } from '@/i18n';
import { ChromeIconButton } from './ChromeIconButton';

const ICONS: Record<ModuleKey, ReactNode> = {
  chat: <MessageSquare size={14} />,
  train: <Zap size={14} />,
  eval: <Network size={14} />,
  export: <Package size={14} />,
  deploy: <Rocket size={14} />,
  workflow: <Workflow size={14} />,
  research: <FlaskConical size={14} />,
  scripts: <SquareTerminal size={14} />,
  plugins: <Plug size={14} />,
  models: <Boxes size={14} />,
};

/**
 * 侧栏里弹出的菜单，配色跟侧栏同一套。
 *
 * 不用 shadcn 默认的 bg-popover（那是内容区/浮层的语义，比侧栏更亮），
 * 菜单用 sidebar-* 那组看起来就像从侧栏本身撑开的，跟 VS Code 一致。
 */
const MENU_CLS = 'bg-sidebar border-sidebar-border text-sidebar-foreground min-w-[168px]';
const MENU_ITEM_CLS =
  'text-sidebar-foreground/80 focus:bg-sidebar-accent focus:text-sidebar-foreground text-[13px]';

/** 分组小标签，用来打断长列表，而不是一长条等距菜单 */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-sidebar-foreground/40 mt-[18px] mb-1.5 px-[11px] text-xs select-none">
      {children}
    </div>
  );
}

/* 模块级 helper 不能用 hook：t 从调用方传进来（只收用到的签名子集） */
type TFn = (key: MessageKey) => string;

/**
 * 底部的 ModelScope 令牌状态行：图标 + 「MS Token · 已配置/未配置」，
 * 点击去设置页配置（PAT 是 research 对话默认模型与 tinker 服务的凭据）。
 * 折叠时只剩图标，悬停 tooltip 出全名。
 */
function tokenRow(
  collapsed: boolean,
  configured: boolean,
  onOpen: () => void,
  t: TFn,
) {
  const label = t('sidebar.msToken');
  const state = configured ? t('sidebar.msTokenOn') : t('sidebar.msTokenOff');
  const full = `${label} · ${state}`;
  const row = (
    <button
      type="button"
      onClick={onOpen}
      data-tour="ms-token"
      title={full}
      className={cn(
        'flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-md outline-none',
        collapsed ? 'justify-center px-0' : 'justify-start px-[11px]',
        'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      )}
    >
      <KeyRound size={14} className="shrink-0" />
      {!collapsed && (
        <span className="truncate text-[13px]" title={full}>
          {label}
          <span className={cn('ml-1.5 text-[11px]', configured ? 'text-primary' : 'text-sidebar-foreground/40')}>
            {state}
          </span>
        </span>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side="right">{full}</TooltipContent>
    </Tooltip>
  ) : (
    row
  );
}

/**
 * 左侧导航。信息设计参考 Codex：小字号、紧凑行高、细图标，
 * 选中态只是一块低对比底色——导航里不出现品牌色，让内容区去承担强调。
 * 操作按钮走「非线性」：贴边的无框幽灵按钮，而非并排的按钮组。
 */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  /* search 一起取：最近项的 path 带 ?conv= 这类参数，只比 pathname 会全部失配 */
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const current = moduleOf(pathname);
  const { t, locale, setLocale } = useT();

  /** 「最近」分组：用户真实发生过的操作（新对话、新部署…），见 store/recent.ts */
  const recent = useRecent();

  /* 令牌状态（PAT 存全局设置；点击行进设置页配置） */
  const { settings } = useSettings();

  /* 导航行的公共形状。选中/未选中只差一层底色和字重 */
  const row = (active: boolean, extra?: string) =>
    cn(
      'flex h-8 items-center gap-2.5 text-[13px] no-underline transition-colors',
      collapsed ? 'justify-center px-0' : 'justify-start px-[11px]',
      active
        ? 'bg-sidebar-accent text-sidebar-foreground font-medium'
        : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
      extra,
    );

  /** 一个模块的导航行：折叠态包 tooltip（悬停见全名） */
  const renderModule = (m: (typeof MODULES)[ModuleKey]) => {
    const active = current.key === m.key;
    const link = (
      <Link to={m.path} data-tour={m.key} className={row(active)}>
        <span className="inline-flex text-current opacity-90">{ICONS[m.key]}</span>
        {!collapsed && t(m.label)}
      </Link>
    );
    return collapsed ? (
      <Tooltip key={m.key}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{t(m.label)}</TooltipContent>
      </Tooltip>
    ) : (
      <div key={m.key}>{link}</div>
    );
  };

  return (
    <div
      className="bg-sidebar border-sidebar-border flex h-full shrink-0 flex-col overflow-hidden border-r transition-[width] duration-200"
      style={{ width: collapsed ? 60 : 240 }}
    >
      {/* 品牌区：纯文字 + 小箭头，右侧贴边的无框图标 */}
      <div
        className={cn(
          'flex h-[46px] shrink-0 items-center gap-1.5',
          collapsed ? 'px-4' : 'pr-3 pl-3.5',
        )}
      >
        {collapsed ? (
          <span className="text-sidebar-foreground text-sm font-bold">M</span>
        ) : (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="text-sidebar-foreground hover:text-sidebar-foreground/80 inline-flex cursor-pointer items-center gap-1.5 text-[15px] font-semibold tracking-wide outline-none"
                >
                  MS-WebUI
                  <ChevronDown size={10} className="text-sidebar-foreground/40" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={MENU_CLS}>
                <DropdownMenuItem className={MENU_ITEM_CLS}>{t('sidebar.about')}</DropdownMenuItem>
                <DropdownMenuItem className={MENU_ITEM_CLS} onClick={() => navigate('/settings')}>
                  {t('sidebar.preferences')}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-sidebar-border" />
                <DropdownMenuItem className={MENU_ITEM_CLS} asChild>
                  <a href="https://swift.readthedocs.io" target="_blank" rel="noreferrer">
                    {t('common.docs')}
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 语言切换（品牌菜单右侧）：当前语种短码 + 下拉；语言名恒用自身语言书写 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={t('lang.switch')}
                  className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 outline-none"
                >
                  <Globe size={13} />
                  <span className="text-[11px] font-medium">{LOCALES.find((l) => l.value === locale)?.short}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={MENU_CLS}>
                {LOCALES.map((l) => (
                  <DropdownMenuItem key={l.value} className={MENU_ITEM_CLS} onClick={() => setLocale(l.value)}>
                    {l.label}
                    {locale === l.value && <Check size={12} className="ms-auto" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="ms-auto flex gap-0.5">
              <ChromeIconButton icon={<Search size={13} />} label={t('sidebar.searchHint')} />
              <ChromeIconButton icon={<Bell size={13} />} label={t('sidebar.notifications')} />
            </div>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-0.5">
        {/*
         * 模块导航：对话是主入口单独置顶；其余按工作流三组（训练 / 交付 /
         * 资源），组标题复用「最近」的低对比小字——视觉上是一套语言。折叠态
         * 不渲染组标题，纯图标列与分组前完全一致。
         */}
        {features.modules.includes('chat') && (
          <div className="mb-1">{renderModule(MODULES.chat)}</div>
        )}
        {NAV_GROUPS.map((group) => {
          const groupItems = group.items
            .filter((k) => features.modules.includes(k))
            .map((k) => MODULES[k]);
          if (!groupItems.length) return null;
          return (
            <div key={group.label}>
              {!collapsed && <SectionLabel>{t(group.label)}</SectionLabel>}
              {groupItems.map(renderModule)}
            </div>
          );
        })}

        {/* 最近：用户真实操作过的对象（对话、部署……），来自 store/recent.ts */}
        {!collapsed && recent.length > 0 && (
          <>
            <SectionLabel>{t('common.recent')}</SectionLabel>
            {recent.map((item) => (
              <Link
                key={item.id}
                to={item.path}
                title={item.label}
                className={row(
                  /* here 与 item.path 同构（pathname + ?query），对话项才能对上号 */
                  pathname + search === item.path || (pathname + search).startsWith(`${item.path}/`),
                  'h-[30px]',
                )}
              >
                <span className="truncate">{item.label}</span>
              </Link>
            ))}
          </>
        )}
      </div>

      {/*
       * 底部：ModelScope 令牌状态行（点击去设置页；展览模式令牌只在本
       * 浏览器会话内存，本地模式存本机设置文件）；帮助按钮恒在，独立成行。
       */}
      <div className="border-sidebar-border shrink-0 border-t p-2">
        {tokenRow(collapsed, Boolean(settings.msToken), () => navigate('/settings'), t)}

        <div
          className={cn(
            'flex h-[34px] items-center',
            collapsed ? 'justify-center px-0' : 'justify-end px-[11px]',
          )}
        >
          <ChromeIconButton icon={<CircleHelp size={13} />} label={t('common.help')} side="top" />
        </div>
      </div>
    </div>
  );
}
