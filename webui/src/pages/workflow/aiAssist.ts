import type { Dispatch, SetStateAction } from 'react';
import type { AiMessage, ActionState, ProposalView } from '@/components/AiChatPanel';
import { messageId, userMessage } from '@/components/AiChatPanel';
import { listModels, streamChat } from '@/api/models';
import type { GraphEdge, GraphNode, NodeParam } from './nodeTypes';
import { NODE_TYPES, nodeLabel } from './nodeTypes';
import type { TFn } from './nodeTypes';

/**
 * 编排页的 AI 协助层。
 *
 * 这里放两样东西：AI 能提出的动作类型，和一个假 AI。
 * UI 组件只认 FlowMessage，接真后端时把 askAi() 换成一次请求即可，界面不用动。
 *
 * 最重要的一条设计：AI 不直接改图。
 * 它只能"提议"——每条提议是一张动作卡片，得点了应用才会落到图上。
 * 理由是这份图形是流程的唯一事实来源，如果 AI 能静默改它，
 * 「谁把 num_generations 从 8 调成 32 的」就会变成查不出来的事。
 */

/** AI 能提议的动作。故意做得很窄——只有这几种能被安全地一键应用 */
export type AiAction =
  | {
      kind: 'param';
      /** 目标节点 id */
      nodeId: string;
      /** 参数名，对应 NodeParam.label */
      label: string;
      /** 改成什么 */
      to: string;
    }
  | { kind: 'addNode'; typeKey: string; note: string }
  | { kind: 'control'; op: 'start' | 'pause' | 'resume' | 'stop' };

/** 编排页的一条消息。消息的形状是通用的，只有提议的类型是这一页特有的 */
export type FlowMessage = AiMessage<AiAction>;

/** 问 AI 时带上的上下文。有 node 就是在问单个节点，没有就是在问整张图 */
export interface AiContext {
  node?: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  presetLabel: string;
  running: boolean;
}

/** 取节点当前生效的参数（节点自己改过的优先，否则用类型默认） */
export function paramsOf(node: GraphNode): NodeParam[] {
  return node.params ?? NODE_TYPES[node.type].params;
}

function paramValue(node: GraphNode, label: string): string | undefined {
  return paramsOf(node).find((p) => p.label === label)?.value;
}

function reply(text: string, actions?: AiAction[]): FlowMessage {
  return {
    id: messageId(),
    role: 'assistant',
    text,
    actions,
    states: actions?.map(() => 'pending' as ActionState),
  };
}

/** 单个节点视角的开场白：直接把这个节点在干什么、接了什么说清楚 */
export function nodeIntro(node: GraphNode, ctx: AiContext, t: TFn): FlowMessage {
  const def = NODE_TYPES[node.type];
  const upstream = ctx.edges
    .filter((e) => e.to === node.id)
    .map((e) => nodeLabel(NODE_TYPES[ctx.nodes.find((n) => n.id === e.from)?.type ?? ''], t))
    .filter(Boolean);
  const downstream = ctx.edges
    .filter((e) => e.from === node.id)
    .map((e) => nodeLabel(NODE_TYPES[ctx.nodes.find((n) => n.id === e.to)?.type ?? ''], t))
    .filter(Boolean);

  const lines = [t('wf.aiNodeIntroTitle', { label: nodeLabel(def, t), hint: def.hint ? t(def.hint) : '' })];
  lines.push(
    upstream.length
      ? t('wf.aiUpstream', { list: [...new Set(upstream)].join(t('wf.listSep')) })
      : t('wf.aiNoUpstream'),
  );
  lines.push(
    downstream.length
      ? t('wf.aiDownstream', { list: [...new Set(downstream)].join(t('wf.listSep')) })
      : t('wf.aiNoDownstream'),
  );
  if (def.lockedPorts) {
    lines.push(t('wf.aiLockedNote'));
  }
  lines.push(t('wf.aiAskAnything'));
  return reply(lines.join('\n'));
}

/** 整图视角的开场白。跟整图兜底是同一套话，统一从这里出 */
export function flowIntro(ctx: AiContext, t: TFn): FlowMessage {
  return askAi('', ctx, t);
}

/**
 * 假 AI。按关键词匹配剧本。
 *
 * 剧本不是随便编的：每条都对应一个真实会被问到的问题，
 * 回答里引用的是图上当前的真实取值，所以看着才像真在读这张图。
 */
export function askAi(question: string, ctx: AiContext, t: TFn): FlowMessage {
  const q = question.toLowerCase();
  const node = ctx.node;

  /* ---- 控制类：启动 / 暂停 ---- */
  if (/暂停|停一下|停下|pause/.test(q)) {
    return reply(
      ctx.running ? t('wf.aiPauseRunning') : t('wf.aiPauseIdle'),
      ctx.running ? [{ kind: 'control', op: 'pause' }] : [{ kind: 'control', op: 'start' }],
    );
  }
  if (/继续|恢复|resume/.test(q)) {
    return reply(t('wf.aiResume'), [{ kind: 'control', op: 'resume' }]);
  }
  if (/停止|终止|别跑了|stop|kill/.test(q)) {
    return reply(t('wf.aiStop'), [{ kind: 'control', op: 'stop' }]);
  }
  if (/跑起来|启动|开始训|运行|开跑|start|run/.test(q)) {
    return reply(
      t('wf.aiStart', { n: ctx.nodes.length, m: ctx.edges.length }),
      [{ kind: 'control', op: 'start' }],
    );
  }

  /* ---- 显存 ---- */
  if (/oom|显存|内存不够|out of memory|爆了/.test(q)) {
    const trainer = ctx.nodes.find((n) => n.type === 'train_step');
    const cur = trainer ? paramValue(trainer, 'micro_batch_size') : undefined;
    const actions: AiAction[] =
      trainer && cur && Number(cur) > 1
        ? [{ kind: 'param', nodeId: trainer.id, label: 'micro_batch_size', to: '1' }]
        : [];
    return reply(
      t('wf.aiOom', { cur: cur ? t('wf.aiOomCur', { cur }) : '' }),
      actions,
    );
  }

  /* ---- 优势为 0 ---- */
  if (/优势.*0|advantage.*0|全对|全错|方差/.test(q)) {
    const adv = ctx.nodes.find((n) => n.type === 'advantage');
    const numGen = adv ? paramValue(adv, 'num_generations') : undefined;
    return reply(
      t('wf.aiAdvZero', { ng: numGen ? t('wf.aiNg', { n: numGen }) : '' }),
    );
  }

  /* ---- 速度 ---- */
  if (/慢|快一点|速度|太久|加速|slow|faster|speed|too long|accelerate/.test(q)) {
    const rollout = ctx.nodes.find(
      (n) => n.type === 'rollout' || n.type === 'generate',
    );
    const gen = rollout ? paramValue(rollout, 'num_generations') : undefined;
    const actions: AiAction[] =
      rollout && gen && Number(gen) > 4
        ? [{ kind: 'param', nodeId: rollout.id, label: 'num_generations', to: '4' }]
        : [];
    return reply(
      t('wf.aiSpeed', { gen: gen ? t('wf.aiGenNow', { n: gen }) : '' }),
      actions,
    );
  }

  /* ---- 轨迹对错位 ---- */
  if (/错位|对不上|对齐|过滤|丢样本|filter|misalign|out of sync/.test(q)) {
    return reply(t('wf.aiMisalign'));
  }

  /* ---- 学习率 ---- */
  if (/学习率|lr|learning rate/.test(q)) {
    return reply(t('wf.aiLr'));
  }

  /* ---- 节点上下文相关的兜底 ---- */
  if (node) {
    const def = NODE_TYPES[node.type];
    const ps = paramsOf(node);
    return reply(
      t('wf.aiNodeFallback', {
        label: nodeLabel(def, t),
        params: ps.map((p) => `· ${p.label} = ${p.value}`).join('\n'),
        hint: def.hint ? t(def.hint) : '—',
      }),
    );
  }

  /* ---- 整图兜底 ---- */
  return reply(
    t('wf.aiGraphFallback', {
      preset: ctx.presetLabel,
      n: ctx.nodes.length,
      m: ctx.edges.length,
      state: ctx.running ? t('wf.aiStateRunning') : t('wf.aiStateIdle'),
    }),
  );
}

/**
 * 把一条提议翻成卡片上的样子。
 *
 * 翻译放在这里而不是面板里：面板是通用的，它不知道 nodeId 对应哪个节点，
 * 也不该知道——新建页那边的提议改的是表单字段，压根没有节点这回事。
 */
export function describeAction(a: AiAction, nodes: GraphNode[], t: TFn): ProposalView {
  /* 控制类（启停）比改个参数重得多，给它醒目色 */
  return { label: actionLabel(a, nodes, t), heavy: a.kind === 'control' };
}

function actionLabel(a: AiAction, nodes: GraphNode[], t: TFn): string {
  if (a.kind === 'param') {
    const n = nodes.find((x) => x.id === a.nodeId);
    const label = n ? nodeLabel(NODE_TYPES[n.type], t) : a.nodeId;
    const cur = n ? paramValue(n, a.label) : undefined;
    return t('wf.aiActParam', {
      label,
      param: a.label,
      from: cur ? `${cur} → ` : t('wf.aiActSetTo'),
      to: a.to,
    });
  }
  if (a.kind === 'addNode') {
    return t('wf.aiAddNode', { label: nodeLabel(NODE_TYPES[a.typeKey], t) || a.typeKey });
  }
  const ops = { start: t('wf.aiOpStart'), pause: t('task.pause'), resume: t('task.resume'), stop: t('task.stop') };
  return ops[a.op];
}


// --- 真后端接入层 ------------------------------------------------------------

// askAi() 是离线剧本（关键词匹配）；真 LLM 走下面这组函数。动作协议：模型在
// 回复末尾可以用一个 ```action 代码块提议动作（一个 JSON 数组，每项一个
// AiAction），正文里不要重复动作内容——卡片由前端解析渲染，应用仍需用户确认。

const ACTION_BLOCK_RE = /\n?```action\n([\s\S]*?)```\n?/g;

/** 把回复正文拆成 [纯文本, 动作数组]；解析失败的动作整块丢弃（宁可没有不可错的）。 */
export function splitActionBlocks(text: string): { body: string; actions: AiAction[] } {
  const actions: AiAction[] = [];
  let body = text;
  for (const m of text.matchAll(ACTION_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(m[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const a of arr) {
        if (a && typeof a === 'object') {
          if (a.kind === 'control' && ['start', 'pause', 'resume', 'stop'].includes(a.op)) {
            actions.push({ kind: 'control', op: a.op });
          } else if (a.kind === 'param' && a.nodeId && a.label && a.to !== undefined) {
            actions.push({ kind: 'param', nodeId: String(a.nodeId), label: String(a.label), to: String(a.to) });
          } else if (a.kind === 'addNode' && a.typeKey && a.note) {
            actions.push({ kind: 'addNode', typeKey: String(a.typeKey), note: String(a.note) });
          }
        }
      }
    } catch {
      // JSON 坏了就当没提议——正文仍然完整可用
    }
  }
  body = text.replace(ACTION_BLOCK_RE, '\n').trimEnd();
  return { body, actions };
}

/** 图的文本摘要：system prompt 的主体。只放事实（类型/参数/连线），不放解读。 */
export function graphContextText(ctx: AiContext): string {
  const lines: string[] = [];
  lines.push(`流程图「${ctx.presetLabel}」，${ctx.nodes.length} 个节点、${ctx.edges.length} 根连线，运行状态 ${ctx.running ? 'running' : 'idle'}。`);
  for (const n of ctx.nodes) {
    const def = NODE_TYPES[n.type];
    const params = paramsOf(n)
      .map((p) => `${p.label}=${p.value}`)
      .join(', ');
    lines.push(`- 节点 ${n.id}（${def?.label ?? n.type}）${params ? `：${params}` : ''}`);
  }
  for (const e of ctx.edges) {
    lines.push(`- 连线 ${e.from}:${e.fromPort} -> ${e.to}:${e.toPort}`);
  }
  return lines.join('\n');
}

export const ASSISTANT_SYSTEM_PROMPT = `你是 ms-swift 可视化编排页的流程助手。用户正在一张拖拽组装的训练流程图上工作，你回答关于这张图的问题。
回答规则：
- 简洁直接，先给结论再给理由；引用图上的真实取值时用节点 id 或参数名。
- 图能直接跑的参数问题给具体建议；超出图能力的（改骨架、换算法拓扑）明说做不到和为什么。
- 想替用户执行操作时，在回复末尾加一个 \`\`\`action 代码块，内容是一个 JSON 数组，每项形如：
  {"kind":"param","nodeId":"节点id","label":"参数名","to":"新值"}（改参数）
  {"kind":"control","op":"start"}（start/pause/resume/stop 之一）
  {"kind":"addNode","typeKey":"组件类型key","note":"为什么加"}（加节点）
- 动作只是提议：用户点了卡片才会生效。正文里说明为什么提议即可，不要催用户应用。
- 不确定就说不确定，不要编造图上不存在的参数或节点。`;

/**
 * 真后端流式问答：按登记顺序逐个尝试已配置的模型（第一个欠费/断连时换
 * 下一个，都失败才整体失败），onDelta 每次给目前为止的累计全文；一个模型
 * 都没有时返回 null（调用方回落离线剧本，页面不空转）。ctx 里带 node 时
 * 说明用户正盯着这个节点，system 里点名让它优先答相关问题。
 */
export async function streamAiReply(
  text: string,
  ctx: AiContext,
  hooks: { onStart?: () => void; onDelta: (acc: string) => void },
): Promise<string | null> {
  let ids: string[] = [];
  try {
    ids = (await listModels()).map((m) => m.id);
  } catch {
    ids = [];
  }
  if (!ids.length) return null;
  hooks.onStart?.();
  const focus = ctx.node
    ? `用户当前选中的节点：${ctx.node.id}（${NODE_TYPES[ctx.node.type]?.label ?? ctx.node.type}）。优先回答与它相关的问题。\n\n`
    : '';
  for (const modelId of ids) {
    let buf = '';
    try {
      await streamChat(
        modelId,
        [
          { role: 'system', content: `${ASSISTANT_SYSTEM_PROMPT}\n\n${focus}当前图：\n${graphContextText(ctx)}` },
          { role: 'user', content: text },
        ],
        (parts) => {
          buf += parts.content ?? '';
          hooks.onDelta(buf);
        },
      );
      return buf;
    } catch {
      /* 已收到内容的半截流保留已到部分，不再换模型重发（重发会在占位上重复正文） */
      if (buf) return buf;
    }
  }
  throw new Error('all chat models failed');
}

/**
 * 两个 AI 入口（整图抽屉 FlowAssistant / 节点面板 NodeInspector）共用的发送
 * 函数：流式渲染 LLM 回复，末尾的 ```action 块解析成动作卡片；无模型回落
 * askAi 剧本。差异只在 ctx（有没有 node），消息状态管理两边完全同构，收拢
 * 在这里以免两份实现日后漂移。
 */
export function makeAiSend(opts: {
  ctx: () => AiContext;
  t: TFn;
  setMessages: Dispatch<SetStateAction<FlowMessage[]>>;
}): (text: string) => Promise<void> {
  return async (text) => {
    const ctx = opts.ctx();
    let acc = '';
    let placeholderId = '';
    const finalize = () => {
      const { body, actions } = splitActionBlocks(acc);
      opts.setMessages((ms) =>
        ms.map((m) =>
          m.id === placeholderId
            ? {
                ...m,
                text: body,
                pending: false,
                actions: actions.length ? actions : undefined,
                states: actions.length ? actions.map(() => 'pending' as ActionState) : undefined,
              }
            : m,
        ),
      );
    };
    try {
      const reply = await streamAiReply(text, ctx, {
        onStart: () => {
          placeholderId = messageId();
          opts.setMessages((m) => [
            ...m,
            userMessage(text),
            { id: placeholderId, role: 'assistant', text: '', pending: true },
          ]);
        },
        onDelta: (delta) => {
          acc = delta;
          opts.setMessages((ms) =>
            ms.map((m) => (m.id === placeholderId ? { ...m, text: acc } : m)),
          );
        },
      });
      if (reply === null) {
        opts.setMessages((m) => [...m, userMessage(text), askAi(text, ctx, opts.t)]);
        return;
      }
    } catch {
      /* 流中断也保留已到的部分；一个字都没到才提示失败 */
      acc = acc || opts.t('wf.streamFail');
    }
    finalize();
  };
}
