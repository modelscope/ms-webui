import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { CopyButton } from '@/components/CopyText';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n';
import { previewWorkflowOutput, type PreviewReply } from '../../api/workflow';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

/**
 * 节点输出的有界预览：preview 命令是会话里唯一物化重载荷引用的地方
 * （点击才 lazy-collect），所以这里就是「查看输出」的真相源——run_end
 * 回执刻意零 outputs，重型数据从不跟着事件流走。
 *
 * 三层钻取对应 preview 的三档回执：节点 → lane 清单（total + 头部样本）
 * → 单 lane 的分页页（offset/limit）。分页页和标量值都带拷贝按钮。
 * 带 history 数组的 lane（train_step 的 metric、score 的 reward）先画
 * 折线图再给原始 JSON——曲线是训练监控的第一形态，JSON 是核对用的。
 */

const PAGE_LIMIT = 20;

/** 曲线系列颜色：与节点色板同亮度档，四条封顶后循环 */
const SERIES_COLORS = ['#38BDF8', '#F472B6', '#34D399', '#FBBF24'];

type HistoryPoint = Record<string, unknown>;

/** 判断一个 lane 值是否携带可画的 history 序列（每项对象、至少一个数值列） */
function curveSeries(value: unknown): { history: HistoryPoint[]; xKey: string; keys: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const history = (value as { history?: unknown }).history;
  if (!Array.isArray(history) || history.length === 0) return null;
  const points = history.filter((p): p is HistoryPoint => !!p && typeof p === 'object' && !Array.isArray(p));
  if (points.length === 0) return null;
  const xKey = points.some((p) => typeof p.optimizer_steps === 'number') ? 'optimizer_steps' : 'round';
  const keys = Array.from(new Set(points.flatMap((p) => Object.keys(p))))
    .filter((k) => k !== xKey && points.some((p) => typeof p[k] === 'number'));
  if (keys.length === 0) return null;
  return { history: points, xKey, keys };
}

/** 数值序列折线图：history 每项是 {x 轴键, ...数值列}，每列一条线 */
function MetricChart({ series }: { series: NonNullable<ReturnType<typeof curveSeries>> }) {
  const { history, xKey, keys } = series;
  const W = 560;
  const H = 168;
  const PAD = 26;
  const xs = history.map((p, i) => (typeof p[xKey] === 'number' ? (p[xKey] as number) : i));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yValues = history.flatMap((p) => keys.flatMap((k) => (typeof p[k] === 'number' ? [p[k] as number] : [])));
  if (yValues.length === 0) return null;
  let yMin = Math.min(...yValues);
  let yMax = Math.max(...yValues);
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  const sx = (x: number) => PAD + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * (W - 2 * PAD));
  const sy = (y: number) => H - PAD - ((y - yMin) / (yMax - yMin)) * (H - 2 * PAD);
  const single = history.length === 1;
  return (
    <div className="bg-muted/60 rounded-[10px] p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-border" strokeWidth="1" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-border" strokeWidth="1" />
        {keys.map((k, ki) => {
          const pts = history
            .map((p, i) => (typeof p[k] === 'number' ? `${sx(xs[i]).toFixed(1)},${sy(p[k] as number).toFixed(1)}` : ''))
            .filter(Boolean)
            .join(' ');
          return (
            <g key={k}>
              <polyline
                points={pts}
                fill="none"
                stroke={SERIES_COLORS[ki % SERIES_COLORS.length]}
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              {single && typeof history[0][k] === 'number' && (
                <circle cx={sx(xs[0])} cy={sy(history[0][k] as number)} r="3"
                        fill={SERIES_COLORS[ki % SERIES_COLORS.length]} />
              )}
            </g>
          );
        })}
        <text x={PAD} y={PAD - 8} className="fill-muted-foreground" fontSize="10">{yMax.toFixed(3)}</text>
        <text x={PAD} y={H - PAD + 14} className="fill-muted-foreground" fontSize="10">{yMin.toFixed(3)}</text>
        <text x={W - PAD} y={H - PAD + 14} textAnchor="end" className="fill-muted-foreground" fontSize="10">
          {xKey === 'round' ? `round ${xMax}` : `step ${xMax}`}
        </text>
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 pt-1 text-[11px]">
        {keys.map((k, ki) => {
          const last = [...history].reverse().find((p) => typeof p[k] === 'number');
          return (
            <span key={k} className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full"
                    style={{ background: SERIES_COLORS[ki % SERIES_COLORS.length] }} />
              <span className="font-mono">{k}</span>
              {last && <span className="text-muted-foreground tabular">{String(last[k])}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** 一行/一个标量的可读形态：对象走缩进 JSON，标量原样 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function LaneBody({
  reply,
  onOffset,
}: {
  reply: PreviewReply;
  onOffset: (offset: number) => void;
}) {
  const { t } = useT();
  /* 分页 lane：rows 逐行渲染；标量 lane：value 单块。两者都给拷贝。 */
  if (Array.isArray(reply.rows)) {
    const offset = reply.offset ?? 0;
    const total = reply.total ?? reply.rows.length;
    const page = Math.floor(offset / PAGE_LIMIT) + 1;
    const pages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
    const payload = JSON.stringify(reply.rows, null, 2);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="text-muted-foreground flex items-center justify-between text-[11px]">
          <span>
            {t('wf.previewRange', { from: total ? offset + 1 : 0, to: Math.min(offset + PAGE_LIMIT, total), total })}
          </span>
          <div className="flex items-center gap-1">
            <CopyButton text={payload} label={t('wf.previewCopyPage')} />
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-1.5"
              disabled={offset <= 0}
              onClick={() => onOffset(offset - PAGE_LIMIT)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="tabular px-1">{page} / {pages}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-1.5"
              disabled={offset + PAGE_LIMIT >= total}
              onClick={() => onOffset(offset + PAGE_LIMIT)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <pre className="bg-muted text-foreground min-h-0 flex-1 overflow-auto rounded-[10px] px-3 py-2.5 font-mono text-[11.5px] leading-[18px]">
          {reply.rows.map((row, i) => (
            <span key={i}>
              <span className="text-muted-foreground mr-2 select-none">{(reply.offset ?? 0) + i}</span>
              {renderValue(row)}
              {'\n'}
            </span>
          ))}
        </pre>
      </div>
    );
  }
  const series = curveSeries(reply.value);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex justify-end">
        <CopyButton text={renderValue(reply.value)} label={t('wf.previewCopyValue')} />
      </div>
      {series && <MetricChart series={series} />}
      <pre className="bg-muted text-foreground min-h-0 flex-1 overflow-auto rounded-[10px] px-3 py-2.5 font-mono text-[11.5px] leading-[18px]">
        {renderValue(reply.value)}
      </pre>
    </div>
  );
}

export function OutputPreview({
  sessionId,
  nodeId,
  onPopup,
}: {
  sessionId: string;
  nodeId: string;
  /** 传入时渲染「弹出大窗」按钮而不是内嵌大窗本体 */
  onPopup?: () => void;
}) {
  const { t } = useT();
  const [overview, setOverview] = useState<PreviewReply | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [lane, setLane] = useState('');
  const [page, setPage] = useState<PreviewReply | null>(null);
  const [pageError, setPageError] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchPage = useCallback(async (target: string, offset: number) => {
    setLoading(true);
    setPageError('');
    try {
      const reply = await previewWorkflowOutput(sessionId, {
        nodeId, lane: target, offset, limit: PAGE_LIMIT,
      });
      if (reply.ok) {
        setPage(reply);
      } else {
        setPage(null);
        setPageError(reply.error ?? t('wf.previewUnavailable'));
      }
    } catch (error) {
      setPage(null);
      setPageError(String(error));
    } finally {
      setLoading(false);
    }
  }, [sessionId, nodeId, t]);

  /* 换节点重新拉 lane 清单；同节点切 lane 时复位页游标 */
  useEffect(() => {
    setOverview(null);
    setOverviewError('');
    setLane('');
    setPage(null);
    setPageError('');
    let alive = true;
    previewWorkflowOutput(sessionId, { nodeId })
      .then((reply) => {
        if (!alive) return;
        if (reply.ok) setOverview(reply);
        else setOverviewError(reply.error ?? t('wf.previewUnavailable'));
      })
      .catch((error) => {
        if (alive) setOverviewError(String(error));
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, nodeId]);

  const selectLane = (key: string) => {
    setLane(key);
    setPage(null);
    setPageError('');
    void fetchPage(key, 0);
  };

  /* 重新拉取：曲线随轮次推进，点一下就能看到新一轮的点 */
  const refresh = useCallback(() => {
    previewWorkflowOutput(sessionId, { nodeId })
      .then((reply) => {
        if (reply.ok) setOverview(reply);
        else setOverviewError(reply.error ?? t('wf.previewUnavailable'));
      })
      .catch((error) => setOverviewError(String(error)));
    if (lane) void fetchPage(lane, 0);
  }, [sessionId, nodeId, lane, fetchPage, t]);

  if (overviewError) {
    return (
      <div className="text-muted-foreground rounded-[10px] border border-border bg-secondary px-3 py-2.5 text-[12px] leading-[18px]">
        {overviewError}
      </div>
    );
  }
  if (!overview?.lanes) return null;
  const laneKeys = Object.keys(overview.lanes);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px]">{t('wf.previewLanes')}</span>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-6 gap-1 px-2" onClick={refresh}>
            <RefreshCw className="h-3 w-3" /> {t('wf.previewRefresh')}
          </Button>
          {onPopup && (
            <Button variant="outline" size="sm" className="h-6 gap-1 px-2" onClick={onPopup}>
              <Maximize2 className="h-3 w-3" /> {t('wf.previewPopup')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {laneKeys.map((key) => {
          /* A lane whose value is None (an optional channel the round did
           * not produce, e.g. advantage.returns outside GAE) summarizes as
           * null -- show the bare name instead of crashing on .total. */
          const summary = overview.lanes![key];
          const total = typeof summary?.total === 'number' ? summary.total : null;
          return (
            <button
              key={key}
              type="button"
              onClick={() => selectLane(key)}
              className={cn(
                'rounded-md border px-2 py-1 font-mono text-[11.5px] transition-colors',
                lane === key
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-foreground/20',
              )}
            >
              {key}
              {total !== null && <span className="ml-1 tabular opacity-70">×{total}</span>}
            </button>
          );
        })}
      </div>
      {lane && (loading && !page ? (
        <div className="text-muted-foreground px-1 text-[12px]">{t('wf.previewLoading')}</div>
      ) : pageError ? (
        <div className="text-state-failed px-1 text-[12px]">{pageError}</div>
      ) : page ? (
        <LaneBody reply={page} onOffset={(offset) => void fetchPage(lane, offset)} />
      ) : null)}
    </div>
  );
}

/** 输出预览的大窗形态：同一组件、更大的舞台（分页 + 拷贝都在） */
export function OutputPreviewDialog({
  sessionId,
  nodeId,
  nodeLabel,
  open,
  onOpenChange,
}: {
  sessionId: string;
  nodeId: string;
  nodeLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {nodeLabel}
            <span className="text-muted-foreground ml-2 font-mono text-[11px]">{nodeId}</span>
          </DialogTitle>
        </DialogHeader>
        {open && (
          <OutputPreview sessionId={sessionId} nodeId={nodeId} />
        )}
        <p className="text-muted-foreground text-[11px]">{t('wf.previewBoundedNote')}</p>
      </DialogContent>
    </Dialog>
  );
}
