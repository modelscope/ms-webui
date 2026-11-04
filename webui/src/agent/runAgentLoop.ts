import { streamChat, type ChatMessage, type DeltaParts, type ToolCall } from '../api/models';
import { MAX_TOOL_ROUNDS } from './builtin';
import { executeToolCall, toolSchemas, type AgentTool, type ToolContext } from './tools';

/**
 * agent 循环的通用核：模型发起工具调用就执行、结果回喂再续一轮，直到模型
 * 不再调用或撞轮次上限。从 ChatPage 抽出——首页、批三的每页助手共用。
 *
 * 循环内部维护发给模型的 history（本地累积）；消息流（渲染 + 持久化）由
 * 调用方通过 events 回调推进，这样每个使用方可以各存一份自己的消息形态。
 * assistant 消息靠 onAssistantStart + onDelta 增量累积（与原 ChatPage 行为
 * 逐点一致），完整形态只进 history；工具结果走 onToolResult，呈现方式
 * （消息卡、动作卡）由调用方决定。
 */

export interface AgentLoopEvents {
  /** 一轮流式开始：调用方在消息流末尾追加空 assistant 占位 */
  onAssistantStart: () => void;
  /** 流式增量：调用方把增量累积到末尾消息上（parts 可能带 toolCalls 片段） */
  onDelta: (parts: DeltaParts) => void;
  /** 一条工具结果：调用方把它落进自己的消息流或转成动作卡 */
  onToolResult: (call: ToolCall, result: string) => void;
  /** 一轮出错：调用方把末尾消息替换成错误文案 */
  onError: (text: string) => void;
  /**
   * 非致命提示（如回复被长度截断）：调用方把它追加到末尾消息尾部，
   * 已收到的内容不丢——与 onError 的替换语义分开。
   */
  onNotice?: (text: string) => void;
  /**
   * 每轮结束后回吐完整的模型视角 history（含本轮 assistant/tool 消息）。
   * 需要把会话原样持久化或续聊的调用方（页面助手）用它同步自己的副本，
   * 不需要就别传——事件本身不落任何状态。
   */
  onRound?: (history: ChatMessage[]) => void;
}

export interface AgentLoopOptions {
  model: string;
  /** 本次对话的完整上下文（含 system 与 user 消息），循环只追加不修改 */
  history: ChatMessage[];
  tools: AgentTool[];
  ctx: ToolContext;
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
  /**
   * 展览模式的会话 token：随请求头带给服务端鉴权（默认模型不在 models.json，
   * 服务端无处可查 key）。正常形态不传。
   */
  apiKey?: string;
  maxRounds?: number;
  /**
   * 停止键通道：中止时当前这轮流式正常收尾（已收增量保留）、不再续任何
   * 工具轮。正在执行的工具任其跑完——半途掐断写操作比让它落完更糟。
   */
  signal?: AbortSignal;
  /** 发起回合的会话 id（页面回合传）：透传给代理中间件做中断回合登记 */
  convId?: string;
  events: AgentLoopEvents;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { model, tools, ctx, events } = opts;
  const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
  const schemas = toolSchemas(tools);
  let history = opts.history;
  /* 本轮是否还带着工具调用：轮次上限退出时用它区分「静默到顶」与自然终轮 */
  let lastHadTools = false;

  for (let round = 0; round <= maxRounds; round++) {
    if (opts.signal?.aborted) break;
    events.onAssistantStart();
    let acc = '';
    let accReasoning = '';
    let toolCalls: ToolCall[] = [];
    let finishReason: string | undefined;
    /*
     * 同轮重试（最多一次）：思维链与正文共享 max_tokens，思考吃光预算时
     * finish_reason=length 且正文零产出——这正是「静默结束」的根因（实测
     * 形态是思考几千字、正文一字不出）。重试条件=正文与工具调用都零：
     * 思考增量留在同一折叠块里继续累积，重放不会重复正文。显式设了
     * maxTokens 才翻倍重试（未显式的调用方无从翻起），上限 32768 防失控。
     */
    let roundMaxTokens = opts.sampling?.maxTokens;
    let attempt = 0;
    try {
      for (;;) {
        const r = await streamChat(
          model,
          history,
          (parts) => {
            if (parts.content) acc += parts.content;
            if (parts.reasoning) accReasoning += parts.reasoning;
            events.onDelta(parts);
          },
          {
            ...(opts.sampling ?? {}),
            ...(roundMaxTokens !== undefined ? { maxTokens: roundMaxTokens } : {}),
            ...(schemas.length ? { tools: schemas } : {}),
            ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.convId ? { convId: opts.convId } : {}),
          },
        );
        toolCalls = r.toolCalls;
        finishReason = r.finishReason;
        if (
          finishReason === 'length' &&
          !toolCalls.length &&
          !acc &&
          attempt === 0 &&
          roundMaxTokens !== undefined &&
          roundMaxTokens < 32768
        ) {
          attempt = 1;
          roundMaxTokens = Math.min(roundMaxTokens * 2, 32768);
          continue;
        }
        break;
      }
      /*
       * 截断与空回合的显式上报：不再让它们冒充自然结束。正文零产出（思考
       * 吃光预算、重试后仍截断）报错误并终止——思考过程已保留在折叠块里；
       * 有部分产出则追加提示后照常收尾（带 toolCalls 的截断照常执行，参数
       * 残缺由 JSON 解析失败的回喂兜底）。
       */
      const budget = roundMaxTokens !== undefined ? `（max_tokens=${roundMaxTokens}）` : '';
      /* 先记录本轮工具态：下方所有 break 路径（截断/空回合/自然终轮）都不得残留上轮值 */
      lastHadTools = toolCalls.length > 0;
      if (finishReason === 'length' && !toolCalls.length && !acc) {
        events.onError(
          `⚠ 本轮思维链耗尽了回复长度${budget}，没有产出正文（思考过程保留在上方折叠块）。把输入框上方的「回复长度」调大后重发即可。`,
        );
        break;
      }
      if (finishReason === 'length') {
        events.onNotice?.(`⚠ 本轮回复被回复长度${budget}截断，以上内容可能不完整；调大后重发可避免。`);
      } else if (!toolCalls.length && !acc && !accReasoning) {
        events.onError('⚠ 模型本轮没有输出（上游返回了空流，偶发）。重发一次即可。');
        break;
      }
      /* 被停止或自然终轮都不再续轮；被停时已收增量保留在末尾消息里 */
      if (!toolCalls.length || opts.signal?.aborted) break;
      /*
       * 正文空而思考非空：非思考模型（流里既无 think 标签也无 reasoning_content
       * 字段）的整条输出被拆分器误入思考桶——回喂模型的 history 取思考全文当
       * 正文，与渲染层「思考顶当正文」的兜底同一语义；正常思考模型 acc 非空，
       * 不受影响。
       */
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: acc || accReasoning,
        ...(accReasoning ? { reasoning: accReasoning } : {}),
        toolCalls,
      };
      history = [...history, assistantMsg];
      for (const call of toolCalls) {
        const result = await executeToolCall(tools, call, ctx);
        history = [...history, { role: 'tool', content: result, toolCallId: call.id }];
        events.onToolResult(call, result);
      }
      /* 有工具轮才有续轮：这一份 history 就是下一轮的输入，同步给持久化方 */
      events.onRound?.(history);
    } catch (e) {
      /* 停止键在流式建立前/中止 fetch 时抛 AbortError：干净收尾，不当错误渲染 */
      lastHadTools = false;
      if ((e as { name?: string })?.name === 'AbortError') break;
      events.onError(`⚠ ${String(e)}`);
      break;
    }
  }
  /*
   * 轮次到顶而最后一轮还带着工具调用：工具结果已回喂但模型没有终轮总结，
   * 观感是「干到一半静默停了」。与截断/空回合的 onError 同理，必须显式告知。
   */
  if (lastHadTools && !opts.signal?.aborted) {
    events.onNotice?.(`⚠ 单回合工具轮次已达上限（${maxRounds}），工具结果已回喂但模型没有收尾总结；重发一句话即可继续。`);
  }
}
