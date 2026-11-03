/**
 * 训练任务的 webui 后端客户端。
 *
 * 后端是 vite dev server 的任务执行器（见 vite.config.ts）：一个训练任务 =
 * 一次 `swift sft` / `swift pt` / `swift rl` 子进程（taskType 选择，RL 算法
 * 由 params.rl_type 携带）。核心字段（模型/数据集/tuner/插件/选卡）结构化，
 * 其余训练旋钮以 params KV 自由携带（key = CLI flag 名）；「将要执行」直写
 * 的附加参数走 extraArgs。完整 spawn 参数由后端在创建时拼好存 args。
 */

import { tStatic } from '@/i18n';

/** 从训练日志解析出的单条指标（swift 的 logging_steps 行） */
export interface TrainMetric {
  step: number;
  loss?: number;
  lr?: number;
  gradNorm?: number;
  epoch?: number;
  /** 算法专有指标（reward、rewards/margins 等）：key 与日志行里的指标名同文 */
  extra?: Record<string, number>;
}

/** 训练任务的公开形态（后端 publicTrainTask 的镜像） */
export interface TrainTaskInfo {
  id: string;
  /** 用户改的显示名；不设时列表用「模型 · tuner · 数据集摘要」拼接 */
  name?: string;
  /**
   * v5 训练命令面三选一：sft / pt / rl。dpo、grpo、gkd 等算法是
   * `swift rl --rl_type <t>` 的变体（见 params.rl_type），不是独立命令。
   * 'code' 是第四种形态：用户直接写 Python（swift.dev 原生 API），整份
   * 代码落盘后由解释器执行（mode='code' 创建，见 startCodeTrain）。
   */
  taskType: 'sft' | 'pt' | 'rl' | 'code';
  model: string;
  datasets: string[];
  valDatasets?: string[];
  tuner: 'full' | 'lora' | 'trainable_tokens';
  /** 插件来源（external_plugins），登记于 plugins.json */
  plugins: string[];
  gpus?: number[];
  gpuCount?: number;
  params: Record<string, string | number | boolean>;
  /** 关注指标（创建页预选）：不传/空 = 展示全部实际出现的指标 */
  watchMetrics?: string[];
  extraArgs?: string;
  outputDir: string;
  /** 创建时拼好的完整 spawn 参数——createCommand 直接由它重建 */
  args: string[];
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  step?: number;
  totalSteps?: number;
  metrics: TrainMetric[];
}

export async function listTrains(): Promise<TrainTaskInfo[]> {
  const res = await fetch('/api/train');
  if (!res.ok) throw new Error(tStatic('api.loadTrainListFailed', { status: res.status }));
  return (await res.json()).tasks;
}

export async function startTrain(input: {
  model: string;
  datasets: string[];
  /** 创建时直接携带的显示名（消融实验批量启动用；不传由列表拼接展示） */
  name?: string;
  /** 训练命令：sft / pt / rl（默认 sft） */
  taskType?: 'sft' | 'pt' | 'rl';
  valDatasets?: string[];
  tuner: 'full' | 'lora' | 'trainable_tokens';
  plugins?: string[];
  gpus?: number[];
  gpuCount?: number;
  /** 训练旋钮（key = CLI flag 名） */
  params?: Record<string, string | number | boolean>;
  /**
   * 关注指标（创建页按任务类型预选）：详情/对比页按它决定画哪几张曲线；
   * 不传/空 = 显示日志里实际出现的全部指标。key 与日志行指标名同文
   * （loss/grad_norm/lr 固定，其余如 reward、rewards/margins）。
   */
  watchMetrics?: string[];
  extraArgs?: string;
}): Promise<string> {
  const res = await fetch('/api/train', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.startFailed'));
  return (await res.json()).id;
}

/**
 * 代码模式创建：整份 Python 落盘 ~/.swift/workspace/train-code/<任务 id>.py
 * 后 spawn 解释器执行。字段校验只有「代码非空」一条——训练内容对错由
 * 解释器与 swift.dev 报错。gpus 进 CUDA_VISIBLE_DEVICES（本机选卡）；
 * 并行规格由代码内的 DistributedConfig 自己声明，没有集群卡数一说。
 */
export async function startCodeTrain(input: {
  code: string;
  name?: string;
  gpus?: number[];
}): Promise<string> {
  const res = await fetch('/api/train', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'code', ...input }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.startFailed'));
  return (await res.json()).id;
}

export async function stopTrain(id: string): Promise<void> {
  const res = await fetch(`/api/train/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopFailed', { status: res.status }));
}

/** 重命名：只改 webui 里的显示名，不触碰任务本体与输出目录 */
export async function renameTrain(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/train/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.renameFailed'));
}

export async function getTrainLog(id: string): Promise<string[]> {
  const res = await fetch(`/api/train/${encodeURIComponent(id)}/log`);
  if (!res.ok) throw new Error(tStatic('api.readLogFailed', { status: res.status }));
  return (await res.json()).lines;
}

/*
 * 列表/详情页共用展示助手：label 与 createCommand 的拼装逻辑只此一份
 * （原先在两个页面各抄一遍，代码模式出现后两处都得改，干脆收进来）。
 */

/** 任务显示名：用户改过用改的；没改时按形态拼（代码任务模型/数据集为空，兜底「代码训练」） */
export function trainTaskLabel(t: TrainTaskInfo): string {
  if (t.name) return t.name;
  if (t.taskType === 'code') return tStatic('api.codeTrainLabel', { time: t.startedAt });
  return `${t.model} · ${t.taskType}${t.taskType === 'rl' && t.params.rl_type ? `:${t.params.rl_type}` : ''} · ${t.tuner} · ${t.datasets[0] ?? ''}${t.datasets.length > 1 ? tStatic('api.moreDatasets', { n: t.datasets.length }) : ''}`;
}

/**
 * 创建命令：args 是后端创建时拼好的完整 spawn 参数（spawn 与展示同源）。
 * CLI 形态把首个 -m swift.dev.cli.<taskType> 换成用户可读的命令形态；
 * 代码形态 args 就是落盘文件本身——展示 `python <file>`。
 */
export function trainCreateCommand(t: TrainTaskInfo): string {
  if (t.taskType === 'code') {
    return `USE_SWIFT_V5=1 python ${t.args[0]}`;
  }
  return [
    `USE_SWIFT_V5=1 swift ${t.taskType}`,
    ...t.args
      .slice(2)
      .map((a) => `    ${a}`),
  ].join(' \\\n');
}

/*
 * 训练预检（可视化）客户端：模型可训练结构 + 数据集前 N 条。
 * 都是手动触发（结构探测对非缓存模型要联网拉 config；数据集预览对 hub
 * 数据集首次要下载）——后端 /api/train/model-structure / dataset-preview。
 */

/** 模型结构（参数量精确与否看 paramsSource：本机缓存走 safetensors 头，否则 config 估算） */
export interface ModelStructure {
  model: string;
  params: number;
  paramsSource: 'safetensors' | 'config-estimate';
  modelType?: string;
  layers?: number;
  hidden?: number;
  heads?: number;
  kvHeads?: number;
  vocab?: number;
  intermediate?: number;
  moeExperts?: number;
  /** 各 LoRA 目标模块的出现次数（从权重名统计；混合注意力架构会含 in_proj_* / out_proj） */
  loraModules?: Record<string, number>;
  /** 各模块的权重 shape [out, in]（同构模块取第一个） */
  loraShapes?: Record<string, number[]>;
}

export async function fetchModelStructure(model: string): Promise<ModelStructure> {
  const res = await fetch('/api/train/model-structure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.probeFailed'));
  return (await res.json()) as ModelStructure;
}

/** 数据集行的开放形态：messages 形态或任意 KV（训练 loader 原样产出） */
export type DatasetPreviewRow = Record<string, unknown>;

export async function fetchDatasetPreview(
  dataset: string,
  n: number,
): Promise<{ rows: DatasetPreviewRow[]; truncated: boolean }> {
  const res = await fetch('/api/train/dataset-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset, n }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.datasetLoadFailed'));
  return (await res.json()) as { rows: DatasetPreviewRow[]; truncated: boolean };
}

/** 奖励规则名注册表（orm/prm）：判别奖励条目是规则名（不占组）还是模型 id（占独立组） */
export async function listOrmRules(): Promise<{ orm: string[]; prm: string[] }> {
  const res = await fetch('/api/train/orm-rules');
  if (!res.ok) throw new Error(`orm-rules ${res.status}`);
  return res.json();
}
