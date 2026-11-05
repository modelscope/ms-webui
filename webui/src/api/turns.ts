/**
 * 回合引擎的浏览器侧 client（单写者架构）：提交回合、订阅 SSE 增量、
 * 停止/删除/搬桶。回合执行体在 server——浏览器只是提交与观看，刷新或
 * 关闭页面不影响回合跑完，重连后靠单会话桶对账补齐错过的增量。
 */

import { apiBase } from './base';
import type { ChatMessage, ToolCall } from './models';

/** 页面提交的动态工具定义（与 server/turnEngine.ts 的 PageToolSpec 同构；type-only 无法跨端共享，此处镜像） */
export interface PageToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 重操作元数据：引擎先挂起审批（approvals.json 同一张卡），批准才上抛页面段 */
  approval?: { title: string; reason: string };
}

export interface TurnSubmitPayload {
  text: string;
  models: string[];
  images?: string[];
  /** 页面组装好的 system 块（persona/研究指引/联网说明等，按序注入） */
  system: string[];
  /** 工具注册表键名清单（引擎按名构建） */
  tools: string[];
  /*
   * 页面动态工具（执行体在页面，引擎挂起上抛等回传）；仅单模型回合受理。
   * search_models 等已入注册表，别在这里重复定义。
   */
  pageTools?: PageToolSpec[];
  title?: string;
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
  /** 展览模式的会话 token（MS 默认模型；models.json 无 key 时必带） */
  apiKey?: string;
  /** 免审总闸（配置浮层）：引擎侧同语义放行该回合的一切审批 */
  noApproval?: boolean;
}

/** SSE 事件（与 server/turnEngine.ts 的 TurnEvent 同构；type-only 无法跨端共享，此处镜像） */
export interface TurnLiveEvent {
  type: 'sync' | 'turn-start' | 'user' | 'assistant-start' | 'delta' | 'assistant' | 'tool' | 'page-tool' | 'error' | 'turn-done';
  conv: string;
  model: string;
  /** sync：当前在跑的列名 */
  models?: string[];
  content?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  message?: ChatMessage;
  /*
   * page-tool：引擎上抛的挂起工具调用（执行体在页面）。arguments 是参数
   * JSON 串（create_link 例外，载荷是 CreatedLink 跳转意图对象）；页面执行
   * 后 POST resolvePageTool 回传结果，回合续轮。
   */
  call?: { id: string; name: string; arguments: string };
  error?: string;
}

export async function submitTurn(conv: string, payload: TurnSubmitPayload): Promise<{ turnId: string } | { error: string }> {
  const res = await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}/turn`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(payload.apiKey ? { 'x-swift-api-key': payload.apiKey } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 409) return { error: 'turn in flight' };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return (await res.json()) as { turnId: string };
}

/** 订阅回合增量；返回关闭函数（组件卸载/切会话时调用） */
export function openTurnLive(conv: string, onEvent: (ev: TurnLiveEvent) => void): () => void {
  const es = new EventSource(`${apiBase()}/api/conv/${encodeURIComponent(conv)}/live`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as TurnLiveEvent);
    } catch {
      /* 坏帧跳过：对账端点兜底 */
    }
  };
  return () => es.close();
}

/** 停止按钮：中止该列页面提交的在跑回合（唤醒回合不受影响） */
export async function abortTurn(conv: string, model: string): Promise<void> {
  try {
    await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  } catch {
    /* 中止失败：回合自然结束，按钮态由 SSE 恢复 */
  }
}

/** 单会话桶对账：回合完成/重连时轻量拉回（server 是唯一真相源） */
export async function fetchConvBuckets(conv: string): Promise<Record<string, ChatMessage[]>> {
  try {
    const res = await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}`);
    if (!res.ok) return {};
    return ((await res.json()) as { buckets?: Record<string, ChatMessage[]> }).buckets ?? {};
  } catch {
    return {};
  }
}

/*
 * 页面工具回传面：页面执行完挂起工具（表单卡片应用、画布操作、跳转按钮）
 * 后把结果文本交回引擎续轮；失败静默（面板重开重放时重传）。挂起调用清单
 * 拉取用于挂载/重连恢复重放。
 */
export async function resolvePageTool(conv: string, model: string, callId: string, result: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}/page-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, callId, result }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchPendingPageTools(
  conv: string,
  model?: string,
): Promise<{ id: string; name: string; arguments: string; model?: string }[]> {
  try {
    const q = model ? `?model=${encodeURIComponent(model)}` : '';
    const res = await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}/page-tools${q}`);
    if (!res.ok) return [];
    return ((await res.json()) as { calls?: { id: string; name: string; arguments: string; model?: string }[] }).calls ?? [];
  } catch {
    return [];
  }
}

/** 删除会话（server 侧 chats + 全部桶一起清） */
export async function deleteConv(conv: string): Promise<void> {
  try {
    await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}`, { method: 'DELETE' });
  } catch {
    /* 删除失败：本地列表已清，server 残留下次删除再清 */
  }
}

/** 切模型续聊：把桶搬到新模型（目标桶已有消息不动） */
export async function moveConvBuckets(conv: string, from: string, to: string): Promise<void> {
  try {
    await fetch(`${apiBase()}/api/conv/${encodeURIComponent(conv)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
  } catch {
    /* 搬桶失败：新旧两列并存，历史可见不丢 */
  }
}
