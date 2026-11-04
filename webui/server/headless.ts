/**
 * server 侧 headless 研究驱动器：浏览器关闭后由本模块接管 autoresearch 的
 * 「事件 → 模型续轮」半环（任务执行层本来就在 server，无需接管）。
 *
 * 让位协议：对话页的 2s 双泵请求即心跳，超 10s 无心跳判定离线；headless
 * 只在「有积压事件 + 离线 + 无锁」时启动回合，浏览器心跳恢复即不再新起
 * 回合（在跑的回合跑完让位）。审批语义：白名单（approvals.json 的 allowed，
 * 与浏览器「总是允许」共用一份）命中直接放行；未命中则回合挂起等浏览器
 * 处理（pending 落盘，用户决定后恢复）。
 *
 * agent 层（runAgentLoop + 工具集）是浏览器/node 共享的前端源码模块——
 * 工具执行体经 apiBase() 自调用本机 HTTP，与浏览器完全同一执行面；模型
 * 调用打用户配置的绝对 baseUrl，node 侧原生可用。历史直接写 convs.json
 * 的 turns 桶（dirty 集合 + PUT 合并守卫防浏览器旧版本覆盖）。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ToolCall } from '../src/api/models';
import { runAgentLoop } from '../src/agent/runAgentLoop';
import { compressHistory, setSummaryStorage, type SummaryStorage } from '../src/agent/history';
import { composeWakeupMessage, composeScriptWakeupMessage } from '../src/agent/wakeup';
import {
  WORKBENCH_GUIDE,
  envInfoTool,
  listCatalogTool,
  readSkillDocTool,
  readSwiftSourceTool,
  workspaceTools,
} from '../src/agent/builtin';
import { AUTORESEARCH_GUIDE, researchTools } from '../src/agent/researchTools';
import { HOME_SYSTEM, homeTools } from '../src/agent/taskTools';
import { listSkills, buildSkillsSystem } from '../src/api/skills';
import type { ResearchSession } from '../src/api/research';

/** vite.config.ts 注入的执行面依赖（避免本模块反向 import 配置文件） */
export interface HeadlessDeps {
  loadResearch(): ResearchSession[];
  /** 取走研究会话积压事件（consume=1 同款语义：取走即删） */
  consumeResearchEvents(id: string): Promise<ResearchSession['events']>;
  /** 取走该对话的积压脚本事件 */
  consumeConvEvents(conv: string): { text: string; modelId?: string }[];
  /**
   * convs.json 的 turns 桶读（无桶时空数组）。文件读坏返回 null：调用方必须
   * 显式放弃/失败——把它当空库跑回合或落盘会把整库替换成单回合的桶。
   */
  readTurns(conv: string, model: string): ChatMessage[] | null;
  /** turns 桶追加一条并落盘（读-改-写全量） */
  appendTurn(conv: string, model: string, msg: ChatMessage): void;
  /** 模型可用性：models.json 里的自定义远端（baseUrl + apiKey 齐备才 headless） */
  loadModel(modelId: string): { baseUrl?: string; apiKey?: string } | undefined;
  /** 机器侧全局偏好里的对话采样默认（webui-settings.json 的 chatDefaults） */
  chatDefaults(): { temperature?: number; topP?: number; maxTokens?: number };
  /** workspace/EXPERIMENTS.md 头部（教训常驻注入；无文件空串） */
  readExperimentsHead(): string;
  /** 摘要落盘文件路径（node 侧 SummaryStorage 后端用） */
  summariesFile(): string;
  /** 审批与 dirty 落盘目录（~/.swift/webui） */
  dataDir(): string;
}

export interface HeadlessApproval {
  id: string;
  conv: string;
  model: string;
  title: string;
  reason: string;
  command?: string;
  createdAt: string;
}

export interface HeadlessHandle {
  /** 对话页泵请求到达时刷新心跳（/api/research/:id 与 /api/conv-events 两处挂） */
  touchHeartbeat(conv: string): void;
  /** 5s 一拍：寻找可接管的会话 */
  headlessTick(): void;
  /** stall 哨兵的在飞判定用：headless 回合（含审批挂起）在跑即 true */
  headlessBusy(conv: string): boolean;
  /** 页面泵心跳在线判定（与让位判据同源）：中断回合恢复用 */
  isConvOnline(conv: string): boolean;
  listPendingApprovals(conv: string): HeadlessApproval[];
  /** 共用白名单（浏览器会话加载时灌进本地允许集，headless 与页面一致放行） */
  listAllowedCommands(): string[];
  /** 浏览器侧决定；approve 且勾了总是允许时把审批自带的命令收进白名单。未知 id 返回 false */
  resolveApproval(id: string, approve: boolean, alwaysAllow?: boolean): boolean;
  /** 浏览器「总是允许」同步白名单（页面侧审批通过时调用） */
  addAllowedCommand(command: string): void;
  /**
   * convs PUT 合并守卫：headless 写过且浏览器推来的桶更短时保住 server 版。
   * srvTurns/putChats 由调用方读一次传入（PUT 侧对坏文件直接拒写，这里拿到的
   * 一定是可读的 server 现状）；putChats 用于分辨「删除传播」与「浏览器侧桶
   * 丢失」——会话还在而桶没了按丢失处理（保住 server 桶），会话一并删了才
   * 跟随删除。
   */
  guardConvsPut(
    turns: Record<string, Record<string, unknown>>,
    srvTurns: Record<string, Record<string, unknown>>,
    putChats: unknown[],
  ): Record<string, Record<string, unknown>>;
}

interface ApprovalsFile {
  /** 免审命令白名单（shell 命令名等；浏览器与 headless 共用一份） */
  allowed: string[];
  pending: HeadlessApproval[];
}

/** 离线判定：超过该时长没有泵心跳即接管（泵是 2s 一拍，10s 容忍网络抖动） */
const OFFLINE_AFTER_MS = 10_000;
/** 恢复在线后 PUT 守卫继续保护的宽限：拉回 server 桶（fetch + 合并）留的时间 */
const ONLINE_GRACE_MS = 10_000;

/*
 * 实例代数：vite 改配置热重启会在同进程内重跑 configureServer——新实例创建时
 * 旧实例的 tick 定时器虽被 clear，但正在跑的回合（async 循环）不会停。换代后
 * 旧实例在每个 await 边界与流回调里发现 epoch 落后即自行终止，避免新旧两个
 * 回合并发写同一个 turns 桶。整进程重启（部署）无此问题——旧回合随进程消失。
 */
let currentEpoch = 0;

export function createHeadlessRunner(deps: HeadlessDeps): HeadlessHandle {
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

  const heartbeats = new Map<string, number>();
  /*
   * 心跳恢复时刻（conv → 离线后重新上线的时间）：PUT 守卫的放行宽限用。
   * 浏览器刚恢复在线的头 ONLINE_GRACE_MS 内仍在拉回 server 桶（fetch 在途），
   * 此时放行 PUT 会让旧 localStorage 盖掉 headless 轮次；宽限期后页面已稳定，
   * 浏览器才是主写入方。
   */
  const resumedAt = new Map<string, number>();
  /** headless 回合锁：conv → model（在跑即占用，含审批挂起） */
  const running = new Map<string, string>();
  /** headless 写过、浏览器尚未拉回的 turns 桶（conv\u0000model） */
  let dirty = new Set<string>();
  let approvals: ApprovalsFile = { allowed: [], pending: [] };

  const approvalsFile = () => join(deps.dataDir(), 'approvals.json');
  const dirtyFile = () => join(deps.dataDir(), 'headless-dirty.json');
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
  const saveDirty = (): void => {
    try {
      writeFileSync(dirtyFile(), JSON.stringify([...dirty]));
    } catch {
      /* 守卫失效可容忍：最坏是浏览器旧桶覆盖 headless 轮次 */
    }
  };
  /* 启动恢复：白名单/在途审批/脏桶跨重启续用 */
  try {
    const a = JSON.parse(readFileSync(approvalsFile(), 'utf-8')) as ApprovalsFile;
    if (a && typeof a === 'object') {
      approvals = { allowed: Array.isArray(a.allowed) ? a.allowed : [], pending: Array.isArray(a.pending) ? a.pending : [] };
    }
  } catch {
    /* 无文件 */
  }
  try {
    const d = JSON.parse(readFileSync(dirtyFile(), 'utf-8')) as unknown[];
    if (Array.isArray(d)) dirty = new Set(d.map(String));
  } catch {
    /* 无文件 */
  }

  const online = (conv: string): boolean => Date.now() - (heartbeats.get(conv) ?? 0) < OFFLINE_AFTER_MS;

  /*
   * headless 版 requestApproval：白名单命中放行；未命中挂起回合（落盘 pending，
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
      const req: HeadlessApproval = {
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
      console.log(`[headless] 审批挂起（${conv}）：${title}`);
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
   * headless 回合：消费事件 → 组装上下文（与 ChatPage 研究分支同一套 system
   * 块与工具集）→ runAgentLoop → 消息逐条落盘 turns 桶。
   */
  const runHeadlessTurn = async (session: ResearchSession): Promise<void> => {
    const conv = session.convId;
    const model = session.modelId;
    running.set(conv, model);
    try {
      const researchEvents = await deps.consumeResearchEvents(session.id);
      if (!isCurrent()) return; /* 换代（vite 热重启）：让新实例重整旗鼓 */
      const scriptEvents = deps.consumeConvEvents(conv);
      if (!researchEvents.length && !scriptEvents.length) return;
      const text = [
        ...(researchEvents.length ? [composeWakeupMessage(session, researchEvents)] : []),
        ...(scriptEvents.length ? [composeScriptWakeupMessage(scriptEvents)] : []),
      ].join('\n\n');
      console.log(`[headless] 接管 ${session.id}（${researchEvents.length} 研究事件 + ${scriptEvents.length} 脚本事件）`);

      /* system 块：研究指引 + 教训文件 + 任务/行动指引 + 技能文档（与页面 research 分支同构） */
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
      const bucket = deps.readTurns(conv, model);
      if (bucket === null) {
        /* convs.json 读坏：放弃本回合（事件已消费，靠下一次 stall 唤醒补） */
        console.log(`[headless] ${conv} turns 读失败，放弃本回合`);
        return;
      }
      const dialogue = [...bucket, { role: 'user' as const, content: text }];
      const compressed = await compressHistory({ convId: conv, modelId: model, dialogue });
      if (!isCurrent()) return;
      const history: ChatMessage[] = [
        { role: 'system', content: AUTORESEARCH_GUIDE },
        ...(lessonsSystem ? [{ role: 'system' as const, content: lessonsSystem }] : []),
        { role: 'system', content: HOME_SYSTEM },
        { role: 'system', content: WORKBENCH_GUIDE },
        ...(skillsSystem ? [{ role: 'system' as const, content: skillsSystem }] : []),
        ...compressed,
      ];
      /*
       * 消息流落盘：增量聚合成完整消息再 append（headless 无渲染，不需要逐 delta
       * 持久化）。toolCalls 必须随 assistant 消息一起落盘——OpenAI 协议要求
       * role:'tool' 消息紧跟在同一条带 tool_calls 的 assistant 之后，缺失会让
       * 下一回合组装的历史里 tool 结果悬空（远端 400 或行为异常）。
       */
      let acc = '';
      let accReasoning = '';
      let accToolCalls: ToolCall[] = [];
      let pendingNotice = '';
      const flushAssistant = (): void => {
        if (!acc && !accReasoning && !accToolCalls.length) return;
        deps.appendTurn(conv, model, {
          role: 'assistant',
          content: acc + (pendingNotice ? `\n\n${pendingNotice}` : ''),
          ...(accReasoning ? { reasoning: accReasoning } : {}),
          ...(accToolCalls.length ? { toolCalls: accToolCalls } : {}),
        });
        dirty.add(`${conv}\u0000${model}`);
        saveDirty();
        acc = '';
        accReasoning = '';
        accToolCalls = [];
        pendingNotice = '';
      };
      deps.appendTurn(conv, model, { role: 'user', content: text });
      dirty.add(`${conv}\u0000${model}`);
      saveDirty();

      const tools = [
        readSkillDocTool(),
        listCatalogTool(),
        envInfoTool(),
        readSwiftSourceTool(),
        ...workspaceTools(conv, model),
        ...researchTools(conv, model),
        ...homeTools({ userRequest: text, conv, model }),
      ];
      const sampling = deps.chatDefaults();
      await runAgentLoop({
        model,
        history,
        tools,
        ctx: { requestApproval: requestApproval(conv, model), allowedCommands: new Set(approvals.allowed) },
        sampling,
        events: {
          onAssistantStart: () => undefined,
          onDelta: (parts) => {
            acc += parts.content;
            accReasoning += parts.reasoning;
            if (parts.toolCalls?.length) accToolCalls = [...accToolCalls, ...parts.toolCalls];
          },
          onToolResult: (call, result) => {
            flushAssistant();
            deps.appendTurn(conv, model, { role: 'tool', content: result, toolCallId: call.id });
            dirty.add(`${conv}\u0000${model}`);
            saveDirty();
          },
          onError: (errorText) => {
            flushAssistant();
            deps.appendTurn(conv, model, { role: 'assistant', content: errorText });
            dirty.add(`${conv}\u0000${model}`);
            saveDirty();
          },
          onNotice: (noticeText) => {
            /* 非致命提示（截断等）随下一条 assistant 落盘：没有内容时也留住 */
            if (noticeText) pendingNotice = pendingNotice ? `${pendingNotice}\n\n${noticeText}` : noticeText;
          },
        },
      });
      if (!isCurrent()) return; /* 换代：尾条消息仍落盘（上面已 append），锁由旧闭包自己清 */
      flushAssistant();
      console.log(`[headless] 回合完成 ${session.id}（${session.status}）`);
    } catch (e) {
      console.log(`[headless] 回合失败 ${session.id}: ${String(e)}`);
    } finally {
      running.delete(conv);
    }
  };

  return {
    touchHeartbeat(conv) {
      const now = Date.now();
      /* 离线超过阈值后重新上线：记恢复时刻（PUT 守卫宽限计时起点） */
      if (now - (heartbeats.get(conv) ?? 0) >= OFFLINE_AFTER_MS) resumedAt.set(conv, now);
      heartbeats.set(conv, now);
    },
    headlessTick() {
      for (const session of deps.loadResearch()) {
        if (!session.convId || !session.modelId) continue;
        if (!session.events?.length) continue;
        if (online(session.convId)) continue; /* 浏览器在场：页面泵自己消费 */
        if (running.has(session.convId)) continue;
        const m = deps.loadModel(session.modelId);
        if (!m?.baseUrl || !m?.apiKey) continue; /* MS 登录 token 模型：事件留队等浏览器 */
        void runHeadlessTurn(session);
      }
    },
    headlessBusy(conv) {
      return running.has(conv);
    },
    /** 页面泵心跳在线判定（与 headlessTick 的让位判据同源）：中断回合恢复用 */
    isConvOnline(conv) {
      return online(conv);
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
    guardConvsPut(turns, srvTurns, putChats) {
      const chatAlive = (conv: string): boolean =>
        putChats.some((c) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === conv);
      for (const key of dirty) {
        const sp = key.indexOf('\u0000');
        const conv = key.slice(0, sp);
        const model = key.slice(sp + 1);
        /*
         * 浏览器稳定在线（心跳持续且已过恢复宽限）即浏览器是当前主写入方：
         * 它在跑的回合基于自己的基础桶追加，桶长可能仍短于 headless 早前写
         * 的 server 版（分叉），此时按长度保 server 会把在线页面的新回合静默
         * 丢弃（页面关闭再重进的「回合消失」即此）。放行 PUT 并脱离脏集——
         * dirty 保护的对象是「浏览器关闭期间」的 server 直写；刚恢复在线的
         * 宽限期内仍走长度保护（拉回未完成，旧桶 PUT 会盖掉 headless 轮次）。
         */
        if (online(conv) && Date.now() - (resumedAt.get(conv) ?? 0) >= ONLINE_GRACE_MS) {
          dirty.delete(key);
          continue;
        }
        const srvBucket = (srvTurns[conv]?.[model] as unknown[] | undefined) ?? [];
        const putBucket = turns[conv]?.[model];
        if (putBucket === undefined) {
          /*
           * PUT 不带该桶：会话本身还在（putChats 含该 conv）说明是浏览器侧
           * 桶丢失（localStorage 配额/清缓存）而非用户删除——保住 server 桶，
           * 不脱离脏集；会话一并删了才是真正的删除传播。
           */
          if (chatAlive(conv)) {
            turns[conv] = { ...(turns[conv] ?? {}), [model]: srvBucket };
          } else {
            dirty.delete(key);
          }
          continue;
        }
        if (Array.isArray(putBucket) && srvBucket.length > putBucket.length) {
          /* 浏览器推来的桶短于 server（headless 新轮次未被拉回）：保住 server  版 */
          turns[conv] = { ...(turns[conv] ?? {}), [model]: srvBucket };
        } else if (Array.isArray(putBucket) && putBucket.length >= srvBucket.length) {
          /* 浏览器已含 headless 轮次：桶归还浏览器主存储，脱离脏集 */
          dirty.delete(key);
        }
      }
      if (dirty.size) saveDirty();
      return turns;
    },
  };
}
