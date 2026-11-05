/**
 * 在线 RL（grpo/ppo/rft/gkd/opsd/mopd）的 actor/sampler 双组放置规划器。
 * 本组件只管放置形态（colocate / 独立分片）与分段串的数量关系校验、摘要；
 * 每组卡数的步进调节在「显卡与分片分组」弹窗里（写回分段串），组内并行
 * （spec / vllm 引擎形状）同在弹窗。
 *
 * 放置语义对齐 swift plan_device_groups：colocate 时采样组覆盖在训练组
 * 卡上时间分片（CLI 缺省即 colocate）；独立分片时各组 ranks 前后相接、
 * 互不相交，须显式 --sampler_mode disaggregated。
 */
import { Field, SegmentedControl } from '@/components/FormField';
import { useT, type MessageKey } from '@/i18n';

/* 纯函数收翻译函数：错误文案带插值，无法延迟到渲染处 */
type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 表单态：groups 是逗号串原文，解析放派生函数（单一真相源） */
export interface RlPlacement {
  placement: 'disaggregated' | 'colocate';
  groups: string;
}

export interface RlPlacementInfo {
  valid: boolean;
  error?: string;
  actorCards: number;
  samplerCards: number;
  /** 段 3+ 的每段卡数（辅助组宽度）；空数组 = 无辅助组 */
  auxSegments: number[];
  auxCards: number;
  totalCards: number;
}

/** 教师形态约束：gkd/opsd 恰 0/1 个教师；mopd 为 K 个（--teacher_model 个数） */
export interface RlTeacherOpts {
  /** 教师数：mopd 取 teacher_model 个数；gkd/opsd 填了教师即 1；其余算法 0 */
  teacherCount?: number;
  /** distill 族（gkd/opsd/mopd）才按教师规划辅助组 */
  teacherRequired?: boolean;
}

export function parseRlPlacement(
  value: RlPlacement,
  totalGpus: number,
  opts: RlTeacherOpts = {},
  t: TFn,
): RlPlacementInfo {
  const empty: RlPlacementInfo = {
    valid: false, actorCards: 0, samplerCards: 0, auxSegments: [], auxCards: 0, totalCards: 0,
  };
  if (totalGpus <= 0) return { ...empty, error: t('rl.errPool') };
  const raw = value.groups.split(',').map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return { ...empty, error: t('rl.errFill') };
  const segments: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const n = Number(raw[i]);
    if (!Number.isInteger(n) || n < 1) return { ...empty, error: t('rl.errSeg', { i: i + 1, v: raw[i] }) };
    segments.push(n);
  }
  if (value.placement === 'disaggregated' && segments.length < 2) {
    return { ...empty, error: t('rl.errNeedTwo') };
  }
  const actorCards = segments[0];
  /* colocate：采样器覆盖训练卡（独立 rank 空间，不单独占段）；但辅助组仍各占
   * 一段——对齐 plan_device_groups：辅助组在两种放置下都追加不相交的 ranks */
  const samplerCards = value.placement === 'disaggregated' ? (segments[1] ?? 0) : 0;
  const auxSegments = value.placement === 'disaggregated' ? segments.slice(2) : segments.slice(1);
  /* 辅助段 ↔ 教师的数量关系（spec 是全体教师共用的单值，spread 须等宽且段数=教师数） */
  if (auxSegments.length > 0 && opts.teacherRequired) {
    const k = opts.teacherCount ?? 0;
    if (k === 0) {
      return { ...empty, actorCards, error: t('rl.errTeacherMissing') };
    }
    if (k === 1 && auxSegments.length > 1) {
      return { ...empty, actorCards, error: t('rl.errTeacherSingle') };
    }
    if (k >= 2 && auxSegments.length >= 2) {
      if (new Set(auxSegments).size !== 1) {
        return { ...empty, actorCards, error: t('rl.errTeacherUneven') };
      }
      if (auxSegments.length !== k) {
        return { ...empty, actorCards, error: t('rl.errTeacherCount', { n: auxSegments.length, k }) };
      }
    }
  }
  const auxCards = auxSegments.reduce((a, b) => a + b, 0);
  const totalCards = actorCards + samplerCards + auxCards;
  if (totalCards > totalGpus) {
    return { ...empty, actorCards, error: t('rl.errOverBudget', { total: totalCards, pool: totalGpus }) };
  }
  return { valid: true, actorCards, samplerCards, auxSegments, auxCards, totalCards };
}

export function RlGpuPlanner({
  totalGpus,
  value,
  onChange,
  teacherOpts,
  expectedSegments,
}: {
  totalGpus: number;
  value: RlPlacement;
  onChange: (v: RlPlacement) => void;
  /** distill 族传入教师形态；缺省 = 非教师算法（辅助段仅占卡校验） */
  teacherOpts?: RlTeacherOpts;
  /** 规划器弹窗按算法/字段推导的预计段数（2 + Σ辅助组数）；不符时提示对齐 */
  expectedSegments?: number;
}) {
  const { t } = useT();
  const info = parseRlPlacement(value, totalGpus, teacherOpts, t);
  /* 物理段数（用户需填几段）：colocate = 训练 1 段 + 辅助各段；独立分片 = 训练 + 采样 + 辅助各段 */
  const segmentCount = info.valid ? (value.placement === 'colocate' ? 1 : 2) + info.auxSegments.length : 0;
  const mismatch = info.valid && expectedSegments !== undefined && segmentCount !== expectedSegments;
  return (
    <div className="bg-muted/40 border-border/60 space-y-3 rounded-lg border p-3.5">
      <div className="text-muted-foreground/80 text-[11px] font-medium tracking-[0.08em] uppercase">
        {t('rl.title')}
      </div>
      <Field label={t('rl.placement')} hint={t('rl.placementHint')}>
        <SegmentedControl
          value={value.placement}
          onChange={(v) => onChange({ ...value, placement: v as RlPlacement['placement'] })}
          options={[
            { value: 'disaggregated', label: t('rl.disaggregated') },
            { value: 'colocate', label: t('rl.colocate') },
          ]}
        />
      </Field>
      <p className="text-muted-foreground text-[11px]">{t('rl.cardsMovedNote')}</p>
      {info.valid ? (
        <p className="text-muted-foreground text-[12px] leading-5">
          {value.placement === 'colocate' ? (
            <>
              {t('rl.summaryCo', { actor: info.actorCards })}
              {info.auxCards > 0 && t('rl.summaryAuxCo', { n: info.auxSegments.length, cards: info.auxCards })}
            </>
          ) : (
            <>
              {t('rl.summaryDis', { actor: info.actorCards, last: info.actorCards - 1, sampler: info.samplerCards, from: info.actorCards, to: info.actorCards + info.samplerCards - 1 })}
              {info.auxCards > 0 && t('rl.summaryAux', { n: info.auxSegments.length, cards: info.auxCards })}
              {t('rl.summaryTotal', { total: info.totalCards, pool: totalGpus })}
            </>
          )}
          {mismatch && (
            <span className="text-destructive block">{t('rl.mismatch', { n: segmentCount, expected: expectedSegments })}</span>
          )}
        </p>
      ) : (
        <p className="text-destructive text-[12px] leading-5">{info.error}</p>
      )}
    </div>
  );
}
