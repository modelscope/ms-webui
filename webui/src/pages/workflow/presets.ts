import type { GraphEdge, GraphFrame, GraphNode } from './nodeTypes';
import type { MessageKey } from '@/i18n';

/**
 * 示例图（v5 契约版）：轨迹是唯一样本载荷——driver/generate 的数据口是
 * traj；评分列写回轨迹（score 出 traj，下游不再有独立 reward 线）；训练目标
 * （advantages/returns/old_* /ref_logps/teacher_*）由 advantage 写回轨迹，
 * advantage.traj 直接接管 train_step 的 batch。前向汇成单一 MODEL_OUTPUT 出口
 * （out），参考/教师信号接 estimate的 ref_out/teacher_out 或 train_step 的
 * reference/teacher 口。构造身份（tokenizer、优化器）一律是参数，训练目标与
 * 评分函数是独立节点（loss / scorer）。many 口的边带 slot，slot 是消费端参数
 * 的真实名字或评分列名。数据集一律经 dataloader 进消费面，不直连。
 */
export interface Preset {
  key: string;
  label: MessageKey;
  desc: MessageKey;
  nodes: GraphNode[];
  edges: GraphEdge[];
  frames?: GraphFrame[];
  /** 画布真实的声明版本（preset 自身即 v5，留空按 5 记；载入旧图时被覆盖），
   * 保存/提交写回它而非盖章成 v5——升级退路靠它保住 */
  version?: number;
}

const E = (from: string, fromPort: string, to: string, toPort: string, slot?: string): GraphEdge => ({
  id: `${from}.${fromPort}-${to}.${toPort}${slot ? `#${slot}` : ''}`,
  from,
  fromPort,
  to,
  toPort,
  ...(slot ? { slot } : {}),
});

const N = (id: string, type: string, x: number, y: number, params?: GraphNode['params'],
           portSides?: GraphNode['portSides']): GraphNode => ({
  id, type, x, y, status: 'idle', ...(params ? { params } : {}),
  ...(portSides ? { portSides } : {}),
});

const P = (label: string, value: string) => ({ label, value });

/* 主链 x 坐标刻度与资源列 y 坐标刻度（沿用既有版式） */
const X = [0, 262, 524, 786, 1048, 1310, 1572, 1834, 2096];
const Y = [330, 560, 790, 1020, 1250, 1480];

const TOKENIZER = 'Qwen/Qwen3.5-4B';
const DATASET = '["AI-MO/NuminaMath-TIR"]';
// 编码模板显式钉在 qwen3_5（Qwen3_5Template）；loader 的 model_type→template
// 自动解析同样命中，显式声明只是防 registry 演进漂移。
const TEMPLATE = '{"template": "qwen3_5"}';
/*
 * 思考体实测 2K token 上下：补全上限 3072（RL 的 rl_config.max_completion_length、
 * 生成的 max_tokens），vLLM 序列上限 4096（prompt ~150 + completion 3072）。
 * 512/1024 的默认档会截断在思考中段——答案正确也提取不到，reward 恒 0。
 */
const COMPLETION = '{"max_completion_length": 3072}';
const GEN_ARGS = '{"max_tokens": 3072}';
// vLLM 引擎参数用引擎自己的参数名（gpu_memory_utilization）；拼错的名字
// 会被 VLLMEngine 当无效参数滤掉，静默落回默认 0.7。
const ENGINE_ARGS = '{"max_model_len": 4096, "gpu_memory_utilization": 0.3}';
// agentic 图（challenger 多轮出题/解题）的 episode 会累积 system+工具声明+
// 多轮调用+工作区快照 followup，1024 会把 episode 截断成 episode_cut_short。
const ENGINE_ARGS_AGENTIC = '{"max_model_len": 4096, "gpu_memory_utilization": 0.25}';

/**
 * GRPO（LoRA 流式）：主链 dataset→loader→driver→score→advantage→train→ckpt→merge→infer。
 * 组基线是 advantage 的 estimator 参数；损失与评分是独立节点（kind 参数）；
 * 采样器按模型 id 参数自建引擎。循环环：train.then→sync.after、sync.then→driver.after。
 * 参考前向（全参版的 KL 锚）接 advantage 的 ref_out，估计器把 ref_logps 写回轨迹。
 */
const GRPO: Preset = {
  key: 'grpo',
  label: 'wf.presetGrpo',
  desc: 'wf.presetGrpoDesc',
  nodes: [
    N('g_data', 'dataset', X[0], 0, [P('dataset', DATASET)]),
    N('g_loader', 'dataloader', X[0], 260, [P('batch_size', '4')]),
    N('g_driver', 'streaming_driver', X[1], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('rl_config', COMPLETION), P('async_mode', 'none'), P('max_staleness', '0'), P('num_generations', '4')]),
    N('g_score', 'score', X[2], 0),
    N('g_adv', 'advantage', X[3], 0, [P('estimator', 'grpo')]),
    N('g_train', 'train_step', X[4], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('g_ckpt', 'checkpoint', X[5], 0, [P('profile', 'model')]),
    N('g_merge', 'merge', X[6], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('g_infer', 'infer', X[7], 0, [P('infer_config', '{"sampler": "vllm"}')]),
    N('g_sync', 'weight_sync', X[3], 520, undefined, { after: 'right', then: 'left' }),
    /* 打分函数与训练目标是独立节点：kind 选注册名 */
    N('g_scor', 'scorer', X[2], 260, [P('kind', 'accuracy')]),
    N('g_loss', 'loss', X[4], 520, [P('kind', 'grpo')]),
    /* 左列资源：采样器与策略模型（各只有一个真实关系：引擎、被训对象） */
    N('g_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS), P('template_config', TEMPLATE)]),
    N('g_policy', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
  ],
  edges: [
    E('g_data', 'data', 'g_loader', 'data'),
    E('g_loader', 'source', 'g_driver', 'prompts'),
    E('g_sampler', 'sampler', 'g_driver', 'engine', 'engine'),
    E('g_scor', 'scorer', 'g_score', 'scorers', 'math'),
    E('g_driver', 'traj', 'g_score', 'traj'),
    E('g_score', 'traj', 'g_adv', 'traj'),
    /* 训练目标随轨迹交付：advantage 写完 advantages/old_logps 的轨迹接管训练批 */
    E('g_adv', 'traj', 'g_train', 'batch'),
    E('g_loss', 'loss', 'g_train', 'loss'),
    E('g_policy', 'model', 'g_train', 'model'),
    E('g_train', 'step', 'g_ckpt', 'step'),
    E('g_ckpt', 'artifact', 'g_merge', 'artifact'),
    E('g_merge', 'model', 'g_infer', 'artifact'),
    E('g_data', 'data', 'g_infer', 'data'),
    E('g_train', 'then', 'g_sync', 'after'),
    E('g_sync', 'then', 'g_driver', 'after'),
    E('g_sampler', 'sampler', 'g_sync', 'targets', 'targets'),
  ],
  frames: [{
    id: 'g_loop', label: 'wf.frameStreamLoop', note: 'wf.noteGrpo',
    x: 222, y: -40, w: 1560, h: 760,
    memberIds: ['g_driver', 'g_score', 'g_adv', 'g_train', 'g_sync'],
  }],
};

/**
 * 全参 GRPO：同一张图——训练类型是参数档位不是拓扑分叉；参考模型是独立冻结
 * 副本，其前向 logps 接 advantage 的 ref_out（估计器把 ref_logps 写回轨迹，
 * KL 锦在训练目标里）。
 */
const GRPO_FULL: Preset = {
  ...GRPO,
  key: 'grpo_full',
  label: 'wf.presetGrpoFull',
  desc: 'wf.presetGrpoFullDesc',
  nodes: GRPO.nodes.map((n) => {
    if (n.id === 'g_policy') return { ...n, params: [P('model', TOKENIZER), P('train_type', 'full')] };
    if (n.id === 'g_train') return { ...n, params: [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-6'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')] };
    return n;
  }).concat([
    N('g_ref', 'model', -262, Y[1], [P('model', TOKENIZER), P('freeze', 'true')]),
    N('g_refsig', 'model_forward', X[4], 260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('outputs', '["logps"]')]),
  ]),
  edges: GRPO.edges.concat([
    E('g_ref', 'model', 'g_refsig', 'model'),
    E('g_score', 'traj', 'g_refsig', 'traj'),
    E('g_refsig', 'out', 'g_adv', 'ref_out'),
    /* 双模型（policy+ref）作用下 checkpoint / weight_sync 显式消歧：接前序输出 */
    E('g_train', 'model', 'g_ckpt', 'model'),
    E('g_train', 'model', 'g_sync', 'model'),
  ]),
  frames: [{
    ...GRPO.frames![0],
    memberIds: [...GRPO.frames![0].memberIds ?? [], 'g_refsig'],
  }],
};

/**
 * GRPO colocate：dataloader→generate 替代 streaming_driver（同步逐批生成），
 * 打分→优势→训练同构。无发布回环（同步形态权重常驻采样器）。
 */
const GRPO_COLOCATE: Preset = {
  key: 'grpo_colocate',
  label: 'wf.presetGrpoColocate',
  desc: 'wf.presetGrpoColocateDesc',
  nodes: [
    N('c_data', 'dataset', X[0], 0, [P('dataset', DATASET)]),
    N('c_loader', 'dataloader', X[1], 0, [P('batch_size', '4')]),
    N('c_gen', 'generate', X[2], 0, [P('num_generations', '4'), P('generation_config', GEN_ARGS)]),
    N('c_score', 'score', X[3], 0),
    N('c_adv', 'advantage', X[4], 0, [P('estimator', 'grpo')]),
    N('c_train', 'train_step', X[5], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('c_ckpt', 'checkpoint', X[6], 0, [P('profile', 'model')]),
    N('c_merge', 'merge', X[7], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('c_scor', 'scorer', X[3], 260, [P('kind', 'accuracy')]),
    N('c_loss', 'loss', X[5], 260, [P('kind', 'grpo')]),
    N('c_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS), P('template_config', TEMPLATE)]),
    N('c_policy', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
  ],
  edges: [
    E('c_data', 'data', 'c_loader', 'data'),
    E('c_loader', 'batch', 'c_gen', 'prompts'),
    E('c_sampler', 'sampler', 'c_gen', 'engine'),
    E('c_scor', 'scorer', 'c_score', 'scorers', 'math'),
    E('c_gen', 'traj', 'c_score', 'traj'),
    E('c_score', 'traj', 'c_adv', 'traj'),
    E('c_adv', 'traj', 'c_train', 'batch'),
    E('c_loss', 'loss', 'c_train', 'loss'),
    E('c_policy', 'model', 'c_train', 'model'),
    E('c_train', 'step', 'c_ckpt', 'step'),
    E('c_ckpt', 'artifact', 'c_merge', 'artifact'),
  ],
  frames: [{
    id: 'c_loop', label: 'wf.frameTrainLoop', note: 'wf.noteColocateAuto',
    x: 222, y: -40, w: 2080, h: 520,
    memberIds: ['c_loader', 'c_gen', 'c_score', 'c_adv', 'c_train'],
  }],
};

/**
 * PPO（双模型）：在 GRPO 骨架上加 critic 线——独立 value 模型前向读 values
 * （接 advantage 的 value_out，GAE 估计器 delta_t = r_t + gamma·V_{t+1} − V_t
 * 递推），weight_average 把训练权重 EMA 进冻结参考。两个模型各占自己的
 * train_step；critic 的训练目标（returns/old_values）同样由 advantage 写回轨迹。
 * 双模型作用下 checkpoint / weight_sync / weight_average 的模型身份从 train
 * 的 model 输出口显式接线（前序输出），不再从 actor 横拉。
 */
const PPO: Preset = {
  key: 'ppo',
  label: 'wf.presetPpo',
  desc: 'wf.presetPpoDesc',
  nodes: [
    N('p_data', 'dataset', X[0], 0, [P('dataset', DATASET)]),
    N('p_loader', 'dataloader', X[0], 260, [P('batch_size', '4')]),
    N('p_driver', 'streaming_driver', X[1], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('rl_config', COMPLETION), P('async_mode', 'none'), P('max_staleness', '0'), P('num_generations', '4')]),
    N('p_score', 'score', X[2], 0),
    N('p_vsig', 'model_forward', X[3], -260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('outputs', '["values"]')]),
    N('p_adv', 'advantage', X[3], 0, [P('estimator', 'gae'), P('kwargs', '{"gamma": 1.0, "gae_lambda": 0.95}')]),
    N('p_train', 'train_step', X[4], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-5'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('p_vtrain', 'train_step', X[5], -260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-5'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('p_ckpt', 'checkpoint', X[5], 0, [P('profile', 'model')]),
    N('p_merge', 'merge', X[6], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('p_wavg', 'weight_average', X[4], 780, [P('mode', 'ema'), P('alpha', '0.9')]),
    N('p_sync', 'weight_sync', X[3], 520, undefined, { after: 'right', then: 'left' }),
    N('p_scor', 'scorer', X[2], 260, [P('kind', 'accuracy')]),
    N('p_loss', 'loss', X[4], 260, [P('kind', 'ppo')]),
    N('p_vloss', 'loss', X[6], -260, [P('kind', 'ppo_value')]),
    N('p_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS), P('template_config', TEMPLATE)]),
    N('p_policy', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
    // critic 头：PPO 的 value 前向（task='value'）要求 seq_cls 打分头，与 recipe 侧
    // critic（seq_cls + num_labels=1）同一构造口径。
    N('p_value', 'model', 0, Y[2], [P('model', TOKENIZER), P('train_type', 'lora'),
      P('model_config', '{"task_type": "seq_cls", "num_labels": 1}')]),
    N('p_ref', 'model', -262, Y[2], [P('model', TOKENIZER), P('freeze', 'true')]),
  ],
  edges: [
    E('p_data', 'data', 'p_loader', 'data'),
    E('p_loader', 'source', 'p_driver', 'prompts'),
    E('p_sampler', 'sampler', 'p_driver', 'engine', 'engine'),
    E('p_scor', 'scorer', 'p_score', 'scorers', 'math'),
    E('p_driver', 'traj', 'p_score', 'traj'),
    E('p_score', 'traj', 'p_adv', 'traj'),
    E('p_driver', 'traj', 'p_vsig', 'traj'),
    E('p_value', 'model', 'p_vsig', 'model'),
    E('p_vsig', 'out', 'p_adv', 'value_out'),
    E('p_adv', 'traj', 'p_train', 'batch'),
    E('p_loss', 'loss', 'p_train', 'loss'),
    E('p_policy', 'model', 'p_train', 'model'),
    E('p_train', 'step', 'p_ckpt', 'step'),
    E('p_train', 'model', 'p_ckpt', 'model'),
    E('p_ckpt', 'artifact', 'p_merge', 'artifact'),
    /* critic 线：value 前向 → advantage 的 value_out；critic 自己的 train_step
     * 消费轨迹上写回的 returns/old_values（train_ready） */
    E('p_adv', 'traj', 'p_vtrain', 'batch'),
    E('p_vloss', 'loss', 'p_vtrain', 'loss'),
    E('p_value', 'model', 'p_vtrain', 'model'),
    /* EMA 参考：训练权重混入冻结副本 */
    E('p_train', 'step', 'p_wavg', 'step'),
    E('p_ref', 'model', 'p_wavg', 'target'),
    E('p_train', 'model', 'p_wavg', 'source'),
    /* 发布环 */
    E('p_train', 'then', 'p_sync', 'after'),
    E('p_sync', 'then', 'p_driver', 'after'),
    E('p_sampler', 'sampler', 'p_sync', 'targets', 'targets'),
    E('p_train', 'model', 'p_sync', 'model'),
  ],
  frames: [{
    id: 'p_loop', label: 'wf.frameStreamLoop', note: 'wf.notePpo',
    x: 222, y: -300, w: 1560, h: 1420,
    memberIds: ['p_driver', 'p_score', 'p_vsig', 'p_adv', 'p_train', 'p_vtrain', 'p_wavg', 'p_sync'],
  }],
};

/**
 * RFT（拒绝采样微调）：generate→score→select（整组 best_of_n）→CE 训练。
 * select 同时切批与对齐信号，不是零方差过滤（那是组规则的事）。
 */
const RFT: Preset = {
  key: 'rft',
  label: 'wf.presetRft',
  desc: 'wf.presetRftDesc',
  nodes: [
    N('r_data', 'dataset', X[0], 0, [P('dataset', DATASET)]),
    N('r_loader', 'dataloader', X[1], 0, [P('batch_size', '4')]),
    N('r_gen', 'generate', X[2], 0, [P('num_generations', '8'), P('generation_config', GEN_ARGS)]),
    N('r_score', 'score', X[3], 0),
    N('r_sel', 'select', X[4], 0, [P('select', 'best_of_n'), P('top_k', '1')]),
    N('r_train', 'train_step', X[5], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('r_ckpt', 'checkpoint', X[6], 0, [P('profile', 'model')]),
    N('r_merge', 'merge', X[7], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('r_scor', 'scorer', X[3], 260, [P('kind', 'accuracy')]),
    N('r_loss', 'loss', X[5], 260, [P('kind', 'cross_entropy')]),
    N('r_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS), P('template_config', TEMPLATE)]),
    N('r_policy', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
  ],
  edges: [
    E('r_data', 'data', 'r_loader', 'data'),
    E('r_loader', 'batch', 'r_gen', 'prompts'),
    E('r_sampler', 'sampler', 'r_gen', 'engine'),
    E('r_scor', 'scorer', 'r_score', 'scorers', 'math'),
    E('r_gen', 'traj', 'r_score', 'traj'),
    /* 判据是轨迹上的具名评分列：select 从 score 的 traj 读，不再有独立 reward 线 */
    E('r_score', 'traj', 'r_sel', 'batch'),
    E('r_sel', 'batch', 'r_train', 'batch'),
    E('r_loss', 'loss', 'r_train', 'loss'),
    E('r_policy', 'model', 'r_train', 'model'),
    E('r_train', 'step', 'r_ckpt', 'step'),
    E('r_ckpt', 'artifact', 'r_merge', 'artifact'),
  ],
  frames: [{
    id: 'r_loop', label: 'wf.frameTrainLoop', note: 'wf.noteRft',
    x: 222, y: -40, w: 2080, h: 520,
    memberIds: ['r_loader', 'r_gen', 'r_score', 'r_sel', 'r_train'],
  }],
};

/**
 * OPD-MT（多教师蒸馏）：两路 teacher 前向各出一路 logps（单一 out 口），
 * signal_combine 以概率混合（logsumexp_k(log w_k + logp_k)）把 K 路融成单一
 * 教师目标——多教师融合是一个显式的通用数学组件，不是损失的隐藏分支；
 * 混合结果接 train_step 的 teacher 口（教师信号不再是 loss 形参连线）。
 */
const OPD_MT: Preset = {
  key: 'opd_mt',
  label: 'wf.presetOpdMt',
  desc: 'wf.presetOpdMtDesc',
  nodes: [
    N('o_data', 'dataset', X[0], 0, [P('dataset', DATASET)]),
    N('o_loader', 'dataloader', X[1], 0, [P('batch_size', '4')]),
    N('o_gen', 'generate', X[2], 0, [P('num_generations', '4'), P('generation_config', GEN_ARGS)]),
    N('o_tsig1', 'model_forward', X[3], -260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('outputs', '["logps"]')]),
    N('o_tsig2', 'model_forward', X[4], -260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('outputs', '["logps"]')]),
    N('o_mix', 'signal_combine', X[5], -260, [P('mode', 'probability_mixture')]),
    N('o_train', 'train_step', X[5], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('o_ckpt', 'checkpoint', X[6], 0, [P('profile', 'model')]),
    N('o_merge', 'merge', X[7], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('o_loss', 'loss', X[5], 260, [P('kind', 'opsd')]),
    N('o_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS), P('template_config', TEMPLATE)]),
    N('o_teach1', 'model', 0, Y[1], [P('model', TOKENIZER), P('freeze', 'true')]),
    N('o_teach2', 'model', 0, Y[2], [P('model', TOKENIZER), P('freeze', 'true')]),
    N('o_policy', 'model', 0, Y[3], [P('model', TOKENIZER), P('train_type', 'lora')]),
  ],
  edges: [
    E('o_data', 'data', 'o_loader', 'data'),
    E('o_loader', 'batch', 'o_gen', 'prompts'),
    E('o_sampler', 'sampler', 'o_gen', 'engine'),
    E('o_gen', 'traj', 'o_tsig1', 'traj'),
    E('o_teach1', 'model', 'o_tsig1', 'model'),
    E('o_tsig1', 'out', 'o_mix', 'signals', 'teacher_1'),
    E('o_gen', 'traj', 'o_tsig2', 'traj'),
    E('o_teach2', 'model', 'o_tsig2', 'model'),
    E('o_tsig2', 'out', 'o_mix', 'signals', 'teacher_2'),
    E('o_mix', 'out', 'o_train', 'teacher'),
    E('o_gen', 'traj', 'o_train', 'batch'),
    E('o_loss', 'loss', 'o_train', 'loss'),
    E('o_policy', 'model', 'o_train', 'model'),
    E('o_train', 'step', 'o_ckpt', 'step'),
    E('o_train', 'model', 'o_ckpt', 'model'),
    E('o_ckpt', 'artifact', 'o_merge', 'artifact'),
  ],
  frames: [{
    id: 'o_loop', label: 'wf.frameTrainLoop', note: 'wf.noteOpdMt',
    x: 222, y: -300, w: 2080, h: 780,
    memberIds: ['o_loader', 'o_gen', 'o_tsig1', 'o_tsig2', 'o_mix', 'o_train'],
  }],
};

/** OPSD：单教师版——一路 teacher logps 直进损失，GKD logits 契约由 loss 参数选择。 */
const OPSD: Preset = {
  key: 'opsd',
  label: 'wf.presetOpsd',
  desc: 'wf.presetOpsdDesc',
  nodes: OPD_MT.nodes.filter((n) => n.id !== 'o_teach2' && n.id !== 'o_tsig2' && n.id !== 'o_mix'),
  edges: OPD_MT.edges
    .filter((e) => e.from !== 'o_teach2' && e.from !== 'o_tsig2' && e.from !== 'o_mix'
      && e.to !== 'o_tsig2' && e.to !== 'o_mix')
    .map((e) => (e.from === 'o_tsig1' && e.to === 'o_mix'
      ? { ...e, to: 'o_train', toPort: 'teacher', slot: undefined } : e)),
  frames: [{
    ...OPD_MT.frames![0],
    memberIds: (OPD_MT.frames![0].memberIds ?? []).filter((id) => id !== 'o_tsig2' && id !== 'o_mix'),
  }],
};

/**
 * SFT（监督微调）：dataset→dataloader→train。编码在训练步内部按 tokenizer
 * 参数完成（labels shift 按离线规则）；训练帧成员只有迭代器与每批阶段。
 */
const SFT: Preset = {
  key: 'sft',
  label: 'wf.presetSft',
  desc: 'wf.presetSftDesc',
  nodes: [
    N('s_data', 'dataset', X[0], 0, [P('dataset', '["AI-ModelScope/alpaca-gpt4-data-en"]')]),
    N('s_loader', 'dataloader', X[1], 0, [P('batch_size', '8'), P('source', 'rows')]),
    N('s_train', 'train_step', X[2], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('s_loss', 'loss', X[2], 260, [P('kind', 'cross_entropy')]),
    N('s_ckpt', 'checkpoint', X[3], 0, [P('profile', 'model')]),
    N('s_merge', 'merge', X[4], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('s_policy', 'model', 0, Y[0], [P('model', TOKENIZER), P('train_type', 'lora')]),
  ],
  edges: [
    E('s_data', 'data', 's_loader', 'data'),
    E('s_loader', 'batch', 's_train', 'batch'),
    E('s_loss', 'loss', 's_train', 'loss'),
    E('s_policy', 'model', 's_train', 'model'),
    E('s_train', 'step', 's_ckpt', 'step'),
    E('s_ckpt', 'artifact', 's_merge', 'artifact'),
  ],
  frames: [{
    id: 's_loop', label: 'wf.frameTrainLoop', note: 'wf.noteOfflineAuto',
    x: 222, y: -40, w: 1560, h: 520,
    memberIds: ['s_loader', 's_train'],
  }],
};

/** SFT 全参版：train_type=full；checkpoint 的 model profile 即最终权重形态。 */
const SFT_FULL: Preset = {
  ...SFT,
  key: 'sft_full',
  label: 'wf.presetSftFull',
  desc: 'wf.presetSftFullDesc',
  nodes: SFT.nodes.map((n) => {
    if (n.id === 's_policy') return { ...n, params: [P('model', TOKENIZER), P('train_type', 'full')] };
    if (n.id === 's_train') return { ...n, params: [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-5'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')] };
    return n;
  }),
};

/**
 * DPO（偏好对）：数据经 loader 直入训练步（paired 编码在内部完成）；参考分支
 * 从独立冻结副本前向读 ref logps，接 train_step 的 reference 口。
 */
const DPO: Preset = {
  key: 'dpo',
  label: 'wf.presetDpo',
  desc: 'wf.presetDpoDesc',
  nodes: [
    N('d_data', 'dataset', X[0], 0, [P('dataset', '["AI-ModelScope/ultrafeedback-binarized-preferences-cleaned-kto"]')]),
    N('d_loader', 'dataloader', X[1], 0, [P('batch_size', '4'), P('source', 'rows')]),
    N('d_rsig', 'model_forward', X[2], -260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('outputs', '["logps"]')]),
    N('d_train', 'train_step', X[2], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '5e-6'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('d_loss', 'loss', X[2], 260, [P('kind', 'dpo')]),
    N('d_ckpt', 'checkpoint', X[3], 0, [P('profile', 'model')]),
    N('d_merge', 'merge', X[4], 0, [P('merge_config', '{"adapters": ["output/checkpoint-final"]}')]),
    N('d_policy', 'model', 0, Y[0], [P('model', TOKENIZER), P('train_type', 'lora')]),
    N('d_ref', 'model', 0, Y[1], [P('model', TOKENIZER), P('freeze', 'true')]),
  ],
  edges: [
    E('d_data', 'data', 'd_loader', 'data'),
    E('d_loader', 'batch', 'd_rsig', 'traj'),
    E('d_ref', 'model', 'd_rsig', 'model'),
    E('d_rsig', 'out', 'd_train', 'reference'),
    E('d_loader', 'batch', 'd_train', 'batch'),
    E('d_loss', 'loss', 'd_train', 'loss'),
    E('d_policy', 'model', 'd_train', 'model'),
    E('d_train', 'step', 'd_ckpt', 'step'),
    E('d_train', 'model', 'd_ckpt', 'model'),
    E('d_ckpt', 'artifact', 'd_merge', 'artifact'),
  ],
  frames: [{
    id: 'd_loop', label: 'wf.frameTrainLoop', note: 'wf.noteDpo',
    x: 222, y: -300, w: 1560, h: 780,
    memberIds: ['d_loader', 'd_rsig', 'd_train'],
  }],
};

/**
 * TCPO（试探图）：政策端点 + 外部 agent（api_endpoint）驱动的对照形态——
 * challenger 出题（backend 是被训策略的采样器）、answers 流进打分→优势→训练；
 * 判官是 score 的评分函数参数（API 判官的连接配置走评分参数）。
 */
const TCPO: Preset = {
  key: 'tcpo',
  label: 'wf.presetTcpo',
  desc: 'wf.presetTcpoDesc',
  nodes: [
    N('t_api', 'api_endpoint', 0, 0, [P('base_url', 'https://api.modelscope.cn/v1'), P('model', 'deepseek-ai/DeepSeek-V3.1')]),
    // 出题/解题批形走 challenger_config（原生构造参数）：小批快收敛。
    // num_solver_rollouts=3 + pass_band=[1,2]：被保留的任务求解结果必有
    // 通过/失败混合（组内奖励有差异，组准入不丢）；max_empty_rounds 让
    // 空产出快速失败而不是无限搜索；max_turns 透传给内部 MultiTurnRollout。
    N('t_chal', 'challenger', X[1], 0, [P('seed', '数学谜题'), P('max_tasks', '4'), P('tokenizer', TOKENIZER), P('template_config', TEMPLATE),
                                        P('challenger_config', '{"num_challenger_rollouts": 2, "num_solver_rollouts": 3, "pass_band": [1, 2], "max_empty_rounds": 12, "max_turns": 8}')]),
    N('t_score', 'score', X[2], 0),
    N('t_adv', 'advantage', X[3], 0, [P('estimator', 'grpo'), P('num_generations', '3')]),
    N('t_train', 'train_step', X[4], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('t_ckpt', 'checkpoint', X[5], 0, [P('profile', 'model')]),
    N('t_sync', 'weight_sync', X[3], 520, undefined, { after: 'right', then: 'left' }),
    N('t_scor', 'scorer', X[2], 260, [P('kind', 'accuracy')]),
    N('t_loss', 'loss', X[4], 260, [P('kind', 'grpo')]),
    N('t_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS_AGENTIC), P('template_config', TEMPLATE)]),
    N('t_policy', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
    // 相对 workspace 落在会话目录下（sandbox_config 的 LocalEnv 原生字段）：
    // 持久工作区启用文件工具，出题 episode 才有可被 check 脚本读回的产出。
    N('t_env', 'sandbox_env', X[1], 260, [P('sandbox_config', '{"workspace": "workspace"}')]),
  ],
  edges: [
    E('t_api', 'endpoint', 't_chal', 'api'),
    E('t_sampler', 'sampler', 't_chal', 'backend'),
    E('t_env', 'env', 't_chal', 'env'),
    E('t_scor', 'scorer', 't_score', 'scorers', 'math'),
    E('t_chal', 'answers', 't_score', 'traj'),
    E('t_score', 'traj', 't_adv', 'traj'),
    E('t_adv', 'traj', 't_train', 'batch'),
    E('t_loss', 'loss', 't_train', 'loss'),
    E('t_policy', 'model', 't_train', 'model'),
    E('t_train', 'step', 't_ckpt', 'step'),
    E('t_chal', 'source', 't_sync', 'source'),
    E('t_sampler', 'sampler', 't_sync', 'targets', 'targets'),
    E('t_train', 'then', 't_sync', 'after'),
    E('t_sync', 'then', 't_chal', 'after'),
  ],
  frames: [{
    id: 't_loop', label: 'wf.frameStreamLoop', note: 'wf.noteTcpo',
    x: 222, y: -40, w: 1560, h: 900,
    memberIds: ['t_chal', 't_score', 't_adv', 't_train', 't_sync'],
  }],
};

/**
 * PSC（提议者-求解者自博弈）：一个 challenger 双路出流——questions 训提议者、
 * answers 由求解者模型驱动的多轮机制产生（solver 线走 rollout 资源）；出题
 * backend 是提议者的采样引擎，判官走评分参数。
 */
const PSC: Preset = {
  key: 'psc',
  label: 'wf.presetPsc',
  desc: 'wf.presetPscDesc',
  nodes: [
    N('s_api', 'api_endpoint', 0, 0, [P('base_url', 'https://api.modelscope.cn/v1'), P('model', 'deepseek-ai/DeepSeek-V3.1')]),
    // 出题/解题批形与 tcpo 同构（challenger_config 原生构造参数）；questions
    // 口是出题组（2 条/组），rloo 的 num_generations 与组宽对齐。
    N('s_chal', 'challenger', X[1], 0, [P('seed', '谜题生成'), P('max_tasks', '4'), P('tokenizer', TOKENIZER), P('template_config', TEMPLATE),
                                         P('challenger_config', '{"num_challenger_rollouts": 2, "num_solver_rollouts": 3, "pass_band": [1, 2], "max_empty_rounds": 12, "max_turns": 8}')]),
    N('s_score', 'score', X[2], 0),
    N('s_adv', 'advantage', X[3], 0, [P('estimator', 'rloo'), P('num_generations', '2')]),
    N('s_train', 'train_step', X[4], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('s_ckpt', 'checkpoint', X[5], 0, [P('profile', 'model')]),
    N('s_sync', 'weight_sync', X[3], 780, undefined, { after: 'right', then: 'left' }),
    N('s_scor', 'scorer', X[2], 260, [P('kind', 'accuracy')]),
    N('s_loss', 'loss', X[4], 260, [P('kind', 'grpo')]),
    N('s_sampler', 'sampler', -262, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS_AGENTIC), P('template_config', TEMPLATE)]),
    N('s_sam2', 'sampler', -262, Y[1], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS_AGENTIC), P('template_config', TEMPLATE)]),
    N('s_prop', 'model', 0, Y[0], [P('model', TOKENIZER), P('train_type', 'lora')]),
    N('s_solver', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
    // 相对 workspace 落在会话目录下（sandbox_config 的 LocalEnv 原生字段）。
    N('s_env', 'sandbox_env', X[1], 520, [P('sandbox_config', '{"workspace": "workspace"}')]),
    N('s_sroll', 'rollout', X[1], 260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('max_turns', '4')]),
  ],
  edges: [
    E('s_api', 'endpoint', 's_chal', 'api'),
    E('s_sampler', 'sampler', 's_chal', 'backend'),
    E('s_env', 'env', 's_chal', 'env'),
    E('s_sam2', 'sampler', 's_sroll', 'sampler'),
    E('s_sroll', 'rollout', 's_chal', 'solver_rollout'),
    E('s_scor', 'scorer', 's_score', 'scorers', 'math'),
    E('s_chal', 'questions', 's_score', 'traj'),
    E('s_score', 'traj', 's_adv', 'traj'),
    E('s_adv', 'traj', 's_train', 'batch'),
    E('s_loss', 'loss', 's_train', 'loss'),
    E('s_prop', 'model', 's_train', 'model'),
    E('s_train', 'step', 's_ckpt', 'step'),
    E('s_train', 'model', 's_ckpt', 'model'),
    E('s_chal', 'source', 's_sync', 'source'),
    E('s_sampler', 'sampler', 's_sync', 'targets', 'targets'),
    E('s_train', 'then', 's_sync', 'after'),
    E('s_sync', 'then', 's_chal', 'after'),
  ],
  frames: [{
    id: 's_frame', label: 'wf.frameProposerLoop', note: 'wf.noteProposer',
    x: 222, y: -40, w: 1560, h: 1100,
    memberIds: ['s_chal', 's_score', 's_adv', 's_train', 's_sync'],
  }],
};

/**
 * RSI（研究迭代）：多轮 agentic 主链——rollout 引擎在沙箱里跑 tool-calling
 * episodes（工具集声明、环境 lease），generate 的 episode 口替换裸采样；
 * 判官是 score 的评分函数参数。
 */
const RSI: Preset = {
  key: 'rsi',
  label: 'wf.presetRsi',
  desc: 'wf.presetRsiDesc',
  nodes: [
    N('i_data', 'dataset', X[0], 260, [P('dataset', DATASET)]),
    N('i_loader', 'dataloader', X[1], 260, [P('batch_size', '4')]),
    N('i_gen', 'generate', X[2], 260, [P('num_generations', '4'), P('generation_config', GEN_ARGS)]),
    N('i_score', 'score', X[3], 260),
    N('i_adv', 'advantage', X[4], 260, [P('estimator', 'grpo')]),
    N('i_train', 'train_step', X[5], 260, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('lr', '1e-4'), P('gradient_accumulation_steps', '1'), P('micro_batch_size', '4')]),
    N('i_ckpt', 'checkpoint', X[6], 260, [P('profile', 'model')]),
    N('i_scor', 'scorer', X[3], 520, [P('kind', 'accuracy')]),
    N('i_loss', 'loss', X[5], 520, [P('kind', 'grpo')]),
    N('i_sampler', 'sampler', 0, Y[0], [P('model', TOKENIZER), P('engine', 'vllm'), P('engine_args', ENGINE_ARGS), P('template_config', TEMPLATE)]),
    N('i_policy', 'model', 0, Y[1], [P('model', TOKENIZER), P('train_type', 'lora')]),
    // 空工具集：仓内没有随包发布的工具插件模块（toolset 的 plugins 收插件
    // 文件/目录路径）；用户把自己的工具模块路径填进来即得真实工具环。
    N('i_tool', 'toolset', X[2], 0, [P('plugins', '[]')]),
    N('i_env', 'sandbox_env', X[3], 0),
    N('i_roll', 'rollout', X[4], 0, [P('tokenizer', TOKENIZER), P('template_config', TEMPLATE), P('max_turns', '6')]),
  ],
  edges: [
    E('i_data', 'data', 'i_loader', 'data'),
    E('i_loader', 'batch', 'i_gen', 'prompts'),
    E('i_sampler', 'sampler', 'i_roll', 'sampler'),
    E('i_tool', 'tools', 'i_roll', 'tools'),
    E('i_env', 'env', 'i_roll', 'env'),
    E('i_roll', 'rollout', 'i_gen', 'episode'),
    E('i_scor', 'scorer', 'i_score', 'scorers', 'math'),
    E('i_gen', 'traj', 'i_score', 'traj'),
    E('i_score', 'traj', 'i_adv', 'traj'),
    E('i_adv', 'traj', 'i_train', 'batch'),
    E('i_loss', 'loss', 'i_train', 'loss'),
    E('i_policy', 'model', 'i_train', 'model'),
    E('i_train', 'step', 'i_ckpt', 'step'),
  ],
  frames: [{
    id: 'i_loop', label: 'wf.frameEpisodeLoop', note: 'wf.noteRsi',
    x: 222, y: 200, w: 2080, h: 720,
    memberIds: ['i_loader', 'i_gen', 'i_score', 'i_adv', 'i_train'],
  }],
};

/** 深拷贝一张预设图并把节点状态复位——编辑页载入示例/切换示例用。 */
export const clonePreset = (p: Preset): Preset => ({
  ...p,
  nodes: p.nodes.map((n) => ({ ...n, status: 'idle', params: n.params?.map((x) => ({ ...x })) })),
  edges: p.edges.map((e) => ({ ...e })),
  frames: (p.frames ?? []).map((f) => ({ ...f, memberIds: f.memberIds ? [...f.memberIds] : undefined })),
});

export const PRESETS: Preset[] = [
  GRPO, GRPO_FULL, GRPO_COLOCATE, PPO, RFT, OPD_MT, OPSD, SFT, SFT_FULL, DPO, RSI, TCPO, PSC,
];

export const DEFAULT_PRESET = GRPO;
