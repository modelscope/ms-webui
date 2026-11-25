/** 训练创建页的预检：右侧可训练结构 + 数据集前 N 条预览弹窗。 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/FormField';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { DatasetPreviewRow } from '@/api/train';
import { useT } from '@/i18n';
import { ModelStructurePanel } from '../workflow/ModelStructurePanel';
import type { GraphNode } from '../workflow/nodeTypes';
import { Panel } from '@/components/TaskDetailShell';
import type { SpecDims } from './parallelSpec';

const MODEL_CONFIG_KEYS = new Set([
  'model_type', 'model_revision', 'torch_dtype', 'attn_impl', 'vit_attn_impl',
  'language_model_only', 'new_special_tokens', 'num_labels', 'problem_type',
]);
const TUNER_CONFIG_KEYS = new Set([
  'adapters', 'freeze_llm', 'freeze_vit', 'freeze_aligner', 'target_modules', 'target_regex',
  'target_parameters', 'modules_to_save', 'lora_rank', 'lora_alpha', 'lora_dropout', 'lora_bias',
  'use_rslora', 'use_dora', 'init_weights', 'lorap_lr_ratio', 'lorap_emb_lr', 'trainable_token_indices',
]);
const TRAIN_CONFIG_KEYS = new Set([
  'learning_rate', 'freeze_parameters', 'freeze_parameters_regex', 'freeze_parameters_ratio',
  'trainable_parameters', 'trainable_parameters_regex',
]);
const LIST_KEYS = new Set([
  'adapters', 'target_modules', 'target_parameters', 'modules_to_save', 'new_special_tokens',
  'freeze_parameters', 'trainable_parameters',
]);

function parseExtraParams(extraArgs: string): Record<string, string | number | boolean> {
  const tokens = extraArgs.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const result: Record<string, string | number | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inline] = token.slice(2).split(/=(.*)/s);
    const values = inline !== undefined ? [inline] : [];
    while (inline === undefined && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
      values.push(tokens[++i]);
    }
    const raw = values.length
      ? values.map((value) => value.replace(/^(['"])(.*)\1$/, '$2')).join(' ')
      : 'true';
    try {
      result[rawKey] = JSON.parse(raw);
    } catch {
      result[rawKey] = raw;
    }
  }
  return result;
}

function useInspectionNode(
  model: string,
  tuner: 'lora' | 'full' | 'trainable_tokens',
  params: Record<string, string | number | boolean>,
  extraArgs: string,
  backend: 'transformers' | 'megatron',
  parallel: Partial<SpecDims>,
): GraphNode {
  return useMemo<GraphNode>(() => {
    const modelConfig: Record<string, unknown> = {};
    const tunerConfig: Record<string, unknown> = {};
    const trainConfig: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries({ ...params, ...parseExtraParams(extraArgs) })) {
      const value = LIST_KEYS.has(key) && typeof raw === 'string'
        ? raw.split(/[\s,]+/).filter(Boolean)
        : key === 'trainable_token_indices' && typeof raw === 'string'
          ? raw.split(/[\s,]+/).filter(Boolean).map(Number)
          : raw;
      if (MODEL_CONFIG_KEYS.has(key)) modelConfig[key] = value;
      if (TUNER_CONFIG_KEYS.has(key)) tunerConfig[key] = value;
      if (TRAIN_CONFIG_KEYS.has(key)) trainConfig[key] = value;
    }
    return {
      id: 'train-model', type: 'model', x: 0, y: 0, status: 'idle',
      params: [
        { label: 'model', value: model, ptype: 'str' },
        { label: 'train_type', value: tuner, ptype: 'str' },
        /* registry 的 backend 词表是 hf|megatron：UI 侧的 transformers 在这里折回 hf */
        { label: 'backend', value: backend === 'megatron' ? 'megatron' : 'hf', ptype: 'str' },
        { label: 'parallel_spec', value: JSON.stringify(parallel), ptype: 'dict' },
        { label: 'model_config', value: JSON.stringify(modelConfig), ptype: 'dict' },
        { label: 'tuner_config', value: JSON.stringify(tunerConfig), ptype: 'dict' },
        { label: 'train_config', value: JSON.stringify(trainConfig), ptype: 'dict' },
      ],
    };
  }, [model, tuner, params, extraArgs, backend, parallel]);
}

export function StructurePanel({
  model,
  editing,
  tuner,
  params,
  extraArgs,
  backend,
  parallel,
}: {
  model: string;
  editing: boolean;
  tuner: 'lora' | 'full' | 'trainable_tokens';
  params: Record<string, string | number | boolean>;
  extraArgs: string;
  backend: 'transformers' | 'megatron';
  parallel: Partial<SpecDims>;
}) {
  const { t } = useT();
  const inspectionNode = useInspectionNode(model, tuner, params, extraArgs, backend, parallel);
  return (
    <Panel title={t('pre.trainableStructure')}>
      <div className="flex h-[640px] flex-col">
        {model.trim() && !editing ? (
          <ModelStructurePanel node={inspectionNode} />
        ) : (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
            {t(editing ? 'pre.finishModelStructure' : 'pre.selectModelStructure')}
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ---------- 数据集前 N 条预览弹窗 ---------- */

function RowMessages({ messages }: { messages: Array<{ role?: string; content?: unknown }> }) {
  return (
    <div className="space-y-1">
      {messages.map((m, i) => (
        <div key={i} className="flex gap-2 text-[13px] leading-5">
          <span className="text-muted-foreground w-14 flex-none text-right">{m.role ?? '?'}</span>
          <span className="min-w-0 break-all line-clamp-6">{String(m.content ?? '')}</span>
        </div>
      ))}
    </div>
  );
}

function RowKV({ row }: { row: DatasetPreviewRow }) {
  return (
    <div className="space-y-0.5">
      {Object.entries(row).map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[13px] leading-5">
          <span className="text-muted-foreground w-24 flex-none truncate text-right">{k}</span>
          <span className="min-w-0 break-all line-clamp-4">{typeof v === 'string' ? v : JSON.stringify(v)}</span>
        </div>
      ))}
    </div>
  );
}

export function DatasetPreviewDialog({
  dataset,
  rows,
  truncated,
  loading,
  error,
  n,
  onN,
  onFetch,
}: {
  dataset: string;
  rows: DatasetPreviewRow[] | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  n: number;
  onN: (n: number) => void;
  onFetch: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && !rows && !loading && !error) onFetch();
  }, [open, rows, loading, error, onFetch]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!dataset.trim()} className="h-7 gap-1.5 px-2.5 text-[12px]">
          <Table2 className="size-3.5" /> {t('pre.datasetSamples')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{t('pre.datasetSamples')} · {dataset}</DialogTitle>
          <DialogDescription>{t('pre.datasetPreview')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            value={String(n)}
            onChange={(v) => onN(Number(v))}
            options={[
              { value: '5', label: '5' },
              { value: '10', label: '10' },
              { value: '20', label: '20' },
            ]}
          />
          <Button variant="outline" size="sm" disabled={loading} onClick={onFetch} className="h-7 text-[12px]">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('pre.reload')}
          </Button>
        </div>
        {error && <p className="text-destructive text-sm leading-5">{error}</p>}
        {loading && <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> {t('pre.loading')}</div>}
        {rows && rows.length === 0 && <p className="text-muted-foreground text-sm">{t('pre.emptyDataset')}</p>}
        {rows && rows.length > 0 && (
          <div className="bg-muted/40 border-border/50 divide-border/50 max-h-[55vh] divide-y overflow-auto rounded-lg border">
            {rows.map((row, i) => (
              <div key={i} className="p-3">
                {Array.isArray(row.messages) ? (
                  <RowMessages messages={row.messages as Array<{ role?: string; content?: unknown }>} />
                ) : (
                  <RowKV row={row} />
                )}
              </div>
            ))}
            {truncated && <div className="text-muted-foreground p-2 text-center text-[11px]">{t('pre.truncated', { n: rows.length })}</div>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
