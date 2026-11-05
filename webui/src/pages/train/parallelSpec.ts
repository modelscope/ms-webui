/**
 * 并行规划器的纯函数层：DeviceMesh spec 维度模型（词表对齐 twinkle
 * parse_spec）、按算法/表单字段推导组清单（对齐各 recipe 的 group_requests）、
 * 计划态 → CLI flag 的转换，以及教科书口径的理论效率粗估。
 *
 * 职责边界：本层定组内切分（spec 各维）；组卡数不再单独输入——它是派生值，
 * 每组卡数 = 该组 spec 的 rank 维乘积（采样组 = vllm 引擎 world），分段串由
 * deriveSegments 从计划态生成。占独立 rank 维的只有 dp/fsdp/tp/pp/cp（world = 五维乘积，
 * 须恰好等于组卡数——对齐 from_spec(spec, world_size=nproc) 的 reshape 校验）；
 * ep/etp/vpp/ul/sp 是 mesh 对象属性维不占 rank。后端词表：transformers 消费
 * dp/fsdp/ep/ul，tp/pp/cp/etp/vpp/sp 为 megatron 专用；ul（ulysses）为
 * transformers 专有（device_mesh 标注 transformers only），megatron 后端下隐藏。
 */
import type { RlPlacement, RlPlacementInfo } from './RlGpuPlanner';
import type { MessageKey } from '@/i18n';

export type Backend = 'transformers' | 'megatron';

export interface SpecDims {
  dp: number;
  fsdp: number;
  tp: number;
  pp: number;
  cp: number;
  ep: number;
  etp: number;
  epfsdp: number;
  vpp: number;
  ul: number;
  sp: boolean;
}

export const DEFAULT_SPEC: SpecDims = { dp: 1, fsdp: 1, tp: 1, pp: 1, cp: 1, ep: 1, etp: 1, epfsdp: 1, vpp: 1, ul: 1, sp: false };

/** 维度词表：key、显示名、是否占 rank 维、transformers 是否可用、是否布尔 flag */
export const DIM_TABLE: ReadonlyArray<{
  key: keyof SpecDims;
  label: string;
  rank: boolean;
  tf: boolean;
  bool?: boolean;
}> = [
  { key: 'dp', label: 'dp', rank: true, tf: true },
  { key: 'fsdp', label: 'fsdp', rank: true, tf: true },
  { key: 'tp', label: 'tp', rank: true, tf: false },
  { key: 'pp', label: 'pp', rank: true, tf: false },
  { key: 'cp', label: 'cp', rank: true, tf: false },
  { key: 'ep', label: 'ep', rank: false, tf: true },
  { key: 'ul', label: 'ul', rank: false, tf: true },
  { key: 'etp', label: 'etp', rank: false, tf: false },
  { key: 'epfsdp', label: 'epfsdp', rank: false, tf: false },
  { key: 'vpp', label: 'vpp', rank: false, tf: false },
  { key: 'sp', label: 'sp', rank: false, tf: false, bool: true },
];

export function specWorld(s: SpecDims): number {
  return s.dp * s.fsdp * s.tp * s.pp * s.cp;
}

/** spec 字符串（只列非默认维，顺序固定）；全默认返回 null（等价 CLI 缺省，不生成 flag） */
export function specToString(s: SpecDims): string | null {
  const parts: string[] = [];
  for (const d of DIM_TABLE) {
    const v = s[d.key];
    if (d.bool) {
      if (v === true) parts.push(d.label);
    } else if (typeof v === 'number' && v > 1) {
      parts.push(`${d.label}${v}`);
    }
  }
  return parts.length ? parts.join('_') : null;
}

/** 纯 DP（dp=world、其余默认）：等价不传 spec 的 CLI 缺省形态 */
export function isDefaultSpec(s: SpecDims, world: number): boolean {
  return specToString(s) === null || (s.dp === world && specToString({ ...s, dp: 1 }) === null);
}

/** 组卡数 → 填满 world 的默认 spec（dp 吸收全部卡） */
export function defaultSpecFor(cards: number): SpecDims {
  return { ...DEFAULT_SPEC, dp: Math.max(1, cards) };
}

/* ---------- 组清单推导（对齐各 recipe 的 group_requests） ---------- */

export type GroupKind = 'mesh' | 'vllm';

export interface PlannerGroup {
  /** 组身份键：model/sampler/teacher/ref/orm/prm（同键多组共用一份 spec） */
  key: string;
  label: MessageKey;
  /** 来源说明（i18n key + 插值变量，渲染处 t()） */
  detail?: { key: MessageKey; vars?: Record<string, string | number> };
  /** 同 spec 的组个数（mopd spread=K、orm 模型数=N；其余 1） */
  count: number;
  /** 每组卡数（vllm 组为总卡数） */
  cards: number;
  /** spec 形态：mesh → *parallel_spec 字符串；vllm → 引擎 int flag */
  kind: GroupKind;
  /** mesh 形态的 flag 名（不含 -- 前缀） */
  flag?: string;
  /** 拓扑图组色 */
  color: string;
}

const GROUP_COLORS = {
  model: '#2563eb',
  sampler: '#059669',
  teacher: '#7c3aed',
  ref: '#ea580c',
  orm: '#db2777',
  prm: '#0891b2',
} as const;

export interface DeriveGroupsInput {
  taskType: 'sft' | 'pt' | 'rl';
  /** 在线算法名（taskType=rl 时） */
  rlType?: string;
  tuner: 'lora' | 'full' | 'trainable_tokens';
  params: Record<string, string | number | boolean>;
  /** sft/pt 的卡池数（=训练组卡数） */
  nproc: number;
  /** rl 的双组配卡解析结果（在线算法） */
  rlInfo?: RlPlacementInfo;
  /** orm/prm 的注册规则名清单（探针端点；判别条目是规则名（不占组）还是模型 id（占组）） */
  ormRules?: string[];
  prmRules?: string[];
}

function modelIdCount(value: unknown, rules: string[]): number {
  if (typeof value !== 'string') return 0;
  return value.trim().split(/\s+/).filter(Boolean).filter((item) => !rules.includes(item)).length;
}

/**
 * 组清单：训练组恒在；rl 在线族再加热组（恒在，vllm 形态）与辅助组——
 * 辅助组序与 recipe 的 group_requests 一致（grpo：ref→teacher→orm→prm；
 * distill：teacher）。count>1 的组在「每组卡数」里占 count 段（共用单值 spec，
 * 各段等宽）。colocate 时采样组仍可调引擎形状（覆盖在训练卡上）。
 */
export function deriveGroups(input: DeriveGroupsInput): PlannerGroup[] {
  const { taskType, tuner, params } = input;
  if (taskType !== 'rl') {
    return [{ key: 'model', label: 'planner.groupModel', count: 1, cards: Math.max(1, input.nproc), kind: 'mesh', flag: 'parallel_spec', color: GROUP_COLORS.model }];
  }
  const rl = input.rlInfo;
  const online = input.rlType !== undefined;
  const rlType = input.rlType!;
  if (!online || !rl) {
    /* 非在线 RL（sft/pt/离线偏好优化）：单训练组，卡池全部归它 */
    return [{ key: 'model', label: 'planner.groupModel', count: 1, cards: Math.max(1, input.nproc), kind: 'mesh', flag: 'parallel_spec', color: GROUP_COLORS.model }];
  }
  const groups: PlannerGroup[] = [
    {
      key: 'model', label: 'planner.groupModel', count: 1, cards: rl.actorCards, kind: 'mesh',
      flag: 'parallel_spec', color: GROUP_COLORS.model,
      /* PPO 的 value critic 与策略同组同卡训练（initialize_ppo_cluster：共用 'model' 组、
       * 同 slice_dp，不单列组不占新卡）——仅作展示标注，无独立 spec */
      detail: rlType === 'ppo' ? { key: 'planner.groupCritic' } : undefined,
    },
  ];
  /* 采样组恒在（colocate 时 cards=0：覆盖在训练卡上，引擎形状仍可调） */
  groups.push({
    key: 'sampler', label: 'planner.groupSampler', detail: { key: 'planner.groupSamplerDetail' }, count: 1,
    cards: rl.samplerCards, kind: 'vllm', color: GROUP_COLORS.sampler,
  });
  const auxSegments = rl.auxSegments;
  let seg = 0;
  const takeCards = (): number => {
    const c = auxSegments[seg] ?? 0;
    seg += 1;
    return Math.max(1, c);
  };
  const ormRules = input.ormRules ?? [];
  const prmRules = input.prmRules ?? [];
  /* grpo/ppo：ref 组在前（对齐 grpo_group_requests/ppo_group_requests 的顺序）。
   * 判据与 recipe 的 disable 分支对齐：tuner_config 存在（lora/trainable_tokens）且
   * 未配 ref_adapters/sync_ref_model 时复用策略 actor 不建组（表单无这两个字段，
   * 故 tuner==trainable_tokens 同样不建）；PPO 恒锚 KL，全参必建、无需 beta/ref_model */
  if (rlType === 'grpo' || rlType === 'ppo') {
    const fullParam = tuner === 'full';
    const hasRef = rlType === 'ppo'
      ? fullParam
      : fullParam && Boolean(params.ref_model) && Number(params.beta ?? 0) > 0;
    if (hasRef) {
      groups.push({ key: 'ref', label: 'planner.groupRef', detail: { key: 'planner.groupRefDetail' }, count: 1, cards: takeCards(), kind: 'mesh', flag: 'ref_parallel_spec', color: GROUP_COLORS.ref });
    }
  }
  /* 蒸馏族：teacher 组（gkd/opsd 单教师；mopd pack=1 组、spread=K 组共用单值 spec） */
  const teacherCount = typeof params.teacher_model === 'string' && params.teacher_model.trim()
    ? (rlType === 'mopd' ? params.teacher_model.trim().split(/\s+/).filter(Boolean).length : 1)
    : 0;
  if (teacherCount > 0) {
    const spread = rlType === 'mopd' && rl.auxSegments.length > 1;
    groups.push({
      key: 'teacher', label: 'planner.groupTeacher',
      detail: rlType === 'mopd'
        ? { key: spread ? 'planner.teacherSpread' : 'planner.teacherPack', vars: { count: teacherCount } }
        : { key: 'planner.teacherSingle' },
      count: spread ? teacherCount : 1, cards: takeCards(), kind: 'mesh', flag: 'teacher_parallel_spec', color: GROUP_COLORS.teacher,
    });
    if (spread) seg += teacherCount - 1; /* spread 的 K 段各吃一段（首段已 take） */
  }
  /* 奖励通道：orm 每个模型 id 一组（共用 orm_parallel_spec）、prm 一个组 */
  const ormModels = modelIdCount(params.orm, ormRules);
  if (ormModels > 0) {
    groups.push({ key: 'orm', label: 'planner.groupOrm', detail: { key: 'planner.ormDetail', vars: { count: ormModels } }, count: ormModels, cards: takeCards(), kind: 'mesh', flag: 'orm_parallel_spec', color: GROUP_COLORS.orm });
    seg += ormModels - 1;
  }
  const prmModels = modelIdCount(params.prm, prmRules);
  if (prmModels > 0) {
    groups.push({ key: 'prm', label: 'planner.groupPrm', detail: { key: 'planner.prmDetail' }, count: 1, cards: takeCards(), kind: 'mesh', flag: 'prm_parallel_spec', color: GROUP_COLORS.prm });
  }
  return groups;
}

/* ---------- 计划态 → CLI flag ---------- */

export interface ParallelPlan {
  backend: Backend;
  /** 每个 spec 组的维度（组键 → spec）；vllm 组走 vllmDims */
  specs: Record<string, SpecDims>;
  /** 采样组的引擎形状（vLLM int flag） */
  vllmDims: { dp: number; tp: number; pp: number };
  /** transformers 后端的 ZeRO 档（显存口径；megatron 用 fsdp 维） */
  zero: 0 | 1 | 2 | 3;
}

export function defaultPlan(): ParallelPlan {
  return { backend: 'transformers', specs: {}, vllmDims: { dp: 1, tp: 1, pp: 1 }, zero: 0 };
}

/**
 * 计划 → CLI flags（命令预览与提交同源）。缺省形态不生成 flag：
 * transformers 后端不传 --backend（hf 缺省）、纯 DP 不传 spec、
 * vllm 全 1 不传引擎 flag。
 */
export function planFlags(plan: ParallelPlan, groups: PlannerGroup[]): Record<string, string | number> {
  const flags: Record<string, string | number> = {};
  if (plan.backend === 'megatron') flags.backend = 'megatron';
  for (const g of groups) {
    if (g.kind === 'vllm') {
      const { dp, tp, pp } = plan.vllmDims;
      if (dp > 1) flags.vllm_data_parallel_size = dp;
      if (tp > 1) flags.vllm_tensor_parallel_size = tp;
      if (pp > 1) flags.vllm_pipeline_parallel_size = pp;
      continue;
    }
    if (g.key === 'model' && g.cards <= 1) continue;
    const spec = plan.specs[g.key];
    if (!spec) continue;
    const s = specToString(spec);
    if (s && g.flag) flags[g.flag] = s;
  }
  return flags;
}

/* ---------- 组卡数派生（自动 worldsize：卡数 = spec 的 rank 维乘积） ---------- */

/** 组键 → 分段串段序：model 段 0；sampler 仅 disaggregated 占段（colocate 覆盖训练
 * 卡不占段）；辅助组按 count 逐段展开（spread 教师 / 多 orm 各一段） */
export function groupSegments(groups: PlannerGroup[], placement: RlPlacement['placement']): Record<string, number[]> {
  const map: Record<string, number[]> = {};
  let seg = 0;
  for (const g of groups) {
    if (g.key === 'model') {
      map.model = [seg++];
    } else if (g.key === 'sampler') {
      map.sampler = placement === 'disaggregated' ? [seg++] : [];
    } else {
      map[g.key] = Array.from({ length: Math.max(1, g.count) }, () => seg++);
    }
  }
  return map;
}

/**
 * plan + 组清单 → 分段串：组卡数的唯一派生源（弹窗确认时写回 RlGpuPlanner）。
 * 每段 = 该组 spec 的 rank 维乘积；specs 缺省 = 纯 DP，卡数沿用组清单带来的分配；
 * 采样组 = vllm 引擎 world；count>1 的组（spread 教师 / 多 orm）各段等宽（共用单值 spec）。
 */
export function deriveSegments(
  plan: ParallelPlan,
  groups: PlannerGroup[],
  placement: RlPlacement['placement'],
): string {
  const segMap = groupSegments(groups, placement);
  const out: number[] = [];
  for (const g of groups) {
    const segs = segMap[g.key] ?? [];
    if (g.key === 'sampler') {
      if (segs.length > 0) out.push(plan.vllmDims.dp * plan.vllmDims.tp * plan.vllmDims.pp);
      continue;
    }
    const spec = plan.specs[g.key] ?? defaultSpecFor(g.cards);
    for (let i = 0; i < segs.length; i++) out.push(specWorld(spec));
  }
  return out.join(',');
}

/* ---------- 理论效率粗估（教科书口径，非实测） ---------- */

export interface EfficiencyFactor {
  label: string;
  /** 该维的效率因子（0-1）；综合加速比 = dp × Π因子 */
  eff: number;
  note: MessageKey;
  /** note 的插值变量（如 pp 气泡率的微批数 m），渲染处 t(note, noteVars) */
  noteVars?: Record<string, string | number>;
}

export function efficiencyEstimate(spec: SpecDims, microBatches = 4): { speedup: number; factors: EfficiencyFactor[] } {
  const factors: EfficiencyFactor[] = [];
  if (spec.tp > 1) {
    factors.push({ label: `tp=${spec.tp}`, eff: 1 / (1 + 0.08 * (spec.tp - 1)), note: 'planner.effTpNote' });
  }
  if (spec.pp > 1) {
    const bubble = (spec.pp - 1) / (microBatches + spec.pp - 1);
    factors.push({ label: `pp=${spec.pp}`, eff: 1 - bubble, note: 'planner.effPpNote', noteVars: { m: microBatches } });
  }
  if (spec.cp > 1) {
    factors.push({ label: `cp=${spec.cp}`, eff: 1 / (1 + 0.05 * (spec.cp - 1)), note: 'planner.effCpNote' });
  }
  if (spec.fsdp > 1) {
    factors.push({ label: `fsdp=${spec.fsdp}`, eff: 0.95, note: 'planner.effFsdpNote' });
  }
  const speedup = spec.dp * factors.reduce((acc, f) => acc * f.eff, 1);
  return { speedup, factors };
}
