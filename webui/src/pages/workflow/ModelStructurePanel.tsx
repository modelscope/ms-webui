import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Brain, ChevronDown, ChevronRight, Eye, Layers3, Loader2 } from 'lucide-react';
import { cn } from 'cn';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n';
import type { GraphNode, TFn } from './nodeTypes';
import { serializeNodeParams } from './nodeTypes';
import {
  inspectModelStructure,
  type ModelStructure,
  type StructureNode,
  type WorkflowNodeDecl,
} from '../../api/workflow';

interface StatusStyle {
  dot: string;
  chip: string;
  key: MessageKey;
}

const FROZEN: StatusStyle = {
  dot: 'bg-muted-foreground/40',
  chip: 'border-border bg-muted/40 text-muted-foreground',
  key: 'wf.structFrozen',
};

/** 状态 → 树中圆点、详情 chip 与文案的唯一来源；新增状态只改这张表。 */
const STATUS_META: Record<string, StatusStyle> = {
  full_trainable: {
    dot: 'bg-emerald-500',
    chip: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600',
    key: 'wf.structFullTrainable',
  },
  adapter_trainable: {
    dot: 'bg-orange-500',
    chip: 'border-orange-500/50 bg-orange-500/10 text-orange-600',
    key: 'wf.structAdapterTrainable',
  },
  adapter_estimated: {
    dot: 'bg-orange-500',
    chip: 'border-orange-500/40 bg-orange-500/5 text-orange-600',
    key: 'wf.structAdapterEstimated',
  },
  trainable_copy: {
    dot: 'bg-violet-500',
    chip: 'border-violet-500/50 bg-violet-500/10 text-violet-600',
    key: 'wf.structTrainableCopy',
  },
  /** 冻结规则/可训名单解开了部分底座：既不是全参也不是纯 adapter。 */
  trainable_base: {
    dot: 'bg-teal-500',
    chip: 'border-teal-500/50 bg-teal-500/10 text-teal-600',
    key: 'wf.structTrainableBase',
  },
  mixed: {
    dot: 'bg-blue-500',
    chip: 'border-blue-500/40 bg-blue-500/10 text-blue-600',
    key: 'wf.structMixed',
  },
  frozen_base: FROZEN,
  frozen_adapter: FROZEN,
  frozen_copy: FROZEN,
  unknown: {
    dot: 'border border-muted-foreground/60 bg-background',
    chip: 'border-border bg-background text-muted-foreground',
    key: 'wf.structUnknown',
  },
  empty: {
    dot: 'bg-muted-foreground/40',
    chip: 'border-border bg-background text-muted-foreground',
    key: 'wf.structEmpty',
  },
};

/** 图例顺序：从冻结到待测算，同色的状态相邻。 */
const LEGEND_ORDER = [
  'frozen_base',
  'frozen_adapter',
  'frozen_copy',
  'adapter_estimated',
  'adapter_trainable',
  'full_trainable',
  'trainable_base',
  'trainable_copy',
  'mixed',
  'unknown',
  'empty',
];

function statusLabel(status: string | undefined, t: TFn): string {
  const key = status ? STATUS_META[status]?.key : undefined;
  return key ? t(key) : (status ?? t('wf.structUnknown'));
}

function formatCount(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function partIcon(part: string) {
  if (part === 'vit') return <Eye />;
  if (part === 'llm') return <Brain />;
  return <Layers3 />;
}

export function ModelStructurePanel({ node }: { node: GraphNode }) {
  const { t } = useT();
  const declaration = useMemo<WorkflowNodeDecl>(() => ({
    id: node.id,
    type: node.type,
    params: serializeNodeParams(node),
  }), [node]);
  const declarationKey = JSON.stringify(declaration);
  const megatron = declaration.params.backend === 'megatron';
  const [structure, setStructure] = useState<ModelStructure>();
  const [measurement, setMeasurement] = useState<ModelStructure>();
  const [exact, setExact] = useState(false);
  const [loading, setLoading] = useState(true);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState('');
  /** structure 对应的声明键：meta 只对"配置档已经回来"的声明发起，避免改参数时白跑一次精确测算。 */
  const [structureKey, setStructureKey] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState('root');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root']));

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError('');
      setExact(false);
      setMeasurement(undefined);
      inspectModelStructure(declaration, { detail: 'config' })
        .then((result) => {
          if (cancelled) return;
          setStructure(result);
          setStructureKey(declarationKey);
          setSelectedId(result.nodes[0]?.id ?? 'root');
          setExpanded(new Set(result.nodes.filter((n) => !n.parent_id || n.parent_id === 'root').map((n) => n.id)));
        })
        .catch((reason) => {
          if (!cancelled) setError(errorText(reason));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [declarationKey, attempt]);

  useEffect(() => {
    if (!exact) {
      setMeasuring(false);
      setMeasurement(undefined);
      return;
    }
    if (structureKey !== declarationKey) return;
    let cancelled = false;
    setMeasuring(true);
    setError('');
    inspectModelStructure(declaration, { detail: 'meta' })
      .then((result) => {
        if (!cancelled) setMeasurement(result);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(errorText(reason));
          setExact(false);
        }
      })
      .finally(() => {
        if (!cancelled) setMeasuring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [declarationKey, exact, structureKey]);

  const byId = useMemo(() => new Map(structure?.nodes.map((n) => [n.id, n] as const)), [structure]);
  const selected = byId.get(selectedId) ?? structure?.nodes[0];
  const roots = structure?.nodes.filter((n) => !n.parent_id).map((n) => n.id) ?? [];
  const presentStatuses = new Set((structure?.nodes ?? [])
    .filter((n) => n.parent_id && n.training)
    .map((n) => n.training!.status));
  const legends: { className: string; label: string }[] = [];
  const legendKeys = new Set<MessageKey>();
  for (const status of LEGEND_ORDER) {
    const meta = STATUS_META[status];
    if (!presentStatuses.has(status) || legendKeys.has(meta.key)) continue;
    legendKeys.add(meta.key);
    legends.push({ className: meta.dot, label: t(meta.key) });
  }
  const total = measurement?.summary.total_params ?? structure?.summary.total_params;
  const totalSourceName = measurement?.summary.total_params_source ?? structure?.summary.total_params_source;
  const totalSource = totalSourceName === 'meta'
    ? t('wf.structVerified')
    : totalSourceName === 'safetensors'
      ? t('wf.structSafetensors')
      : totalSourceName === 'config-estimate'
        ? t('wf.structConfigEstimate')
        : t('wf.structUnknown');
  const trainable = measurement?.summary.training?.trainable_params;
  const warnings = [...(structure?.warnings ?? []), ...(measurement?.warnings ?? [])];
  const parallel = Object.entries(structure?.model.parallel ?? {})
    .filter(([, value]) => value === true || (typeof value === 'number' && value > 1));

  const selectNode = (id: string) => {
    setSelectedId(id);
    const next = new Set(expanded);
    let current = byId.get(id);
    while (current?.parent_id) {
      next.add(current.parent_id);
      current = byId.get(current.parent_id);
    }
    setExpanded(next);
  };

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-4">
      {error && (
        <div className="border-destructive/30 bg-destructive/5 text-destructive mb-2 flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs leading-5">
          <span className="min-w-0 flex-1 break-all">{error}</span>
          <button
            className="border-destructive/40 hover:bg-destructive/10 flex-none rounded border px-1.5 py-0.5"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('wf.structRetry')}
          </button>
        </div>
      )}
      {!structure && loading && (
        <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 py-10 text-xs">
          <Loader2 className="size-4 animate-spin" /> {t('wf.structLoading')}
        </div>
      )}
      {!structure && !loading && !error && <div className="text-muted-foreground py-8 text-center text-xs">—</div>}

      {structure && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-semibold">{structure.model.name || structure.model.source}</span>
                {/* 徽标跟着 detail 走：精确测算后不应还挂着「配置推导」 */}
                {structure.detail === 'config' && (
                  <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t('wf.structEstimated')}
                  </span>
                )}
                {megatron && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                    {t('wf.structMegatronStatic')}
                  </span>
                )}
                {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </div>
              <div className="text-muted-foreground mt-0.5 truncate font-mono text-[10px]" title={structure.model.source}>
                {structure.model.model_type || structure.model.architectures?.join(', ') || structure.model.source}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <SummaryCard label={t('wf.structTotal')} value={formatCount(total)} badge={totalSource} />
            <SummaryCard
              label={t('wf.structTrainable')}
              value={measuring ? '…' : formatCount(trainable)}
              badge={measurement ? t('wf.structVerified') : t('wf.structUnknown')}
              tone="text-emerald-600"
              action={(
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">{t('wf.structExact')}</span>
                  <Switch checked={exact} disabled={measuring || megatron} onCheckedChange={setExact} />
                </div>
              )}
            />
          </div>

          {megatron && (
            <div className="border-amber-500/30 bg-amber-500/5 rounded-md border px-2.5 py-2 text-[11px] leading-5 text-amber-700 dark:text-amber-400">
              {t('wf.structMegatronHint')}
            </div>
          )}

          {parallel.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {parallel.map(([key, value]) => (
                <span key={key} className="rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px]">
                  {key.toUpperCase()}={value === true ? 'on' : String(value)}
                </span>
              ))}
            </div>
          )}

          {warnings.map((warning, i) => (
            <div key={`${warning.code}-${i}`} className="border-amber-500/30 bg-amber-500/5 rounded-md border px-2.5 py-2 text-[11px] leading-5 text-amber-700 dark:text-amber-400">
              {warning.message}
            </div>
          ))}

          <section className="flex h-64 flex-none flex-col">
            <div className="text-muted-foreground mb-1.5 text-[11px] font-medium">{t('wf.structTree')}</div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg border border-border/60">
              {roots.map((id) => (
                <TreeRow
                  key={id}
                  node={byId.get(id)!}
                  depth={0}
                  selectedId={selected?.id}
                  expanded={expanded}
                  byId={byId}
                  onSelect={selectNode}
                  onToggle={toggle}
                />
              ))}
            </div>
            {legends.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                {legends.map((legend) => (
                  <LegendDot key={legend.label} className={legend.className} label={legend.label} />
                ))}
              </div>
            )}
          </section>

          {selected && (
            <section className="flex-none rounded-lg border border-border/60 bg-muted/20 p-2.5">
              <div className="text-xs font-semibold">{selected.name}</div>
              <div className="text-muted-foreground mt-0.5 break-all font-mono text-[10px]">
                {megatron && `${t('wf.structHfPath')}: `}{selected.module_path || selected.id}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <InfoChip>{selected.class_name || selected.kind}</InfoChip>
                <InfoChip>{selected.part.toUpperCase()}</InfoChip>
                {selected.repeat && <InfoChip>× {selected.repeat}</InfoChip>}
                {selected.training && (
                  <InfoChip className={STATUS_META[selected.training.status]?.chip ?? STATUS_META.unknown.chip}>
                    {statusLabel(selected.training.status, t)}
                  </InfoChip>
                )}
              </div>
              {Object.keys(selected.details).length > 0 && (
                <pre className="text-muted-foreground mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-background/70 p-2 font-mono text-[9px]">
                  {JSON.stringify(selected.details, null, 2)}
                </pre>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  node, depth, selectedId, expanded, byId, onSelect, onToggle,
}: {
  node: StructureNode;
  depth: number;
  selectedId?: string;
  expanded: Set<string>;
  byId: Map<string, StructureNode>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const open = expanded.has(node.id);
  const children = node.children.map((id) => byId.get(id)).filter((n): n is StructureNode => !!n);
  const status = node.training?.status;
  const dotClass = (status ? STATUS_META[status]?.dot : undefined) ?? FROZEN.dot;
  return (
    <>
      <div
        className={cn(
          'flex h-8 items-center border-b border-border/40 pr-1 last:border-b-0 hover:bg-accent/50',
          selectedId === node.id && 'bg-accent/70',
        )}
        style={{ paddingLeft: `${Math.min(depth, 8) * 12 + 4}px` }}
      >
        <button className="flex size-6 flex-none items-center justify-center" onClick={() => onToggle(node.id)} disabled={!children.length}>
          {children.length ? (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />) : <span className="size-1 rounded-full bg-border" />}
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onSelect(node.id)} title={node.module_path || node.id}>
          <span className={cn('size-1.5 flex-none rounded-full', dotClass)} />
          <span className="flex-none [&>svg]:size-3">{partIcon(node.part)}</span>
          <span className="truncate text-[11px]">{node.name}</span>
          {node.repeat && <span className="text-muted-foreground flex-none text-[9px]">×{node.repeat}</span>}
          <span className="text-muted-foreground ml-auto hidden max-w-24 truncate font-mono text-[8px] sm:block">{node.class_name}</span>
        </button>
      </div>
      {open && children.slice(0, 200).map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          expanded={expanded}
          byId={byId}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
      {/* 截断要明说：深模型一层可能有上百个子模块，静默吞掉会让人以为结构不全 */}
      {open && children.length > 200 && (
        <div
          className="text-muted-foreground h-6 text-[10px] leading-6"
          style={{ paddingLeft: `${Math.min(depth + 1, 8) * 12 + 4}px` }}
        >
          +{children.length - 200}
        </div>
      )}
    </>
  );
}

function SummaryCard({
  label, value, badge, tone, action,
}: {
  label: string;
  value: string;
  badge: string;
  tone?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground truncate text-[10px]">{label}</span>
        <span className="text-muted-foreground ml-auto truncate text-[9px]">{badge}</span>
      </div>
      <div className="mt-1 flex min-h-6 items-center gap-2">
        <span className={cn('truncate text-sm font-semibold', tone)}>{value}</span>
        {action && <div className="ml-auto flex-none">{action}</div>}
      </div>
    </div>
  );
}

function InfoChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('rounded border border-border/60 bg-background px-1.5 py-0.5 text-[9px]', className)}>{children}</span>;
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={cn('size-1.5 rounded-full', className)} />{label}</span>;
}
