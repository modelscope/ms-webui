/**
 * 导出任务的 webui 后端客户端。
 *
 * 后端是 vite dev server 的任务执行器（见 vite.config.ts）：一个导出任务 =
 * 一次 `swift export` 子进程（LoRA 合并 / 量化 / 推送 Hub 的组合），attached
 * 生命周期与部署/评测同构。产物落 ~/.swift/export/<id>/output/，完成后浅层
 * 扫描进 artifacts 供详情页展示。
 */

import { tStatic } from '@/i18n';

/** 导出任务的公开形态（后端 publicExportTask 的镜像） */
export interface ExportTaskInfo {
  id: string;
  /** 用户改的显示名；不设时列表用「源 → 操作摘要」拼接 */
  name?: string;
  /** 底座模型（hub id 或本地路径） */
  model: string;
  /** LoRA adapter（训练 checkpoint 目录） */
  adapters?: string;
  mergeLora: boolean;
  /** awq / gptq / bnb；位宽由后端按方法推导 */
  quantMethod?: 'awq' | 'gptq' | 'bnb';
  /** awq / gptq 的校准数据集 */
  calibDataset?: string;
  pushToHub: boolean;
  hubModelId?: string;
  outputDir: string;
  /** 指定使用的 GPU 卡号（CUDA_VISIBLE_DEVICES）；undefined = 不限制 */
  gpus?: number[];
  /** 插件来源（--external_plugins），登记于 plugins.json */
  plugins?: string[];
  /** 「将要执行」直写的附加参数原文（spawn 时 tokenize 追加） */
  extraArgs?: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  /** 完成后对 outputDir 的浅层扫描（文件名 + 字节数） */
  artifacts?: { name: string; size: number }[];
}

export async function listExports(): Promise<ExportTaskInfo[]> {
  const res = await fetch('/api/export');
  if (!res.ok) throw new Error(tStatic('api.loadExportListFailed', { status: res.status }));
  return (await res.json()).tasks;
}

export async function startExport(input: {
  /** 底座模型：hub id 或本地路径 */
  model: string;
  /** LoRA adapter（训练 checkpoint 目录）；mergeLora 时必填 */
  adapters?: string;
  mergeLora: boolean;
  /** 量化方式；位宽跟着方法走（awq|gptq=int4, bnb=int8） */
  quantMethod?: 'awq' | 'gptq' | 'bnb';
  /** awq / gptq 的校准数据集 id */
  calibDataset?: string;
  pushToHub: boolean;
  /** 推送目标（ModelScope Hub 的 repo id） */
  hubModelId?: string;
  /** 本机 GPU 卡号（CUDA_VISIBLE_DEVICES）；量化 / 合并是 GPU 作业 */
  gpus?: number[];
  /** 插件来源（--external_plugins） */
  plugins?: string[];
  /** 「将要执行」直写的附加参数原文（按空白切分追加，引号包裹保留空格） */
  extraArgs?: string;
}): Promise<string> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.startFailed'));
  return (await res.json()).id;
}

export async function stopExport(id: string): Promise<void> {
  const res = await fetch(`/api/export/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopFailed', { status: res.status }));
}

/** 重命名：只改 webui 里的显示名，不触碰任务本体与产物 */
export async function renameExport(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/export/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.renameFailed'));
}

export async function getExportLog(id: string): Promise<string[]> {
  const res = await fetch(`/api/export/${encodeURIComponent(id)}/log`);
  if (!res.ok) throw new Error(tStatic('api.readLogFailed', { status: res.status }));
  return (await res.json()).lines;
}
