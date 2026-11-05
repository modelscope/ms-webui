import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AiMessage, ActionState } from '@/components/AiChatPanel';
import { messageId, reconcileEngineMessages, toEngineDisplay, userMessage } from '@/components/AiChatPanel';
import { pushChat } from '@/store/chats';
import {
  submitTurn,
  openTurnLive,
  abortTurn,
  fetchConvBuckets,
  fetchPendingPageTools,
  resolvePageTool,
  type PageToolSpec,
} from '@/api/turns';
import type { ChatMessage } from '@/api/models';
import type { GraphEdge, GraphNode, NodeParam } from './nodeTypes';
import { NODE_TYPES, nodeLabel } from './nodeTypes';
import type { TFn } from './nodeTypes';

/**
 * 编排页的 AI 协助层。
 *
 * 这里放三样东西：AI 能提出的动作类型（AiAction）、离线剧本（无可用模型
 * 时的关键词匹配兜底，消息带 offline 标记）、引擎式会话 hook（useFlowAiChat
 * ——回合由 server 引擎执行，动作经页面工具挂起协议回传）。
 *
 * 最重要的一条设计不变：AI 不直接改图。它只能"提议"——每个提议是一张
 * 动作卡片，得点了应用才会落到图上。理由是这份图形是流程的唯一事实
 * 来源，如果 AI 能静默改它，「谁把 num_generations 从 8 调成 32 的」
 * 就会变成查不出来的事。提议的上抛通道从旧版 ```action 文本块换成
 * tool-calling（set_node_param / add_node / flow_control 三个页面工具，
 * 引擎挂起上抛、页面出卡、用户点应用）。
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
    /* 剧本产出：面板据此给这条消息标「本地示意」，与 LLM 回复区分 */
    offline: true,
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
 * 无可用模型（models.json 一个都没配）时整页回落到它，页面不空转。
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
export function describeAction(a: AiAction, nodes: GraphNode[], t: TFn): { label: string; heavy?: boolean } {
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
    return t('wf.aiAddNode', { label: nodeLabel(NODE_TYPES[a.typeKey as GraphNode['type']], t) || a.typeKey });
  }
  const ops = { start: t('wf.aiOpStart'), pause: t('task.pause'), resume: t('task.resume'), stop: t('task.stop') };
  return ops[a.op];
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
- 想替用户改参数或加节点，调用 set_node_param / add_node：修改会以卡片列出，用户点了「应用」才会落图——正文里说明为什么提议即可，不要催用户应用。
- 想替用户启停流程，调用 flow_control（start/pause/resume/stop；执行前会弹审批卡，用户确认后才执行）。
- 不确定就说不确定，不要编造图上不存在的参数或节点。`;

/**
 * 会话桶的 ChatMessage → 面板展示消息：共享基础版（编排页用户消息不带图片）。
 * 思维链/工具调用/工具结果以结构化字段交给面板渲染折叠卡（与对话页同一套）。
 */
const toDisplay = (m: ChatMessage): FlowMessage => toEngineDisplay<AiAction>(m);

/** 拖拽页的三个页面工具（schema 随回合提交；执行体在页面，经挂起协议回传） */
const FLOW_PAGE_TOOLS: PageToolSpec[] = [
  {
    name: 'set_node_param',
    description: '把某个节点的某个参数改成新值。修改以卡片列出，用户逐条点「应用」才落图。',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '目标节点 id（图摘要里列出的）' },
        label: { type: 'string', description: '参数名（对应节点参数 label）' },
        to: { type: 'string', description: '新值（一律字符串）' },
      },
      required: ['nodeId', 'label', 'to'],
    },
  },
  {
    name: 'add_node',
    description: '在图上新增一个组件节点。以卡片列出，用户点「应用」才落图。',
    parameters: {
      type: 'object',
      properties: {
        typeKey: { type: 'string', description: '组件类型 key（图摘要里出现过的类型）' },
        note: { type: 'string', description: '为什么加这个节点（卡片上展示）' },
      },
      required: ['typeKey', 'note'],
    },
  },
  {
    name: 'flow_control',
    description: '启动/暂停/恢复/停止整张流程图的运行（start/pause/resume/stop）。执行前需用户审批。',
    parameters: {
      type: 'object',
      properties: { op: { type: 'string', enum: ['start', 'pause', 'resume', 'stop'], description: '要执行的操作' } },
      required: ['op'],
    },
    approval: { title: '控制流程运行', reason: '对流程图的常驻会话执行启停控制（AI 提议，需用户确认）。' },
  },
];

/**
 * 页面工具调用的全局去重表：整图抽屉与节点面板两个 hook 实例可能同时订阅
 * 同一会话（两面板同时开着），callId 首见才执行——不共享会双出卡+双回传。
 * callId 是 UUID，跨会话不碰撞。
 */
const seenPageCallIds = new Set<string>();

/**
 * 编排页 AI 会话 hook（整图抽屉 FlowAssistant 与节点面板 NodeInspector 共用）：
 * 回合由 server 引擎执行（单写者架构——压缩历史、模型流、落盘全在引擎），
 * 动作提议经页面工具挂起协议（引擎上抛 → 页面出卡 → 用户点应用 → 回传续轮）。
 * 无可用模型时整条路回落离线剧本 askAi（页面不空转、不提交引擎）。
 */
export function useFlowAiChat({
  baseConv,
  model,
  ctx,
  t,
  onControl,
}: {
  /** 会话锚点：已保存实验传 `wf-<flowId>`（重开画布续上历史图对话），未保存传 ''（首发建临时会话） */
  baseConv: string;
  /** 当前模型 id（'' = 无可用模型，发送回落离线剧本） */
  model: string;
  ctx: () => AiContext;
  t: TFn;
  onControl: (op: 'start' | 'pause' | 'resume' | 'stop') => void;
}) {
  const [messages, setMessages] = useState<FlowMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  /* 会话 id：'' = 未起（首发时建临时）；SSE 订阅与回传都以它为锚 */
  const [convId, setConvId] = useState(baseConv);
  /* 图与控制回调都活在组件 render 里——hook 的 effect 闭包会过期，用 ref 拿现值 */
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const controlRef = useRef(onControl);
  controlRef.current = onControl;

  /*
   * 页面工具的执行面：引擎把挂起调用上抛（SSE page-tool 事件或恢复重放），
   * 这里出卡（param/addNode，等用户点应用）或执行控制（flow_control，审批
   * 已由引擎先行完成），然后回传结果续轮。恢复重放时 flow_control 不重执行
   * ——防止刷新造成误启停，改回执请用户用画布上的按钮。
   */
  const runPageTool = async (call: { id: string; name: string; arguments: string }, replay: boolean) => {
    if (seenPageCallIds.has(call.id)) return;
    seenPageCallIds.add(call.id);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch {
      await resolvePageTool(convId, model, call.id, '参数不是合法 JSON；请重发完整参数。');
      return;
    }
    let result = '';
    if (call.name === 'set_node_param') {
      const nodeId = String(args.nodeId ?? '');
      const label = String(args.label ?? '');
      const to = String(args.to ?? '');
      const node = ctxRef.current().nodes.find((n) => n.id === nodeId);
      if (node && label) {
        setMessages((ms) => [
          ...ms,
          {
            id: messageId(),
            role: 'assistant',
            text: t('assistant.proposeChanges'),
            actions: [{ kind: 'param', nodeId, label, to }],
            states: ['pending' as ActionState],
          },
        ]);
        result = '已列出参数修改卡片，用户点「应用」才会改图；应用结果不回显，可在图上核对。';
      } else {
        result = `图上没有节点 ${nodeId} 或参数名为空；请用图摘要里的节点 id 与参数名重发。`;
      }
    } else if (call.name === 'add_node') {
      const typeKey = String(args.typeKey ?? '');
      const note = String(args.note ?? '');
      const def = NODE_TYPES[typeKey as GraphNode['type']];
      if (def && typeKey) {
        setMessages((ms) => [
          ...ms,
          {
            id: messageId(),
            role: 'assistant',
            text: t('assistant.proposeChanges'),
            actions: [{ kind: 'addNode', typeKey, note }],
            states: ['pending' as ActionState],
          },
        ]);
        result = '已列出加节点卡片，用户点「应用」才会落图。';
      } else {
        result = `没有类型为 ${typeKey} 的组件；请用图摘要里出现过的类型重发。`;
      }
    } else if (call.name === 'flow_control') {
      const op = String(args.op ?? '');
      if (['start', 'pause', 'resume', 'stop'].includes(op)) {
        if (replay) {
          result = '页面刷新中断了控制动作；为避免误启停未自动重执行，请用户用画布上的启停按钮自行控制。';
        } else {
          controlRef.current(op as 'start' | 'pause' | 'resume' | 'stop');
          result = `已对流程执行 ${op}；状态以画布上的运行指示为准。`;
        }
      } else {
        result = `未知操作 ${op}（只接受 start/pause/resume/stop）。`;
      }
    } else {
      result = `未知页面工具 ${call.name}（本面板未注册它的执行体）。`;
    }
    await resolvePageTool(convId, model, call.id, result);
  };

  /*
   * 引擎回合增量订阅（SSE）：与页面助手面板同构。事件直接 patch messages，
   * 引擎落盘的消息是唯一真相，turn-done 时拉单会话桶对账兜底；挂起中的
   * 页面工具随重连重放（卡片回来，回合继续）。
   */
  useEffect(() => {
    if (!convId || !model) return;
    const conv = convId;
    void fetchPendingPageTools(conv, model).then((calls) => {
      for (const c of calls) void runPageTool(c, true);
    });
    const close = openTurnLive(conv, (ev) => {
      if (ev.conv !== conv || ev.model !== model) return;
      switch (ev.type) {
        case 'sync':
          setStreaming((ev.models ?? []).includes(model));
          return;
        case 'turn-start':
          setStreaming(true);
          return;
        case 'user': {
          const incoming = ev.message;
          if (!incoming) return;
          setMessages((ms) => {
            const last = ms[ms.length - 1];
            if (last?.role === 'user' && last.text === incoming.content) return ms;
            return [...ms, userMessage(incoming.content)];
          });
          return;
        }
        case 'assistant-start':
          setMessages((ms) => [...ms, { id: messageId(), role: 'assistant', text: '', pending: true }]);
          return;
        case 'delta':
          setMessages((ms) => {
            const last = ms[ms.length - 1];
            if (!last || last.role !== 'assistant') return ms; /* 乱序保护 */
            /* 思维链与正文各自累加：面板的折叠卡据此展示「思考中…」进度 */
            return [
              ...ms.slice(0, -1),
              {
                ...last,
                text: last.text + (ev.content ?? ''),
                reasoning: (last.reasoning ?? '') + (ev.reasoning ?? ''),
              },
            ];
          });
          return;
        case 'page-tool': {
          if (!ev.call) return;
          void runPageTool(ev.call, false);
          return;
        }
        case 'assistant':
        case 'tool':
        case 'error': {
          /*
           * 引擎落盘的完整消息：尾部对齐只替换本轮流式残影（pending）。
           * 不能只看 role——页面工具的卡片消息也是 assistant 且被插在尾部
           * （page-tool 出卡），引擎续轮前的落盘事件若把它当残影替换掉，
           * 卡片就永远不见了（时序竞态时隐时现）。
           */
          const incoming = ev.message;
          if (!incoming) return;
          setMessages((ms) => {
            const disp = toDisplay(incoming);
            const last = ms[ms.length - 1];
            if (last?.role === 'assistant' && last.pending && incoming.role === 'assistant') {
              return [...ms.slice(0, -1), disp];
            }
            return [...ms, disp];
          });
          return;
        }
        case 'turn-done':
          setStreaming(false);
          /* 对账兑底：桶拉回重建，本地未决卡片插回（与页面助手同一语义——
           * 引擎桶里只有回执文本，整列重置会抹掉用户还没点「应用」的提议卡） */
          void fetchConvBuckets(conv).then((buckets) => {
            const bucket = buckets[model] ?? [];
            if (!bucket.length) return;
            setMessages((prev) => reconcileEngineMessages(prev, bucket, toDisplay));
          });
          return;
      }
    });
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, model]);

  /*
   * 引擎回合挂起的审批面（flow_control 等）：轮询拉回渲染——决定走 POST，
   * 引擎恢复回合。与页面助手面板的审批轮询同一模式。
   */
  const [approvals, setApprovals] = useState<
    { id: string; title: string; reason: string; command?: string }[]
  >([]);
  const [engineAlways, setEngineAlways] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!convId) {
      setApprovals([]);
      return;
    }
    const conv = convId;
    const tick = async () => {
      try {
        const res = await fetch(`/api/headless/approvals?conv=${encodeURIComponent(conv)}`);
        if (!res.ok) return;
        const r = (await res.json()) as {
          approvals?: { id: string; title: string; reason: string; command?: string }[];
        };
        setApprovals(r.approvals ?? []);
      } catch {
        /* 审批面暂不可达：下一拍重试 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => clearInterval(timer);
  }, [convId]);
  const resolveEngineApproval = (id: string, approve: boolean, allowCommand: boolean) => {
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    void fetch(`/api/headless/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve, ...(allowCommand ? { alwaysAllow: true } : {}) }),
    }).catch(() => undefined);
  };

  const send = async (text: string) => {
    if (!text || streaming) return;
    const conv = convId || `wf${Date.now().toString(36)}`;
    if (conv !== convId) setConvId(conv);
    const title = text.length > 16 ? `${text.slice(0, 16)}…` : text;
    pushChat(conv, title);
    setMessages((ms) => [...ms, userMessage(text)]);
    /*
     * 无可用模型：回落离线剧本（不提交引擎、不落盘）——画布不空转是编排页
     * 的既有兜底，引擎化的前提是有模型。
     */
    if (!model) {
      setMessages((ms) => [...ms, askAi(text, ctxRef.current(), t)]);
      return;
    }
    setStreaming(true);
    const ctxNow = ctxRef.current();
    const focus = ctxNow.node
      ? `用户当前选中的节点：${ctxNow.node.id}（${NODE_TYPES[ctxNow.node.type]?.label ?? ctxNow.node.type}）。优先回答与它相关的问题。\n\n`
      : '';
    const isNew = conv !== convId;
    const r = await submitTurn(conv, {
      text,
      models: [model],
      system: [`${ASSISTANT_SYSTEM_PROMPT}\n\n${focus}当前图：\n${graphContextText(ctxNow)}`],
      tools: [],
      pageTools: FLOW_PAGE_TOOLS,
      /* 新会话把标题一并交给引擎建档（server 侧 chats 注册表与本机同步，
       * 首页会话列表才能看到这段对话） */
      ...(isNew ? { title } : {}),
    });
    if ('error' in r) {
      setStreaming(false);
      setMessages((ms) => [...ms, { id: messageId(), role: 'assistant', text: t('wf.streamFail') }]);
    }
  };

  const stop = () => {
    if (!convId || !model) return;
    void abortTurn(convId, model);
  };

  return {
    messages,
    setMessages,
    streaming,
    send,
    stop,
    approvals,
    engineAlways,
    setEngineAlways,
    resolveEngineApproval,
  } satisfies {
    messages: FlowMessage[];
    setMessages: Dispatch<SetStateAction<FlowMessage[]>>;
    streaming: boolean;
    send: (text: string) => Promise<void>;
    stop: () => void;
    approvals: { id: string; title: string; reason: string; command?: string }[];
    engineAlways: Record<string, boolean>;
    setEngineAlways: Dispatch<SetStateAction<Record<string, boolean>>>;
    resolveEngineApproval: (id: string, approve: boolean, allowCommand: boolean) => void;
  };
}
