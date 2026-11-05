import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Paperclip, X } from 'lucide-react';
import { listModels, type ChatMessage, type ModelConfig } from '@/api/models';
import { pushChat, useChats } from '@/store/chats';
import { useT, type MessageKey } from '@/i18n';
import {
  submitTurn,
  openTurnLive,
  abortTurn,
  fetchConvBuckets,
  fetchPendingPageTools,
  resolvePageTool,
  type PageToolSpec,
} from '@/api/turns';
import { listSkills, buildSkillsSystem } from '@/api/skills';
import { CONFIG_ASSISTANT_GUIDE } from '@/agent/builtin';
import { normalizeImage } from './attachments';
import { AiChatPanel, messageId, userMessage, type AiMessage } from './AiChatPanel';
import { EngineApprovalCard } from './EngineApprovalCard';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { SelectInput } from './FormField';
import type { ModuleKey } from '@/theme/modules';
import { MODULES } from '@/theme/modules';

/**
 * 页面 AI 助手面板：真模型（models.json 里的配置）+ 会话续聊，回合全部由
 * server 引擎执行（单写者架构——执行体、落盘、审批挂起全在 server，面板
 * 只做提交与 SSE 观看）。两种形态共用一个组件：
 * - 任务列表/详情页：toolNames 传 'task:<module>'（引擎注册表键名）；
 * - 新建页（经 ConfigFormShell）：fields + onSubmit → schema 随回合提交
 *   （pageTools），执行体留在页面——引擎挂起上抛（SSE page-tool 事件），
 *   页面执行后回传续轮。ActionCard 逐条确认的哲学不变。
 *
 * 会话与首页 ChatPage 同一套存储（chats 注册表 + swift-webui-turns 分桶）：
 * 顶部下拉可选首页任一会话加载消息本体继续聊，写回同一分桶——会话在
 * 首页与各页之间流动。默认新会话（无上下文）。新建页配置助手随回合注入
 * skills 索引与 swift 源码/环境工具（填 swift CLI 参数的知识面）。
 */

/** 助手能读、能改的一个表单字段（key 与 CLI flag / 表单 key 同名） */
export interface ConfigField {
  key: string;
  label: string;
  /** 当前值。一律字符串——助手只负责显示和回写，不参与计算 */
  value: string;
  /** 提议被应用时怎么写回去；不给就是只读 */
  apply?: (value: string) => void;
  /** 合法值域（枚举型字段给）：提议值不在域内时拒绝生成卡片并回喂原因，
   * 防止模型把算法名写进不相干的枚举字段产出非法表单态 */
  options?: readonly string[];
  /**
   * 生效判据：入参是「表单现值被本批提议覆盖后」的虚拟形态（key → 值）。
   * 不满足时提议被拒并回喂原因——可写字段面是恒全集，但条件字段（如 RL
   * 专有参数需 task_type=rl）在形态不满足时写入不会进命令，必须在同一批
   * 里把条件字段一并提议；缺省 = 任何形态都生效。
   */
  active?: (form: Record<string, string>) => boolean;
  /** 生效条件的说明（schema 描述与拒绝回执共用，如「task_type=rl 且 rl_type=grpo」） */
  scopeNote?: string;
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

/**
 * 会话桶里的 ChatMessage → 面板展示消息（用户图片随消息回显）。思维链/
 * 工具调用/工具结果以结构化字段交给面板渲染折叠卡（与对话页同一套），
 * 不再折成一行文本。
 */
function toDisplay(m: ChatMessage): AiMessage<ConfigAction> {
  if (m.role === 'user') return { id: messageId(), role: 'user', text: m.content, ...(m.images?.length ? { images: m.images } : {}) };
  if (m.role === 'tool') {
    /* text 留空：面板对只有工具结果的消息不画正文气泡，折叠卡独立成行 */
    return { id: messageId(), role: 'assistant', text: '', toolResult: m.content };
  }
  return {
    id: messageId(),
    role: 'assistant',
    text: m.content,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
  };
}

/**
 * turn-done 对账合并：桶是唯一真相源，但页面工具产出的卡片消息只活在本地
 * （引擎桶里只有回执文本，卡片结构不落盘）——整列重置会把它抹掉，用户
 * 就看到「模型说已列卡片、面板却没动」的断层。卡片按原顺序插回重建列
 * 末尾；切会话/重开面板走 restoreConversation（全新建，不保留卡片）。
 */
function reconcile(
  prev: AiMessage<ConfigAction>[],
  bucket: ChatMessage[],
): AiMessage<ConfigAction>[] {
  const rebuilt = bucket.map((m) => toDisplay(m));
  const cards = prev.filter((m) => m.actions?.length);
  return cards.length ? [...rebuilt, ...cards] : rebuilt;
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
  /** 提交动作：提供时启用 submit_form（heavy 审批）。返回 string = 失败原因（回喂模型，可自治修正后重提）；null/undefined = 成功 */
  onSubmit?: () => string | null | undefined | Promise<string | null | undefined>;
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
  /* SSE 事件回调（page-tool 等）里读最新消息：render 闭包会过期，与 aiAssist 的 ctxRef 同一模式 */
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /* 同一过期闭包问题也适用于 onSubmit：SSE 回调里调用的必须是最新 render 的提交闭包 */
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  /* 多模态附件（data URL）：随回合提交给引擎，与首页同一条压缩入口 */
  const [attachments, setAttachments] = useState<string[]>([]);
  /* skills 索引段：配置页（fields）注入用，mount 拉一次拼好（空串 = 无技能不注入） */
  const [skillsSystem, setSkillsSystem] = useState('');
  /* 页面工具调用去重：SSE 实时帧与恢复重放共用（callId 首见才执行） */
  const seenPageCalls = useRef(new Set<string>());
  /* 停止键：中止 server 侧本列回合（引擎 abort 连带结算挂起的审批与页面工具）；stopping 期按钮转圈 */
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!streaming) setStopping(false);
  }, [streaming]);
  const stop = () => {
    if (!convId) return;
    setStopping(true);
    void abortTurn(convId, model);
  };
  /* skills 索引：只给配置页拉（任务页工具面不含 read_skill，注入无展开入口） */
  useEffect(() => {
    if (!fields) return;
    listSkills()
      .then((skills) => setSkillsSystem(buildSkillsSystem(skills)))
      .catch(() => {
        /* 技能面不可达：不注入，回合仍可 read_skill */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(fields)]);

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
      restoreConversation(buckets[initialModel] ?? []);
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

  /*
   * 恢复/加载一条对话（server 桶是唯一真相源，引擎单写者落盘——刷新/切换
   * 后都在）：空内容时给开场白，避免面板白屏。
   */
  const restoreConversation = (bucket: ChatMessage[]) => {
    if (bucket.length) {
      setMessages(bucket.map((m) => toDisplay(m)));
    } else {
      setMessages([
        {
          id: messageId(),
          role: 'assistant',
          text: intro ?? (fields ? t('assistant.introFields', { label, n: fields.length }) : t('assistant.introTasks')),
        },
      ]);
    }
  };

  /* 切会话：目标从 server 桶加载 */
  const switchConv = (id: string) => {
    if (streaming) return;
    setConvId(id);
    seenPageCalls.current.clear();
    if (!id) {
      restoreConversation([]);
      return;
    }
    void fetchConvBuckets(id).then((buckets) => {
      restoreConversation(buckets[model] ?? []);
    });
  };

  /* 切模型：换到该模型自己的桶（各模型上下文独立，与首页同构） */
  const switchModel = (id: string) => {
    if (streaming || !id || id === model) return;
    setModel(id);
    seenPageCalls.current.clear();
    if (convId) {
      void fetchConvBuckets(convId).then((buckets) => {
        restoreConversation(buckets[id] ?? []);
      });
    }
  };

  /*
   * 页面工具的执行面（配置模式）：引擎把挂起调用上抛（SSE page-tool 事件
   * 或恢复重放），这里执行页面侧动作并回传结果续轮。set_form_fields 出卡
   * 等用户逐条应用（应用动作不回喂模型，既有哲学）；submit_form 的审批已由
   * 引擎先行完成，页面段只执行提交。恢复重放时 submit_form 不重执行——防
   * 刷新造成双重提交，改回执请用户在页面上点启动。
   */
  const runPageTool = async (call: { id: string; name: string; arguments: string }, replay: boolean) => {
    if (seenPageCalls.current.has(call.id)) return;
    seenPageCalls.current.add(call.id);
    let result = '';
    if (call.name === 'set_form_fields') {
      result = await proposeFormFields(call.arguments);
    } else if (call.name === 'submit_form') {
      result = replay
        ? '页面刷新中断了提交动作；为避免重复提交未自动重执行，请用户在页面上直接点启动按钮完成。'
        : await triggerSubmit();
    } else {
      result = `未知页面工具 ${call.name}（本面板未注册它的执行体）。`;
    }
    await resolvePageTool(convId, model, call.id, result);
  };
  
  /*
   * 引擎回合增量订阅（SSE）：单写者架构的观看面，与首页 ChatPage 同构。
   * 单列会话——只认当前模型的事件；事件直接 patch messages（渲染缓存），
   * 引擎落盘的消息是唯一真相，turn-done 时拉单会话桶对账兑底（丢帧/重连
   * 后补齐）。streaming 态同源维护：首连 sync 事件恢复（重开面板/切会话后
   * 回合可能还在跑）；挂起中的页面工具随重连重放（卡片回来，回合继续）。
   */
  useEffect(() => {
    if (!convId) return;
    const conv = convId;
    /* 挂起恢复：重连时重放挂起中的页面工具调用（重出卡片/按钮，防丢帧后挂死） */
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
          /* 引擎上抛的挂起工具调用：页面执行（出卡/提交）后回传续轮 */
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
           * 卡片就永远不见了（回执说已列出、界面没有，时序竞态时隐时现）。
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
          /* 对账兜底：桶拉回重建，但本地卡片消息插回（否则确认面被抹掉） */
          void fetchConvBuckets(conv).then((buckets) => {
            const bucket = buckets[model] ?? [];
            if (!bucket.length) return;
            setMessages((prev) => reconcile(prev, bucket));
          });
          return;
      }
    });
    return close;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, model]);

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
    if (!convId) {
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
  }, [convId]);
  const resolveEngineApproval = (id: string, approve: boolean, allowCommand: boolean) => {
    setEngineApprovals((prev) => prev.filter((a) => a.id !== id));
    void fetch(`/api/headless/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve, ...(allowCommand ? { alwaysAllow: true } : {}) }),
    }).catch(() => undefined);
  };

  /*
   * set_form_fields 的页面执行体：把提议转成一条 ActionCard 消息，应用权在
   * 用户（handleAction 回写字段）。返回文本作为工具结果回喂模型——含拒
   * 绝原因（域外提议、形态条件不满足）与「等用户逐条应用」的说明。
   */
  const proposeFormFields = async (argumentsText: string): Promise<string> => {
    let list: unknown[] = [];
    try {
      const parsed = JSON.parse(argumentsText || '{}') as { fields?: unknown };
      list = Array.isArray(parsed.fields) ? parsed.fields : [];
    } catch {
      return '参数不是合法 JSON；请重发完整的 fields 数组。';
    }
    const actions: ConfigAction[] = [];
    const rejected: string[] = [];
    /*
     * 逐条分态：值相同（已就位，成功语义）/ 不生效（形态条件不满足，
     * 本批没带切换字段）/ 不在可写面 / 只读。多类结局压成一句「没有可
     * 应用的修改」会让模型只能瞎猜（出过：表单停在 sft 而奖励通道字段
     * 被误判为「改不了」，模型只能让用户先手动点卡再分批补配）。
     */
    const already: string[] = [];
    const inactive: string[] = [];
    const notWritable: string[] = [];
    const readOnly: string[] = [];
    /*
     * 虚拟形态 = 表单现值被本批提议覆盖后的样子：校验按「本批应用后」
     * 的形态评估生效性——模型同批切 task_type/rl_type 再配算法专有字段
     * 一次通过；只配专有字段而不带切换时会被点名拒绝，防止值落进表单
     * 却永远不进命令（死参数静默失效）。
     */
    const form: Record<string, string> = {};
    for (const f of fields ?? []) {
      if (f.value !== '') form[f.key] = f.value;
    }
    for (const item of list) {
      const k = String((item as Record<string, unknown>).key ?? '');
      if (k) form[k] = String((item as Record<string, unknown>).value ?? '');
    }
    for (const item of list) {
      const key = String((item as Record<string, unknown>).key ?? '');
      const to = String((item as Record<string, unknown>).value ?? '');
      const f = (fields ?? []).find((x) => x.key === key);
      if (!f) {
        notWritable.push(key);
        continue;
      }
      if (f.active && !f.active(form)) {
        const formDesc = ['task_type', 'rl_type', 'tuner', 'mode']
          .filter((k) => form[k])
          .map((k) => `${k}=${form[k]}`)
          .join('、');
        inactive.push(`${key}（需${f.scopeNote ?? '特定表单形态'}；本批应用后：${formDesc || '（空）'}）`);
        continue;
      }
      if (f.options && !f.options.includes(to)) {
        rejected.push(`${key}: "${to}" 不在合法值（${f.options.join(' / ')}）`);
        continue;
      }
      if (!f.apply) {
        readOnly.push(key);
        continue;
      }
      if (f.value === to) already.push(`${key}=${to}`);
      else actions.push({ key, to });
    }
    /*
     * 表单形态（本批提议应用后）：模型看不见页面 state，不带的话它只在
     * 撞墙时才能发现表单还停在别的类型。
     */
    const formMode = ['task_type', 'rl_type', 'tuner', 'mode']
      .map((k) => (form[k] ? `${k}=${form[k]}` : ''))
      .filter(Boolean)
      .join('、');
    const notes: string[] = [];
    if (inactive.length) {
      notes.push(
        `以下字段在当前/本批形态下不生效（值不会进命令）：${inactive.join('；')}。把条件字段（task_type/rl_type/tuner/mode）与它们放进同一批提议即可一次生效。`,
      );
    }
    if (notWritable.length) notes.push(`以下字段不在可写面（本页没有这个字段）：${notWritable.join('、')}。`);
    if (readOnly.length) notes.push(`以下字段只读，不能通过本工具修改：${readOnly.join('、')}。`);
    if (already.length) notes.push(`以下字段已是目标值，无需修改：${already.join('、')}。`);
    if (formMode) notes.push(`表单形态（本批提议应用后）：${formMode}。`);
    if (!actions.length && !notWritable.length && !readOnly.length && !already.length && !rejected.length && !inactive.length) {
      notes.push('提议清单为空，没有任何字段。');
    }
    if (rejected.length) notes.push(`以下提议被拒绝（不在字段合法值域）：${rejected.join('；')}。请改用正确的字段与值。`);
    if (actions.length) {
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
      notes.push(
        `已列出 ${actions.length} 条修改卡片（${actions.map((a) => `${a.key}=${a.to}`).join('、')}）。` +
          '用户可逐条点「应用」写入表单；用户批准 submit_form 提交时未决卡片会自动应用。',
      );
    }
    return notes.join(' ');
  };

  /*
   * submit_form 的页面执行体：引擎审批已过（用户显式批准「按这套配置提交」，
   * 等于认可这批提议），这里先把未决卡片写进表单再触发提交——否则用户
   * 口头说「可以」而没逐条点「应用」时，提交上去的是空表单。
   *
   * 自动应用的值必须真正参与本次提交：apply 是同步连续 setState，React 要
   * 到下个宏任务才 flush 重渲染——紧接着同步调 onSubmit 的话，submit 闭包
   * 读到的还是 apply 前的旧 state（旧卡数/旧放置），页面校验用旧值通过、
   * 提交命令却是新组合（出过：4 卡 + disaggregated 实需 5 卡，校验未拦、
   * CLI 侧 Ray 资源断言才炸）。故 apply 后等一帧让 React flush，再经
   * onSubmitRef 拿最新闭包（SSE 回调里的 onSubmit prop 也是过期闭包，与
   * messagesRef 同问题同模式）。
   */
  const triggerSubmit = async (): Promise<string> => {
    if (!onSubmit) return '本页没有接提交动作，请用户在页面上点启动。';
    let applied = 0;
    for (const m of messagesRef.current) {
      if (!m.actions?.length) continue;
      m.actions.forEach((a, i) => {
        if (m.states?.[i] !== 'pending') return;
        const target = (fields ?? []).find((f) => f.key === a.key);
        if (target?.apply) {
          target.apply(a.to);
          applied++;
        }
      });
    }
    if (applied) {
      setMessages((ms) =>
        ms.map((m) =>
          m.actions?.length
            ? {
                ...m,
                states: m.actions.map((a, i) => {
                  if ((m.states?.[i] ?? 'pending') !== 'pending') return m.states?.[i] ?? 'pending';
                  const target = (fields ?? []).find((f) => f.key === a.key);
                  return target?.apply ? ('applied' as const) : 'pending';
                }),
              }
            : m,
        ),
      );
      /* 等 React flush 重渲染（微任务级批处理在宏任务前完成），提交闭包才能读到新值 */
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    try {
      const outcome = await Promise.resolve(onSubmitRef.current?.());
      /*
       * 提交结果回喂真实事实：失败原因（页面校验拦截或创建报错）交给模型，
       * 它能据此补齐配置重提（如 GRPO 缺奖励通道时自己加 orm 再提交），
       * 而不是拿「已触发提交」当成功、任务却没建出来。
       */
      if (typeof outcome === 'string' && outcome) {
        return `提交失败：${outcome}。请修正后重试。`;
      }
      return applied
        ? `已先自动应用 ${applied} 条待确认的修改；任务已创建并跳转任务列表。`
        : '已提交；任务已创建并跳转任务列表。';
    } catch (e) {
      return `提交失败: ${String(e)}`;
    }
  };
  
  /*
   * 配置页随回合提交的页面工具定义（schema 携带，执行体经 page-tool 事件
   * 走 runPageTool）：set_form_fields 出卡、submit_form 带审批元数据（引擎
   * 先挂起审批，批准才上抛页面段）。search_models 是注册表工具，不在此列。
   */
  const pageToolSpecs = useMemo<PageToolSpec[]>(
    () => {
      const specs: PageToolSpec[] = [];
      if (fields) {
        specs.push({
          name: 'set_form_fields',
          description: `批量修改${label}表单字段。每条修改会以卡片列出，用户逐条点「应用」才落表单。可写字段（恒全集，不随表单当前形态裁剪）：${
            fields
              .map((f) => f.key + (f.options ? `（${f.options.join(' / ')}）` : '') + (f.scopeNote ? `［需${f.scopeNote}］` : ''))
              .join(', ') || '（无）'
          }。带生效条件的字段（［…］标注者）把条件字段与本字段放进同一批提议即可一次生效——同批切 task_type=rl 并配 orm/num_generations 等专有字段是常规操作，不需要分两轮`,
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
                    value: { type: 'string', description: '目标值（一律字符串；枚举字段只接受其合法值）' },
                  },
                  required: ['key', 'value'],
                },
              },
            },
            required: ['fields'],
          },
        });
      }
      if (onSubmit) {
        specs.push({
          name: 'submit_form',
          description: `按当前表单内容提交创建${label}任务（等价于用户点启动按钮）。属于重操作，执行前需用户审批`,
          parameters: { type: 'object', properties: {} },
          approval: { title: t('assistant.approveSubmitTitle', { label }), reason: t('assistant.approveSubmitDesc') },
        });
      }
      return specs;
    },
    [label, fields, onSubmit, t],
  );

  const system = useMemo(
    () =>
      fields
        ? `你是新建${label}页面的配置助手。回答字段怎么填、给起手值；要改表单用 set_form_fields（修改以卡片列出、用户逐条确认）；用户确认后可用 submit_form 提交（需审批）。工具拿不到的字段值就以用户的话为准，别猜。用户提到的模型名是简称或口语（如 "qwen3.5-4b"）时，先用 search_models 解析出真实 hub id 再写 model 字段；查不到就向用户确认，不要把原话直接当 id。改枚举字段只能用其合法值（工具描述里列了）。可写字段清单是恒全集、不随表单当前形态变化：带生效条件的字段（如 RL 专有参数需 task_type=rl、奖励通道需在线族）在提议时把条件字段（task_type/rl_type/mode/tuner）与本字段放进同一批，一次生效——不要让用户先手动切类型再分批补配。在线 RL（grpo/ppo/rft）提交前必须先配 orm 奖励通道（至少一条，如 orm=accuracy format），否则提交会被拒绝。简单问题直接答，不要为了严谨去翻文档或源码。`
        : `你是${label}模块页面的助手。可以 list_tasks 查看任务、stop_task / delete_task 停止或删除（需用户审批）、rename_task 重命名。操作前先核对任务 id。`,
    [label, fields],
  );

  const handleAction = (msgId: string, index: number, next: 'applied' | 'ignored') => {
    const action = messages.find((m) => m.id === msgId)?.actions?.[index];
    const target = action ? fields?.find((f) => f.key === action.key) : undefined;
    /* 回写走字段自带的 setter；字段已消失或只读时不能假装成功——按未应用处理 */
    if (next === 'applied' && action && target?.apply) {
      target.apply(action.to);
    }
    const settled = next === 'applied' && !target?.apply ? 'ignored' : next;
    setMessages((ms) =>
      ms.map((m) =>
        m.id === msgId ? { ...m, states: m.states?.map((s, i) => (i === index ? settled : s)) } : m,
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
    const images = [...attachments];
    setAttachments([]);
    setMessages((ms) => [
      ...ms,
      userMessage(text),
      ...(images.length ? [{ id: messageId(), role: 'user' as const, text: '', images }] : []),
    ]);
    /*
     * 提交回合（两种形态同一入口）：执行体在 server（压缩历史、模型流、
     * 工具循环、落盘全在引擎），增量经下方 SSE 订阅进视图；新会话把标题
     * 一并交给引擎建档（server 侧 chats 注册表与本机同步）。配置页随回合
     * 携带 pageTools（执行体在页面）并注入 skills 索引与工作台指引；任务页
     * 工具面沿用 toolNames 注册表键名。SSE 的 user 事件带同一条消息回来，
     * 尾部去重见订阅 effect。
     */
    setStreaming(true);
    const r = await submitTurn(conv, {
      text,
      models: [model],
      ...(images.length ? { images } : {}),
      system: fields
        ? [system, CONFIG_ASSISTANT_GUIDE, ...(skillsSystem ? [skillsSystem] : [])]
        : [system],
      /* 配置页不挂 read_swift_source：填表用不上源码仲裁，挂了反而诱发翻源码的漫长回合 */
      tools: fields
        ? ['read_skill', 'search_models', 'env_info', ...(toolNames ?? [])]
        : (toolNames ?? []),
      ...(pageToolSpecs.length ? { pageTools: pageToolSpecs } : {}),
      ...(isNew ? { title } : {}),
    });
    if ('error' in r) {
      setStreaming(false);
      setMessages((ms) => [...ms, { id: messageId(), role: 'assistant', text: t('chat.errSubmit') }]);
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

  /*
   * 审批时未决的表单提议（key=to）：批准提交决定的就是这批值，必须在卡
   * 附近可见；全应用完（无 pending）则不渲染清单。
   */
  const pendingConfig = messages.flatMap((m) =>
    (m.actions ?? []).map((a, i) => ({ a, state: m.states?.[i] ?? 'pending' })),
  ).filter((x) => x.state === 'pending');

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
          模型与会话两枚下拉 + 多模态附件入口：模型决定回答来源与 turns 分桶；会话默认新开，
          可选首页任一会话续聊（历史随对话发送，写回同一分桶）。回形针选图（压缩到
          多模态有效分辨率）随回合提交——选文件必须由用户手势触发，input 用完重置
          否则同一张图二次选择不触发 onChange。
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
          <label
            className="border-border/60 text-muted-foreground hover:bg-secondary flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border"
            title={t('assistant.attachImage')}
          >
            <Paperclip className="size-3.5" />
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                void Promise.all(files.map((f) => normalizeImage(f, t).catch(() => null))).then((urls) => {
                  setAttachments((prev) => [...prev, ...urls.filter((u): u is string => u !== null)]);
                });
              }}
            />
          </label>
        </div>
        
        {/* 已选附件缩略图：可逐个移除；坏图静默丢弃（上传入口已 catch） */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 py-2">
            {attachments.map((src, i) => (
              <span key={i} className="relative">
                <img src={src} alt="" className="border-border size-14 rounded-lg border object-cover" />
                <button
                  type="button"
                  className="bg-destructive absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full text-white"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/*
         * 审批卡走 AiChatPanel 的 trailing 插槽：跟在最新消息后面、输入框
         * 上方，随对话滚动（盖在消息区顶部会遮挡对话）；卡下附「将应用的
         * 配置」清单——只写「提交表单」不列值，用户无从判断批不批。
         */}
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
          trailing={
            engineApprovals.length ? (
              <div className="flex flex-col gap-2">
                {engineApprovals.map((a) => (
                  <EngineApprovalCard
                    key={a.id}
                    approval={a}
                    checked={engineAlways[a.id] === true}
                    onCheck={(v) => setEngineAlways((prev) => ({ ...prev, [a.id]: v }))}
                    onResolve={resolveEngineApproval}
                  />
                ))}
                {pendingConfig.length > 0 && (
                  <div className="border-border/60 bg-muted/40 mx-3 mb-3 rounded-xl border p-3">
                    <div className="text-muted-foreground text-xs font-medium">
                      {t('assistant.applyListTitle')}
                    </div>
                    <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-xs">
                      {pendingConfig.map(({ a }, i) => (
                        <div key={`${a.key}-${i}`} className="whitespace-pre-wrap break-all">
                          <span className="text-muted-foreground">{a.key}</span>
                          <span className="text-foreground"> = {a.to}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : undefined
          }
        />
      </SheetContent>
    </Sheet>
  );
}
