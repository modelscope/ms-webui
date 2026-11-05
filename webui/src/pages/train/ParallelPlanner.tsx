/**
 * 并行规划器弹窗（「显卡与分片分组」的升级形态）：不只是预览，还调节
 * parallel_spec——每个 DeviceGroup 一块调节区，维度词表按后端过滤
 * （transformers：dp/fsdp/ep/ul；megatron 全套），采样组走 vLLM 引擎
 * int flag（dp/tp/pp）。调节实时写回表单命令（实时回调，关弹窗保留）。
 *
 * 三路实时联动：SVG 卡连接拓扑（组分色框、TP 全互联线、PP 流水箭头、
 * colocate 覆盖层）、每卡显存估算（fsdp≈ZeRO3、cp 并入激活口径）、
 * 理论效率粗估（dp 线性 × tp 通信 × pp 气泡 × …，教科书口径非实测）。
 */
import { useEffect, useState } from 'react';
import { Cpu, Loader2 } from 'lucide-react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/FormField';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { ModelStructure } from '@/api/train';
import { fmtBytes, fmtParams } from './memoryEstimate';
import type { RlPlacement } from './RlGpuPlanner';
import {
  DIM_TABLE, defaultSpecFor, deriveSegments, efficiencyEstimate, specToString, specWorld,
  type Backend, type ParallelPlan, type PlannerGroup, type SpecDims,
} from './parallelSpec';

/* ---------- 小步进器（spec 维度行内调节） ---------- */

function DimStepper({
  label, value, max, disabled, title, onChange,
}: {
  label: string;
  value: number;
  max: number;
  disabled?: boolean;
  title?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1" title={title}>
      <span className={`w-12 font-mono text-[11px] ${disabled ? 'text-muted-foreground/40 line-through' : 'text-muted-foreground'}`}>{label}</span>
      <Button
        variant="outline" size="sm" className="h-5 w-5 p-0" disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
      >−</Button>
      <span className={`w-7 rounded border py-0 text-center font-mono text-[12px] ${disabled ? 'bg-muted/30 border-border/40 text-muted-foreground/40' : 'bg-muted/60 border-border/60'}`}>{value}</span>
      <Button
        variant="outline" size="sm" className="h-5 w-5 p-0" disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
      >+</Button>
    </div>
  );
}

/* ---------- SVG 卡连接拓扑：组分色框 + TP 互联线 + PP 流水箭头 ---------- */

const CARD_W = 46;
const CARD_H = 30;
const CARD_GAP = 10;

function TopologySvg({ groups, plan, cards, totalCards }: {
  groups: PlannerGroup[];
  plan: ParallelPlan;
  /** 本机模式勾选卡号（CUDA_VISIBLE_DEVICES 顺序即 rank 顺序）；集群为空显示 rank */
  cards: number[];
  totalCards: number;
}) {
  const { t } = useT();
  let rank = 0;
  const rows: Array<{
    group: PlannerGroup;
    spec?: SpecDims;
    vllm?: { dp: number; tp: number; pp: number };
    ranks: number[];
    colocate?: boolean;
    /* 多组拆行的子组序号（spread K 教师 / N orm：每组一行，共用组色与 spec） */
    sub?: number;
  }> = [];
  for (const g of groups) {
    const spec = g.kind === 'mesh' ? (plan.specs[g.key] ?? defaultSpecFor(g.cards)) : undefined;
    if (g.key === 'sampler') {
      /* colocate：采样器覆盖在训练卡上（独立 rank 空间），不占卡池新位 */
      if (g.cards === 0) { rows.push({ group: g, vllm: plan.vllmDims, ranks: [], colocate: true }); continue; }
      /* 物理卡位按段宽分配（g.cards 张，后续组 ranks 才能与「每组卡数」对齐）；
       * 引擎 world 可小于段宽——余下卡位灰显（vLLM 不起 worker，卡闲置） */
      rows.push({ group: g, vllm: plan.vllmDims, ranks: Array.from({ length: g.cards }, (_, i) => rank + i) });
      rank += g.cards;
      continue;
    }
    /* count>1（spread 多教师 / 多 orm 模型）：拆成独立子组行，拓扑与真实设备布局一致 */
    for (let c = 0; c < g.count; c++) {
      rows.push({ group: g, spec, ranks: Array.from({ length: g.cards }, () => rank++), sub: g.count > 1 ? c + 1 : undefined });
    }
  }
  const used = rank;
  const width = Math.max(totalCards, 1) * (CARD_W + CARD_GAP) + 150;
  const rowH = CARD_H + 34;
  const height = rows.length * rowH + 20;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ minWidth: 480 }}>
      {rows.map((row, r) => {
        const y = 14 + r * rowH;
        const g = row.group;
        const n = row.colocate
          ? (groups.find((x) => x.key === 'model')?.cards ?? 0)
          : row.ranks.length;
        const spec = row.spec;
        const engineWorld = row.vllm ? row.vllm.dp * row.vllm.tp * row.vllm.pp : 0;
        const tp = row.vllm ? row.vllm.tp : (spec?.tp ?? 1);
        const pp = row.vllm ? row.vllm.pp : (spec?.pp ?? 1);
        /* 子组归属标注（对齐 DeviceMesh.from_sizes 的 rank 布局：tp 最内、cp 次之、
         * dp/fsdp 再次、pp 最外）：每卡标 dp 副本号与 pp 段号；vllm 行仅标引擎实际占用的卡 */
        const cp = row.vllm ? 1 : (spec?.cp ?? 1);
        const dpTotal = row.vllm ? row.vllm.dp : (spec?.dp ?? 1) * (spec?.fsdp ?? 1);
        const engineLimit = row.vllm ? engineWorld : n;
        const subOf = (i: number): string => {
          if (i >= engineLimit) return '';
          const parts: string[] = [];
          if (dpTotal > 1) parts.push(`d${Math.floor(i / (cp * tp))}`);
          if (pp > 1) parts.push(`p${Math.floor(i / (dpTotal * cp * tp))}`);
          return parts.join('·');
        };
        return (
          <g key={g.key + r}>
            <rect x={148} y={y - 8} width={n * (CARD_W + CARD_GAP) - CARD_GAP + 8} height={CARD_H + 16} rx={8}
              fill={g.color + '14'} stroke={g.color} strokeDasharray={row.colocate ? '5 3' : undefined} strokeWidth={1.2} />
            <text x={8} y={y + 8} className="fill-foreground" style={{ fontSize: 11, fontWeight: 600 }}>{t(g.label)}{row.sub !== undefined && <tspan className="fill-muted-foreground" style={{ fontWeight: 400 }}> #{row.sub}</tspan>}</text>
            <text x={8} y={y + 21} className="fill-muted-foreground" style={{ fontSize: 10 }}>
              {row.colocate ? t('planner.rowColocate') : `${t('planner.rowCards', { n })}${row.sub !== undefined ? t('planner.rowSub', { sub: row.sub, count: g.count }) : ''}${spec ? ` · ${specToString(spec) ?? t('planner.pureDp')}` : row.vllm ? ` · dp${row.vllm.dp}×tp${row.vllm.tp}${n > engineWorld ? t('planner.engineIdle', { world: engineWorld, n: n - engineWorld }) : ''}` : ''}`}
            </text>
            {Array.from({ length: n }, (_, i) => {
              const x = 152 + i * (CARD_W + CARD_GAP);
              const base = row.ranks[0] ?? 0;
              const cardNo = cards.length > i + base ? cards[base + i] : null;
              const sub = subOf(i);
              return (
                <g key={i}>
                  {/* DP 副本边界（虚竖线）：左右两卡分属不同数据并行副本，无互联 */}
                  {dpTotal > 1 && i > 0 && i < engineLimit && i % (cp * tp) === 0 && (
                    <line x1={x - CARD_GAP / 2} y1={y - 8} x2={x - CARD_GAP / 2} y2={y + CARD_H + 8}
                      stroke="currentColor" strokeDasharray="3 3" strokeWidth={1} opacity={0.25} />
                  )}
                  <rect x={x} y={y} width={CARD_W} height={CARD_H} rx={4}
                    fill={row.colocate ? g.color + '26' : g.color + '33'} stroke={g.color} strokeWidth={1}
                    opacity={row.colocate ? 0.75 : row.vllm && i >= engineWorld ? 0.3 : 1}
                    strokeDasharray={row.vllm && i >= engineWorld ? '3 2' : undefined} />
                  <text x={x + CARD_W / 2} y={y + CARD_H / 2 - (sub ? 4 : 2)} textAnchor="middle" className="fill-foreground" style={{ fontSize: 10, fontWeight: 600 }}>
                    {cardNo !== null ? t('planner.cardLabel', { no: cardNo }) : `r${row.ranks[i] ?? i}`}
                  </text>
                  {sub && (
                    <text x={x + CARD_W / 2} y={y + CARD_H / 2 + 7} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 7 }}>{sub}</text>
                  )}
                  {tp > 1 && i < n - 1 && (i + 1) % tp !== 0 && (
                    <line x1={x + CARD_W} y1={y + CARD_H / 2} x2={x + CARD_W + CARD_GAP} y2={y + CARD_H / 2} stroke={g.color} strokeWidth={1.6} />
                  )}
                  {pp > 1 && (i + 1) % (n / pp) === 0 && i < n - 1 && (
                    <path d={`M ${x + CARD_W + 2} ${y + CARD_H / 2} l 6 -3 l 0 6 z`} fill={g.color} />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
      {totalCards > used && (
        <g>
          <rect x={152 + used * (CARD_W + CARD_GAP)} y={14} width={(totalCards - used) * (CARD_W + CARD_GAP) - CARD_GAP} height={CARD_H} rx={4}
            fill="none" stroke="currentColor" strokeDasharray="4 3" opacity={0.3} />
          <text x={152 + used * (CARD_W + CARD_GAP) + 12} y={34} className="fill-muted-foreground" style={{ fontSize: 10 }}>
            {t('planner.unassigned', { n: totalCards - used })}
          </text>
        </g>
      )}
      {/* 图例 */}
      <g transform={`translate(${width - 260}, ${height - 14})`}>
        <line x1={0} y1={0} x2={18} y2={0} stroke="currentColor" strokeWidth={1.6} opacity={0.6} />
        <text x={22} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendTp')}</text>
        <path d="M 60 -3 l 6 -3 l 0 6 z" fill="currentColor" opacity={0.6} />
        <text x={70} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendPp')}</text>
        <line x1={118} y1={0} x2={136} y2={0} stroke="currentColor" strokeDasharray="5 3" strokeWidth={1.2} opacity={0.6} />
        <text x={140} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendColocate')}</text>
        <line x1={192} y1={-6} x2={192} y2={6} stroke="currentColor" strokeDasharray="3 3" strokeWidth={1} opacity={0.5} />
        <text x={198} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendDp')}</text>
      </g>
    </svg>
  );
}

/* ---------- 并行规划器弹窗 ---------- */

export function ParallelPlanner({
  model,
  structure,
  structureLoading,
  structureError,
  onFetchStructure,
  groups,
  plan,
  onPlanChange,
  cards,
  totalCards,
  /* 显存估算输入（训练组口径） */
  memory,
  /* 卡池总量（派生卡数的预算上限）；缺省用 totalCards（非在线 RL 单组 = 卡池） */
  cardsPool,
  /* 在线 RL 的放置值与确认写回：组卡数派生自 spec，确认时重写分段串 */
  placement,
  onPlacementCommit,
}: {
  model: string;
  structure: ModelStructure | null;
  structureLoading: boolean;
  structureError: string | null;
  onFetchStructure: () => void;
  /** 组清单（表单派生：算法/字段 → 训练/采样/教师/ref/orm…） */
  groups: PlannerGroup[];
  plan: ParallelPlan;
  onPlanChange: (p: ParallelPlan) => void;
  cards: number[];
  totalCards: number;
  memory: {
    tuner: 'lora' | 'full' | 'trainable_tokens';
    loraRank: number;
    batch: number;
    seqLen: number;
    gradCheckpoint: boolean;
    cardBytes: number;
    cardLabel: string;
    /** 训练组每卡显存（按 spec 联动重算），由父组件传入或内部计算 */
    estimate: (spec: SpecDims, zero: number) => { perCard: number; weights: number; grads: number; optimizer: number; activations: number; ctx: number } | null;
  };
  /** 卡池总量（预算约束）；缺省用 totalCards */
  cardsPool?: number;
  /** 在线 RL 的放置值（确认时分段串由派生值重写）；缺省 = 非在线 RL */
  placement?: RlPlacement;
  /** 确认回调：将派生的分段串写回 rlPlacement.groups */
  onPlacementCommit?: (groups: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  /* 草稿态：开弹窗时快照 plan，所有调节只改草稿——确认才落盘，取消/关闭即还原 */
  const [draft, setDraft] = useState<ParallelPlan>(() => ({ ...plan, specs: { ...plan.specs }, vllmDims: { ...plan.vllmDims } }));
  const handleOpenChange = (next: boolean): void => {
    if (next) setDraft({ ...plan, specs: { ...plan.specs }, vllmDims: { ...plan.vllmDims } });
    setOpen(next);
  };
  useEffect(() => {
    if (open && model.trim() && !structure && !structureLoading && !structureError) onFetchStructure();
  }, [open, model, structure, structureLoading, structureError, onFetchStructure]);

  const pool = cardsPool ?? totalCards;
  /* 生效组视图（自动 worldsize）：组卡数 = spec 的 rank 维乘积（specs 缺省 = 纯 DP，
   * 卡数沿用组清单带来的分配）；采样组 disaggregated = 引擎 world，colocate 覆盖训练卡为 0 */
  const effGroups: PlannerGroup[] = groups.map((g) => {
    if (g.kind === 'vllm') {
      return g.cards === 0 ? g : { ...g, cards: draft.vllmDims.dp * draft.vllmDims.tp * draft.vllmDims.pp };
    }
    return { ...g, cards: specWorld(draft.specs[g.key] ?? defaultSpecFor(g.cards)) };
  });
  /* 卡池预算：某组扩卡时其余组占用扣减后的余额（count>1 的组按每段算） */
  const othersCards = (g: PlannerGroup): number =>
    effGroups.filter((x) => x.key !== g.key).reduce((a, x) => a + x.cards * Math.max(1, x.count), 0);
  const groupBudget = (g: PlannerGroup): number =>
    Math.max(1, Math.floor((pool - othersCards(g)) / Math.max(1, g.count)));
  const actorEffCards = effGroups.find((g) => g.key === 'model')?.cards ?? 0;
  const engineWorld = draft.vllmDims.dp * draft.vllmDims.tp * draft.vllmDims.pp;
  const colocateSampler = effGroups.some((g) => g.key === 'sampler' && g.cards === 0);
  /* 超限（确认禁用）：合计超卡池；colocate 引擎 world 超训练组卡数（sampler_world ≤ nproc 硬约束） */
  const totalEffCards = effGroups.reduce((a, g) => a + g.cards * Math.max(1, g.count), 0);
  const poolOverflow = totalEffCards > pool;
  const colocateOverflow = colocateSampler && engineWorld > actorEffCards;
  const canConfirm = !poolOverflow && !colocateOverflow;

  /* 确认：草稿落盘（并行计划 + 派生分段串），关闭弹窗 */
  const commit = (): void => {
    onPlanChange(draft);
    if (placement && onPlacementCommit) {
      onPlacementCommit(deriveSegments(draft, groups, placement.placement));
    }
    setOpen(false);
  };

  const setSpec = (key: string, dim: keyof SpecDims, v: number | boolean) => {
    const g = groups.find((x) => x.key === key);
    const prev = draft.specs[key] ?? defaultSpecFor(g?.cards ?? 1);
    const next = { ...prev, [dim]: v } as SpecDims;
    /* 自动 worldsize：调非 dp 的 rank 维时 dp 自动吸收、组卡数不变；余数卡
     * 放不下时不吸收（world 变大），交给卡池超限告警与确认门禁 */
    const meta = DIM_TABLE.find((d) => d.key === dim);
    if (meta?.rank && dim !== 'dp') {
      const rest = specWorld({ ...next, dp: 1 });
      const world = specWorld(prev);
      if (rest > 0 && world % rest === 0) next.dp = world / rest;
    }
    setDraft({ ...draft, specs: { ...draft.specs, [key]: next } });
  };
  const modelGroup = effGroups.find((g) => g.key === 'model');
  const modelSpec = draft.specs.model ?? defaultSpecFor(modelGroup?.cards ?? 1);
  /* 显存：spec 映射（fsdp>1 ≈ ZeRO3 分片；cp 并入激活缩减） */
  const est = memory.estimate(modelSpec, draft.zero);
  const eff = efficiencyEstimate(modelSpec);
  const backend = draft.backend;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[12px]">
          <Cpu className="size-3.5" /> {t('planner.triggerLabel')}{groups.length > 1 ? t('planner.groupCountSuffix', { n: groups.length }) : ''}
        </Button>
      </DialogTrigger>
      {/* sm: 变体必须显式覆盖（基类 sm:max-w-lg 与 max-w-* 不同断点，cn 不会互相顶掉），
          否则桌面端弹窗被钉在 32rem 宽，内容撑破背景框 */}
      <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{t('planner.title', { model })}</DialogTitle>
          <DialogDescription>
            {t('planner.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* 后端选择：词表与 flag 的分叉点 */}
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              value={backend}
              onChange={(v) => setDraft({ ...draft, backend: v as Backend })}
              options={[
                { value: 'transformers', label: 'transformers（hf）' },
                { value: 'megatron', label: 'megatron' },
              ]}
            />
            <span className="text-muted-foreground text-[11px]">
              {backend === 'transformers'
                ? t('planner.dimsAvailable')
                : t('planner.dimsAll')}
            </span>
            {backend === 'megatron' && <span className="text-amber-600 dark:text-amber-400 text-[11px]">{t('planner.megatronFlag')}</span>}
          </div>

          {/* 主体两栏：左为组调节区、右为卡连接拓扑（窄屏退化为堆叠） */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* 组清单：每组一块调节区 */}
            <div className="min-w-0 space-y-2.5">
              {effGroups.map((g) => {
                const spec = draft.specs[g.key] ?? defaultSpecFor(g.cards);
                const flagText = g.kind === 'vllm'
                  ? `--vllm_data_parallel_size ${draft.vllmDims.dp}${draft.vllmDims.tp > 1 ? ` · --vllm_tensor_parallel_size ${draft.vllmDims.tp}` : ''}${draft.vllmDims.pp > 1 ? ` · --vllm_pipeline_parallel_size ${draft.vllmDims.pp}` : ''}`
                  : `--${g.flag} ${specToString(spec) ?? t('planner.specFlagDefault')}`;
                /* transformers 只渲染可用维；megatron 全套但剔除 ul——ulysses 是
                 * transformers 专有维（device_mesh 标注 transformers only），megatron 下是死维 */
                const dims = DIM_TABLE.filter((d) => (backend === 'megatron' ? d.key !== 'ul' : d.tf));
                /* 派生卡数超限告警：该组占用 + 其余组占用 > 卡池 */
                const overPool = g.cards * Math.max(1, g.count) + othersCards(g) > pool;
                return (
                  <div key={g.key} className="border-border/60 rounded-lg border p-3" style={{ borderLeft: `3px solid ${g.color}` }}>
                    {/* 头部单行自适应：左为组名 + 卡数 + 说明，右侧 flag 预览（超长截断、悬停看全文） */}
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[13px] font-semibold">{t(g.label)}{g.count > 1 && <span className="text-muted-foreground font-normal"> ×{g.count}</span>}</span>
                        <span className="text-muted-foreground text-[11px]">{t('planner.cardsPerGroup', { n: g.cards })}</span>
                        {g.detail && <span className="text-muted-foreground text-[11px]">{t(g.detail.key, g.detail.vars)}</span>}
                      </div>
                      <code className="bg-muted/60 min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-[11px]" title={flagText}>{flagText}</code>
                    </div>
                    {overPool && <p className="text-destructive mt-1 text-[11px] font-medium">{t('planner.poolOverflow', { total: g.cards * Math.max(1, g.count) + othersCards(g), pool })}</p>}
                    {g.kind === 'vllm' ? (
                      <>
                        <div className="mt-2 grid grid-cols-3 gap-x-3">
                          {/* dp = 副本数即段宽：colocate 受训练组卡数硬约束，独立分片受卡池预算 */}
                          <DimStepper label={t('planner.dpLabel')} value={draft.vllmDims.dp}
                            max={g.cards === 0
                              ? Math.max(1, Math.floor(actorEffCards / Math.max(1, draft.vllmDims.tp * draft.vllmDims.pp)))
                              : Math.max(1, Math.floor(groupBudget(g) / Math.max(1, draft.vllmDims.tp * draft.vllmDims.pp)))}
                            onChange={(v) => setDraft({ ...draft, vllmDims: { ...draft.vllmDims, dp: v } })} title="vllm_data_parallel_size" />
                          <DimStepper label="tp" value={draft.vllmDims.tp} max={8} onChange={(v) => setDraft({ ...draft, vllmDims: { ...draft.vllmDims, tp: v } })} title={t('planner.tpTitle')} />
                          <DimStepper label="pp" value={draft.vllmDims.pp} max={4} onChange={(v) => setDraft({ ...draft, vllmDims: { ...draft.vllmDims, pp: v } })} title="vllm_pipeline_parallel_size" />
                        </div>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {g.cards === 0 ? t('planner.colocateNote') : t('planner.engineWorld', { world: engineWorld, cards: g.cards })}
                        </p>
                        {colocateOverflow && g.cards === 0 && (
                          <p className="mt-0.5 text-[11px] font-medium text-destructive">{t('planner.colocateOverflow', { world: engineWorld, cards: actorEffCards })}</p>
                        )}
                        {draft.vllmDims.pp > 1 && (
                          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{t('planner.vllmPpNote')}</p>
                        )}
                      </>
                    ) : (
                      <div className="mt-2 grid grid-cols-4 gap-x-3 gap-y-1.5">
                        {dims.map((d) => (
                          <DimStepper
                            key={d.key}
                            label={d.label}
                            value={spec[d.key] as number}
                            max={d.key === 'dp' ? Math.max(1, Math.floor(groupBudget(g) / Math.max(1, specWorld({ ...spec, dp: 1 })))) : 64}
                            title={d.rank ? t('planner.dimRankTitle') : t('planner.dimMeshTitle')}
                            onChange={(v) => setSpec(g.key, d.key, v)}
                          />
                        ))}
                        {backend === 'transformers' && g.key === 'model' && (
                          <div className="col-span-2 flex items-center gap-1">
                            <span className="text-muted-foreground w-10 font-mono text-[11px]">ZeRO</span>
                            <SegmentedControl
                              value={String(draft.zero)}
                              onChange={(v) => setDraft({ ...draft, zero: Number(v) as ParallelPlan['zero'] })}
                              options={[0, 1, 2, 3].map((z) => ({ value: String(z), label: String(z) }))}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {effGroups.length === 0 && <p className="text-muted-foreground text-sm">{t('planner.emptyGroups')}</p>}
            </div>

            {/* SVG 卡连接拓扑（容器内横向滚动，minWidth 不再撑破弹窗背景）：吃派生视图与草稿 */}
            <div className="min-w-0">
              <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-[0.08em] uppercase">{t('planner.topologyTitle')}</div>
              <div className="bg-muted/30 overflow-x-auto rounded-lg border p-2">
                <TopologySvg groups={effGroups} plan={draft} cards={cards} totalCards={Math.max(1, totalCards)} />
              </div>
            </div>
          </div>

          {/* 显存与效率 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-[0.08em] uppercase">{t('planner.memTitle')}</div>
              {structureLoading && <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> {t('planner.probing')}</div>}
              {structureError && <p className="text-destructive text-sm">{structureError}</p>}
              {est && structure ? (
                <>
                  <div className="flex h-4 w-full overflow-hidden rounded-sm bg-zinc-200 dark:bg-zinc-700">
                    {([
                      [t('planner.memWeights'), est.weights, 'bg-blue-500/80'],
                      [t('planner.memGrads'), est.grads, 'bg-cyan-500/80'],
                      [t('planner.memOptimizer'), est.optimizer, 'bg-violet-500/80'],
                      [t('planner.memActivations'), est.activations, 'bg-amber-500/80'],
                      [t('planner.memFixed'), est.ctx, 'bg-zinc-400/80'],
                    ] as const)
                      .filter(([, b]) => b > 0)
                      .map(([l, b, c]) => <div key={l} className={c} style={{ width: `${(b / est.perCard) * 100}%` }} title={`${l} ${fmtBytes(b)}`} />)}
                  </div>
                  <p className="mt-1.5 text-[12px] leading-5">
                    {t('planner.perCard')} <b className={memory.cardBytes > 0 && est.perCard > memory.cardBytes * 0.95 ? 'text-destructive' : ''}>{fmtBytes(est.perCard)}</b>
                    {memory.cardBytes > 0 && t('planner.ofCard', { size: fmtBytes(memory.cardBytes), label: memory.cardLabel })}
                    <span className="text-muted-foreground">{t('planner.memFootnote', {
                      source: structure.paramsSource === 'config-estimate'
                        ? t('planner.configEstimate')
                        : t('planner.exactParams', { params: fmtParams(structure.params) }),
                    })}</span>
                  </p>
                </>
              ) : (!structureLoading && !structureError && <p className="text-muted-foreground text-sm">{t('planner.memHint')}</p>)}
            </div>
            <div>
              <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-[0.08em] uppercase">{t('planner.effTitle')}</div>
              <p className="text-[13px] leading-6">
                {t('planner.effSpeedup')} <b>{eff.speedup.toFixed(1)}×</b>
                <span className="text-muted-foreground">{t('planner.effDp', { dp: modelSpec.dp })}</span>
              </p>
              {eff.factors.length === 0
                ? <p className="text-muted-foreground text-[11px]">{t('planner.effPureDp')}</p>
                : eff.factors.map((f) => (
                  <p key={f.label} className="text-[11px] leading-4">
                    <span className="font-mono">{f.label}</span> ×{f.eff.toFixed(2)} <span className="text-muted-foreground">{t(f.note, f.noteVars)}</span>
                  </p>
                ))}
              <p className="text-muted-foreground/70 mt-1 text-[10px]">{t('planner.effNote')}</p>
            </div>
          </div>

          {/* 确认 / 取消：草稿落盘或还原（Esc / 右上角关闭同取消） */}
          <div className="border-border/60 flex items-center justify-end gap-2 border-t pt-3">
            {poolOverflow && <p className="text-destructive mr-auto text-[11px] font-medium">{t('planner.poolOverflow', { total: totalEffCards, pool })}</p>}
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t('planner.cancelBtn')}</Button>
            <Button size="sm" disabled={!canConfirm} onClick={commit}>{t('planner.confirmBtn')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
