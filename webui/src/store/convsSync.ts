/**
 * 对话历史的服务端镜像（~/.swift/webui/convs.json）。
 *
 * localStorage 仍是主存储，这里做同栈备份——换设备/换实例/清缓存后把服务端
 * 有的、本地缺的会话拉回来（只补缺不覆盖：本地更新才是真相）。推送为防抖
 * 全量覆盖，任何本地写（新消息/删会话/切模型搬桶）都会触发，删除随下一次
 * 推送自然传播。展览模式禁用：机器侧文件是共享面，多用户对话不落同一份。
 */

const CHATS_KEY = 'swift-webui-chats';
const TURNS_KEY = 'swift-webui-turns';
/** 推送防抖：一次回合会写多桶，攒 3s 一起推 */
const PUSH_DEBOUNCE_MS = 3000;

let enabled = false;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

interface ChatMetaShape {
  id: string;
  updatedAt: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** 启动时拉一次：补本地缺的会话与消息桶，然后推一帧全量对齐服务端 */
export async function initConvSync(): Promise<void> {
  try {
    const modeRes = await fetch('/api/mode');
    const mode = (await modeRes.json()) as { mode?: string };
    if (mode.mode === 'expo') return;
    enabled = true;
    const res = await fetch('/api/convs');
    if (res.ok) pullMissing((await res.json()) as { chats?: unknown[]; turns?: Record<string, Record<string, unknown>> });
    scheduleConvPush();
  } catch {
    /* 服务端不可达：浏览器本地态照常工作 */
  }
}

function pullMissing(srv: { chats?: unknown[]; turns?: Record<string, Record<string, unknown>> }): void {
  try {
    const localChats = JSON.parse(localStorage.getItem(CHATS_KEY) ?? '[]') as ChatMetaShape[];
    if (!Array.isArray(localChats)) return;
    const localIds = new Set(localChats.map((c) => c.id));
    const missing = (Array.isArray(srv.chats) ? srv.chats : []).filter(
      (c): c is ChatMetaShape => isRecord(c) && typeof c.id === 'string' && typeof c.title === 'string' && !localIds.has(c.id),
    );
    if (missing.length) localStorage.setItem(CHATS_KEY, JSON.stringify([...localChats, ...missing]));
  } catch {
    /* 坏数据不动本地 */
  }
  try {
    const local = JSON.parse(localStorage.getItem(TURNS_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
    let added = false;
    for (const [conv, buckets] of Object.entries(srv.turns ?? {})) {
      if (!isRecord(buckets)) continue;
      if (!local[conv]) {
        local[conv] = buckets;
        added = true;
      } else {
        for (const [model, msgs] of Object.entries(buckets)) {
          if (local[conv][model] === undefined) {
            local[conv][model] = msgs;
            added = true;
          } else if (
            /* headless 拉回：浏览器关闭期间 server 直写过轮次（桶更长），采用 server 版 */
            Array.isArray(msgs) &&
            Array.isArray(local[conv][model]) &&
            msgs.length > (local[conv][model] as unknown[]).length
          ) {
            local[conv][model] = msgs;
            added = true;
          }
        }
      }
    }
    if (added) localStorage.setItem(TURNS_KEY, JSON.stringify(local));
  } catch {
    /* 坏数据不动本地 */
  }
}

/** 本地对话面有任何写之后调用：防抖全量推送到服务端镜像 */
export function scheduleConvPush(): void {
  if (!enabled) return;
  if (pushTimer !== undefined) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    void (async () => {
      try {
        const chats = JSON.parse(localStorage.getItem(CHATS_KEY) ?? '[]');
        const turns = JSON.parse(localStorage.getItem(TURNS_KEY) ?? '{}');
        await fetch('/api/convs', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chats, turns }),
        });
      } catch {
        /* 推送失败不影响本地态；下一次写会再试 */
      }
    })();
  }, PUSH_DEBOUNCE_MS);
}
