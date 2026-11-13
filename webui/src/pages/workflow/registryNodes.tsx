import type { ReactNode } from 'react';
import {
  ArrowLeftRight, Brain, CloudUpload, Code, Database, Filter, FlaskConical, GitMerge,
  GraduationCap, Layers, Lock, Minimize2, Network, RefreshCw, RefreshCcw, Repeat, Rocket,
  Scale, Sigma, TrendingUp, Waves, Wrench, Zap, Globe,
} from 'lucide-react';
import registryData from './registry.json';
import type { MessageKey } from '@/i18n';
import type { NodeParam, NodeTypeDef, PortDef } from './nodeTypes';

/**
 * registry.json 驱动的节点类型生成层。
 *
 * 组件的「有哪些口、有哪些参数」以 Python 侧 swift/dev/webui/registry.py 为唯一
 * 真相源，export.py 导出成 registry.json，本文件把它转成画布的 NodeTypeDef。
 * JSON 里没有的纯展示信息（图标、配色、面板分组、提示语、能否单独运行）
 * 由下面的 UI_EXTRAS 表补充——单一真相源管语义，展示层管长相。
 *
 * 由此新增一个后端组件 = registry.py 加 descriptor + 这里加一行 UI_EXTRAS。
 */

interface RegistryPort {
  key: string;
  kind: string;
  role: string;
  profiles?: string[];
  many?: boolean;
  optional?: boolean;
  /** 消费者口额外接受的异构通道（后端 PortSpec.accepts 的导出） */
  accepted_kinds?: string[];
}

interface RegistryParam {
  name: string;
  label: string;
  /** v3 的默认值是任意 JSON 类型（dict/list/bool/number/str）；展示层转文本 */
  default: unknown;
  doc?: string;
  options?: unknown[];
  group?: string;
  type?: string;
  required?: boolean;
}

interface RegistryComponent {
  type: string;
  label: string;
  /** Resource / Iterator / Stage / Task：构建与调用次数的声明，不是后台状态 */
  lifecycle: string;
  math_doc: string;
  ports_in: RegistryPort[];
  ports_out: RegistryPort[];
  params: RegistryParam[];
  factory?: string;
  effects?: string[];
  /** 展示归属面（算法/资源/运行/产物）：registry v5 起随 descriptor 导出 */
  surface?: string;
}

/** registry 的中文参数分区 → 展示 key；未映射的分区原样展示（en 回落中文） */
const GROUP_KEYS: Record<string, MessageKey> = {
  放置: 'wf.grpPlacement',
  训练面: 'wf.grpTrainSide',
  模板: 'wf.grpTemplate',
  预处理: 'wf.grpPreprocess',
};

/** 注册表默认值 → 面板文本：对象/数组走 JSON，标量走 String，空落空串 */
function defaultToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** registry JSON 里每个参数转画布参数：label 用参数名（英文），与 preset 覆盖格式一致 */
function paramFromRegistry(p: RegistryParam): NodeParam {
  return {
    label: p.name,
    value: defaultToText(p.default),
    ptype: p.type,
    group: p.group ? (GROUP_KEYS[p.group] ?? (p.group as MessageKey)) : undefined,
  };
}

interface UiExtras {
  /** 面板分组：沿用产品阅读流（输入 → 采样 → …），而非 registry 的数学分类 */
  category: MessageKey;
  /** 展示名（registry 的中文 label 在这里映射成 key；缺映射回落原文） */
  labelKey?: MessageKey;
  color: string;
  icon: ReactNode;
  hint?: MessageKey;
  runnable?: boolean;
  /** 完全替换 registry 生成的参数（后端默认值太素时，用带解释的展示值） */
  params?: NodeParam[];
  /** 代码组件：节点体里显示可编辑 Python 片段 */
  code?: string;
}

/** 与 nodeTypes.tsx 里的 C 配色保持同值（那里是手写分组色，这里按引用传入） */
const COLORS = {
  input: '#3A6EA5',
  data: '#6D3FD1',
  rollout: '#0E7490',
  agent: '#3F6212',
  reward: '#A16207',
  adv: '#C2410C',
  loss: '#B4342B',
  loop: '#4F46E5',
  after: '#475569',
  code: '#334155',
};

/**
 * 每个后端组件的展示信息。key 与 registry.py 的 ComponentDescriptor.type
 * 一一对应（生命周期分类不决定展示分组——展示沿产品阅读流）；改名时两侧
 * 一起改。新组件没配 labelKey 时回落 registry 的中文 label，不新增 locale 键。
 */
const UI_EXTRAS: Record<string, UiExtras> = {
  model: {
    category: 'wf.catInput', labelKey: 'wf.nodePolicyModel', color: COLORS.input, icon: <Brain />,
    hint: 'wf.hintPolicyModel',
  },
  dataset: {
    category: 'wf.catInput', labelKey: 'wf.nodeDataset', color: COLORS.data, icon: <Database />,
  },
  dataloader: {
    category: 'wf.catInput', labelKey: 'wf.nodeDataloader', color: COLORS.data, icon: <Layers />, runnable: true,
    hint: 'wf.hintDataloader',
  },
  sampler: {
    category: 'wf.catSampler', labelKey: 'wf.nodeSampler', color: COLORS.rollout, icon: <Zap />, runnable: true,
    hint: 'wf.hintSampler',
  },
  rollout: {
    category: 'wf.catSampler', labelKey: 'wf.nodeMultiTurnRollout', color: COLORS.rollout, icon: <ArrowLeftRight />, runnable: true,
    hint: 'wf.hintMultiTurnRollout',
  },
  generate: {
    category: 'wf.catSampler', labelKey: 'wf.nodeBatchRollout', color: COLORS.rollout, icon: <Repeat />, runnable: true,
    hint: 'wf.hintBatchRollout',
  },
  streaming_driver: {
    category: 'wf.catLoop', labelKey: 'wf.nodeStreamingDriver', color: COLORS.loop, icon: <Waves />, runnable: true,
    hint: 'wf.hintStreamingDriver',
  },
  score: {
    category: 'wf.catRewardAdv', color: COLORS.reward, icon: <Sigma />, runnable: true,
  },
  scorer: {
    category: 'wf.catRewardAdv', labelKey: 'wf.nodeRewardScorer', color: COLORS.reward, icon: <Scale />,
    hint: 'wf.hintRewardScorer',
  },
  loss: {
    category: 'wf.catLoss', labelKey: 'wf.nodeLossNode', color: COLORS.loss, icon: <Sigma />,
    hint: 'wf.hintLossNode',
  },
  group_rule: {
    category: 'wf.catRewardAdv', color: COLORS.reward, icon: <Scale />,
  },
  model_forward: {
    category: 'wf.catRewardAdv', color: COLORS.adv, icon: <TrendingUp />, runnable: true,
  },
  privileged_view: {
    category: 'wf.catRewardAdv', color: COLORS.adv, icon: <Layers />, runnable: true,
  },
  advantage: {
    category: 'wf.catRewardAdv', labelKey: 'wf.nodeAdvantage', color: COLORS.adv, icon: <TrendingUp />, runnable: true,
    hint: 'wf.hintAdvantage',
  },
  signal_combine: {
    category: 'wf.catRewardAdv', color: COLORS.adv, icon: <GitMerge />,
  },
  select: {
    category: 'wf.catRewardAdv', labelKey: 'wf.nodeTrajFilter', color: COLORS.adv, icon: <Filter />, runnable: true,
    hint: 'wf.hintTrajFilter',
  },
  train_step: {
    category: 'wf.catLoop', labelKey: 'wf.nodeTrainStep', color: COLORS.loop, icon: <RefreshCw />, runnable: true,
    hint: 'wf.hintTrainStep',
  },
  weight_sync: {
    category: 'wf.catLoop', labelKey: 'wf.nodeWeightSync', color: COLORS.loop, icon: <RefreshCcw />,
    hint: 'wf.hintWeightSync',
  },
  weight_average: {
    category: 'wf.catLoop', color: COLORS.loop, icon: <RefreshCw />,
  },
  checkpoint: {
    category: 'wf.catAfter', color: COLORS.after, icon: <CloudUpload />,
  },
  toolset: {
    category: 'wf.catAgentEnv', labelKey: 'wf.nodeToolset', color: COLORS.agent, icon: <Wrench />,
    hint: 'wf.hintToolset',
  },
  sandbox_env: {
    category: 'wf.catAgentEnv', labelKey: 'wf.nodeSandboxEnv', color: COLORS.agent, icon: <Globe />, runnable: true,
    hint: 'wf.hintSandboxEnv',
  },
  api_endpoint: {
    category: 'wf.catInput', labelKey: 'wf.nodeApiModel', color: COLORS.input, icon: <Globe />,
    hint: 'wf.hintApiModel',
  },
  challenger: {
    category: 'wf.catSampler', labelKey: 'wf.nodeChallenger', color: COLORS.data, icon: <FlaskConical />, runnable: true,
    hint: 'wf.hintChallenger',
  },
  merge: {
    category: 'wf.catAfter', labelKey: 'wf.nodeMerge', color: COLORS.after, icon: <GitMerge />, runnable: true,
  },
  infer: {
    category: 'wf.catAfter', labelKey: 'wf.nodeInfer', color: COLORS.after, icon: <Layers />, runnable: true,
    hint: 'wf.hintInfer',
  },
  eval: {
    category: 'wf.catAfter', labelKey: 'wf.nodeEval', color: COLORS.after, icon: <Sigma />, runnable: true,
    hint: 'wf.hintEval',
  },
  deploy: {
    category: 'wf.catAfter', labelKey: 'wf.nodeDeploy', color: COLORS.after, icon: <Rocket />, runnable: true,
    hint: 'wf.hintDeploy',
  },
  quantize: {
    category: 'wf.catAfter', labelKey: 'wf.nodeQuantize', color: COLORS.after, icon: <Minimize2 />, runnable: true,
    hint: 'wf.hintQuantize',
  },
  hub_push: {
    category: 'wf.catAfter', labelKey: 'wf.nodeHubPush', color: COLORS.after, icon: <CloudUpload />, runnable: true,
    hint: 'wf.hintHubPush',
  },
  code_component: {
    category: 'wf.catAgentEnv', labelKey: 'wf.nodeCodeComponent', color: COLORS.code, icon: <Code />, runnable: true,
    code: 'def fn(x):\n    return x',
    hint: 'wf.hintCodeComponent',
  },
};

/**
 * 口身份的展示说明。registry 的 role 是英文蛇形名（单一真相源），
 * 这里只做展示翻译；没有映射的 role 原样显示。
 */
export const ROLE_HINTS: Record<string, MessageKey> = {
  policy_view: 'wf.rolePolicyView',
  base_view: 'wf.roleBaseView',
  frozen_reference: 'wf.roleFrozenReference',
  external_api: 'wf.roleExternalApi',
  kl_ref: 'wf.roleKlRef',
  preference_ref: 'wf.rolePreferenceRef',
  teacher: 'wf.roleTeacher',
  scorer: 'wf.roleScorer',
  rubric_judge: 'wf.roleRubricJudge',
  value_head: 'wf.roleValueHead',
  serving_view: 'wf.roleServingView',
  engine: 'wf.roleEngine',
  sandbox: 'wf.roleSandbox',
  tool_decls: 'wf.roleToolDecls',
  prompt_stream: 'wf.rolePromptStream',
  receive_weights: 'wf.roleReceiveWeights',
};

const DEFAULT_EXTRAS: UiExtras = { category: 'wf.catInput', color: COLORS.code, icon: <Code /> };

function fromRegistry(c: RegistryComponent): NodeTypeDef {
  const extras = UI_EXTRAS[c.type] ?? DEFAULT_EXTRAS;
  const toPort = (p: RegistryPort): PortDef =>
    ({ key: p.key, label: p.key, type: p.kind as PortDef['type'], role: p.role, many: p.many,
       acceptedKinds: p.accepted_kinds });
  return {
    key: c.type,
    label: c.label,
    labelKey: extras.labelKey,
    category: extras.category,
    color: extras.color,
    icon: extras.icon,
    inputs: c.ports_in.map(toPort),
    outputs: c.ports_out.map(toPort),
    params: extras.params ?? c.params.map(paramFromRegistry),
    lifecycle: c.lifecycle,
    effects: c.effects,
    runnable: extras.runnable,
    hint: extras.hint,
    code: extras.code,
  };
}

/** 由后端注册表生成的节点类型集：语义（口/参数）全部来自 registry.json */
export const REGISTRY_NODE_TYPES: Record<string, NodeTypeDef> = Object.fromEntries(
  Object.values(registryData.components as Record<string, RegistryComponent>).map((c) => [c.type, fromRegistry(c)]),
);

/**
 * 已删除节点类型（v4 存量图里的 policy_endpoint / reduce / reward_shape 等）的画布占位：
 * 灰卡、零口零参、不可连线不可运行。nodeTypes 的 NODE_TYPES 缺键一律兑到它，旧图加载、
 * 升级副本预览、YAML/代码导出从此渲染占位而不是整页卸载；真类型永远只来自注册表。
 */
export const UNKNOWN_NODE_DEF: NodeTypeDef = {
  key: 'unknown',
  label: 'unknown',
  category: 'wf.catInput',
  color: COLORS.after,
  icon: <Wrench />,
  inputs: [],
  outputs: [],
  params: [],
};
