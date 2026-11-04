/**
 * server 侧回合引擎（单写者架构）：对话回合的执行体——读桶、压缩历史、
 * 组装上下文、跑 agent 循环、落盘——全部在本模块，是 convs.json 的 turns
 * 桶唯一写入方。浏览器只做两件事：POST 提交回合、SSE 订阅观看增量；关闭
 * 或刷新页面只是不看了，回合照跑到底。
 *
 * 回合的两个入口形态：
 * - 页面回合（submitTurn）：页面组装好 system 块与工具名清单提交；
 * - 唤醒回合（runWakeupTurn）：研究/脚本事件的合成消息（原 headless 驱动
 *   器的组装逻辑），事件由 vite 侧 tick 消费后调这里。
 *
 * agent 层（runAgentLoop + 工具集）是浏览器/node 共享的前端源码模块——
 * 工具执行体经 apiBase() 自调用本机 HTTP，与浏览器完全同一执行面。审批
 * 沿用落盘审批面（approvals.json 的白名单与 pending，浏览器审批卡共用）。
 *
 * 实例代数：vite 热重启会在同进程内重跑 configureServer——新实例创建时
 * 旧实例正在跑的回合（async 循环）不会停，换代后在每个 await 边界发现
 * epoch 落后即自行终止，避免新旧两个回合并发写同一个 turns 桶。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '../src/agent/tools';
import type { ChatMessage, ToolCall } from '../src/api/models';
import { runAgentLoop } from '../src/agent/runAgentLoop';
import { compressHistory, setSummaryStorage, type SummaryStorage } from '../src/agent/history';
import {
  WORKBENCH_GUIDE,
  envInfoTool,
  listCatalogTool,
  readSkillDocTool,
  readSwiftSourceTool,
  workspaceTools,
} from '../src/agent/builtin';
import { webSearchTool } from '../src/agent/builtin';
import { AUTORESEARCH_GUIDE, researchTools } from '../src/agent/researchTools';
import { HOME_SYSTEM, homeTools, moduleTaskTools } from '../src/agent/taskTools';
import { listSkills, buildSkillsSystem } from '../src/api/skills';

/** vite.config.ts 注入的执行面依赖（避免本模块反向 import 配置文件） */
export interface TurnEngineDeps {
  /**
   * convs.json 的 turns 桶读（无桶时空数组）。文件读坏返回 null：调用方必须
   * 显式放弃/失败——把它当空库跑回合或落盘会把整库替换成单回合的桶。
   */
  readTurns(conv: string, model: string): ChatMessage[] | null;
  /** turns 桶追加一条并落盘（读-改-写全量；本引擎是唯一调用方） */
  appendTurn(conv: string, model: string, msg: ChatMessage): void;
  /** 会话元数据建档/上浮（convs.json 的 chats；新建回合带标题时调用） */
  upsertChat(conv: string, title?: string): void;
  /** 模型可用性：models.json 里的自定义远端（baseUrl + apiKey 齐备才无头跑） */
  loadModel(modelId: string): { baseUrl?: string; apiKey?: string } | undefined;
  /** 机器侧全局偏好里的对话采样默认（webui-settings.json 的 chatDefaults） */
  chatDefaults(): { temperature?: number; topP?: number; maxTokens?: number };
  /** workspace/EXPERIMENTS.md 头部（教训常驻注入；无文件空串） */
  readExperimentsHead(): string;
  /** 摘要落盘文件路径（node 侧 SummaryStorage 后端用） */
  summariesFile(): string;
  /** 审批落盘目录（~/.swift/webui） */
  dataDir(): string;
}

/** 页面提交的回合材料：system 块与工具名清单由页面按胶囊状态组装 */
export interface TurnSubmit {
  text: string;
  models: string[];
  images?: string[];
  /** 页面组装好的 system 块（persona/研究指引/联网说明等，按序注入） */
  system: string[];
  /** 工具注册表键名清单（buildTools 支持的名字） */
  tools: string[];
  /** 新会话建档标题（已有会话不传） */
  title?: string;
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
  /** 展览模式的会话 token（MS 默认模型；models.json 无 key 时必带） */
  apiKey?: string;
}

/** SSE 推送的回合增量（页面订阅渲染的唯一事件面） */
export interface TurnEvent {
  type: 'turn-start' | 'user' | 'assistant-start' | 'delta' | 'assistant' | 'tool' | 'error' | 'turn-done';
  conv: string;
  model: string;
  /** delta：本次增量片段 */
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  /** assistant/tool/error：刚落盘的完整消息（页面直接替换尾部） */
  message?: ChatMessage;
  error?: string;
}

export interface TurnApproval {
  id: string;
  conv: string;
  model: string;
  title: string;
  reason: string;
  command?: string;
  createdAt: string;
}

export interface TurnEngineHandle {
  /** 页面提交回合：任一列在跑即整批拒绝（页面按钮本就有流式守卫） */
  submitTurn(conv: string, req: TurnSubmit): { turnId: string } | { error: string };
  /** 唤醒回合（研究/脚本事件的合成消息；组装沿用 headless 时代的块） */
  runWakeupTurn(conv: string, model: string, text: string): void;
  /** SSE 订阅：返回退订函数 */
  subscribe(conv: string, fn: (ev: TurnEvent) => void): () => void;
  /** 该列在跑（含审批挂起）即 true：提交拒绝与页面按钮态共用 */
  busy(conv: string, model: string): boolean;
  /** 该会话任一列在跑：stall 哨兵的在飞判定用 */
  busyConv(conv: string): boolean;
  /** 该会话在跑的列名（SSE 重连同步用：页面刷新后恢复按钮态） */
  busyModels(conv: string): string[];
  /** 页面停止按钮：中止该列页面提交的回合（唤醒回合不受页面控制） */
  abortTurn(conv: string, model: string): void;
  /**
   * 会话删除：中止该会话全部在跑回合，并屏蔽后续落盘——abort 是异步生效，
   * 回合在下一个 await 边界仍可能 flush 尾部消息，不屏蔽会把已删桶重建出来。
   */
  retire(conv: string): void;
  listPendingApprovals(conv: string): TurnApproval[];
  /** 共用白名单（浏览器会话加载时灌进本地允许集，引擎与页面一致放行） */
  listAllowedCommands(): string[];
  /** 浏览器侧决定；approve 且勾了总是允许时把审批自带的命令收进白名单。未知 id 返回 false */
  resolveApproval(id: string, approve: boolean, alwaysAllow?: boolean): boolean;
  /** 浏览器「总是允许」同步白名单（页面侧审批通过时调用） */
  addAllowedCommand(command: string): void;
}

interface ApprovalsFile {
  /** 免审命令白名单（shell 命令名等；浏览器与引擎共用一份） */
  allowed: string[];
  pending: TurnApproval[];
}

/*
 * 工具注册表：页面按名字要工具（工具构建需要 conv/model 等执行面参数）。
 * 'task:<module>' 形态覆盖各业务页助手用的模块任务工具。
 */
function buildTools(names: string[], conv: string, model: string, userRequest: string): AgentTool[] {
  const out: AgentTool[] = [];
  for (const name of names) {
    if (name === 'read_skill') out.push(readSkillDocTool());
    else if (name === 'list_catalog') out.push(listCatalogTool());
    else if (name === 'env_info') out.push(envInfoTool());
    else if (name === 'read_swift_source') out.push(readSwiftSourceTool());
    else if (name === 'workspace') out.push(...workspaceTools(conv, model));
    else if (name === 'research') out.push(...researchTools(conv, model));
    else if (name === 'web') out.push(webSearchTool());
    else if (name === 'home') out.push(...homeTools({ userRequest, conv, model }));
    else if (name.startsWith('task:')) out.push(...moduleTaskTools(name.slice(5) as 'train' | 'eval' | 'export' | 'deploy' | 'script'));
  }
  return out;
}

let currentEpoch = 0;

export function createTurnEngine(deps: TurnEngineDeps): TurnEngineHandle {
  const epoch = ++currentEpoch;
  const isCurrent = (): boolean => epoch === currentEpoch;
  /* 摘要存储换 node 后端（文件全表读写，与 localStorage 同语义） */
  setSummaryStorage({
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(deps.summariesFile(), 'utf-8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    },
    save: (all) => {
      try {
        const dir = deps.dataDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${deps.summariesFile()}.tmp`;
        writeFileSync(tmp, JSON.stringify(all));
        renameSync(tmp, deps.summariesFile());
      } catch {
        /* 写失败与浏览器超配额同语义：下次重新摘 */
      }
    },
  } satisfies SummaryStorage);

  /** 已删除会话：屏蔽其一切后续落盘（见 retire） */
  const retired = new Set<string>();
  /** appendTurn 的删除屏蔽版（本引擎全程经此落盘） */
  const appendTurn: TurnEngineDeps['appendTurn'] = (conv, model, msg) => {
    if (retired.has(conv)) return;
    deps.appendTurn(conv, model, msg);
  };
  /** 回合锁：conv\u0000model → turnId（在跑即占用，含审批挂起） */
  const running = new Map<string, string>();
  /** 页面回合的中止通道（唤醒回合不受页面控制，不入此表） */
  const aborters = new Map<string, AbortController>();
  /** SSE 订阅者：conv → 监听集合 */
  const listeners = new Map<string, Set<(ev: TurnEvent) => void>>();
  let approvals: ApprovalsFile = { allowed: [], pending: [] };

  const approvalsFile = () => join(deps.dataDir(), 'approvals.json');
  const saveApprovals = (): void => {
    try {
      const dir = deps.dataDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${approvalsFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify(approvals));
      renameSync(tmp, approvalsFile());
    } catch {
      /* 落盘失败：白名单退化为本次进程内有效 */
    }
  };
  /* 启动恢复：白名单与在途审批跨重启续用（换代前的回合已终止，pending 由用户清） */
  try {
    const a = JSON.parse(readFileSync(approvalsFile(), 'utf-8')) as ApprovalsFile;
    if (a && typeof a === 'object') {
      approvals = { allowed: Array.isArray(a.allowed) ? a.allowed : [], pending: Array.isArray(a.pending) ? a.pending : [] };
    }
  } catch {
    /* 无文件 */
  }

  const broadcast = (ev: TurnEvent): void => {
    const set = listeners.get(ev.conv);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch {
        /* 订阅者异常不拖垮回合 */
      }
    }
  };

  /*
   * 引擎版 requestApproval：白名单命中放行；未命中挂起回合（落盘 pending，
   * 1s 轮询等浏览器决定——挂起语义，无超时）。同会话旧 pending 未决时新请求
   * 顶掉旧的（一张卡原则，与页面 useApproval 的「前一个未决自动拒绝」同构）。
   */
  const requestApproval = (conv: string, model: string) => (title: string, reason: string, command?: string) =>
    new Promise<boolean>((resolve) => {
      if (command && approvals.allowed.includes(command)) {
        resolve(true);
        return;
      }
      approvals.pending = approvals.pending.filter((p) => p.conv !== conv);
      const req: TurnApproval = {
        id: randomUUID(),
        conv,
        model,
        title,
        reason,
        ...(command ? { command } : {}),
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      };
      approvals.pending.push(req);
      saveApprovals();
      console.log(`[turn] 审批挂起（${conv}）：${title}`);
      const poll = setInterval(() => {
        /* 换代（vite 热重启）：pending 已归新实例的内存，本实例等不到决定——按拒绝结算让回合走完 */
        if (!isCurrent()) {
          clearInterval(poll);
          resolve(false);
          return;
        }
        const cur = approvals.pending.find((p) => p.id === req.id);
        if (cur === undefined) {
          clearInterval(poll);
          const decision = resolvedDecisions.get(req.id) ?? false;
          resolvedDecisions.delete(req.id);
          resolve(decision);
        }
      }, 1000);
    });
  /* 决定不落盘（决定即消费）：轮询发现 pending 消失时从这里取结果并清理 */
  const resolvedDecisions = new Map<string, boolean>();

  /*
   * 回合核心：两入口（页面提交 / 事件唤醒）只在「组装材料」上不同，执行与
   * 落盘同一条流。消息落盘策略与渲染解耦——增量在引擎内存聚合，完整消息
   * （含 toolCalls）一次性 append：OpenAI 协议要求 role:'tool' 紧跟带
   * tool_calls 的 assistant，缺失会让下一回合的历史里 tool 结果悬空。
   */
  const runTurnCore = async (
    conv: string,
    model: string,
    opts: {
      userMsg: ChatMessage;
      system: ChatMessage[];
      tools: AgentTool[];
      label: string;
      /** 页面回合带页面旋钮；唤醒回合用机器侧默认 */
      sampling?: { temperature?: number; topP?: number; maxTokens?: number };
      /** 页面提交的回合可被停止按钮中止；唤醒回合不受页面控制 */
      abortable?: AbortController;
      /** 页面带来的会话 token（MS 默认模型；models.json 无 key 时必带） */
      apiKey?: string;
    },
  ): Promise<void> => {
    const key = `${conv}\u0000${model}`;
    running.set(key, randomUUID());
    if (opts.abortable) aborters.set(key, opts.abortable);
    try {
      broadcast({ type: 'turn-start', conv, model });
      const bucket = deps.readTurns(conv, model);
      if (bucket === null) {
        /* convs.json 读坏：放弃本回合（不落盘，事件靠下一次 stall 唤醒补） */
        console.log(`[turn] ${conv} turns 读失败，放弃本回合`);
        broadcast({ type: 'turn-done', conv, model, error: 'turns unreadable' });
        return;
      }
      const dialogue = [...bucket, opts.userMsg];
      const compressed = await compressHistory({ convId: conv, modelId: model, dialogue });
      if (!isCurrent()) return;
      const history: ChatMessage[] = [...opts.system, ...compressed];
      appendTurn(conv, model, opts.userMsg);
      /* 唤醒回合的合成 user 消息实时进在线页面的视图（页面回合本地已 append，SSE 侧去重） */
      broadcast({ type: 'user', conv, model, message: opts.userMsg });
      let acc = '';
      let accReasoning = '';
      let accToolCalls: ToolCall[] = [];
      let pendingNotice = '';
      const flushAssistant = (): void => {
        if (!acc && !accReasoning && !accToolCalls.length) return;
        const msg: ChatMessage = {
          role: 'assistant',
          content: acc + (pendingNotice ? `\n\n${pendingNotice}` : ''),
          ...(accReasoning ? { reasoning: accReasoning } : {}),
          ...(accToolCalls.length ? { toolCalls: accToolCalls } : {}),
        };
        appendTurn(conv, model, msg);
        broadcast({ type: 'assistant', conv, model, message: msg });
        acc = '';
        accReasoning = '';
        accToolCalls = [];
        pendingNotice = '';
      };
      await runAgentLoop({
        model,
        history,
        tools: opts.tools,
        ctx: { requestApproval: requestApproval(conv, model), allowedCommands: new Set(approvals.allowed) },
        sampling: opts.sampling ?? deps.chatDefaults(),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.abortable ? { signal: opts.abortable.signal } : {}),
        events: {
          onAssistantStart: () => broadcast({ type: 'assistant-start', conv, model }),
          onDelta: (parts) => {
            acc += parts.content;
            accReasoning += parts.reasoning;
            if (parts.toolCalls?.length) accToolCalls = [...accToolCalls, ...parts.toolCalls];
            broadcast({
              type: 'delta',
              conv,
              model,
              ...(parts.content ? { content: parts.content } : {}),
              ...(parts.reasoning ? { reasoning: parts.reasoning } : {}),
              ...(parts.toolCalls?.length ? { toolCalls: parts.toolCalls } : {}),
            });
          },
          onToolResult: (call, result) => {
            flushAssistant();
            const msg: ChatMessage = { role: 'tool', content: result, toolCallId: call.id };
            appendTurn(conv, model, msg);
            broadcast({ type: 'tool', conv, model, message: msg });
          },
          onError: (errorText) => {
            flushAssistant();
            const msg: ChatMessage = { role: 'assistant', content: errorText };
            appendTurn(conv, model, msg);
            broadcast({ type: 'error', conv, model, message: msg, error: errorText });
          },
          onNotice: (noticeText) => {
            /* 非致命提示（截断等）随下一条 assistant 落盘：没有内容时也留住 */
            if (noticeText) pendingNotice = pendingNotice ? `${pendingNotice}\n\n${noticeText}` : noticeText;
          },
        },
      });
      if (!isCurrent()) return; /* 换代：尾条消息仍落盘（上面已 append），锁由旧闭包自己清 */
      flushAssistant();
      console.log(`[turn] 回合完成 ${opts.label}（${conv}/${model}）`);
      broadcast({ type: 'turn-done', conv, model });
    } catch (e) {
      console.log(`[turn] 回合失败 ${opts.label}: ${String(e)}`);
      broadcast({ type: 'turn-done', conv, model, error: String(e) });
    } finally {
      running.delete(key);
      aborters.delete(key);
    }
  };

  return {
    submitTurn(conv, req) {
      for (const m of req.models) {
        if (running.has(`${conv}\u0000${m}`)) return { error: 'turn in flight' };
      }
      const turnId = randomUUID();
      if (req.title) deps.upsertChat(conv, req.title);
      for (const m of req.models) {
        const abortable = new AbortController();
        void runTurnCore(conv, m, {
          userMsg: { role: 'user', content: req.text, ...(req.images?.length ? { images: req.images } : {}) },
          system: req.system.map((content) => ({ role: 'system' as const, content })),
          tools: buildTools(req.tools, conv, m, req.text),
          label: 'page',
          sampling: req.sampling,
          abortable,
          ...(req.apiKey ? { apiKey: req.apiKey } : {}),
        });
      }
      return { turnId };
    },
    runWakeupTurn(conv, model, text) {
      if (running.has(`${conv}\u0000${model}`)) return;
      /*
       * 唤醒回合的组装（与 headless 时代同一套 system 块）：研究指引 + 教训
       * 文件 + 任务/行动指引 + 技能文档。工具集 = 研究会话的全套（workspace +
       * research + home + 常驻查询件）。
       */
      void (async () => {
        const experimentsHead = deps.readExperimentsHead();
        const lessonsSystem = experimentsHead
          ? `## 过往实验与踩坑记录（workspace/EXPERIMENTS.md 头部，最新在前；更早的条目用 read_file 读全文件）\n${experimentsHead}`
          : '';
        let skillsSystem = '';
        try {
          skillsSystem = buildSkillsSystem(await listSkills());
        } catch {
          /* 技能面不可达：不注入，工具仍可 read_skill */
        }
        if (!isCurrent()) return;
        await runTurnCore(conv, model, {
          userMsg: { role: 'user', content: text },
          system: [
            { role: 'system', content: AUTORESEARCH_GUIDE },
            ...(lessonsSystem ? [{ role: 'system' as const, content: lessonsSystem }] : []),
            { role: 'system', content: HOME_SYSTEM },
            { role: 'system', content: WORKBENCH_GUIDE },
            ...(skillsSystem ? [{ role: 'system' as const, content: skillsSystem }] : []),
          ],
          tools: buildTools(['read_skill', 'list_catalog', 'env_info', 'read_swift_source', 'workspace', 'research', 'home'], conv, model, text),
          label: 'wakeup',
        });
      })();
    },
    subscribe(conv, fn) {
      const set = listeners.get(conv) ?? new Set();
      set.add(fn);
      listeners.set(conv, set);
      return () => {
        set.delete(fn);
        if (!set.size) listeners.delete(conv);
      };
    },
    busy(conv, model) {
      return running.has(`${conv}\u0000${model}`);
    },
    busyConv(conv) {
      for (const key of running.keys()) if (key.startsWith(`${conv}\u0000`)) return true;
      return false;
    },
    busyModels(conv) {
      const out: string[] = [];
      for (const key of running.keys()) {
        if (key.startsWith(`${conv}\u0000`)) out.push(key.slice(conv.length + 1));
      }
      return out;
    },
    abortTurn(conv, model) {
      aborters.get(`${conv}\u0000${model}`)?.abort();
    },
    retire(conv) {
      retired.add(conv);
      for (const model of this.busyModels(conv)) this.abortTurn(conv, model);
    },
    listPendingApprovals(conv) {
      return approvals.pending.filter((p) => p.conv === conv);
    },
    listAllowedCommands() {
      return [...approvals.allowed];
    },
    resolveApproval(id, approve, alwaysAllow) {
      const idx = approvals.pending.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      const [req] = approvals.pending.splice(idx, 1);
      resolvedDecisions.set(id, approve);
      if (approve && alwaysAllow && req.command) {
        if (!approvals.allowed.includes(req.command)) approvals.allowed.push(req.command);
      }
      saveApprovals();
      return true;
    },
    addAllowedCommand(command) {
      if (!approvals.allowed.includes(command)) {
        approvals.allowed.push(command);
        saveApprovals();
      }
    },
  };
}
