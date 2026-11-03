/**
 * 侧栏「最近」栏的数据源：跨模块记录用户真实发生过的操作
 * （发起一段新对话、启动一个新部署……），最多保留 MAX 条。
 *
 * 不做成后端接口的理由：这是「这台浏览器上的这个人最近干了什么」，
 * 与服务端任务表（/api/deploy 等）不同源——任务表是事实的完整清单，
 * 这里只是导航捷径。localStorage 持久化，刷新不丢。
 */

import { useSyncExternalStore } from 'react';

export interface RecentItem {
  /** 去重键：同一对象的重复操作只上浮，不占新位 */
  id: string;
  /** 侧栏里显示的一句短标签 */
  label: string;
  /** 点击跳转的路由 */
  path: string;
  /** 最近一次操作时间（ms 时间戳） */
  at: number;
}

const KEY = 'swift-webui-recent';
const MAX = 5;

function load(): RecentItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as RecentItem[]) : [];
    if (!Array.isArray(parsed)) return [];
    /*
     * 存量清洗：会话跳转改为 ?conv= 之前落库的对话项是死链（path 裸 /chat，
     * 点击不携带目标），其对话本体在旧版也未持久化、无从恢复——直接丢弃，
     * 免得侧栏留着一条点了没反应的条目。
     */
    const alive = parsed.filter((i) => !(i.id.startsWith('chat:') && !i.path.includes('?conv=')));
    if (alive.length !== parsed.length) {
      try {
        localStorage.setItem(KEY, JSON.stringify(alive.slice(0, MAX)));
      } catch {
        /* 清洗结果写不回去只影响下次启动，本次内存态已干净 */
      }
    }
    return alive.slice(0, MAX);
  } catch {
    /* 存储损坏（手改过/旧格式）时从零开始，不值得报错打断 */
    return [];
  }
}

let items: RecentItem[] = load();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** 记录一次操作：置顶插入，同 id 上浮刷新，超出上限丢最旧的 */
export function pushRecent(item: Omit<RecentItem, 'at'>) {
  items = [{ ...item, at: Date.now() }, ...items.filter((i) => i.id !== item.id)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 隐私模式等写入失败只影响持久化，不影响本次会话 */
  }
  emit();
}

/** 撤掉一条记录（对象被删除时调用，避免侧栏留着指向已删对象的死链） */
export function removeRecent(id: string) {
  items = items.filter((i) => i.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* 同上：写失败只影响持久化 */
  }
  emit();
}

/** 侧栏消费的订阅入口；动作发起方直接调 pushRecent，不走 hook */
export function useRecent(): RecentItem[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => items,
  );
}
