import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronUp, X } from 'lucide-react';
import { Panel } from '@/components/TaskDetailShell';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { MultiLineChart, type ChartSeries } from '@/components/charts/MultiLineChart';
import { fsTool } from '@/api/tools';
import { listTrains, trainTaskLabel, type TrainTaskInfo } from '@/api/train';
import { diffLines, type DiffLine } from './diff';
import { useT, type MessageKey } from '@/i18n';

/**
 * 训练实验对比页：训练列表多选若干任务进来，对比三样东西——
 * 指标曲线（多序列叠加）、训练参数（键并集表格，差异行高亮）、
 * 代码形态的训练代码 diff（第一个选中为基准，可切换）。
 *
 * 数据全部来自 GET /api/train（与详情页同源）；代码内容走 fs 工具读
 * workspace/train-code/<id>.py（与新建页模板回填同一通道）。
 */

/** 对比序列色板：--chart-1..5 循环（消融实验一般 2-5 个任务） */
const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const colorOf = (i: number) => PALETTE[i % PALETTE.length];

const STATUS_TEXT: Record<TrainTaskInfo['status'], MessageKey> = {
  running: 'task.running',
  done: 'task.done',
  failed: 'task.failed',
  stopped: 'tcmp.stopped',
};

/** 值形态归一：数组 join、未设置给 —（与「显式空串」区分） */
function fmtVal(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.length ? v.join(' ') : '—';
  return String(v);
}

/** 参数对比表的一行：key + 每个任务一格的原始值（高亮判定用全等） */
interface ParamRow {
  key: string;
  values: unknown[];
}

/** 从任务对象抽出对比用的字段：结构化字段在前（固定顺序），params/extraArgs 并入键并集 */
function paramRows(tasks: TrainTaskInfo[]): ParamRow[] {
  const fixed: Array<{ key: string; get: (t: TrainTaskInfo) => unknown }> = [
    { key: 'model', get: (t) => t.model },
    { key: 'taskType', get: (t) => t.taskType },
    { key: 'rl_type', get: (t) => t.params.rl_type },
    { key: 'tuner', get: (t) => t.tuner },
    { key: 'datasets', get: (t) => t.datasets },
    { key: 'val_datasets', get: (t) => t.valDatasets },
    { key: 'external_plugins', get: (t) => t.plugins },
    { key: 'gpus', get: (t) => t.gpus },
    { key: 'gpu_count', get: (t) => t.gpuCount },
    { key: 'extra_args', get: (t) => t.extraArgs },
  ];
  /* params 键并集（含 rl_type，但 fixed 已单独列一行——并集里剔除避免重复） */
  const paramKeys = new Set<string>();
  for (const t of tasks) {
    for (const k of Object.keys(t.params)) paramKeys.add(k);
  }
  paramKeys.delete('rl_type');
  return [
    ...fixed.map((f) => ({ key: f.key, values: tasks.map(f.get) })),
    ...[...paramKeys].sort().map((k) => ({ key: k, values: tasks.map((t) => t.params[k]) })),
  ];
}

/** 行内各任务值是否不一致（不一致的行才高亮；全一致的行是消融实验的「共享底座」） */
function rowDiffers(row: ParamRow): boolean {
  const first = row.values[0];
  return row.values.some((v) => v !== first);
}

/** 代码 diff 面板：基准 → 目标的一份差异 + 展开开关（长脚本默认折叠相同段） */
function CodeDiffBlock({
  baseLabel,
  targetLabel,
  lines,
}: {
  baseLabel: string;
  targetLabel: string;
  lines: DiffLine[];
}) {
  const [expandAll, setExpandAll] = useState(false);
  const { t } = useT();
  /* 折叠态：差异行 ±8 行上下文（与 diff 工具的习惯一致） */
  const [collapsed, view] = useMemo(() => {
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (l.type === 'same') return;
      for (let k = Math.max(0, i - 8); k <= Math.min(lines.length - 1, i + 8); k++) keep.add(k);
    });
    const out: Array<DiffLine | { type: 'skip'; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (keep.has(i) || expandAll) {
        out.push(lines[i]);
      } else if (out.at(-1)?.type !== 'skip') {
        out.push({ type: 'skip', text: '' });
      }
    }
    return [!expandAll, out] as const;
  }, [lines, expandAll]);

  if (lines.every((l) => l.type === 'same')) {
    return (
      <div className="text-muted-foreground py-4 text-center text-[13px]">
        {t('tcmp.codeIdentical', { target: targetLabel, base: baseLabel })}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-foreground text-[12.5px]">
          <span className="text-muted-foreground">{t('tcmp.base')}</span>
          {baseLabel}
          <span className="text-muted-foreground ml-3">{t('tcmp.compare')}</span>
          {targetLabel}
        </div>
        {collapsed && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11.5px]" onClick={() => setExpandAll(true)}>
            <ChevronDown size={12} /> {t('tcmp.expandAll')}
          </Button>
        )}
        {!collapsed && (
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11.5px]" onClick={() => setExpandAll(false)}>
            <ChevronUp size={12} /> {t('tcmp.collapseSame')}
          </Button>
        )}
      </div>
      <div className="border-border bg-muted/30 mt-2 overflow-x-auto rounded-md border py-2 font-mono text-[12px] leading-relaxed">
        {view.map((l, i) => {
          if (l.type === 'skip') {
            return (
              <div key={i} className="text-muted-foreground/60 px-4 py-0.5 select-none">
                {t('tcmp.folded')}
              </div>
            );
          }
          const mark = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          return (
            <div
              key={i}
              className={
                l.type === 'add'
                  ? 'bg-emerald-500/10 px-4 py-0.5'
                  : l.type === 'del'
                    ? 'bg-red-500/10 px-4 py-0.5'
                    : 'px-4 py-0.5'
              }
            >
              <span className="text-muted-foreground/70 mr-2 inline-block w-2 select-none">{mark}</span>
              <span className={l.type === 'same' ? 'text-muted-foreground' : 'text-foreground'}>{l.text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrainComparePage() {
  const { t: tr } = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [infos, setInfos] = useState<TrainTaskInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [codes, setCodes] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setInfos(await listTrains());
    } catch {
      /* keep last frame */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  /* URL ids 是唯一事实源：解析去重，找不到的任务（重启后表清零）给可见提示 */
  const ids = useMemo(
    () => [...new Set((searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean))],
    [searchParams],
  );
  const tasks = useMemo(
    () => ids.map((id) => infos.find((t) => t.id === id)).filter((t): t is TrainTaskInfo => !!t),
    [ids, infos],
  );
  const missing = ids.filter((id) => loaded && !infos.some((t) => t.id === id));

  const setSelected = (next: string[]) => {
    setSearchParams(next.length ? { ids: next.join(',') } : {}, { replace: true });
  };
  const removeTask = (id: string) => setSelected(ids.filter((x) => x !== id));

  /* 代码形态的内容：全部为 code 且 ≥2 个时才拉取（懒加载，仅一次/任务） */
  const allCode = tasks.length >= 2 && tasks.every((t) => t.taskType === 'code');
  useEffect(() => {
    if (!allCode) return;
    for (const t of tasks) {
      if (codes[t.id] !== undefined) continue;
      fsTool({ op: 'read', path: `train-code/${t.id}.py` })
        .then((r) => setCodes((prev) => ({ ...prev, [t.id]: String(r.content ?? '') })))
        .catch(() => setCodes((prev) => ({ ...prev, [t.id]: '' })));
    }
  }, [allCode, tasks, codes]);
  const codeMissing = allCode && tasks.some((t) => codes[t.id] === '');

  /* diff 基准：默认第一个选中（= 对照组），页面可点 chip 换 */
  const [baseId, setBaseId] = useState('');
  const effectiveBaseId = tasks.some((t) => t.id === baseId) ? baseId : (tasks[0]?.id ?? '');
  const baseTask = tasks.find((t) => t.id === effectiveBaseId);

  /*
   * 指标对比：按指标键分组，每键一张叠加图。键集合 = 各任务实际出现的全部键
   * （固定键 + extra KV）；有任务配了 watchMetrics 时用其交集筛选（任一任务
   * 配置了就生效——消融组通常同套配置，一个任务筛选即整组筛选）。loss 优先。
   */
  const chartGroups = useMemo(() => {
    const pick = (m: TrainTaskInfo['metrics'][number], key: string): number | undefined => {
      if (key === 'loss') return m.loss;
      if (key === 'grad_norm') return m.gradNorm;
      if (key === 'lr') return m.lr;
      const v = m.extra?.[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    const keys = new Set<string>();
    for (const t of tasks) {
      for (const m of t.metrics) {
        if (m.loss !== undefined) keys.add('loss');
        if (m.gradNorm !== undefined) keys.add('grad_norm');
        if (m.lr !== undefined) keys.add('lr');
        for (const k of Object.keys(m.extra ?? {})) keys.add(k);
      }
    }
    const watch = tasks.map((t) => t.watchMetrics).find((w) => w?.length);
    const ordered = [...(watch ? [...keys].filter((k) => watch.includes(k)) : keys)];
    ordered.sort((a, b) => (a === 'loss' ? -1 : b === 'loss' ? 1 : 0));
    return ordered.map((key) => ({
      key,
      series: tasks
        .map((t, i) => ({
          label: trainTaskLabel(t),
          color: colorOf(i),
          points: t.metrics
            .map((m) => ({ x: m.step, y: pick(m, key) }))
            .filter((p): p is { x: number; y: number } => p.y !== undefined),
        }))
        .filter((s) => s.points.length > 0),
    }));
  }, [tasks]);

  /* 每任务摘要（最终/最小 loss） */
  const summary = tasks.map((t) => {
    const losses = t.metrics.map((m) => m.loss).filter((l): l is number => l !== undefined);
    return {
      t,
      final: losses.at(-1),
      min: losses.length ? Math.min(...losses) : undefined,
    };
  });

  /* 未选够 / 全部失效时的引导态 */
  if (loaded && tasks.length < 2) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <PageHeader
          title={tr('tcmp.title')}
          desc={tr('tcmp.descEmpty')}
          back={
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate('/train')}>
              <ArrowLeft size={14} /> {tr('shell.backToList', { module: tr('nav.train') })}
            </Button>
          }
        />
        <Panel title={tr('tcmp.pick')}>
          <div className="text-muted-foreground py-6 text-center text-[13px]">
            {ids.length === 0
              ? tr('tcmp.emptyHint')
              : `${tr('tcmp.urlTasks', { n: ids.length })}${missing.length ? tr('tcmp.missingSuffix') : ''}${tr('tcmp.notEnough')}`}
          </div>
        </Panel>
      </div>
    );
  }

  const rows = paramRows(tasks);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <PageHeader
        title={tr('tcmp.title')}
        desc={tr('tcmp.desc')}
        back={
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate('/train')}>
            <ArrowLeft size={14} /> {tr('shell.backToList', { module: tr('nav.train') })}
          </Button>
        }
      />

      {/* 参与实验 chip：可移除、可换 diff 基准 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tasks.map((t, i) => {
          const isBase = t.id === effectiveBaseId;
          return (
            <span
              key={t.id}
              className="border-border bg-card flex items-center gap-2 rounded-full border py-1 pr-2 pl-2.5 text-[12.5px]"
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorOf(i) }} />
              <button type="button" className="max-w-56 truncate hover:underline" onClick={() => setBaseId(t.id)}>
                {trainTaskLabel(t)}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => removeTask(t.id)}
              >
                <X size={13} />
              </button>
              {isBase && <span className="text-muted-foreground text-[11px]">{tr('tcmp.diffBase')}</span>}
            </span>
          );
        })}
      </div>

      {missing.length > 0 && (
        <div className="border-border bg-muted/30 mb-4 rounded-md border px-3 py-2 text-[12.5px] text-muted-foreground">
          {tr('tcmp.skipped', { n: missing.length })}
        </div>
      )}

      <div className="space-y-5">
        {/* 一、每任务摘要 */}
        <div className="flex flex-wrap gap-3">
          {summary.map(({ t, final, min }) => (
            <div key={t.id} className="bg-card border-border rounded-lg border px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium">{trainTaskLabel(t)}</span>
                <span className="text-muted-foreground text-[11.5px]">
                  {tr(STATUS_TEXT[t.status])}
                  {t.step !== undefined ? ` · step ${t.step}${t.totalSteps ? `/${t.totalSteps}` : ''}` : ''}
                </span>
              </div>
              <div className="mt-2 flex gap-6 text-[12.5px]">
                <span className="text-muted-foreground">
                  {tr('tcmp.finalLoss')} <span className="text-foreground font-medium">{final !== undefined ? final.toFixed(4) : '—'}</span>
                </span>
                <span className="text-muted-foreground">
                  {tr('tcmp.minLoss')} <span className="text-foreground font-medium">{min !== undefined ? min.toFixed(4) : '—'}</span>
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* 二、指标曲线叠加：每指标键一张图 */}
        <Panel title={tr('task.metrics')}>
          {chartGroups.length > 0 ? (
            <div className="space-y-4">
              {chartGroups.map((g) =>
                g.series.length > 0 ? (
                  <MultiLineChart key={g.key} series={g.series} yLabel={g.key} />
                ) : null,
              )}
              <div className="text-muted-foreground text-[12px]">
                {tr('tcmp.chartNote')}
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground py-6 text-center text-[13px]">
              {tr('tcmp.noMetrics')}
            </div>
          )}
        </Panel>

        {/* 三、参数对比（键并集，差异行高亮） */}
        <Panel title={tr('tcmp.params')} padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-border border-b">
                  <th className="text-muted-foreground px-4 py-2 text-left font-normal">{tr('tcmp.paramCol')}</th>
                  {tasks.map((t, i) => (
                    <th key={t.id} className="px-4 py-2 text-left font-medium">
                      <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: colorOf(i) }} />
                      <span className="align-middle">{trainTaskLabel(t)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const differs = rowDiffers(row);
                  return (
                    <tr key={row.key} className="border-border/60 border-b last:border-b-0">
                      <td className="text-muted-foreground px-4 py-1.5 font-mono">{row.key}</td>
                      {row.values.map((v, i) => (
                        <td
                          key={i}
                          className={`px-4 py-1.5 font-mono break-all ${differs ? 'bg-amber-500/8 text-foreground' : 'text-muted-foreground'}`}
                        >
                          {fmtVal(v)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-muted-foreground px-4 py-2 text-[12px]">
            {tr('tcmp.paramNote')}
          </div>
        </Panel>

        {/* 四、代码 diff（全部为 code 形态才有） */}
        <Panel title={tr('tcmp.codeDiff')}>
          {tasks.some((t) => t.taskType !== 'code') ? (
            <div className="text-muted-foreground py-4 text-center text-[13px]">
              {tr('tcmp.codeCliOnly')}
            </div>
          ) : codeMissing ? (
            <div className="text-muted-foreground py-4 text-center text-[13px]">
              {tr('tcmp.codeMissing')}
            </div>
          ) : baseTask && codes[baseTask.id] !== undefined ? (
            <div className="space-y-5">
              {tasks
                .filter((t) => t.id !== baseTask.id)
                .map((t) => (
                  <CodeDiffBlock
                    key={t.id}
                    baseLabel={trainTaskLabel(baseTask)}
                    targetLabel={trainTaskLabel(t)}
                    lines={diffLines(codes[baseTask.id], codes[t.id])}
                  />
                ))}
              <div className="text-muted-foreground text-[12px]">{tr('tcmp.diffBaseHint')}</div>
            </div>
          ) : (
            <div className="text-muted-foreground py-4 text-center text-[13px]">{tr('tcmp.loadingCode')}</div>
          )}
        </Panel>
      </div>

    </div>
  );
}
