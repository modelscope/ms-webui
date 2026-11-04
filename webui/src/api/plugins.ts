/**
 * 插件登记的 webui 后端客户端。
 *
 * 后端是 ~/.swift/plugins.json（vite 中间件 CRUD）。一条登记 = 一个
 * external_plugins 来源（本地 .py / 本地文件夹 / hub id），训练等页面的
 * 插件选择读它，选中即把 source 放进命令行 --external_plugins。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

/** 一条插件登记（后端 StoredPlugin 的镜像） */
export interface StoredPlugin {
  /** 登记名（缺省取 source） */
  id: string;
  /** 本地 .py / 本地文件夹 / hub id（ms:// 或 hf://） */
  source: string;
  /** 类型标注（model/dataset/template/reward/tool/sampler 等自由标签） */
  tags: string[];
  note?: string;
}

export async function listPlugins(): Promise<StoredPlugin[]> {
  const res = await fetch(apiBase() + '/api/plugins');
  if (!res.ok) throw new Error(tStatic('api.loadPluginsFailed', { status: res.status }));
  return (await res.json()).plugins;
}

/** 新增或按 id 覆盖一条登记 */
export async function savePlugin(input: { id?: string; source: string; tags?: string[]; note?: string }): Promise<void> {
  const res = await fetch(apiBase() + '/api/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.saveFailed'));
}

export async function deletePlugin(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.deleteFailed', { status: res.status }));
}
