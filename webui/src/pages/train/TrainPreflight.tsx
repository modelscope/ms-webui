/**
 * 训练创建页的两个预检弹窗（点击弹出、可关闭）：
 * 模型可训练结构 / 数据集前 N 条预览。每卡显存与分片分组已升级为
 * 独立的并行规划器（ParallelPlanner，含 SVG 卡连接拓扑与实时 spec 调节）。
 */
import { useEffect, useState } from 'react';
import { Box, Loader2, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/FormField';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { DatasetPreviewRow, ModelStructure } from '@/api/train';
import { fmtParams, loraParams } from './memoryEstimate';
import { useT } from '@/i18n';

/* ---------- 模型可训练结构弹窗 ---------- */

export function StructureDialog({
  model,
  structure,
  loading,
  error,
  onFetch,
  tuner,
  loraRank,
}: {
  model: string;
  structure: ModelStructure | null;
  loading: boolean;
  error: string | null;
  onFetch: () => void;
  tuner: 'lora' | 'full' | 'trainable_tokens';
  loraRank: number;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  /* 打开时自动探测（无结果且不在途）——错误保留，弹窗里给重新探测入口 */
  useEffect(() => {
    if (open && !structure && !loading && !error) onFetch();
  }, [open, structure, loading, error, onFetch]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={!model.trim()} className="h-7 gap-1.5 px-2.5 text-[12px]">
          <Box className="size-3.5" />
          {t('pre.trainableStructure')}
          {structure ? <span className="text-muted-foreground font-normal">{fmtParams(structure.params)}</span> : null}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('pre.trainableStructure')} · {model}</DialogTitle>
          <DialogDescription>
            {t('pre.structureHint')}
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t('pre.probing')}
          </div>
        )}
        {error && (
          <div className="space-y-2">
            <p className="text-destructive text-sm leading-5">{error}</p>
            <Button variant="outline" size="sm" onClick={onFetch}>{t('pre.reprobe')}</Button>
          </div>
        )}
        {structure && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm leading-6">
              <span>{t('pre.paramCount')} <b>{fmtParams(structure.params)}</b>{structure.paramsSource === 'config-estimate' && <span className="text-muted-foreground">{t('pre.configEstimate')}</span>}</span>
              {structure.layers !== undefined && <span>{t('pre.layers')} <b>{structure.layers}</b></span>}
              {structure.hidden !== undefined && <span>hidden <b>{structure.hidden}</b></span>}
              {structure.intermediate !== undefined && <span>FFN <b>{structure.intermediate}</b></span>}
              {structure.moeExperts !== undefined && <span className="text-amber-600 dark:text-amber-400">{t('pre.moeExperts')} <b>{structure.moeExperts}</b></span>}
              {structure.modelType && <span className="text-muted-foreground">{structure.modelType}</span>}
              {structure.heads !== undefined && structure.kvHeads !== undefined && (
                <span>{t('pre.attnHeads')} <b>{structure.heads}</b> / KV <b>{structure.kvHeads}</b></span>
              )}
              {structure.vocab !== undefined && <span>{t('pre.vocab')} <b>{structure.vocab}</b></span>}
            </div>
            {tuner === 'lora' && (
              <div className="bg-muted/50 rounded-lg p-3 text-sm leading-6">
                {t('pre.loraTrainable', { rank: loraRank })} <b>{fmtParams(loraParams(structure, loraRank))}</b>
                <span className="text-muted-foreground">{t('pre.loraNote', { pct: ((loraParams(structure, loraRank) / structure.params) * 100).toFixed(2) })}</span>
              </div>
            )}
            {tuner === 'full' && <div className="bg-muted/50 rounded-lg p-3 text-sm">{t('pre.fullTuning')}</div>}
            {tuner === 'trainable_tokens' && (
              <div className="bg-muted/50 rounded-lg p-3 text-sm">
                {t('pre.trainableTokensPrefix')} <b>{fmtParams((structure.vocab ?? 0) * (structure.hidden ?? 0))}</b>
              </div>
            )}
            {structure.loraModules && Object.keys(structure.loraModules).length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-[0.08em] uppercase">{t('pre.loraTargets')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(structure.loraModules)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, count]) => (
                      <span key={name} className="bg-muted border-border/60 rounded border px-2 py-0.5 font-mono text-[12px]">
                        {name} ×{count}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
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
