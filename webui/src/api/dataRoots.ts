/**
 * 外部数据目录登记的 webui 后端客户端（~/.swift/data-roots.json）。
 *
 * 登记的是运行机器上的目录，agent 文件工具对它们只读放行——原始数据探查用，
 * 不给写权限。偏好设置的「外部数据目录」组是它的管理界面。
 */

import { tStatic } from '@/i18n';

/** 登记根列表（POST 返回登记后的最新列表，前端直接落 state） */
export async function listDataRoots(): Promise<string[]> {
  const res = await fetch('/api/data-roots');
  if (!res.ok) throw new Error(tStatic('api.readDataRootsFailed', { status: res.status }));
  return (await res.json()).roots;
}

export async function addDataRoot(path: string): Promise<string[]> {
  const res = await fetch('/api/data-roots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.registerFailed'));
  return (await res.json()).roots;
}

export async function removeDataRoot(path: string): Promise<void> {
  const res = await fetch(`/api/data-roots?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.removeFailed', { status: res.status }));
}
