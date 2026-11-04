import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ShieldAlert } from 'lucide-react';
import { listModels, type ChatMessage, type ModelConfig } from '@/api/models';
import { runAgentLoop } from '@/agent/runAgentLoop';
import { compressHistory } from '@/agent/history';
import { defineTool } from '@/agent/tools';
import { useApproval } from '@/agent/useApproval';
import { pushChat, useChats } from '@/store/chats';
import { useT, type MessageKey } from '@/i18n';
import { submitTurn, openTurnLive, abortTurn, fetchConvBuckets } from '@/api/turns';
import { AiChatPanel, messageId, userMessage, type AiMessage } from './AiChatPanel';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { SelectInput } from './FormField';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import type { ModuleKey } from '@/theme/modules';
import { MODULES } from '@/theme/modules';

/**
 * 页面 AI 助手面板：真模型（models.json 里的配置）+ 页面工具 + 会话续聊。
 *
 * 两类使用方共用这一个组件：
 * - 新建页（经 ConfigFormShell）：fields + onSubmit → set_form_fields /
 *   submit_form 两个表单工具，ActionCard 逐条确认的既有哲学不变；
 * - 列表/详情页：toolNames 传 'task:<module>'（引擎注册表键名），回合由
 *   server 引擎执行（单写者架构）。
 *
 * 会话与首页 ChatPage 同一套存储（chats 注册表 + swift-webui-turns 分桶）：
 * 顶部下拉可选首页任一会话加载消息本体继续聊，写回同一分桶——会话在
 * 首页与各页之间流动。默认新会话（无上下文）。
 */

/** 助手能读、能改的一个表单字段（key 与 CLI flag / 表单 key 同名） */
export interface ConfigField {
  key: string;
  label: string;
  /** 当前值。一律字符串——助手只负责显示和回写，不参与计算 */
  value: string;
  /** 提议被应用时怎么写回去；不给就是只读 */
  apply?: (value: string) => void;
}

/** set_form_fields 的一条提议：把某个字段改成某个值 */
export interface ConfigAction {
  key: string;
  to: string;
}

/** 提议在卡片上的样子：字段名和当前值都得摆出来，用户才知道自己点的是什么 */
export function describeConfigAction(a: ConfigAction, fields: ConfigField[], t: (key: MessageKey, vars?: Record<string, string | number>) => string) {
  const f = fields.find((x) => x.key === a.key);
  const cur = f?.value;
  return {
    label: t('assistant.cfgActLabel', {
      label: f?.label ?? a.key,
      from: cur ? `${cur} → ` : t('assistant.cfgActFill'),
      to: a.to,
    }),
  };
}

/** 快捷追问（纯文案，预填输入框） */
const SUGGESTIONS: Partial<Record<ModuleKey, MessageKey[]>> = {
  train: ['assistant.quick1', 'assistant.quick2', 'assistant.quick3'],
  eval: ['assistant.quick4', 'assistant.quick5'],
  export: ['assistant.quick6', 'assistant.quick7'],
  deploy: ['assistant.quick8', 'assistant.quick9'],
};

/** 会话桶里的 ChatMessage → 面板展示消息（工具消息折叠成一行文本） */
function toDisplay(m: ChatMessage, t: (key: MessageKey) => string): AiMessage<ConfigAction> {
  if (m.role === 'user') return { id: messageId(), role: 'user', text: m.content };
  if (m.role === 'tool') {
    return { id: messageId(), role: 'assistant', text: `${t('assistant.toolResult')} ${m.content.slice(0, 400)}` };
  }
  const calls = (m.toolCalls ?? []).map((c) => `${t('assistant.toolCall')} ${c.name}`).join('\n');
  return {
    id: messageId(),
    role: 'assistant',
    text: [m.content, calls].filter(Boolean).join('\n'),
  };
}

export function PageAssistant({
  open,
  onClose,
  module,
  toolNames,
  fields,
  onSubmit,
  confirmBeforeApply,
  intro,
  initialConv,
  initialModel,
}: {
  open: boolean;
  onClose: () => void;
  module: ModuleKey;
  /**
   * 工具名清单（引擎注册表键名，如 'task:train'）：传了且非配置模式时，
   * 回合提交给 server 引擎执行（单写者架构——convs.json 只有引擎写）。
   * 不传或配置模式（fields 表单工具）则页面执行，不落盘。
   */
  toolNames?: string[];
  /** 表单字段：提供时启用 set_form_fields（提议卡片逐条应用） */
  fields?: ConfigField[];
  /** 提交动作：提供时启用 submit_form（heavy 审批） */
  onSubmit?: () => void | Promise<void>;
  confirmBeforeApply: boolean;
  /** 开场白覆盖（首页 AI 创建工具跳转而来时传需求复述 + 已填概览） */
  intro?: string;
  /** 发起创建的首页会话 id（AI 预填跳转）：挂载即加载该会话的 turns 桶续聊 */
  initialConv?: string;
  /** 发起创建的模型 id：turns 按会话 × 模型分桶，续聊要加载对应桶 */
  initialModel?: string;
}) {
  const { t } = useT();
  const label = t(MODULES[module].label);
  /*
   * 引擎模式（单写者架构）：任务页传 toolNames（引擎注册表键名）时，回合
   * 提交给 server 引擎执行——执行体、落盘、审批挂起全在 server，面板只是
   * 提交与 SSE 观看（刷新/关闭面板不影响回合跑完）。配置模式（fields 表单
   * 工具）保留页面执行：set_form_fields / submit_form 闭包耦合本组件的
   * 表单 state 与提交动作，引擎侧无法构建。
   */
  const engineMode = Boolean(toolNames?.length && !fields);
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const [model, setModel] = useState(initialModel ?? '');
  const chats = useChats();
  /*
   * 当前会话：'' = 新会话（无上下文）；否则是 turns 分桶的会话 id。
   * AI 预填跳转带着首页会话过来时直接续聊那段对话——「打开的对话」就是
   * 用户在首页的那段，而不是一个凭空的空会话。
   */
  const [convId, setConvId] = useState(initialConv ?? '');
  const [messages, setMessages] = useState<AiMessage<ConfigAction>[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  /** 模型视角的完整会话（渲染与持久化共用一份） */
  const [history, setHistory] = useState<ChatMessage[]>([]);
  /* shell 会话级允许集：审批卡勾过「总是允许」的命令名，后续同名命令直接执行 */
  const allowedCommands = useRef(new Set<string>());
  const { approval, alwaysAllow, setAlwaysAllow, requestApproval, settleApproval } = useApproval({
    onAlwaysAllow: (command) => allowedCommands.current.add(command),
  });
  /* 停止键句柄：停止时连带把未决审批按拒绝结算，卡片不悬空；stopping 期按钮转圈 */
  const abortRef = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!streaming) setStopping(false);
  }, [streaming]);
  const stop = () => {
    /* 引擎模式：中止 server 侧本列回合（引擎 abort，SSE 的 turn-done 收尾） */
    if (engineMode) {
      if (!convId) return;
      setStopping(true);
      void abortTurn(convId, model);
      return;
    }
    if (!abortRef.current) return;
    setStopping(true);
    abortRef.current.abort();
    settleApproval(false);
  };

  useEffect(() => {
    listModels()
      .then((configs) => {
        setModelConfigs(configs);
        setModel((prev) => prev || configs[0]?.id || '');
      })
      .catch(() => {
        /* 模型清单不可达：选择器显示无可用模型，发送被拦 */
      });
  }, []);

  /* AI 预填跳转带来的续聊：挂载即从 server 加载该（会话 × 模型）桶 */
  useEffect(() => {
    if (!initialConv || !initialModel) return;
    void fetchConvBuckets(initialConv).then((buckets) => {
      const bucket = buckets[initialModel] ?? [];
      setHistory(bucket);
      setMessages(bucket.map((m) => toDisplay(m, t)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 首次打开给开场白：有覆盖（AI 预填跳转）用覆盖，否则按场景给默认 */
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([
        {
          id: messageId(),
          role: 'assistant',
          text:
            intro ??
            (fields
              ? t('assistant.introFields', { label, n: fields.length })
              : t('assistant.introTasks')),
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* 切会话：新会话清空；已有会话从 server 加载其消息本体（当前模型的桶） */
  const switchConv = (id: string) => {
    if (streaming) return;
    setConvId(id);
    if (!id) {
      setMessages([]);
      setHistory([]);
      return;
    }
    void fetchConvBuckets(id).then((buckets) => {
      const bucket = buckets[model] ?? [];
      setHistory(bucket);
      setMessages(bucket.map((m) => toDisplay(m, t)));
    });
  };

  /* 切模型：已有会话换到该模型自己的桶（各模型上下文独立，与首页同构） */
  const switchModel = (id: string) => {
    if (streaming || !id || id === model) return;
    setModel(id);
    if (convId) {
      void fetchConvBuckets(convId).then((buckets) => {
        const bucket = buckets[id] ?? [];
        setHistory(bucket);
        setMessages(bucket.map((m) => toDisplay(m, t)));
      });
    }
  };

  /*
   * 引擎回合增量订阅（SSE）：单写者架构的观看面，与首页 ChatPage 同构。
   * 单列会话——只认当前模型的事件；事件直接 patch messages（渲染缓存），
   * 引擎落盘的消息是唯一真相，turn-done 时拉单会话桶对账兜底（丢帧/重连
   * 后补齐）。streaming 态同源维护：首连 sync 事件恢复（重开面板/切会话后
   * 回合可能还在跑）。
   */
  useEffect(() => {
    if (!engineMode || !convId) return;
    const conv = convId;
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
          /* 引擎回合的 user 消息（唤醒合成或提交 echo）：本地已 append 过则跳过 */
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
            return [...ms.slice(0, -1), { ...last, text: last.text + (ev.content ?? '') }];
          });
          return;
        case 'assistant':
        case 'tool':
        case 'error': {
          /* 引擎落盘的完整消息：尾部对齐（delta 已拼则等价替换，丢帧则补齐） */
          const incoming = ev.message;
          if (!incoming) return;
          setMessages((ms) => {
            const disp = toDisplay(incoming, t);
            const last = ms[ms.length - 1];
            if (last?.role === 'assistant' && incoming.role === 'assistant') {
              return [...ms.slice(0, -1), disp];
            }
            return [...ms, disp];
          });
          return;
        }
        case 'turn-done':
          setStreaming(false);
          /* 对账兜底：单会话桶拉回整列重置（server 是唯一真相源） */
          void fetchConvBuckets(conv).then((buckets) => {
            const bucket = buckets[model] ?? [];
            if (!bucket.length) return;
            setHistory(bucket);
            setMessages(bucket.map((m) => toDisplay(m, t)));
          });
          return;
      }
    });
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMode, convId, model]);

  /*
   * 引擎回合的审批面：任务工具（stop_task / delete_task 等）的审批在
   * server 侧挂起（approvals.json），轮询拉回渲染——决定走 POST，引擎
   * 恢复回合。与本地 useApproval 审批卡同一样式、两个来源互不替代
   * （本地面板卡只管配置模式的页面工具）。
   */
  const [engineApprovals, setEngineApprovals] = useState<
    { id: string; title: string; reason: string; command?: string }[]
  >([]);
  const [engineAlways, setEngineAlways] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!engineMode || !convId) {
      setEngineApprovals([]);
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
        setEngineApprovals(r.approvals ?? []);
      } catch {
        /* 审批面暂不可达：下一拍重试 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => clearInterval(timer);
  }, [engineMode, convId]);
  const resolveEngineApproval = (id: string, approve: boolean, allowCommand: boolean) => {
    setEngineApprovals((prev) => prev.filter((a) => a.id !== id));
    void fetch(`/api/headless/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve, ...(allowCommand ? { alwaysAllow: true } : {}) }),
    }).catch(() => undefined);
  };

  /* set_form_fields：把提议转成一条 ActionCard 消息，应用权在用户 */
  const setFormFields = useMemo(
    () =>
      defineTool(
        {
          type: 'function',
          function: {
            name: 'set_form_fields',
            description: `批量修改${label}表单字段。每条修改会以卡片列出，用户逐条点「应用」才落表单。可写字段：${
              (fields ?? []).map((f) => f.key).join(', ') || '（无）'
            }`,
            parameters: {
              type: 'object',
              properties: {
                fields: {
                  type: 'array',
                  description: '要改的字段清单',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string', description: '字段 key（与表单/CLI flag 同名）' },
                      value: { type: 'string', description: '目标值（一律字符串）' },
                    },
                    required: ['key', 'value'],
                  },
                },
              },
              required: ['fields'],
            },
          },
        },
        async (args) => {
          const list = Array.isArray(args.fields) ? args.fields : [];
          const actions: ConfigAction[] = [];
          for (const item of list) {
            const key = String((item as Record<string, unknown>).key ?? '');
            const to = String((item as Record<string, unknown>).value ?? '');
            const f = (fields ?? []).find((x) => x.key === key);
            if (f?.apply && f.value !== to) actions.push({ key, to });
          }
          if (!actions.length) {
            return '没有可应用的修改（字段不存在、只读、或值本来就一样）。';
          }
          setMessages((ms) => [
            ...ms,
            {
              id: messageId(),
              role: 'assistant',
              text: t('assistant.proposeChanges'),
              actions,
              states: actions.map(() => 'pending' as const),
            },
          ]);
          return `已列出 ${actions.length} 条修改卡片，等用户逐条应用。应用结果不在本次对话里回显，用户点卡片上的「应用」即写入表单。`;
        },
      ),
    [label, fields, t],
  );

  /* submit_form：提交创建，heavy 审批（审批卡在面板底部） */
  const submitForm = useMemo(
    () =>
      defineTool(
        {
          type: 'function',
          function: {
            name: 'submit_form',
            description: `按当前表单内容提交创建${label}任务（等价于用户点启动按钮）。属于重操作，执行前需用户审批`,
            parameters: { type: 'object', properties: {} },
          },
        },
        async (_args, ctx) => {
          const ok = await ctx.requestApproval(
            t('assistant.approveSubmitTitle', { label }),
            t('assistant.approveSubmitDesc'),
          );
          if (!ok) return '用户拒绝了提交。请继续调整或询问用户意图。';
          if (!onSubmit) return '本页没有接提交动作，请用户在页面上点启动。';
          await Promise.resolve(onSubmit());
          return '已触发提交；结果以页面上的提示为准（校验失败会在页面报错）。';
        },
      ),
    [label, onSubmit, t],
  );

  /* 工具集 = 表单工具（配置模式专用；引擎模式的工具在 server 按名构建） */
  const allTools = useMemo(
    () => [...(fields ? [setFormFields] : []), ...(onSubmit ? [submitForm] : [])],
    [fields, setFormFields, onSubmit, submitForm],
  );

  const system = useMemo(
    () =>
      fields
        ? `你是新建${label}页面的配置助手。回答字段怎么填、给起手值；要改表单用 set_form_fields（修改以卡片列出、用户逐条确认）；用户确认后可用 submit_form 提交（需审批）。工具拿不到的字段值就以用户的话为准，别猜。`
        : `你是${label}模块页面的助手。可以 list_tasks 查看任务、stop_task / delete_task 停止或删除（需用户审批）、rename_task 重命名。操作前先核对任务 id。`,
    [label, fields],
  );

  const handleAction = (msgId: string, index: number, next: 'applied' | 'ignored') => {
    const action = messages.find((m) => m.id === msgId)?.actions?.[index];
    /* 回写走字段自带的 setter */
    if (next === 'applied' && action && fields) {
      fields.find((f) => f.key === action.key)?.apply?.(action.to);
    }
    setMessages((ms) =>
      ms.map((m) =>
        m.id === msgId ? { ...m, states: m.states?.map((s, i) => (i === index ? next : s)) } : m,
      ),
    );
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || streaming || !model) return;
    /* 无会话（新会话首发）时建档，标题取首句；续聊只刷新时间 */
    const conv = convId || `c${Date.now().toString(36)}`;
    const isNew = !convId;
    if (isNew) setConvId(conv);
    const title = text.length > 16 ? `${text.slice(0, 16)}…` : text;
    pushChat(conv, title);
    setDraft('');
    setMessages((ms) => [...ms, userMessage(text)]);
    /*
     * 引擎模式：提交回合（执行体在 server——压缩历史、模型流、工具循环、
     * 落盘全在引擎），增量经下方 SSE 订阅进视图；新会话把标题一并交给引擎
     * 建档（server 侧 chats 注册表与本机同步）。SSE 的 user 事件带同一条
     * 消息回来，尾部去重见订阅 effect。
     */
    if (engineMode) {
      setStreaming(true);
      const r = await submitTurn(conv, {
        text,
        models: [model],
        system: [system],
        tools: toolNames ?? [],
        ...(isNew ? { title } : {}),
      });
      if ('error' in r) {
        setStreaming(false);
        setMessages((ms) => [...ms, { id: messageId(), role: 'assistant', text: t('chat.errSubmit') }]);
      }
      return;
    }
    /*
     * 配置模式：页面执行（表单工具闭包耦合本组件）；不落盘——convs.json
     * 的 turns 桶唯一写者是引擎，页面执行体不写桶。
     */
    const userMsg: ChatMessage = { role: 'user', content: text };
    const base = [...history, userMsg];
    setHistory(base);
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    /* 流式累积与轮次标记：无工具的终轮需要手动补进 history */
    let acc = '';
    let accReasoning = '';
    let toolRound = false;
    try {
      /*
       * 对话本体先过压缩（与首页同一入口）：超阈值时旧消息折成摘要 system
       * 消息 + 保留最近几轮。面板的页面 system（工具用法说明）每轮原样在前。
       */
      const dialogue = await compressHistory({ convId: conv, modelId: model, dialogue: base });
      await runAgentLoop({
        model,
        history: [{ role: 'system', content: system }, ...dialogue],
        tools: allTools,
        ctx: { requestApproval, allowedCommands: allowedCommands.current },
        signal: abort.signal,
        events: {
          onAssistantStart: () => {
            toolRound = false;
            setMessages((ms) => [...ms, { id: messageId(), role: 'assistant', text: '', pending: true }]);
          },
          onDelta: (parts) => {
            acc += parts.content;
            accReasoning += parts.reasoning;
            if (parts.content) {
              setMessages((ms) => {
                const last = ms[ms.length - 1];
                return [...ms.slice(0, -1), { ...last, text: last.text + parts.content }];
              });
            }
          },
          onToolResult: (call, result) => {
            toolRound = true;
            setMessages((ms) => [
              ...ms,
              { id: messageId(), role: 'assistant', text: `[${call.name}] ${result.slice(0, 400)}` },
            ]);
          },
          onRound: (h) => setHistory(h),
          onError: (errText) =>
            setMessages((ms) => {
              const last = ms[ms.length - 1];
              return [...ms.slice(0, -1), { ...last, pending: false, text: last.text || errText }];
            }),
        },
      });
      /* 终轮（无工具调用）不会被 onRound 回吐，这里补上 */
      if (!toolRound && acc) {
        setHistory((h) => [
          ...h,
          { role: 'assistant', content: acc, ...(accReasoning ? { reasoning: accReasoning } : {}) },
        ]);
      }
      /* 被停止的流：末条回复补一个停止标记 */
      if (abort.signal.aborted && acc) {
        setMessages((ms) => {
          const last = ms[ms.length - 1];
          if (!last || last.role !== 'assistant' || !last.text) return ms;
          return [...ms.slice(0, -1), { ...last, text: `${last.text}\n\n${t('assistant.stopped')}` }];
        });
      }
    } finally {
      setStreaming(false);
      if (abortRef.current === abort) abortRef.current = null;
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        return last?.pending ? [...ms.slice(0, -1), { ...last, pending: false }] : ms;
      });
    }
  };

  const modelOptions = [
    ...modelConfigs.map((m) => ({ value: m.id, label: m.id })),
    /*
     * 续聊带来的模型可能不在 models.json（如展览模式的默认模型）：补一个
     * 同名选项，让选择器显示它而不是空值——发送能否成功由服务端鉴权决定。
     */
    ...(model && !modelConfigs.some((m) => m.id === model) ? [{ value: model, label: model }] : []),
  ];
  const convOptions = [
    { value: '', label: t('assistant.newSession') },
    ...chats.map((c) => ({ value: c.id, label: c.title })),
  ];

  return (
    <Sheet modal={false} open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        showOverlay={false}
        className="w-105 gap-0 sm:max-w-none"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <SheetHeader className="px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Bot className="text-primary size-4" />
            {t('assistant.pageAssistantTitle', { label })}
          </SheetTitle>
        </SheetHeader>

        {/*
          模型与会话两枚下拉：模型决定回答来源与 turns 分桶；会话默认新开，
          可选首页任一会话续聊（历史随对话发送，写回同一分桶）。
        */}
        <div className="border-border/60 flex items-center gap-2 border-t px-4 py-2.5">
          <SelectInput
            value={model}
            onChange={switchModel}
            options={modelOptions}
            placeholder={t('assistant.noModel')}
            disabled={!modelOptions.length || streaming}
            className="text-muted-foreground h-7 flex-1 gap-1.5 truncate border-0 px-2 text-xs shadow-none"
          />
          <SelectInput
            value={convId}
            onChange={switchConv}
            options={convOptions}
            disabled={streaming}
            className="text-muted-foreground h-7 flex-1 gap-1.5 truncate border-0 px-2 text-xs shadow-none"
          />
        </div>

        <AiChatPanel
          messages={messages}
          describe={(a) => describeConfigAction(a, fields ?? [], t)}
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => void send()}
          onStop={streaming ? stop : undefined}
          stopping={stopping}
          onAction={handleAction}
          confirmBeforeApply={confirmBeforeApply}
          suggestions={(SUGGESTIONS[module] ?? []).map((k) => t(k))}
          placeholder={model ? t('assistant.askPlaceholder', { module: label }) : t('assistant.noModelHint')}
          footerNote={t('assistant.modelHint')}
        />

        {/*
          立即执行类工具（submit_form / stop_task / shell 等）的审批卡：贴在
          输入框上方，等用户点头。拒绝文案会作为工具结果回喂，模型可以换路走。
          command 存在 = shell 审批，多给「会话内总是允许此类命令」勾选。
        */}
        {approval && (
          <div className="border-state-failed/50 bg-card m-3 mt-0 rounded-xl border p-3.5">
            <div className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
              <ShieldAlert size={14} className="text-state-failed flex-none" />
              {t('approval.title')}
            </div>
            <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-lg p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
              {approval.title}
            </pre>
            <div className="text-muted-foreground mt-1.5 text-xs">{approval.reason}</div>
            {approval.command && (
              <label className="text-muted-foreground mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox checked={alwaysAllow} onCheckedChange={(v) => setAlwaysAllow(v === true)} />
                {t('approval.alwaysAllow', { command: approval.command })}
              </label>
            )}
            <div className="mt-2.5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => settleApproval(false)}>
                {t('approval.deny')}
              </Button>
              <Button size="sm" onClick={() => settleApproval(true)}>
                {t('approval.allow')}
              </Button>
            </div>
          </div>
        )}

        {/*
         * 引擎回合挂起的审批：server 侧任务工具（stop_task 等）等的就是它——
         * 决定后引擎恢复回合。样式与本地面板审批卡同构。
         */}
        {engineApprovals.map((a) => (
          <div key={a.id} className="border-state-failed/50 bg-card m-3 mt-0 rounded-xl border p-3.5">
            <div className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
              <ShieldAlert size={14} className="text-state-failed flex-none" />
              {t('approval.title')}
            </div>
            <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-lg p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
              {a.title}
            </pre>
            <div className="text-muted-foreground mt-1.5 text-xs whitespace-pre-line">{a.reason}</div>
            {a.command && (
              <label className="text-muted-foreground mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={engineAlways[a.id] === true}
                  onCheckedChange={(v) => setEngineAlways((prev) => ({ ...prev, [a.id]: v === true }))}
                />
                {t('approval.alwaysAllow', { command: a.command })}
              </label>
            )}
            <div className="mt-2.5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => resolveEngineApproval(a.id, false, false)}>
                {t('approval.deny')}
              </Button>
              <Button
                size="sm"
                onClick={() => resolveEngineApproval(a.id, true, a.command ? engineAlways[a.id] === true : false)}
              >
                {t('approval.allow')}
              </Button>
            </div>
          </div>
        ))}
      </SheetContent>
    </Sheet>
  );
}
