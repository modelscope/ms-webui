/**
 * 训练显存预估（每卡，字节口径）。纯函数——只依赖结构数据与表单旋钮，
 * 不发请求。三项精确字节公式（权重 / 梯度 / 优化器状态）+ 激活的经验系数
 * 模型，分布口径是数据并行（DDP 全复制：每卡一份完整副本）；激活系数取
 * Korthikanti et al.（开梯度检查点 ≈ 每层只存输入 2B/元素位，不开 ≈ 34B，
 * 含注意力 softmax 与 MLP 中间量）。MoE 激活按路由稀疏近似不放大。
 */
import type { ModelStructure } from '@/api/train';

export interface MemoryEstimateInput {
  structure: ModelStructure;
  tuner: 'lora' | 'full' | 'trainable_tokens';
  loraRank: number;
  /** per_device_train_batch_size */
  batch: number;
  /** 序列长度（max_length；未知取 2048） */
  seqLen: number;
  gradCheckpoint: boolean;
  /** 权重精度字节数：bf16/fp16 = 2（默认），fp32 = 4 */
  dtypeBytes: number;
  /** AdamW 优化器状态字节数/可训参数：fp32 m+v = 8（默认），8bit 优化器 = 2 */
  optimizerBytes: number;
}

export interface MemoryBreakdown {
  /** 各分量字节数（每卡） */
  weights: number;
  grads: number;
  optimizer: number;
  activations: number;
  /** CUDA context 与碎片余量的固定开销 */
  ctx: number;
  /** 可训练参数量 */
  trainable: number;
  /** 每卡总需求（字节） */
  perCard: number;
}

const CTX_BYTES = 1.5 * 1024 ** 3;

/** LoRA 可训参数量：Σ 模块数 × r × (in + out)——模块计数与 shape 来自 safetensors 头统计 */
export function loraParams(s: ModelStructure, rank: number): number {
  let total = 0;
  for (const [name, count] of Object.entries(s.loraModules ?? {})) {
    const shape = (s.loraShapes ?? {})[name] ?? [];
    const outDim = shape[0] ?? 0;
    const inDim = shape[1] ?? 0;
    total += count * rank * (inDim + outDim);
  }
  return total;
}

/**
 * trainable_tokens 的可训参数量级：可训的是 embedding 的一个子集，上界是
 * 整个 embedding（vocab × hidden）。预估取上界——宁多勿少不误判 OOM。
 */
function trainableTokensParams(s: ModelStructure): number {
  return (s.vocab ?? 0) * (s.hidden ?? 0) || Math.round(s.params * 0.3);
}

export function estimateMemory(input: MemoryEstimateInput): MemoryBreakdown {
  const { structure: s, tuner, loraRank, batch, seqLen, gradCheckpoint, dtypeBytes, optimizerBytes } = input;
  const trainable =
    tuner === 'full'
      ? s.params
      : tuner === 'lora'
        ? loraParams(s, loraRank) || Math.round(s.params * 0.001)
        : trainableTokensParams(s);
  const weights = s.params * dtypeBytes;
  const grads = trainable * dtypeBytes;
  const optimizer = trainable * optimizerBytes;
  const activations =
    (s.layers ?? 0) * (s.hidden ?? 0) * batch * seqLen * (gradCheckpoint ? 2 : 34);
  const perCard = weights + grads + optimizer + activations + CTX_BYTES;
  return { weights, grads, optimizer, activations, ctx: CTX_BYTES, trainable, perCard };
}

/** 字节数 → 人类可读（GiB 两位 / MiB） */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

/** 参数量 → 人类可读（B/M） */
export function fmtParams(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e3).toFixed(0)}K`;
}

/*
 * 并行分片口径的显存预估：dp / tp / pp / ZeRO 四个自由度（与 twinkle
 * DeviceMesh 的维度同名）。分片规则——TP 切权重与激活、PP 切层（权重/梯度/
 * 优化器都只算本 stage 的层）、ZeRO1/2/3 依次把优化器/梯度/权重按 dp 分片；
 * LoRA 可训参数随 TP 近似切分（每卡只挂本地模块）。ctx 固定开销不切。
 */
export interface ParallelSpec {
  dp: number;
  tp: number;
  pp: number;
  /** ZeRO 档位：0=DDP 全复制；1=优化器分片；2=+梯度；3=+权重 */
  zero: 0 | 1 | 2 | 3;
}

export function estimateMemorySharded(
  input: MemoryEstimateInput,
  spec: ParallelSpec,
): MemoryBreakdown {
  const { structure: s, tuner, loraRank, batch, seqLen, gradCheckpoint, dtypeBytes, optimizerBytes } = input;
  const { dp, tp, pp, zero } = spec;
  /* 模型切分基数：TP 与 PP 都把单卡承担的参数量缩小 */
  const shard = tp * pp;
  const trainableAll =
    tuner === 'full'
      ? s.params
      : tuner === 'lora'
        ? loraParams(s, loraRank) || Math.round(s.params * 0.001)
        : trainableTokensParams(s);
  const trainable = Math.max(1, Math.round(trainableAll / (tuner === 'lora' ? tp : 1)));
  /* ZeRO 对可训练态的分片（zero=3 时连权重也切；embedding 类不分片，粗略按可切算） */
  const zeroDiv = (n: number) => n / dp;
  const weights = zero >= 3 ? zeroDiv((s.params * dtypeBytes) / shard) : (s.params * dtypeBytes) / shard;
  const grads = (trainable * dtypeBytes) / (zero >= 2 ? dp : 1);
  const optimizer = (trainable * optimizerBytes) / (zero >= 1 ? dp : 1);
  const activations = ((s.layers ?? 0) / pp) * (s.hidden ?? 0) * batch * seqLen * (gradCheckpoint ? 2 : 34) / tp;
  const perCard = weights + grads + optimizer + activations + CTX_BYTES;
  return { weights, grads, optimizer, activations, ctx: CTX_BYTES, trainable, perCard };
}

/** DeviceMesh 网格（twinkle get_device_placement 同构）：行 = dp、列 = tp、格 = 全局 rank；pp 展开为 stage 块 */
export function meshGrid(spec: ParallelSpec): number[][][] {
  const grids: number[][][] = [];
  for (let stage = 0; stage < spec.pp; stage++) {
    const rows: number[][] = [];
    for (let d = 0; d < spec.dp; d++) {
      const row: number[] = [];
      for (let t = 0; t < spec.tp; t++) {
        row.push(stage * spec.dp * spec.tp + d * spec.tp + t);
      }
      rows.push(row);
    }
    grids.push(rows);
  }
  return grids;
}
