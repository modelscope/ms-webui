/**
 * 模型配置与对话的后端客户端。
 *
 * 后端是 vite dev server 里的 swift-api 中间件（见 vite.config.ts）：
 * 配置存在运行机器的 ~/.swift/models.json（SWIFT_HOME 可覆盖根路径），
 * key 只在服务端出现——列表接口返回掩码，聊天走服务端转发。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

/** 模型连接配置。apiKey 在前端侧永远是掩码或空串 */
export interface ModelConfig {
  /** 用户起的名字，同时是对话请求里 model 字段的取值 */
  id: string;
  /** OpenAI 兼容服务的根地址，如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey?: string;
  /** 远端真实模型名 */
  model: string;
  note?: string;
  /** 本地部署类条目的探活结果（仅 note='swift 部署' 时后端才探测）；远端 API 不探 */
  alive?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * user 消息的图片附件（data URL）。发请求时转成 OpenAI 多模态 content
   * 数组的 image_url 部分；渲染层直接当 <img> src 用。
   */
  images?: string[];
  /** 思维链。仅 assistant 消息；非思考模型没有这个字段 */
  reasoning?: string;
  /** 联网搜索的来源清单。仅 user 消息；发送时开了搜索且拿到结果才有 */
  sources?: { title: string; url: string }[];
  /** assistant 消息发起的工具调用（简化形状，发请求时转 OpenAI 三层壳） */
  toolCalls?: ToolCall[];
  /** role='tool' 的结果消息对应的调用 id */
  toolCallId?: string;
}

/** 一次工具调用。arguments 是 JSON 字符串（参数值统一为字符串） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function listModels(): Promise<ModelConfig[]> {
  const res = await fetch(apiBase() + '/api/models');
  if (!res.ok) throw new Error(tStatic('api.loadModelsFailed', { status: res.status }));
  const data = (await res.json()) as { models: ModelConfig[] };
  return data.models;
}

export async function saveModel(config: ModelConfig): Promise<void> {
  const res = await fetch(apiBase() + '/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.saveFailed'));
}

export async function deleteModel(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/models?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.deleteFailed', { status: res.status }));
}

/*
 * 展览模式的首页默认模型清单（GET /api/ms-models）：服务端 PUT dolphin 选出
 * DeepSeek/Kimi/Qwen 各排最前一条，default 是整体最前那条。dolphin 不可达时
 * 服务端已兜底，这里不再有降级分支。
 */
export interface MsDefaultModels {
  models: { model: string; label: string }[];
  default: string;
  source: 'dolphin' | 'fallback';
}

export async function listMsModels(): Promise<MsDefaultModels> {
  const res = await fetch(apiBase() + '/api/ms-models');
  if (!res.ok) throw new Error(tStatic('api.readDefaultModelsFailed', { status: res.status }));
  return (await res.json()) as MsDefaultModels;
}

/**
 * 把思维链从正文流里拆出来（Qwen3 系思考模型）。
 *
 * 流形态是「思维链 → </think> → 正文」：开标签 <think> 常由 prompt 侧隐式提供、
 * 在 delta 流里看不到，闭标签 </think> 一定在正文之前，因此 content 流的初始
 * 模式是「思考中」，见到闭标签（或显式出现的开标签 <think>）才切到正文，标签
 * 本身被吞掉不进任何一桶。标签可能跨 SSE chunk 断开，所以结尾处「可能是半个
 * 标签」的文本先扣住，等下一个 chunk 拼上再判。
 *
 * 非思考模型的整条流没有任何标签——它的正文会被初始模式误入思考桶，finish()
 * 里兜底提回正文。服务端若已在 delta 里给出独立的 reasoning_content 字段
 * （拆分后的新形态），content 直接透传，本类不再自作主张。
 */
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** 一段 delta 拆分后的两个出口，空串表示本段没有该通道的内容 */
export interface DeltaParts {
  content: string;
  reasoning: string;
  /** 本段从正文流里拆出的完整工具调用 */
  toolCalls?: ToolCall[];
}

class ThinkSplitter {
  private mode: 'reasoning' | 'content' = 'reasoning';
  private pending = '';
  private sawTag = false;
  private passthrough = false;

  feed(reasoningText: string, contentText: string): DeltaParts {
    if (reasoningText) this.passthrough = true;
    if (this.passthrough) return { content: contentText, reasoning: reasoningText };

    let buf = this.pending + contentText;
    this.pending = '';
    let content = '';
    let reasoning = '';
    for (;;) {
      /* 两种标签谁先出现处理谁：开标签进入思考态，闭标签切回正文态 */
      const openAt = buf.indexOf(THINK_OPEN);
      const closeAt = buf.indexOf(THINK_CLOSE);
      const at = openAt >= 0 && (closeAt < 0 || openAt < closeAt) ? openAt : closeAt;
      if (at < 0) {
        /* 没有完整标签：结尾若是任一标签的前缀，扣住等下个 chunk，其余照常输出 */
        let hold = 0;
        for (let n = Math.min(THINK_CLOSE.length - 1, buf.length); n > 0; n--) {
          const tail = buf.slice(buf.length - n);
          if (THINK_OPEN.startsWith(tail) || THINK_CLOSE.startsWith(tail)) {
            hold = n;
            break;
          }
        }
        const seg = buf.slice(0, buf.length - hold);
        if (this.mode === 'reasoning') reasoning += seg;
        else content += seg;
        this.pending = buf.slice(buf.length - hold);
        return { content, reasoning };
      }
      const tag = at === openAt ? THINK_OPEN : THINK_CLOSE;
      const seg = buf.slice(0, at);
      if (this.mode === 'reasoning') reasoning += seg;
      else content += seg;
      buf = buf.slice(at + tag.length);
      this.mode = tag === THINK_OPEN ? 'reasoning' : 'content';
      this.sawTag = true;
    }
  }

  /** 流结束：扣住的尾巴不再可能成为完整标签，按当前模式直接冲出（不能再走 feed，它会再扣一次） */
  finish(): DeltaParts {
    const text = this.pending;
    this.pending = '';
    return this.mode === 'reasoning'
      ? { content: '', reasoning: text }
      : { content: text, reasoning: '' };
  }
}

/*
 * 工具调用块拆分器：与 ThinkSplitter 串联，只消费它拆出的 content 通道。
 *
 * 部署网关会把请求里的 tools 渲染进模板，但 vLLM 侧没开 auto tool choice，
 * 模型把调用以 Qwen 原生形态直接写进正文：一对 tool_call 标签包住「函数名
 * 标签 + 若干参数标签对」，其后才是（通常为空的）收尾正文；流的末尾偶尔
 * 混入 eos 字面量，一并剥掉。块可能跨 SSE chunk 断开：未闭合时先攒着，
 * 正文结尾若可能是半个 tool_call 开标签或半个 eos 字面量也扣住等下个 chunk。
 * 标签字面量用码点拼出而不是直接写进源码——它们在本仓的编辑链路里会被
 * 静默转写成别的字符（有实测教训），拼出来的是唯一可信来源。
 */
const CODE = (...codes: number[]) => String.fromCharCode(...codes);
const TOOL_OPEN = CODE(60, 116, 111, 111, 108, 95, 99, 97, 108, 108, 62);
const TOOL_CLOSE = CODE(60, 47, 116, 111, 111, 108, 95, 99, 97, 108, 108, 62);
const FUNC_HEAD = CODE(60, 102, 117, 110, 99, 116, 105, 111, 110, 61);
const PARAM_HEAD = CODE(60, 112, 97, 114, 97, 109, 101, 116, 101, 114, 61);
const PARAM_CLOSE = CODE(60, 47, 112, 97, 114, 97, 109, 101, 116, 101, 114, 62);
const EOS_TOKEN = CODE(60, 124, 105, 109, 95, 101, 110, 100, 124, 62);
const GT = CODE(62);

class ToolCallSplitter {
  private buf = '';
  private block: string | null = null;
  private seq = 0;

  feed(text: string): { content: string; toolCalls?: ToolCall[] } {
    if (this.block !== null) this.block += text;
    else this.buf += text;
    const toolCalls: ToolCall[] = [];
    let content = '';
    /* 存量块：收齐闭标签才产出调用，块后文本接回正文缓冲 */
    if (this.block !== null) {
      const close = this.block.indexOf(TOOL_CLOSE);
      if (close < 0) return { content };
      const inner = this.block.slice(0, close);
      this.buf = this.block.slice(close + TOOL_CLOSE.length) + this.buf;
      this.block = null;
      const call = this.parseBlock(inner);
      if (call) toolCalls.push(call);
    }
    for (;;) {
      const eos = this.buf.indexOf(EOS_TOKEN);
      if (eos >= 0) {
        content += this.buf.slice(0, eos);
        this.buf = this.buf.slice(eos + EOS_TOKEN.length);
        continue;
      }
      const open = this.buf.indexOf(TOOL_OPEN);
      if (open < 0) {
        let hold = 0;
        for (let n = Math.min(TOOL_OPEN.length - 1, this.buf.length); n > 0; n--) {
          const t = this.buf.slice(this.buf.length - n);
          if (TOOL_OPEN.startsWith(t) || EOS_TOKEN.startsWith(t)) {
            hold = n;
            break;
          }
        }
        content += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        return toolCalls.length ? { content, toolCalls } : { content };
      }
      content += this.buf.slice(0, open);
      const after = this.buf.slice(open + TOOL_OPEN.length);
      this.buf = '';
      const close = after.indexOf(TOOL_CLOSE);
      if (close >= 0) {
        /* 单个 chunk 里块已完整：就地解析，剩余文本继续扫 */
        const inner = after.slice(0, close);
        this.buf = after.slice(close + TOOL_CLOSE.length);
        const call = this.parseBlock(inner);
        if (call) toolCalls.push(call);
        continue;
      }
      this.block = after;
      return toolCalls.length ? { content, toolCalls } : { content };
    }
  }

  /** 流结束：扣住的半标签尾巴按正文冲出；未闭合的块不会再完整，丢弃 */
  finish(): string {
    const text = this.buf;
    this.buf = '';
    this.block = null;
    return text;
  }

  private parseBlock(inner: string): ToolCall | undefined {
    const fi = inner.indexOf(FUNC_HEAD);
    if (fi < 0) return undefined;
    let rest = inner.slice(fi + FUNC_HEAD.length);
    const nameEnd = rest.indexOf(GT);
    if (nameEnd < 0) return undefined;
    const name = rest.slice(0, nameEnd).trim();
    rest = rest.slice(nameEnd + 1);
    const args: Record<string, string> = {};
    for (;;) {
      const pi = rest.indexOf(PARAM_HEAD);
      if (pi < 0) break;
      rest = rest.slice(pi + PARAM_HEAD.length);
      const keyEnd = rest.indexOf(GT);
      if (keyEnd < 0) break;
      const key = rest.slice(0, keyEnd).trim();
      rest = rest.slice(keyEnd + 1);
      const pc = rest.indexOf(PARAM_CLOSE);
      if (pc < 0) break;
      let val = rest.slice(0, pc);
      if (val.startsWith('\n')) val = val.slice(1);
      if (val.endsWith('\n')) val = val.slice(0, -1);
      args[key] = val;
      rest = rest.slice(pc + PARAM_CLOSE.length);
    }
    if (!name) return undefined;
    return {
      id: `call_${Date.now().toString(36)}_${++this.seq}`,
      name,
      arguments: JSON.stringify(args),
    };
  }
}

/** turns 里的简化消息形状 → OpenAI 请求体形状（tool 结果消息与带调用的 assistant 消息） */
function toOpenAiShape(m: ChatMessage) {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  /*
   * 带图片的 user 消息转 OpenAI 多模态形状：content 从字符串变成
   * text + image_url 的分段数组，多模态模型按序消费。
   */
  if (m.role === 'user' && m.images?.length) {
    return {
      role: 'user',
      content: [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * 流式对话：POST /api/chat/completions（标准 OpenAI 协议，SSE）。
 * 每个 delta 触发一次 onDelta（已拆分 content / reasoning / toolCalls）；结束时
 * 若有错误文本则调 onError。options 里的采样参数是 OpenAI 标准字段，随请求透传；
 * tools 传了则同时透传（部署网关会渲染进模板）。返回本次流里模型发起的全部
 * 工具调用与最终 finish_reason——空 toolCalls 不再等价于「自然结束」：
 * finish_reason="length" 表示回复被 max_tokens 截断（思维链与正文共享预算，
 * 思考吃光预算时正文一个字都不出），调用方必须据此区分终轮与截断。
 *
 * apiKey 是展览形态的会话通道：服务端对不在 models.json 里的默认模型按
 * x-swift-api-key 头鉴权（token 只活在浏览器内存）。正常模式不传，行为不变。
 * signal 是停止键的通道：中止时 fetch/read 抛 AbortError，这里吞掉并冲出
 * 拆分器已扣住的尾巴后正常返回——已收到的增量不丢，调用方无须区分被停
 * 还是自然结束。
 *
 * 请求建立失败（网络拒绝）与上游 5xx 各重试一次（800ms 退避）：瞬时抖动
 * 不至于报废整轮对话。流已经开始后的中断不重试——增量已发给调用方，
 * 重放会让内容重复。
 */
export async function streamChat(
  modelId: string,
  messages: ChatMessage[],
  onDelta: (parts: DeltaParts) => void,
  options?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    tools?: unknown[];
    apiKey?: string;
    signal?: AbortSignal;
    /**
     * 发起对话的会话 id（页面回合才传）：随请求头 x-webui-conv 到达代理
     * 中间件——页面关闭把流掐断时，中间件据此登记中断回合，宽限期后仍
     * 无心跳即判定「页面已关（非用户主动停止）」，推一条续轮事件让
     * headless 或回来的页面接着跑。node 侧（headless）不传：进程内
     * fetch 不会中途断，断了也有 epoch 兜底。
     */
    convId?: string;
  },
): Promise<{ toolCalls: ToolCall[]; finishReason?: string }> {
  /*
   * 停滞看门狗：上游黑洞（连接建立后既不回响应头、也不发任何字节、也不断开）时，
   * fetch/read 会无限挂起且无任何报错——界面只剩无限转圈。两档超时：响应头迟迟
   * 不到（正常 SSE 秒级就该出头）；流中途长时间零字节（思考型模型的增量是持续
   * 流出的，长时间静默只可能是链路死了）。触发即 abort 连接并显式抛错，由错误
   * 卡片提示重发。与停止键共用 abort 通道，用 stalled 标记区分「用户主动停
   * （静默返回已收增量）」与「超时（冲出尾巴后报错）」两种中止。
   */
  const HEADERS_STALL_MS = 120_000;
  const CHUNK_STALL_MS = 300_000;
  const ac = new AbortController();
  options?.signal?.addEventListener('abort', () => ac.abort(), { once: true });
  let stalled: 'headers' | 'chunk' | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStall = (ms: number, phase: 'headers' | 'chunk') => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = phase;
      ac.abort();
    }, ms);
  };
  const disarmStall = () => clearTimeout(stallTimer);
  const stallError = () =>
    stalled === 'headers'
      ? new Error(tStatic('api.stallHeaders', { model: modelId, seconds: HEADERS_STALL_MS / 1000 }))
      : new Error(tStatic('api.stallChunk', { model: modelId, minutes: CHUNK_STALL_MS / 60_000 }));
  const doPost = () =>
    fetch(apiBase() + '/api/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options?.apiKey ? { 'x-swift-api-key': options.apiKey } : {}),
        ...(options?.convId ? { 'x-webui-conv': options.convId } : {}),
      },
      body: JSON.stringify({
        model: modelId,
        messages: messages.map(toOpenAiShape),
        stream: true,
        ...(options?.tools ? { tools: options.tools } : {}),
        ...(options?.temperature !== undefined && { temperature: options.temperature }),
        ...(options?.topP !== undefined && { top_p: options.topP }),
        ...(options?.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      }),
      signal: ac.signal,
    });
  let res: Response;
  try {
    try {
      armStall(HEADERS_STALL_MS, 'headers');
      res = await doPost();
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      await new Promise((r) => setTimeout(r, 800));
      /* 重试再失败就让它抛——上层渲染错误卡片 */
      armStall(HEADERS_STALL_MS, 'headers');
      res = await doPost();
    }
    if (res.status >= 500) {
      await new Promise((r) => setTimeout(r, 800));
      armStall(HEADERS_STALL_MS, 'headers');
      res = await doPost();
    }
  } catch (e) {
    /* 看门狗触发的中止转为显式超时错误（黑洞请求不会在 800ms 内自愈，不做重试）；
     * 用户主动停保持原语义——AbortError 原样上抛，调用方静默收尾 */
    if ((e as { name?: string })?.name === 'AbortError' && stalled) throw stallError();
    throw e;
  } finally {
    disarmStall();
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || tStatic('api.requestFailed', { status: res.status }));
  }

  const splitter = new ThinkSplitter();
  const toolSplitter = new ToolCallSplitter();
  const toolCalls: ToolCall[] = [];
  /* 终轮判定信号：流里最后一个非空 finish_reason（stop / length / tool_calls…） */
  let finishReason: string | undefined;
  /*
   * OpenAI 标准流式工具调用通道：delta.tool_calls[] 按 index 定位调用，
   * id 与 function.name 在首片出现、arguments 逐片追加。远端 OpenAI 兼容
   * API（如 api-inference）走这条通道；本地部署网关把调用以 Qwen 原生
   * 标签写进 content 由 ToolCallSplitter 拆——两条通道并存，同一条流里
   * 通常只有其一生效，都解析也不会重复（不同通道不同出处）。
   */
  const stdCalls = new Map<number, { id: string; name: string; args: string }>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  /*
   * 心跳免疫的流内看门狗：deadline 只被携带 data: 行的字节推进——SSE 保活
   * 注释（": ping" 这类帧）不算进展。否则上游内容发完后不发 [DONE]、光靠
   * 心跳保活，能把一轮无限期挂住：界面停在流式态、脚本/研究的唤醒续跑被
   * 发送守卫静默堵死（隔夜停摆的形态）。用 includes 而非逐行前缀判断：
   * 跨 chunk 撕开的 data 行，其 "data:" 前缀必在先到的半片里。
   */
  let dataDeadline = Date.now() + CHUNK_STALL_MS;
  try {
    for (; !done;) {
      armStall(Math.max(1, dataDeadline - Date.now()), 'chunk');
      const r = await reader.read();
      disarmStall();
      done = r.done;
      if (r.value) {
        const text = decoder.decode(r.value, { stream: true });
        /* 续片也算进展：缓冲里未完结的半行若以 data: 开头，本片是同一事件
         * 的续体（超长单事件的后续分片不含前缀字样，勿误判成心跳） */
        const midDataEvent = /^data:/.test(buffer);
        if (text.includes('data:') || midDataEvent) dataDeadline = Date.now() + CHUNK_STALL_MS;
        buffer += text;
      }
      // SSE 事件以空行分隔；行内可能是 data: / 注释 / 空行
      const events = buffer.split('\n');
      buffer = events.pop() ?? '';
      for (const line of events) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          done = true;
          break;
        }
        try {
          const chunk = JSON.parse(payload);
          const choice = chunk.choices?.[0] ?? {};
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
          const content = typeof delta.content === 'string' ? delta.content : '';
          /* 标准通道分片拼装（缺 index 的退化流一律当第 0 个调用） */
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls as {
              index?: number;
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }[]) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const slot = stdCalls.get(idx) ?? { id: '', name: '', args: '' };
              if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
              if (typeof tc.function?.name === 'string' && tc.function.name) slot.name = tc.function.name;
              if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
              stdCalls.set(idx, slot);
            }
          }
          const parts = splitter.feed(reasoning, content);
          const tOut = toolSplitter.feed(parts.content);
          if (parts.reasoning || tOut.content) {
            onDelta({ content: tOut.content, reasoning: parts.reasoning });
          }
          if (tOut.toolCalls?.length) {
            toolCalls.push(...tOut.toolCalls);
            onDelta({ content: '', reasoning: '', toolCalls: tOut.toolCalls });
          }
        } catch {
          /* 半个 JSON 事件留在下一轮处理；非 JSON 的心跳行直接跳过 */
        }
      }
    }
  } catch (e) {
    /* 停止键：read 在中止时抛 AbortError，已收增量随后面的收尾冲出，不丢 */
    if ((e as { name?: string })?.name !== 'AbortError') throw e;
    done = true;
  }
  disarmStall();
  /*
   * 收尾：冲掉两个拆分器扣住的尾巴。Think 的尾巴先过一遍工具拆分器
   * （可能携带半个块），工具拆分器最后冲出的正文按半标签尾巴处理。
   */
  const tail = splitter.finish();
  const tOut = toolSplitter.feed(tail.content);
  const tTail = toolSplitter.finish();
  if (tail.reasoning || tOut.content || tTail) {
    onDelta({ content: tOut.content + tTail, reasoning: tail.reasoning });
  }
  if (tOut.toolCalls?.length) {
    toolCalls.push(...tOut.toolCalls);
    onDelta({ content: '', reasoning: '', toolCalls: tOut.toolCalls });
  }
  /*
   * 标准通道的调用在流结束时装配：arguments 已随分片拼齐，缺 id 的补一个
   * （回发时工具结果的 tool_call_id 要对得上）。有名字才算数——个别服务
   * 会发只有 index 的空占位片。
   */
  if (stdCalls.size) {
    const calls: ToolCall[] = [...stdCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, s]) => ({
        id: s.id || `call_${Date.now().toString(36)}_${i}`,
        name: s.name,
        arguments: s.args || '{}',
      }))
      .filter((c) => c.name);
    if (calls.length) {
      toolCalls.push(...calls);
      onDelta({ content: '', reasoning: '', toolCalls: calls });
    }
  }
  /*
   * 看门狗在流中途触发时：尾巴已冲出、已收增量不丢，但流本身是死的——
   * 冲完尾巴再抛显式超时错误，让调用方渲染错误卡片提示重发。
   */
  if (stalled) throw stallError();
  return { toolCalls, finishReason };
}
