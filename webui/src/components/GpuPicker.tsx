import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { NumberInput, SegmentedControl } from '@/components/FormField';
import { useT } from '@/i18n';
import { listGpus, type GpuInfo } from '@/api/deploy';

/** 显卡分配的两种模式：本机选卡（卡号进 CUDA_VISIBLE_DEVICES）或集群卡数（只声明数量） */
export interface GpuSelection {
  mode: 'local' | 'cluster';
  /** local：选中的本机卡号 */
  cards: number[];
  /** cluster：声明的卡数（Ray 集群等远端资源，本机探测不到具体卡号） */
  count: number | undefined;
}

export const EMPTY_GPU_SELECTION: GpuSelection = { mode: 'local', cards: [], count: undefined };

/** 一张 GPU 的选择卡片：型号 + 显存占用条，点击切换选中 */
function GpuCard({
  gpu,
  active,
  onToggle,
}: {
  gpu: GpuInfo;
  active: boolean;
  onToggle: () => void;
}) {
  const { t } = useT();
  const busy = gpu.total > 0 && gpu.used / gpu.total > 0.5;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'border-border bg-card flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors',
        active ? 'border-primary bg-primary/8' : 'hover:border-foreground/20',
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-foreground text-[13px] font-medium">GPU {gpu.index}</span>
        {busy && <span className="text-state-failed text-[11px]">{t('gpu.busy')}</span>}
      </div>
      <span className="text-muted-foreground w-full truncate text-[11px]">{gpu.name}</span>
      {/* 显存占用条：满的那截跟着占用率换色，一眼看出哪张卡能用 */}
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', busy ? 'bg-state-failed/70' : 'bg-primary/60')}
          style={{ width: `${gpu.total > 0 ? Math.min(100, (gpu.used / gpu.total) * 100) : 0}%` }}
        />
      </div>
      <span className="text-muted-foreground tabular text-[11px]">
        {Math.round(gpu.used / 1024)} / {Math.round(gpu.total / 1024)} GiB
      </span>
    </button>
  );
}

/**
 * 显卡分配选择器：部署与训练的新建页共用。
 *
 * 两种模式互斥——本机选卡给出的是「用哪几张」（卡号进 CUDA_VISIBLE_DEVICES），
 * 集群卡数给出的是「要几张」（Ray 集群等远端资源本机探测不到，只能声明数量，
 * 由集群调度器决定实际落在哪些卡上）。组件自己探测本机 GPU 并默认勾第一张
 * 空闲卡；探测不到（无 nvidia-smi / 无卡）时本机模式退化为「不设卡限制」。
 */
export function GpuPicker({
  value,
  onChange,
  allowCluster = true,
}: {
  value: GpuSelection;
  onChange: (v: GpuSelection) => void;
  /** false = 只本机选卡（代码训练等场景：集群卡数没有注入落点，不展示以免静默失效） */
  allowCluster?: boolean;
}) {
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const { t } = useT();
  /* effect 只跑一次，但自动选卡要读「最新」选择（用户可能已切到集群模式），用 ref 保存 */
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    listGpus()
      .then((list) => {
        setGpus(list);
        /* 默认勾第一张看起来空闲的卡；全忙就勾第一张，让用户自己换 */
        const free = list.find((g) => g.total > 0 && g.used / g.total <= 0.5) ?? list[0];
        if (free && valueRef.current.mode === 'local' && !valueRef.current.cards.length) {
          onChange({ ...valueRef.current, cards: [free.index] });
        }
      })
      .catch(() => setGpus([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (index: number) =>
    onChange({
      ...value,
      cards: value.cards.includes(index)
        ? value.cards.filter((i) => i !== index)
        : [...value.cards, index].sort((a, b) => a - b),
    });

  return (
    <div className="flex flex-col gap-3">
      {allowCluster && (
        <SegmentedControl
          value={value.mode}
          onChange={(mode) => onChange({ ...value, mode: mode as GpuSelection['mode'] })}
          options={[
            { value: 'local', label: t('gpu.local') },
            { value: 'cluster', label: t('gpu.cluster') },
          ]}
        />
      )}
      {value.mode === 'local' || !allowCluster ? (
        gpus.length ? (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {gpus.map((g) => (
              <GpuCard
                key={g.index}
                gpu={g}
                active={value.cards.includes(g.index)}
                onToggle={() => toggle(g.index)}
              />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground text-[13px] leading-5">
            {t('gpu.noLocal')}
            {allowCluster && t('gpu.clusterHint')}.
          </div>
        )
      ) : (
        <div className="flex items-center gap-2.5">
          <NumberInput
            className="w-30"
            value={value.count}
            onChange={(count) => onChange({ ...value, count })}
            min={1}
          />
          <span className="text-muted-foreground text-xs">{t('gpu.cardsUnit')}</span>
        </div>
      )}
    </div>
  );
}
