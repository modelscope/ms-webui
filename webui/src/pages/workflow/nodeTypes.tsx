import type { ReactNode } from 'react';
import { REGISTRY_NODE_TYPES, UNKNOWN_NODE_DEF } from './registryNodes';
import registryData from './registry.json';
import type { MessageKey } from '@/i18n';

/**
 * 节点类型注册表：编排画布上「有哪些组件」的唯一定义源。
 *
 * 粒度上刻意不做「SFT 训练」这种一体节点——训练循环里真正要调的是
 * 损失、优势估计、奖励、指标这几块，包成一个节点就没得配了。
 * 所以训练被拆成：采样 → 奖励 → 优势 → 损失 → 训练循环，各自独立成节点。
 *
 * 加一种节点 = 在这里加一项，左侧组件面板、画布、YAML 生成都会自动跟随。
 */

/**
 * 端口数据类型。连线两端类型必须一致，画布会挡掉不匹配的连接；
 * 端口圆点和连线颜色都取自类型，扫一眼就知道这根线在传什么。
 */
/* 通道语义表（kind -> schema）。20 个 kind 的全集，PORT_TYPES 据此派生。 */
const registryChannels: Record<string, unknown> = registryData.channels as Record<string, unknown>;

/**
 * 通道的展示层（颜色 + 文案键）。语义真相源是 registry.json 的 channels
 * （20 个 kind）；本表只管长相，两者在下方的派生循环里合成 PORT_TYPES。
 * channels 里出现而本表没配的 kind 走兑底色，不再崩溃；本表里有而
 * channels 已除名的 kind（如旧图的 REWARD/ADV/SIGNAL）保留条目，
 * 旧画布数据在升级前仍可渲染。
 */
const PORT_DISPLAY: Record<string, { label: MessageKey; color: string }> = {
  MODEL: { label: 'wf.portModel', color: '#3B82F6' },
  DATA: { label: 'wf.portData', color: '#A855F7' },
  SAMPLER: { label: 'wf.portSampler', color: '#0EA5E9' },
  /**
   * 轨迹。一根 TRAJ 线传的是一批轨迹（batch × num_generations 条），
   * 每条轨迹自带 input_ids / labels / logprobs / turns；评分列与训练目标
   * （advantages/returns/old_*）都是轨迹的字段，不单独拉线。
   */
  TRAJ: { label: 'wf.portTraj', color: '#22D3EE' },
  /**
   * 前向结果（ModelOutput）。logps/values/logits/embeddings 是它的字段
   * profile，不是独立连线类型；参考/教师/旧策略/critic 的前向角色由
   * 消费口（ref_out/teacher_out/old_out/value_out）表达。
   */
  MODEL_OUTPUT: { label: 'wf.portModelOutput', color: '#34D399' },
  /** 环境池。一根 ENV 线代表一批 env slot，与轨迹按下标一一对应 */
  ENV: { label: 'wf.portEnv', color: '#84CC16' },
  TOOL: { label: 'wf.portTool', color: '#D946EF' },
  REWARD: { label: 'wf.portReward', color: '#EAB308' },
  ADV: { label: 'wf.portAdv', color: '#F97316' },
  METRIC: { label: 'wf.portMetric', color: '#14B8A6' },
  ENDPOINT: { label: 'wf.portEndpoint', color: '#10B981' },
  /**
   * 空 token（先后顺序）。组件即 lambda：数据边本身已蕴含 happens-before，
   * 只有没有数据依赖可依附的先后关系才用 CTRL 线——如训练完发布、发布完回生成。
   */
  CTRL: { label: 'wf.portCtrl', color: '#64748B' },
  /* --- 资源通道（scope 类） --- */
  DATASET: { label: 'wf.portDataset', color: '#9333EA' },
  ROLLOUT: { label: 'wf.portRollout', color: '#06B6D4' },
  GROUP_RULE: { label: 'wf.portGroupRule', color: '#DB2777' },
  BATCH: { label: 'wf.portBatch', color: '#C084FC' },
  SIGNAL: { label: 'wf.portSignal', color: '#34D399' },
  TRAIN_BATCH: { label: 'wf.portTrainBatch', color: '#2DD4BF' },
  STEP: { label: 'wf.portStep', color: '#94A3B8' },
  PUBLISH: { label: 'wf.portPublish', color: '#2563EB' },
  SYNC: { label: 'wf.portSync', color: '#0D9488' },
  ARTIFACT: { label: 'wf.portArtifact', color: '#F59E0B' },
  /* 旧图数据里的已除名通道：保渲染，不参与新图生成（v5 契约除名：
     REWARD/ADV/SIGNAL 包装降为轨迹字段或 MODEL_OUTPUT；模板/损失/优化器
     /评分均降为参数，不再有对应连线） */
  TEMPLATE: { label: 'wf.portTemplate', color: '#8B5CF6' },
  SCORER: { label: 'wf.portScorer', color: '#E11D48' },
  OPTIMIZER: { label: 'wf.portOptimizer', color: '#DC2626' },
  LOSS: { label: 'wf.portLoss', color: '#EF4444' },
  CKPT: { label: 'wf.portCkpt', color: '#F59E0B' },
  OPTIMIZER_SPEC: { label: 'wf.portOptimizerSpec', color: '#DC2626' },
  TRAINER: { label: 'wf.portTrainer', color: '#475569' },
};

/* channels 是全集真相源；本表已配的旧名也并入，保证旧图可渲染 */
export const PORT_TYPES: Record<string, { label: MessageKey; color: string }> = {};
for (const kind of Object.keys(PORT_DISPLAY)) {
  PORT_TYPES[kind] = PORT_DISPLAY[kind];
}
for (const kind of Object.keys(registryChannels)) {
  if (!PORT_TYPES[kind]) {
    PORT_TYPES[kind] = { label: kind as MessageKey, color: '#6B7280' };
  }
}

export type PortTypeKey = keyof typeof PORT_TYPES;

/** 翻译函数的最小形状（纯函数注入用），与 useT 的 t 同构 */
export type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 节点类型的展示名：有翻译 key 走 key，否则回落 registry 原文；def 缺失时空串 */
export function nodeLabel(def: NodeTypeDef | undefined, t: TFn): string {
  return def ? (def.labelKey ? t(def.labelKey) : def.label) : '';
}

export interface PortDef {
  key: string;
  label: string;
  type: PortTypeKey;
  /**
   * 多输入口（many）：同一口接多条边，每条边带 slot（消费端参数名）。
   * 连线层据此放行多路（普通口重连即替换）；序列化层据此要求 slot。
   */
  many?: boolean;
  /**
   * 口的身份（registry PortSpec.role）：同一个 MODEL 出口是策略视图还是底座视图、
   * 一个 MODEL 入口要的是 KL 锚还是教师——类型系统只能保证「都叫 MODEL」，
   * role 说明这根线在算法里扮演什么。连线引导时显示在兼容口旁。
   */
  role?: string;
  /**
   * 消费者口额外接受的异构通道（后端 PortSpec.accepts 的导出，如 train_step.batch
   * 声明 ['DATA','BATCH']）：源口类型等于本口类型、或命中该表，连线即合法——
   * 与后端图校验同一套规则，否则 preset 里的合法边用户手工重连时会被拒。
   */
  acceptedKinds?: string[];
}

export interface NodeParam {
  label: string;
  value: string;
  /**
   * registry 声明的参数类型（str/int/float/bool/list/dict）。展示层不读它；
   * 序列化层据此把面板的字符串值转回真实 JSON 类型——v3 契约要类型化参数，
   * 面板输入恒为文本是 UI 现实，转换发生在提交边界而不是各组件。
   */
  ptype?: string;
  /**
   * 参数分区。带 group 的连续参数在检查面板里聚成一节、共用一个小标题——
   * 训练单元这种参数多但明显分几类的节点，靠它把「主链 / 旋钮 / 观察」分开，
   * 免得十几行平铺谁也找不到自己要改的那个。不写就归入无名区，照旧平铺。
   */
  group?: MessageKey;
}

export interface NodeTypeDef {
  key: string;
  /** 原始展示名（registry.json 的中文 label，AI 上下文等原文场景用） */
  label: string;
  /** 展示名的翻译 key；UI 渲染优先于 label */
  labelKey?: MessageKey;
  /** 组件面板里的分组 */
  category: MessageKey;
  /** 节点主色（按分组走），标题栏用它 */
  color: string;
  icon: ReactNode;
  inputs: PortDef[];
  outputs: PortDef[];
  /** 节点体里显示的参数摘要 */
  params: NodeParam[];
  /**
   * 生命周期与副作用（registry 声明，序列化 frame 时判定成员角色用）：
   * Resource 不进循环框；Iterator 是 frame 的 sources；带 effects 的成员
   * 必须被 consumers 覆盖。展示层不读它们，序列化层读。
   */
  lifecycle?: string;
  effects?: string[];
  /** 能否单独运行。纯声明节点（数据、模型、优化器）没有运行的概念 */
  runnable?: boolean;
  /** 面板 tooltip 里的一句话说明 */
  hint?: MessageKey;
  /**
   * 代码节点：节点体里显示可编辑的 Python 片段，而不是参数表。
   * 承载 action_mapper 这类没法参数化的自由逻辑。
   */
  code?: string;
  /**
   * 端口锁定。true 表示这个节点的连线不允许用户改动。
   *
   * 只用在轨迹过滤上：它的三路数据（轨迹、logprobs、优势）必须同进同出，
   * 且优势必须在过滤的上游算好。这两条一旦被改，训练结果会错但不报错——
   * 端口类型全都匹配，校验器查不出来。等图级校验器能表达跨节点约束再放开。
   */
  lockedPorts?: boolean;
}

/**
 * 画布节点类型全集 = 后端注册表（唯一真相源）。
 * 语义（口、参数、类别）来自 registry.json；图标/配色/提示等纯展示在 registryNodes 的
 * UI_EXTRAS 表。加一种组件 = registry.py 加 descriptor + 重跑 export + UI_EXTRAS 加一行。
 */
/*
 * 缺键兑底（Proxy）：v4 存量图携带的已删除节点类型（policy_endpoint / reduce /
 * reward_shape 等）读注册表拿不到 def，任何 NODE_TYPES[type] 直接解引用都会当场崩。
 * 缺键一律兑 UNKNOWN_NODE_DEF 灰卡占位（零口零参、不可连线不可运行），旧图加载、
 * 升级副本预览、YAML/代码导出渲染占位而不是整页卸载。面板/类型列表不受影响
 * （Object.values/in 均不经 get 陷阱，仍只枚举注册表内类型）。
 */
export const NODE_TYPES: Record<string, NodeTypeDef> = new Proxy(REGISTRY_NODE_TYPES, {
  get: (types, type: string) => types[type] ?? UNKNOWN_NODE_DEF,
});



/** 组件面板的分组顺序，按训练循环的数据流从上到下排 */
export const CATEGORY_ORDER: MessageKey[] = [
  'wf.catInput',
  'wf.catSampler',
  'wf.catAgentEnv',
  'wf.catRewardAdv',
  'wf.catLoss',
  'wf.catMetric',
  'wf.catLoop',
  'wf.catAfter',
];

export const NODE_TYPE_LIST = Object.values(NODE_TYPES);

/** 节点运行状态。单个节点可以独立跑，所以状态挂在节点上而非整图 */
export type NodeStatus = 'idle' | 'running' | 'done' | 'failed';

/**
 * 图上的一个节点。这是编排的「作者格式」：presets.ts 手排坐标、YAML/代码生成、
 * AI 上下文、输出模拟全都读它。画布内部会把它转成 React Flow 的节点结构，
 * 转换只发生在 NodeCanvas 一个地方。
 */
export interface GraphNode {
  id: string;
  type: string;
  x: number;
  y: number;
  status: NodeStatus;
  /** 允许逐节点覆盖默认参数 */
  params?: NodeParam[];
  /** 代码节点的当前内容，覆盖类型里的默认片段 */
  code?: string;
  /**
   * 顺序口（CTRL）的左右侧覆盖：按口 key 写 'left' | 'right'。
   * 数据口固定输入左、输出右；只有空 token 口可翻——回环线贴着布局走就不交叉。
   * 点节点上顺序口的名字切换。
   */
  portSides?: Record<string, 'left' | 'right'>;
}

/**
 * 循环容器。画在节点下面一层的半透明框，标出“这一块每步重跑”。
 *
 * 两种用法：给了 memberIds 就是真归属——框位按成员当前坐标自动计算，
 * 拖节点框跟着走、永不脱框；没给成员就是纯视觉分区（手排坐标，拖走会漂）。
 * 迭代器组件（driver 这类产出流的组件）用它框住自己和消费者，
 * 把「这两个节点在迭代」和一次性流水线区分开。
 */
export interface GraphFrame {
  id: string;
  label: MessageKey;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 框右上角的一行注，写循环条件 */
  note?: MessageKey;
  color?: string;
  /** 成员节点 id：给了就按成员 bbox 自动包裣（拖动跟随） */
  memberIds?: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
  /**
   * 多输入口（many）的槽位名。v3 协议里 many 口的每条边都带 slot，
   * slot 就是消费端参数的真实名字（如 train_step.arguments 的 loss 参数名、
   * signal_combine.signals 的具名权重）——它不是装饰：后端按 (slot, value)
   * 配对消费，缺 slot 的 many 边在执行期无名义可落。
   */
  slot?: string;
}

/**
 * 节点宽度。
 *
 * 原来这里还有 HEADER_H / PORT_TOP / PORT_GAP / portY() / nodeHeight() 五个东西，
 * 用来手算每个端口圆点的绝对坐标、以及手算「适应视图」要缩到多少。
 * 换成 React Flow 之后这些全都不需要了：端口是 <Handle>，位置由它自己排；
 * 节点高度由内容撑开、由布局引擎量；fitView 是库自带的。
 *
 * 只剩宽度还留着，因为它是设计约束（一列放得下几个节点）而不是推导值，
 * 而且点组件面板往画布中央加节点时要拿它算居中偏移。
 */
export const NODE_W = 208;

/** 查端口定义，连线的颜色和类型校验都用它 */
export function findPort(
  typeKey: string,
  portKey: string,
  dir: 'in' | 'out',
): PortDef | undefined {
  const def = NODE_TYPES[typeKey];
  if (!def) return undefined;
  return (dir === 'in' ? def.inputs : def.outputs).find((p) => p.key === portKey);
}

/**
 * 节点级类型定义：内置类型直接取注册表形态；代码组件的端口与生命周期
 * 活在节点自己的 params 里（实例级声明，类型级 def 是空壳），在这里合成。
 * 画布渲染、连线校验、检查器统一走这一个入口——动态端口才能画出口圆点、
 * 边才有 handle 可挂，否则代码组件节点在画布上是连不了线的孤岛。
 */
export function nodeDefOf(node: GraphNode): NodeTypeDef | undefined {
  const def = NODE_TYPES[node.type];
  if (!def || node.type !== 'code_component') return def;
  const raw = (name: string): string | undefined =>
    (node.params ?? def.params).find((p) => p.label === name)?.value;
  const ports = (name: string): PortDef[] => {
    const text = raw(name);
    if (typeof text !== 'string' || !text.trim()) return [];
    try {
      const list = JSON.parse(text) as Array<Record<string, unknown>>;
      return list
        .filter((p) => p && typeof p.key === 'string' && typeof p.kind === 'string')
        .map((p) => ({
          key: String(p.key),
          label: String(p.key),
          type: String(p.kind) as PortDef['type'],
          role: p.role ? String(p.role) : undefined,
          many: p.many === true,
        }));
    } catch {
      /* 声明 JSON 写坏时端口按未声明处理：节点渲染不炸，连线校验自然拒绝 */
      return [];
    }
  };
  const lifecycle = typeof raw('lifecycle') === 'string' ? String(raw('lifecycle')) : def.lifecycle;
  return { ...def, inputs: ports('ports_in'), outputs: ports('ports_out'), lifecycle };
}

/** 按节点查端口：动态端口的连线校验入口（等价 findPort 但吃节点实例） */
export function findPortOf(
  node: GraphNode | undefined,
  portKey: string,
  dir: 'in' | 'out',
): PortDef | undefined {
  if (!node) return undefined;
  const def = nodeDefOf(node);
  if (!def) return undefined;
  return (dir === 'in' ? def.inputs : def.outputs).find((p) => p.key === portKey);
}
