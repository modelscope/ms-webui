/**
 * 对话消息本体的持久化：swift-webui-turns 分桶（会话 id × 模型 id 两维）。
 *
 * 读写方有两个：首页 ChatPage 与各页的 PageAssistant。它们不会同时挂载
 * （路由切换），但都遵循同一约定——写前先读最新全量、改自己的桶、整份写回，
 * 避免互相覆盖对方刚写的桶。
 */

import type { ChatMessage } from '@/api/models';

const TURNS_KEY = 'swift-webui-turns';

export function loadTurns(): Record<string, Record<string, ChatMessage[]>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(TURNS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写一个桶（读-改-写全量，其他桶不动）；写失败只影响持久化 */
export function saveTurns(convId: string, modelId: string, messages: ChatMessage[]): void {
  try {
    const all = loadTurns();
    all[convId] = { ...(all[convId] ?? {}), [modelId]: messages };
    localStorage.setItem(TURNS_KEY, JSON.stringify(all));
  } catch {
    /* 超出配额等写失败不影响内存态 */
  }
}

/**
 * 把一个会话的消息流从旧模型桶搬到新模型桶（切模型续聊时调用）。
 * 目标桶已有消息则不动——那是该会话在新模型下的既有流，覆盖会丢数据；
 * 搬空目标时旧桶同步清空，保证一个会话在 single 模式下只有一条活跃流。
 */
export function moveTurns(convId: string, fromModel: string, toModel: string): void {
  try {
    const all = loadTurns();
    const buckets = all[convId];
    if (!buckets || !buckets[fromModel]?.length || buckets[toModel]?.length) return;
    buckets[toModel] = buckets[fromModel];
    delete buckets[fromModel];
    localStorage.setItem(TURNS_KEY, JSON.stringify(all));
  } catch {
    /* 同 saveTurns：写失败不影响内存态 */
  }
}

/** 删一个会话的全部桶（会话删除时调用） */
export function removeTurns(convId: string): void {
  try {
    const all = loadTurns();
    delete all[convId];
    localStorage.setItem(TURNS_KEY, JSON.stringify(all));
  } catch {
    /* 同上 */
  }
}
