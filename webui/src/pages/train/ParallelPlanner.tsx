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
import {
  DIM_TABLE, defaultSpecFor, efficiencyEstimate, specFits, specToString, specWorld,
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
              return (
                <g key={i}>
                  <rect x={x} y={y} width={CARD_W} height={CARD_H} rx={4}
                    fill={row.colocate ? g.color + '26' : g.color + '33'} stroke={g.color} strokeWidth={1}
                    opacity={row.colocate ? 0.75 : row.vllm && i >= engineWorld ? 0.3 : 1}
                    strokeDasharray={row.vllm && i >= engineWorld ? '3 2' : undefined} />
                  <text x={x + CARD_W / 2} y={y + CARD_H / 2 - 2} textAnchor="middle" className="fill-foreground" style={{ fontSize: 10, fontWeight: 600 }}>
                    {cardNo !== null ? t('planner.cardLabel', { no: cardNo }) : `r${row.ranks[i] ?? i}`}
                  </text>
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
      <g transform={`translate(${width - 140}, ${height - 14})`}>
        <line x1={0} y1={0} x2={18} y2={0} stroke="currentColor" strokeWidth={1.6} opacity={0.6} />
        <text x={22} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendTp')}</text>
        <path d="M 60 -3 l 6 -3 l 0 6 z" fill="currentColor" opacity={0.6} />
        <text x={70} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendPp')}</text>
        <line x1={118} y1={0} x2={136} y2={0} stroke="currentColor" strokeDasharray="5 3" strokeWidth={1.2} opacity={0.6} />
        <text x={140} y={3} className="fill-muted-foreground" style={{ fontSize: 9 }}>{t('planner.legendColocate')}</text>
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
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && model.trim() && !structure && !structureLoading && !structureError) onFetchStructure();
  }, [open, model, structure, structureLoading, structureError, onFetchStructure]);

  const setSpec = (key: string, dim: keyof SpecDims, v: number | boolean) => {
    const prev = plan.specs[key] ?? defaultSpecFor(groups.find((g) => g.key === key)?.cards ?? 1);
    onPlanChange({ ...plan, specs: { ...plan.specs, [key]: { ...prev, [dim]: v } as SpecDims } });
  };
  const modelGroup = groups.find((g) => g.key === 'model');
  const modelSpec = plan.specs.model ?? defaultSpecFor(modelGroup?.cards ?? 1);
  /* 显存：spec 映射（fsdp>1 ≈ ZeRO3 分片；cp 并入激活缩减） */
  const est = memory.estimate(modelSpec, plan.zero);
  const eff = efficiencyEstimate(modelSpec);
  const backend = plan.backend;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-[12px]">
          <Cpu className="size-3.5" /> {t('planner.triggerLabel')}{groups.length > 1 ? t('planner.groupCountSuffix', { n: groups.length }) : ''}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
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
              onChange={(v) => onPlanChange({ ...plan, backend: v as Backend })}
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

          {/* 组清单：每组一块调节区 */}
          <div className="space-y-2.5">
            {groups.map((g) => {
              const spec = plan.specs[g.key] ?? defaultSpecFor(g.cards);
              const fits = g.kind === 'mesh' ? specFits(plan.specs[g.key] ?? defaultSpecFor(g.cards), g.cards) : true;
              const flagText = g.kind === 'vllm'
                ? `--vllm_data_parallel_size ${plan.vllmDims.dp}${plan.vllmDims.tp > 1 ? ` · --vllm_tensor_parallel_size ${plan.vllmDims.tp}` : ''}${plan.vllmDims.pp > 1 ? ` · --vllm_pipeline_parallel_size ${plan.vllmDims.pp}` : ''}`
                : `--${g.flag} ${specToString(spec) ?? t('planner.specFlagDefault')}`;
              return (
                <div key={g.key} className="border-border/60 rounded-lg border p-3" style={{ borderLeft: `3px solid ${g.color}` }}>
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[13px] font-semibold">{t(g.label)}{g.count > 1 && <span className="text-muted-foreground font-normal"> ×{g.count}</span>}</span>
                    {g.detail && <span className="text-muted-foreground text-[11px]">{t(g.detail.key, g.detail.vars)}</span>}
                    <span className="text-muted-foreground text-[11px]">{t('planner.cardsPerGroup', { n: g.cards })}</span>
                    <code className="bg-muted/60 rounded px-1.5 py-0.5 font-mono text-[11px]">{flagText}</code>
                    {!fits && <span className="text-destructive text-[11px] font-medium">{t('planner.specFit', { cards: g.cards, world: specWorld(spec) })}</span>}
                  </div>
                  {g.kind === 'vllm' ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <DimStepper label={t('planner.dpLabel')} value={plan.vllmDims.dp} max={32} onChange={(v) => onPlanChange({ ...plan, vllmDims: { ...plan.vllmDims, dp: v } })} title="vllm_data_parallel_size" />
                      <DimStepper label="tp" value={plan.vllmDims.tp} max={8} onChange={(v) => onPlanChange({ ...plan, vllmDims: { ...plan.vllmDims, tp: v } })} title={t('planner.tpTitle')} />
                      <DimStepper label="pp" value={plan.vllmDims.pp} max={4} onChange={(v) => onPlanChange({ ...plan, vllmDims: { ...plan.vllmDims, pp: v } })} title="vllm_pipeline_parallel_size" />
                      <span className={`text-[11px] ${g.cards === 0 || plan.vllmDims.dp * plan.vllmDims.tp * plan.vllmDims.pp === g.cards ? 'text-muted-foreground' : 'text-destructive font-medium'}`}>
                        {g.cards === 0
                          ? t('planner.colocateNote')
                          : t('planner.engineWorld', { world: plan.vllmDims.dp * plan.vllmDims.tp * plan.vllmDims.pp, cards: g.cards })}
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      {DIM_TABLE.map((d) => (
                        <DimStepper
                          key={d.key}
                          label={d.label}
                          value={spec[d.key] as number}
                          max={64}
                          disabled={backend === 'transformers' && !d.tf}
                          title={backend === 'transformers' && !d.tf ? t('planner.dimDisabledTitle') : d.rank ? t('planner.dimRankTitle') : t('planner.dimMeshTitle')}
                          onChange={(v) => setSpec(g.key, d.key, v)}
                        />
                      ))}
                      {backend === 'transformers' && g.key === 'model' && (
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground w-10 font-mono text-[11px]">ZeRO</span>
                          <SegmentedControl
                            value={String(plan.zero)}
                            onChange={(v) => onPlanChange({ ...plan, zero: Number(v) as ParallelPlan['zero'] })}
                            options={[0, 1, 2, 3].map((z) => ({ value: String(z), label: String(z) }))}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {groups.length === 0 && <p className="text-muted-foreground text-sm">{t('planner.emptyGroups')}</p>}
          </div>

          {/* SVG 卡连接拓扑 */}
          <div>
            <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-[0.08em] uppercase">{t('planner.topologyTitle')}</div>
            <div className="bg-muted/30 rounded-lg border p-2">
              <TopologySvg groups={groups} plan={plan} cards={cards} totalCards={Math.max(1, totalCards)} />
            </div>
          </div>

          {/* 显存与效率 */}
          <div className="grid grid-cols-2 gap-4">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
