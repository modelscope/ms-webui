import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  CloudCog,
  FileText,
  FlaskConical,
  GitCompareArrows,
  LineChart,
  MoreHorizontal,
  Network,
  Package,
  Bot,
  Plus,
  RotateCw,
  Rocket,
  Search,
  Square,
  Workflow,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { PageHeader } from './PageHeader';
import { StatusTag } from './StatusTag';
import { useT, type MessageKey } from '@/i18n';
import { CopyText } from './CopyText';
import { Column } from './Column';
import { RenameDialog, type RenameTarget } from './RenameDialog';
import type { ModuleKey, ModuleMeta } from '@/theme/modules';
import { taskDetailPath } from '@/theme/modules';
import type { TaskItem, TaskStatus } from '@/mock/types';

/** 列表页可选列，各模块按需开启，避免为每个模块复制一份列表页 */
export interface TaskListOptions {
  /** train：显示 step 进度 */
  showProgress?: boolean;
  /** train：行首 checkbox 多选，选中≥2 时头部出「对比选中」按钮（实验对比页入口） */
  showCompare?: boolean;
  /** deploy：显示 endpoint */
  showEndpoint?: boolean;
  /** train：显示指标入口 */
  showMetrics?: boolean;
  /** 「新建」按钮文案；不传则不渲染新建按钮（如脚本任务由 agent 创建，没有新建页） */
  createText?: string;
  /** 「模型 / 来源」的语义标签，各模块不同 */
  sourceLabel: string;
  /** 刷新回调（手动立即拉一帧）；不传则不渲染刷新按钮 */
  onRefresh?: () => Promise<void>;
  /** 重命名回调；不传则不渲染重命名菜单项 */
  onRename?: (id: string, name: string) => Promise<void>;
  /** 停止回调；不传则不渲染停止按钮（含确认弹窗） */
  onStop?: (id: string) => Promise<void>;
  /** 重跑回调（同参数再执行一次，如脚本任务）；不传不显示重跑按钮 */
  onRerun?: (id: string) => Promise<void>;
  /** 停止确认弹窗的说明文案；不传用默认的 SIGTERM 文案（模块间停止语义不同） */
  stopDesc?: string;
}

const STATUS_FILTERS: Array<{ label: MessageKey; value: TaskStatus | 'ALL' }> = [
  { label: 'task.all', value: 'ALL' },
  { label: 'task.running', value: 'RUNNING' },
  { label: 'task.done', value: 'DONE' },
  { label: 'task.failed', value: 'FAILED' },
  { label: 'task.stopped', value: 'STOPPED' },
];

const MODULE_ICON: Partial<Record<ModuleKey, ReactNode>> = {
  train: <Zap size={16} />,
  eval: <Network size={16} />,
  export: <Package size={16} />,
  deploy: <Rocket size={16} />,
  workflow: <Workflow size={16} />,
  research: <FlaskConical size={16} />,
};

/** 次要信息之间的分隔点 */
function Dot() {
  return <span className="text-border">·</span>;
}

/**
 * 行内的小图标按钮。平时藏起来（靠 index.css 的 .task-row .row-actions），
 * hover 整行才浮现，所以不需要每个按钮各自挂 group-hover。
 */
function RowAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          className={danger ? 'text-state-failed hover:text-state-failed' : 'text-muted-foreground'}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TaskListPage({
  module,
  tasks,
  options,
  onAssistant,
}: {
  module: ModuleMeta;
  tasks: TaskItem[];
  options: TaskListOptions;
  /** 页面 AI 助手入口（打开各页挂的 PageAssistant）；不传不显示按钮 */
  onAssistant?: () => void;
}) {
  const navigate = useNavigate();
  const { t: tr } = useT();
  /* 行操作 map 的循环变量 t 是任务项：toast 插值在此预绑，避免遮蔽冲突 */
  const rerunToast = (label: string) => toast.success(tr('task.rerunToast', { label }));
  const stopToast = (label: string) => toast.success(tr('task.stopToast', { label }));
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<TaskStatus | 'ALL'>('ALL');
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  /* 对比多选（仅 showCompare 开关时出现）：选中 id 集合，与筛选器独立 */
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const filtered = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (status === 'ALL' || t.status === status) &&
          (keyword === '' ||
            t.label.includes(keyword) ||
            t.id.includes(keyword) ||
            t.model.includes(keyword)),
      ),
    [tasks, keyword, status],
  );

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <>
      <PageHeader
        module={module}
        title={tr(module.label)}
        desc={tr(module.desc)}
        extra={
          <>
            {onAssistant && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tr('task.aiAssistant')}
                    className="text-muted-foreground"
                    onClick={onAssistant}
                  >
                    <Bot />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{tr('task.aiAssistant')}</TooltipContent>
              </Tooltip>
            )}
            {options.onRefresh && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tr('task.refresh')}
                    className="text-muted-foreground"
                    onClick={() => {
                      void options
                        .onRefresh!()
                        .then(() => toast.success(tr('task.refreshed')))
                        .catch((e) => toast.error(String(e)));
                    }}
                  >
                    <RotateCw />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{tr('task.refresh')}</TooltipContent>
              </Tooltip>
            )}
            {options.showCompare && compareIds.length >= 2 && (
              <Button
                variant="outline"
                className="h-9 gap-1.5"
                onClick={() => navigate(`${module.path}/compare?ids=${compareIds.join(',')}`)}
              >
                <GitCompareArrows size={15} />
                {tr('task.compareSelected', { n: compareIds.length })}
              </Button>
            )}
            {options.createText && (
              <Button onClick={() => navigate(`${module.path}/new`)}>
                <Plus />
                {options.createText}
              </Button>
            )}
          </>
        }
      />

      <Column className="pb-10">
        {/* 整宽搜索，是这一页唯一的输入框。图标绝对定位在框内，输入区留出左内边距 */}
        <div className="relative">
          <Search
            size={15}
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
          <Input
            placeholder={tr('task.searchPlaceholder', { source: options.sourceLabel })}
            className="h-10 ps-9"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        {/* 状态筛选：小字文本按钮，选中才有一点底色 */}
        <div className="mt-4 mb-1.5 flex flex-wrap gap-0.5">
          {STATUS_FILTERS.map((f) => {
            const active = status === f.value;
            const count =
              f.value === 'ALL' ? tasks.length : tasks.filter((t) => t.status === f.value).length;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatus(f.value)}
                className={
                  active
                    ? 'bg-secondary text-foreground inline-flex h-7 cursor-pointer items-center gap-1.5 px-2.5 text-[13px] font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60 inline-flex h-7 cursor-pointer items-center gap-1.5 px-2.5 text-[13px]'
                }
              >
                {tr(f.label)}
                <span className="text-muted-foreground tabular text-xs">{count}</span>
              </button>
            );
          })}
        </div>

        {/* 列表：无边框、无卡片，靠留白分行 */}
        {filtered.length === 0 ? (
          <div className="text-muted-foreground border-border mt-2 border border-dashed py-18 text-center text-sm">
            {tasks.length === 0 ? tr('task.empty') : tr('task.emptyFiltered')}
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((t) => (
              <div
                key={t.id}
                className="task-row hover:bg-secondary/50 -mx-3 flex cursor-pointer items-start gap-3.5 px-3 py-3.5 transition-colors"
                onClick={() => navigate(taskDetailPath(t))}
              >
                {/* 对比多选 checkbox（仅 showCompare 开启）：点击不触发行跳转 */}
                {options.showCompare && (
                  <input
                    type="checkbox"
                    className="border-border accent-primary mt-1 size-3.5 flex-none cursor-pointer"
                    checked={compareIds.includes(t.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() =>
                      setCompareIds((prev) =>
                        prev.includes(t.id) ? prev.filter((x) => x !== t.id) : [...prev, t.id],
                      )
                    }
                  />
                )}

                {/* 裸图标，不套底色方块 */}
                <span className="text-muted-foreground mt-0.5 flex-none">
                  {MODULE_ICON[module.key] ?? <Workflow size={16} />}
                </span>

                <div className="min-w-0 flex-1">
                  {/* 标题行：名字 + 行内灰时间 + 状态 */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-foreground max-w-full truncate text-[15px] font-medium">
                      {t.label}
                    </span>
                    <span className="text-muted-foreground tabular text-[13px]">{t.createdAt}</span>
                    <StatusTag status={t.status} />
                  </div>

                  {/* 描述行：一行灰字串起所有元信息，不再堆胶囊 */}
                  <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-[7px] text-[13.5px] leading-5">
                    <span>{t.model}</span>
                    <Dot />
                    <span>{t.runner}</span>
                    {t.serverUrl && (
                      <>
                        <Dot />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-foreground inline-flex cursor-default items-center gap-1">
                              <CloudCog size={13} /> server
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {tr('task.loopLocal', { url: t.serverUrl })}
                          </TooltipContent>
                        </Tooltip>
                      </>
                    )}
                    {options.showProgress && t.totalSteps ? (
                      <>
                        <Dot />
                        <span className="tabular">
                          {t.step ?? 0} / {t.totalSteps} step ·{' '}
                          {Math.round(((t.step ?? 0) / t.totalSteps) * 100)}%
                        </span>
                      </>
                    ) : null}
                    {options.showEndpoint ? (
                      <>
                        <Dot />
                        {t.endpoint ? (
                          <CopyText text={t.endpoint} mono className="text-[12.5px]" />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default">{tr('task.portAssigning')}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {tr('task.portHint')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </>
                    ) : null}
                    <Dot />
                    <span className="font-mono text-[12.5px]">{t.id}</span>
                  </div>
                </div>

                <div className="row-actions flex flex-none items-center gap-0.5" onClick={stop}>
                  {options.showMetrics && (
                    <RowAction
                      icon={<LineChart />}
                      label={tr('task.metrics')}
                      onClick={() => navigate(`${module.path}/${t.id}/metrics`)}
                    />
                  )}
                  <RowAction
                    icon={<FileText />}
                    label={tr('task.logs')}
                    onClick={() => navigate(taskDetailPath(t))}
                  />
                  {options.onRerun && (
                    <RowAction
                      icon={<RotateCw />}
                      label={tr('task.rerun')}
                      onClick={() => {
                        void options
                          .onRerun!(t.id)
                          .then(() => rerunToast(t.label))
                          .catch((e) => toast.error(String(e)));
                      }}
                    />
                  )}
                  {t.status === 'RUNNING' && options.onStop && (
                    /* 停止是不可逆的，换成需要二次确认的弹窗；
                       antd 的 Popconfirm 在 shadcn 里对应 AlertDialog */
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={tr('task.stop')}
                          className="text-state-failed hover:text-state-failed"
                        >
                          <Square />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{tr('task.stopConfirm', { label: t.label })}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {options.stopDesc ??
                              tr('task.stopHint')}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{tr('common.cancel')}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => {
                              void options
                                .onStop!(t.id)
                                .then(() => stopToast(t.label))
                                .catch((e) => toast.error(String(e)));
                            }}
                          >
                            {tr('task.stop')}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={tr('task.more')}
                        className="text-muted-foreground"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {options.onRename && (
                        <DropdownMenuItem onClick={() => setRenaming({ id: t.id, label: t.label })}>
                          {tr('task.rename')}
                        </DropdownMenuItem>
                      )}
                      {/*
                       * 以此为模板新建：带来源 id 跳新建页，五个模块的新建页都解析
                       * ?from= 预填（train/eval/export/deploy/scripts）。
                       */}
                      <DropdownMenuItem
                        onClick={() => navigate(`${module.path}/new?from=${encodeURIComponent(t.id)}`)}
                      >
                        {tr('task.useAsTemplate')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        )}
      </Column>

      {/* 重命名弹窗放列表外层：不在任何行内，portal 事件不会窜到行点击 */}
      {renaming && options.onRename && (
        <RenameDialog
          key={renaming.id}
          target={renaming}
          onConfirm={options.onRename}
          onClose={() => setRenaming(null)}
        />
      )}
    </>
  );
}
