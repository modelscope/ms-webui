import { forwardRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Bot,
  ChevronLeft,
  Check,
  MoreHorizontal,
  Play,
  RotateCw,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageHeader } from './PageHeader';
import { Column } from './Column';
import { StatusTag } from './StatusTag';
import { useT } from '@/i18n';
import { CopyText } from './CopyText';
import { CodeBlock } from './CodeBlock';
import { RenameDialog, type RenameTarget } from './RenameDialog';
import type { ModuleMeta } from '@/theme/modules';
import type { TaskItem } from '@/mock/types';

export interface DetailTab {
  key: string;
  label: string;
  content: ReactNode;
}

/** 一枚元信息：标签在上、值在下。取代 antd Descriptions 那种「标签：值」的表格观感 */
export function MetaCell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground mb-1 text-xs">{label}</div>
      <div className="text-foreground truncate text-[13.5px]">{value}</div>
    </div>
  );
}

/** 元信息条：一排无边框的键值对，横向铺开 */
export function MetaStrip({ children }: { children: ReactNode }) {
  return (
    <div className="border-border flex flex-wrap gap-x-9 gap-y-4 border-t pt-3.5 pb-4">
      {children}
    </div>
  );
}

/**
 * 提示条。不用 antd Alert 那种带框带图标底的样式。
 * 配色取 --state-*，跟 StatusTag 同源：同一件事在标签上和提示条上不该是两个红。
 */
export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'error';
  title: string;
  children?: ReactNode;
}) {
  const c = tone === 'warn' ? 'var(--state-paused)' : 'var(--state-failed)';
  return (
    <div
      className="mb-4 rounded-md border px-4 py-3"
      style={{
        background: `color-mix(in oklab, ${c} 7%, var(--background))`,
        borderColor: `color-mix(in oklab, ${c} 25%, var(--background))`,
      }}
    >
      <div className="flex items-center gap-2 text-[13.5px] font-medium" style={{ color: c }}>
        <TriangleAlert size={14} /> {title}
      </div>
      {children && (
        <div className="text-muted-foreground mt-1.5 text-[13px] leading-5">{children}</div>
      )}
    </div>
  );
}

/**
 * 内容区的操作按钮。
 *
 * 原来叫 PillButton，圆角写死 999。写死就意味着换皮时它不跟着变，名字也把
 * 外观钉死了，所以改名 ActionButton，实现直接委托给 shadcn 的 Button——
 * 圆角跟着 --radius 走，这里只保留 tone 那层语义映射，页面代码不需要知道 variant 叫什么。
 *
 * 两处不能省的细节：
 *
 * 1. props 必须开放透传（...rest）而不是只列 icon/children/tone/onClick。Radix 的
 *    `<XxxTrigger asChild>` 是把开关逻辑当 props 塞给子元素的（onPointerDown、
 *    onKeyDown、aria-expanded、data-state），子元素不透传就等于把开关拆了——
 *    之前详情页的「更多」下拉点了没反应就是这个原因。
 * 2. 必须 forwardRef，理由见 ui/button.tsx 顶部那段。
 *
 * tooltip 直接做成一个 prop：这个按钮九成场合都要配一句说明，让调用方各自去拼
 * Tooltip/TooltipTrigger/TooltipContent 三层，只会把 asChild 那两个坑重新踩一遍。
 */
export const ActionButton = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & {
    icon?: ReactNode;
    tone?: 'primary' | 'ghost' | 'danger';
    tooltip?: ReactNode;
  }
>(({ icon, children, tone = 'ghost', tooltip, className, ...rest }, ref) => {
  const variant = tone === 'primary' ? 'default' : tone === 'danger' ? 'outline' : 'secondary';
  const btn = (
    <Button
      ref={ref}
      variant={variant}
      /* 没有文字时收成正方形图标按钮，跟有文字的那些保持同一个高度 */
      size={children ? 'default' : 'icon'}
      className={cn(tone === 'danger' && 'text-state-failed hover:text-state-failed', className)}
      {...rest}
    >
      {icon}
      {children}
    </Button>
  );

  if (!tooltip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
});
ActionButton.displayName = 'ActionButton';

/**
 * Tab 条。用 shadcn 的 Tabs 只取它的 TabsList——内容不放在 TabsContent 里，
 * 因为切 Tab 是走路由的（刷新后能停在同一个 Tab），内容由外层按当前路由渲染。
 * 这样做还能白拿 Radix 的左右键导航。
 */
export function TabStrip({
  tabs,
  activeKey,
  onChange,
}: {
  tabs: Array<{ key: string; label: string }>;
  activeKey: string;
  onChange: (k: string) => void;
}) {
  return (
    <Tabs value={activeKey} onValueChange={onChange} className="mb-4">
      <TabsList>
        {tabs.map((t) => (
          <TabsTrigger key={t.key} value={t.key}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * 任务详情外壳：返回、状态、元信息、操作、Tab 切换都在这里，
 * 各模块只负责提供 Tab 内容。切 Tab 走路由，刷新后停在同一个 Tab。
 */
export function TaskDetailShell({
  module,
  tasks,
  tabs,
  activeTab,
  extraMeta,
  actions,
  onRefresh,
  onRename,
  onStop,
  stopTooltip,
  onAssistant,
  onResume,
}: {
  module: ModuleMeta;
  tasks: TaskItem[];
  tabs: DetailTab[];
  activeTab: string;
  /** 模块特有的元信息格 */
  extraMeta?: ReactNode;
  /** 模块特有的操作按钮，放在通用操作左侧 */
  actions?: ReactNode;
  /** 手动刷新回调（立即拉一帧）；不传则不渲染刷新按钮 */
  onRefresh?: () => Promise<void>;
  /** 重命名当前任务的回调；不传则不渲染重命名菜单项 */
  onRename?: (id: string, name: string) => Promise<void>;
  /** 停止当前任务的回调；不传则不渲染停止按钮 */
  onStop?: (id: string) => Promise<void>;
  /** 停止按钮的说明文案；不传用默认的「SIGTERM 优雅关停」（模块间停止语义不同，如研究页只断关联不杀进程） */
  stopTooltip?: string;
  /** 页面 AI 助手入口（打开各页挂的 PageAssistant）；不传不显示按钮 */
  onAssistant?: () => void;
  /**
   * 从断点续跑的回调；不传不显示按钮。页面自己决定何时可续（失败/被停
   * 且有 checkpoint）——shell 只负责呈现，语义判断留在模块侧。
   */
  onResume?: (id: string) => Promise<void>;
}) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useT();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const task = tasks.find((task) => task.id === id);

  if (!task) {
    return (
      <div className="flex flex-col items-center gap-4 py-24">
        <div className="text-muted-foreground text-sm">
          {t('shell.taskNotFound', { id: id ?? '' })}
        </div>
        <ActionButton onClick={() => navigate(module.path)}>{t('shell.backTo', { module: t(module.label) })}</ActionButton>
      </div>
    );
  }

  const current = tabs.find((t) => t.key === activeTab) ?? tabs[0];

  return (
    <>
      <PageHeader
        module={module}
        wide
        size="md"
        title={task.label}
        titleExtra={<StatusTag status={task.status} />}
        back={
          <Link
            to={module.path}
            className="text-muted-foreground hover:text-foreground mb-2 inline-flex items-center gap-1 text-[12.5px] transition-colors"
          >
            <ChevronLeft size={12} /> {t(module.label)}
          </Link>
        }
        extra={
          <>
            {actions}
            {onAssistant && (
              <ActionButton icon={<Bot />} tooltip={t('task.aiAssistant')} onClick={onAssistant} />
            )}
            {onRefresh && (
              <ActionButton
                icon={<RotateCw />}
                tooltip={t('task.refresh')}
                onClick={() => {
                  void onRefresh()
                    .then(() => toast.success(t('task.refreshed')))
                    .catch((e) => toast.error(String(e)));
                }}
              />
            )}
            {/* 从断点续跑：页面判断可续（失败/被停且有 checkpoint）才传 onResume */}
            {onResume && id && task.status !== 'RUNNING' && (
              <ActionButton
                tone="primary"
                icon={<Play />}
                tooltip={t('task.resumeFromHint')}
                onClick={() => {
                  void onResume(id).catch((e) => toast.error(String(e)));
                }}
              >
                {t('task.resumeFrom')}
              </ActionButton>
            )}
            {task.status === 'RUNNING' && onStop && id && (
              <ActionButton
                tone="danger"
                icon={<Square />}
                tooltip={stopTooltip ?? t('task.sigtermHint')}
                onClick={() => {
                  void onStop(id).catch((e) => toast.error(String(e)));
                }}
              >
                {t('task.stop')}
              </ActionButton>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ActionButton icon={<MoreHorizontal />} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {onRename && id && (
                  <DropdownMenuItem onClick={() => setRenaming({ id, label: task.label })}>
                    {t('task.rename')}
                  </DropdownMenuItem>
                )}
                {/*
                 * 以此为模板新建：带来源 id 跳新建页，五个模块的新建页都解析
                 * ?from= 预填（train/eval/export/deploy/scripts）。
                 */}
                <DropdownMenuItem
                  onClick={() => navigate(`${module.path}/new?from=${encodeURIComponent(task.id)}`)}
                >
                  {t('task.useAsTemplate')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <Column wide className="pb-10">
        {task.status === 'FAILED' && task.error && (
          <Notice tone="error" title={t('task.failedBanner')}>
            {task.error}
          </Notice>
        )}

        {/* 元信息条：取代 Descriptions */}
        <MetaStrip>
          <MetaCell label={t('task.metaModel')} value={task.model} />
          <MetaCell label={t('task.metaRunMode')} value={task.runner} />
          <MetaCell
            label={t('task.metaServer')}
            value={task.serverUrl ?? <span className="text-muted-foreground">{t('task.metaLocal')}</span>}
          />
          <MetaCell label={t('task.metaCreated')} value={<span className="tabular">{task.createdAt}</span>} />
          {task.endpoint && (
            <MetaCell label={t('task.metaServerUrl')} value={<CopyText text={task.endpoint} mono />} />
          )}
          <MetaCell
            label={t('task.metaTaskId')}
            value={<span className="font-mono text-[12.5px]">{task.id}</span>}
          />
          {extraMeta}
        </MetaStrip>

        {/*
         * 创建命令：把「这个任务是怎么拉起来的」还原成可直接复现的 CLI。
         * 放在元信息条与 Tab 之间——它是任务级事实（属于哪个 Tab 都该看得到），
         * 且 curl/Python 这类使用示例只在概览 Tab，两者不抢位置。
         */}
        {task.createCommand && (
          <Panel
            title={t('task.metaCommand')}
            extra={<span className="text-muted-foreground text-xs">{t('task.copyCommandHint')}</span>}
          >
            <CodeBlock code={task.createCommand} />
          </Panel>
        )}

        {current ? (
          <>
            <TabStrip
              tabs={tabs}
              activeKey={current.key}
              onChange={(k) => navigate(`${module.path}/${task.id}/${k}`)}
            />

            {current.content}
          </>
        ) : (
          /* 调用方数据未就绪时会传空 tabs（研究会话详情在 session 拉到前的
           * 首帧）：此时 current 是 undefined，直接读 .key 会把整页炸成
           * react-router 的默认错误页且不再自愈——占位一拍等数据到位。 */
          <div className="text-muted-foreground py-16 text-center text-sm">{t('shell.tabsPending')}</div>
        )}
      </Column>

      {renaming && onRename && (
        <RenameDialog
          key={renaming.id}
          target={renaming}
          onConfirm={onRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </>
  );
}

/** 详情页里的内容块。细边框 + 无阴影，取代到处都是的 antd Card */
export function Panel({
  title,
  extra,
  children,
  padded = true,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <div className="bg-card border-border overflow-hidden rounded-lg border">
      {title && (
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <span className="text-foreground text-[13.5px] font-medium">{title}</span>
          {extra}
        </div>
      )}
      <div className={padded ? 'px-4 pt-3 pb-4' : ''}>{children}</div>
    </div>
  );
}

/** 一枚大数字指标。取代 antd Card + Statistic 的组合 */
export function StatCell({
  label,
  value,
  suffix,
  hint,
}: {
  label: string;
  value: ReactNode;
  suffix?: ReactNode;
  hint?: string;
}) {
  const body = (
    <div className="border-border min-w-0 flex-1 rounded-lg border px-4 py-3">
      <div className="text-muted-foreground mb-1 text-xs">{label}</div>
      {/* tabular：指标是会跳的，数字不等宽整个卡片宽度会跟着抖 */}
      <div className="text-foreground tabular text-[23px] leading-7 font-semibold tracking-[-0.02em]">
        {value}
        {suffix && (
          <span className="text-muted-foreground ms-1.5 text-[13px] font-normal">{suffix}</span>
        )}
      </div>
    </div>
  );
  return hint ? (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  ) : (
    body
  );
}

/** 一行「已完成」式的产物条目 */
export function ArtifactRow({
  title,
  desc,
  done,
  extra,
}: {
  title: ReactNode;
  desc?: ReactNode;
  done?: boolean;
  extra?: ReactNode;
}) {
  return (
    <div className="task-row hover:bg-secondary/50 -mx-3 flex items-center gap-3 rounded-md px-3 py-3 transition-colors">
      <span
        className={cn(
          'inline-flex size-[22px] flex-none items-center justify-center rounded-sm border',
          done ? 'text-state-done' : 'border-border text-muted-foreground',
        )}
        style={
          done
            ? {
                background: 'color-mix(in oklab, var(--state-done) 8%, var(--background))',
                borderColor: 'color-mix(in oklab, var(--state-done) 28%, var(--background))',
              }
            : undefined
        }
      >
        {done ? <Check size={12} /> : ''}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm">{title}</div>
        {desc && <div className="text-muted-foreground mt-0.5 text-[13px]">{desc}</div>}
      </div>
      {extra}
    </div>
  );
}
