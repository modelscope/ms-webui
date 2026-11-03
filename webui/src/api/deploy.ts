/**
 * 部署任务的 webui 后端客户端。
 *
 * 后端是 vite dev server 的任务执行器（见 vite.config.ts）：每个部署是一个
 * attached 的 `swift deploy` 子进程（不用 --detach），停止即 SIGTERM 优雅关停。
 * 就绪后部署的 endpoint 会自动登记进模型配置（~/.swift/models.json），
 * 对话页与模型管理页直接可见。
 */

import { tStatic } from '@/i18n';

/** 部署任务的公开形态（后端 publicTask 的镜像） */
export interface DeployTaskInfo {
  id: string;
  servedName: string;
  /** 用户改的显示名；不设时列表用 servedName */
  name?: string;
  model: string;
  engine: string;
  port: number;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  pid?: number;
  startedAt: string;
  /** 指定使用的 GPU 卡号（本机模式，CUDA_VISIBLE_DEVICES）；undefined = 不限制 */
  gpus?: number[];
  /** 集群模式的卡数（远端资源只声明数量）；与 gpus 互斥 */
  gpuCount?: number;
  /** 插件来源（--external_plugins），登记于 plugins.json */
  plugins?: string[];
  /** LoRA adapter（--adapters）：训练产出的 checkpoint 目录，支持 name=path 形态 */
  adapters?: string[];
  /** 「将要执行」直写的附加参数原文（spawn 时 tokenize 追加） */
  extraArgs?: string;
}

/** 一张 GPU 的实时形态（nvidia-smi 探测，显存单位 MiB） */
export interface GpuInfo {
  index: number;
  name: string;
  used: number;
  total: number;
}

/** GPU 清单。无驱动或无卡的机器返回空数组 */
export async function listGpus(): Promise<GpuInfo[]> {
  const res = await fetch('/api/gpus');
  if (!res.ok) throw new Error(tStatic('api.readGpusFailed', { status: res.status }));
  return (await res.json()).gpus;
}

export async function listDeploys(): Promise<DeployTaskInfo[]> {
  const res = await fetch('/api/deploy');
  if (!res.ok) throw new Error(tStatic('api.loadDeployListFailed', { status: res.status }));
  return (await res.json()).tasks;
}

export async function startDeploy(input: {
  model: string;
  servedName?: string;
  engine?: string;
  port?: number;
  /** 本机模式：选中的 GPU 卡号进 CUDA_VISIBLE_DEVICES；多张同时设 vLLM 张量并行 */
  gpus?: number[];
  /** 集群模式：只声明卡数（远端资源由集群调度），不设 CUDA_VISIBLE_DEVICES */
  gpuCount?: number;
  /** 插件来源（--external_plugins） */
  plugins?: string[];
  /** LoRA adapter（--adapters）：训练产出的 checkpoint 目录，支持 name=path 形态，多个即多 adapter */
  adapters?: string[];
  /** 「将要执行」直写的附加参数原文（按空白切分追加，引号包裹保留空格） */
  extraArgs?: string;
}): Promise<string> {
  const res = await fetch('/api/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.startFailed'));
  return (await res.json()).id;
}

export async function stopDeploy(id: string): Promise<void> {
  const res = await fetch(`/api/deploy/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopFailed', { status: res.status }));
}

/** 重命名：只改 webui 里的显示名，不触碰任务本体与模型登记 */
export async function renameDeploy(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/deploy/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.renameFailed'));
}

export async function getDeployLog(id: string): Promise<string[]> {
  const res = await fetch(`/api/deploy/${encodeURIComponent(id)}/log`);
  if (!res.ok) throw new Error(tStatic('api.readLogFailed', { status: res.status }));
  return (await res.json()).lines;
}
