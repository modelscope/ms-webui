import { encode } from 'gpt-tokenizer';
import { streamChat, type ChatMessage } from '../api/models';

/**
 * 对话历史压缩：token 估算超阈值时把旧消息摘要成一条 system 消息 + 保留
 * 最近几轮原文（rolling summary）。
 *
 * 只处理对话本体（turns + 本轮 user 消息）——调用方组装的固定 system 注入
 * （人格 / 任务引导 / skills 文档）不参与：它们每轮都要原样在场，计入阈值
 * 只会让每段对话从第一句起就触发压缩，而它们本身没有可压缩的语义。
 *
 * 摘要单独持久化（会话 × 模型两维），且只增不重算：已覆盖 `covered` 条的
 * 摘要复用，本轮只需增量摘要新覆盖的段。渲染与 turns 持久化仍是全量原文，
 * 压缩只影响发出去的请求体。
 */

/** 触发阈值：约 32k 上下文的 75%。Qwen/DeepSeek 词表与 cl100k 有偏差，保守取值 */
const COMPRESS_THRESHOLD_TOKENS = 24000;
/** 模型上下文假设（32k 级）：与固定 system 注入合计后的总预算约束 */
export const CONTEXT_TOKENS = 32768;
/** 输出与编码偏差的预留量 */
export const CONTEXT_RESERVE_TOKENS = 4096;
/** 压缩后至少保留的对话空间：system 注入再大也不能把对话挤没 */
const MIN_DIALOGUE_TOKENS = 6000;
/** 压缩后保留原文的最近消息条数（对话轮语义，实际切点会对齐到 user 边界） */
const KEEP_RECENT_MSGS = 8;
/** 一张图片的粗估 token（多模态编码 800 上下，只做触发判断用） */
const IMAGE_TOKENS = 800;
/** 每条消息的角色标记等结构性开销 */
const MSG_OVERHEAD_TOKENS = 8;

export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  /*
   * 计数用途允许一切字符参与编码：不传 allowedSpecial 时 gpt-tokenizer 会
   * 对 <|xxx|> 形态做 disallowed 检查并直接 throw（"Disallowed special
   * token found"）——历史里混入这类字面量（agent 读数据/日志带入）会让发送
   * 流程在 fetch 之前就崩掉，表现为无网络请求、换模型也无效的顽固报错。
   */
  const count = (s: string) => encode(s, { allowedSpecial: 'all' }).length;
  for (const m of messages) {
    total += MSG_OVERHEAD_TOKENS;
    total += count(m.content);
    /*
     * reasoning 不计：它只用于渲染/落盘，toOpenAiShape 发请求时整体剥离。
     * 这里计数是为了估「发出去的请求体」，把它算进去会虚增压力——曾有一条
     * 退化的思维链（19 万字符重复循环，正文零产出）被虚记成十几万 token，
     * 把压缩与单回合预算的判断永久顶穿：截短提示每轮刷屏，而被截掉的恰恰
     * 是模型真正看得到的工具结果。
     */
    if (m.toolCallId) total += MSG_OVERHEAD_TOKENS;
    for (const c of m.toolCalls ?? []) total += count(`${c.name} ${c.arguments}`);
    if (m.images?.length) total += m.images.length * IMAGE_TOKENS;
  }
  return total;
}

/** 一条消息进摘要 transcript 的文本形态（思维链不进：摘要只要结论不要过程） */
function serializeForSummary(m: ChatMessage): string {
  if (m.role === 'user') return `[用户] ${m.content}${m.images?.length ? `（附图 ${m.images.length} 张）` : ''}`;
  if (m.role === 'tool') return `[工具结果] ${m.content}`;
  if (m.toolCalls?.length) {
    const calls = m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join('、');
    return `[助手|调用工具] ${calls}${m.content ? `\n[助手] ${m.content}` : ''}`;
  }
  return `[助手] ${m.content}`;
}

/**
 * 压缩切点：从「保留最近 KEEP_RECENT_MSGS 条」的位置向前回退到 user 消息
 * 边界。切在 user 之前保证不会拆散 assistant(toolCalls) 与其 tool 结果的
 * 配对（tool 结果永远紧跟在发起它的 assistant 之后、且不会跨过 user 边界）。
 */
function cutPoint(dialogue: ChatMessage[]): number {
  let k = dialogue.length - KEEP_RECENT_MSGS;
  while (k > 0 && dialogue[k].role !== 'user') k--;
  return k;
}

/** 摘要的持久化（与会话消息本体分轨）：键 = 会话 id × 模型 id */
const SUMMARY_KEY = 'swift-webui-summaries';

/*
 * 摘要持久化后端：默认浏览器 localStorage；node（server 侧 headless runner
 * 复用本模块）启动时 setSummaryStorage 注入文件实现。接口只有读写两张
 * 全表——摘要量小（每会话×模型一条），全表读写没有性能问题。
 */
export interface SummaryStorage {
  load(): Record<string, StoredSummary>;
  save(all: Record<string, StoredSummary>): void;
}

const localStorageBackend: SummaryStorage = {
  load: () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(SUMMARY_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, StoredSummary>) : {};
    } catch {
      return {};
    }
  },
  save: (all) => {
    try {
      localStorage.setItem(SUMMARY_KEY, JSON.stringify(all));
    } catch {
      /* 超配额等写失败：本轮摘要不持久化，下次重新摘（对话不受影响） */
    }
  },
};

let summaryStorage: SummaryStorage = localStorageBackend;

/** node 侧注入文件后端用（浏览器侧永远用默认 localStorage） */
export function setSummaryStorage(s: SummaryStorage): void {
  summaryStorage = s;
}

interface StoredSummary {
  summary: string;
  /** 摘要已覆盖的对话消息条数（dialogue[0..covered) 的内容已进摘要） */
  covered: number;
}

function summaryKey(convId: string, modelId: string): string {
  return `${convId}\u0000${modelId}`;
}

function loadSummaries(): Record<string, StoredSummary> {
  return summaryStorage.load();
}

function saveSummaries(all: Record<string, StoredSummary>): void {
  summaryStorage.save(all);
}

function saveSummary(convId: string, modelId: string, s: StoredSummary): void {
  try {
    const all = loadSummaries();
    all[summaryKey(convId, modelId)] = s;
    saveSummaries(all);
  } catch {
    /* 写失败：本轮摘要不持久化，下次重新摘（对话不受影响） */
  }
}

/** 摘要随消息流一起搬家（切模型续聊时调用）：目标键已有摘要或源无摘要则不动 */
export function moveSummaries(convId: string, fromModel: string, toModel: string): void {
  try {
    const all = loadSummaries();
    const fromKey = summaryKey(convId, fromModel);
    const toKey = summaryKey(convId, toModel);
    if (!all[fromKey] || all[toKey]) return;
    all[toKey] = all[fromKey];
    delete all[fromKey];
    saveSummaries(all);
  } catch {
    /* 同 saveSummary：搬家失败只是下次重新摘要 */
  }
}

/** 删一个会话的全部摘要（各模型桶一起；会话删除时调用） */
export function removeSummaries(convId: string): void {
  try {
    const all = loadSummaries();
    for (const key of Object.keys(all)) {
      if (key.startsWith(`${convId}\u0000`)) delete all[key];
    }
    saveSummaries(all);
  } catch {
    /* 同 saveSummary：清理失败不影响删除本体 */
  }
}

const SUMMARIZER_SYSTEM =
  '你是对话摘要器。把给定的对话记录（可能已含上一版摘要）压缩成一份供后续对话使用的要点摘要：' +
  '用户的目标与约束、已经确定的决定与参数、关键数据与数字、工具操作的结果、尚未完成的事项。' +
  '保留对继续对话有用的细节，丢弃寒暄与过程性内容。直接输出摘要正文，不要任何前缀说明。';

/**
 * 压缩入口：未超阈值原样返回；超阈值把 dialogue[0..k) 摘要成一条 system
 * 消息。摘要调用失败降级为不压缩——压缩是优化，不能让它挡住对话。
 */
export async function compressHistory(opts: {
  convId: string;
  modelId: string;
  dialogue: ChatMessage[];
  /** 展览模式默认模型的会话 token（摘要请求与主对话同一条通道） */
  apiKey?: string;
  /**
   * 调用方固定 system 注入（人格/指引/skills 文档）的 token 占用：真实请求
   * 预算 = system + 对话，阈值必须扣掉它——否则 skills 常驻十几 k 时对话再
   * 压到 24k 也装不进上下文。不传用旧固定阈值（兼容无 system 的调用方）。
   */
  reservedTokens?: number;
}): Promise<ChatMessage[]> {
  const { convId, modelId, dialogue } = opts;
  /*
   * 24000 常量保留为「无预留信息」的默认；有预留时阈值 = 上下文 - 预留 -
   * 余量，且不低于对话最低保留——system 再大也留 6k 给对话本体。
   */
  const threshold =
    opts.reservedTokens === undefined
      ? COMPRESS_THRESHOLD_TOKENS
      : Math.max(MIN_DIALOGUE_TOKENS, CONTEXT_TOKENS - CONTEXT_RESERVE_TOKENS - opts.reservedTokens);
  if (estimateTokens(dialogue) <= threshold) return dialogue;
  const k = cutPoint(dialogue);
  if (k <= 0) return dialogue;

  const stored = loadSummaries()[summaryKey(convId, modelId)];
  const covered = Math.min(stored?.covered ?? 0, k);
  const prevSummary = covered > 0 ? (stored?.summary ?? '') : '';

  /* 切点与已覆盖量一致 = 缓存命中，摘要内容无需更新 */
  if (covered === k && prevSummary) {
    return [
      { role: 'system', content: `此前对话的要点摘要：\n${prevSummary}` },
      ...dialogue.slice(k),
    ];
  }

  const transcript = [
    ...(prevSummary ? [`[上一版摘要]\n${prevSummary}`] : []),
    ...dialogue.slice(covered, k).map(serializeForSummary),
  ].join('\n\n');

  try {
    /*
     * 摘要被 max_tokens 截断时的处理：截断的非空摘要会以 covered=k 落盘，
     * 丢失的段落永不补回——先翻倍重试一次；仍截断再用非空部分（部分摘要
     * 仍优于全丢）；完全没产出才降级为不压缩。
     */
    let roundMaxTokens = 2048;
    for (let attempt = 0; ; attempt += 1) {
      let acc = '';
      let accReasoning = '';
      const r = await streamChat(
        modelId,
        [
          { role: 'system', content: SUMMARIZER_SYSTEM },
          { role: 'user', content: transcript },
        ],
        (parts) => {
          acc += parts.content;
          accReasoning += parts.reasoning;
        },
        {
          temperature: 0.3,
          maxTokens: roundMaxTokens,
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        },
      );
      /* 非思考模型的整条输出会被拆分器误入思考桶，与主循环同一兜底 */
      const summary = (acc || accReasoning).trim();
      if (summary && r.finishReason === 'length' && attempt === 0 && roundMaxTokens < 8192) {
        roundMaxTokens = 8192;
        continue;
      }
      if (!summary) return dialogue;
      saveSummary(convId, modelId, { summary, covered: k });
      return [
        { role: 'system', content: `此前对话的要点摘要：\n${summary}` },
        ...dialogue.slice(k),
      ];
    }
  } catch {
    return dialogue;
  }
}
