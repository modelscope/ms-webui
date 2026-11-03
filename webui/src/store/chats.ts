/**
 * 对话会话的元数据注册：每段对话一个 {id, title, updatedAt}。
 *
 * 与 store/recent.ts 同一套模式（localStorage + useSyncExternalStore）：
 * 消息本体由 ChatPage 自行持久化（swift-webui-turns），这里只登记
 * 「有哪些对话、各自叫什么」，供左侧会话列表与侧栏「最近」跳转使用。
 */

import { useSyncExternalStore } from 'react';

export interface ChatMeta {
  /** 会话 id，同时是消息分桶（turns）的键 */
  id: string;
  /** 列表标题，取该会话第一句话的截断 */
  title: string;
  /** 最近一条消息的时间（ms 时间戳） */
  updatedAt: number;
}

const KEY = 'swift-webui-chats';

function load(): ChatMeta[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as ChatMeta[]) : [];
    if (!Array.isArray(parsed)) return [];
    /*
     * 存量清洗：旧版 pushChat 在新建会话时插入了两条同 id 记录（列表渲染
     * 成对条目、删除时一起消失）。按 id 去重，同 id 保留 updatedAt 最新的一条。
     */
    const byId = new Map<string, ChatMeta>();
    for (const c of parsed) {
      const seen = byId.get(c.id);
      if (!seen || seen.updatedAt < c.updatedAt) byId.set(c.id, c);
    }
    return [...byId.values()];
  } catch {
    /* 存储损坏（手改过/旧格式）时从零开始，不值得报错打断 */
    return [];
  }
}

let items: ChatMeta[] = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 写失败只影响持久化，不影响本次会话 */
  }
}

/** 注册/刷新一段会话：已存在的只上浮并更新时间，标题保持首句 */
export function pushChat(id: string, title: string) {
  const prev = items.find((c) => c.id === id);
  items = [
    { ...(prev ?? { id, title }), updatedAt: Date.now() },
    ...items.filter((c) => c.id !== id),
  ];
  persist();
  listeners.forEach((l) => l());
}

/** 删除一段会话（调用方负责同步清理消息与「最近」里的对应项） */
export function deleteChat(id: string) {
  items = items.filter((c) => c.id !== id);
  persist();
  listeners.forEach((l) => l());
}

/** 侧栏会话列表的订阅入口；发起方直接调 pushChat，不走 hook */
export function useChats(): ChatMeta[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
  );
}
