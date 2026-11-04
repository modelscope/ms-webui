/**
 * 评测任务的 webui 后端客户端。
 *
 * 后端是 vite dev server 的任务执行器（见 vite.config.ts）：一个评测任务 =
 * 被测模型（models.json 条目）× 若干评测集，逐集串行跑 swift eval 的 api 模式
 * （--eval_url 指向该模型的端点）。报告落 ~/.swift/eval/<id>/results.jsonl，
 * 任务完成后逐集读回。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

/** EvalScope 数据集注册表里的一项 */
export interface EvalDatasetInfo {
  name: string;
  prettyName: string;
  tags: string[];
  metrics: string[];
}

/** 一个评测集及其采样设置 */
export interface EvalItem {
  dataset: string;
  /** 只评前 N 条；undefined = 全量 */
  limit?: number;
  /** 逐集 dataset_args（subset_list 版本透传等）：JSON 序列化进 --eval_dataset_args */
  datasetArgs?: Record<string, unknown>;
}

/** 本地直评目标：--model 底座 + --adapters checkpoint，不连端点（autoresearch 主用，评测页可手填） */
export interface EvalLocalTarget {
  model: string;
  adapters?: string[];
  gpus?: number[];
}

/**
 * EvalScope 报告行（Native summarize 的输出行）。字段按真实 results.jsonl 声明，
 * 全部可选：行里还有 dataset_description 等长文本与嵌套 categories，展示层不消费。
 */
export interface EvalReportRow {
  name?: string;
  dataset_pretty_name?: string;
  model_name?: string;
  /** 该集的加权总分 */
  score?: number;
  num?: number;
  metrics?: Array<{ name?: string; score?: number; num?: number }>;
}

/** 评测任务的公开形态（后端 publicEvalTask 的镜像） */
export interface EvalTaskInfo {
  id: string;
  modelId: string;
  /** 用户改的显示名；不设时列表用「模型 · 评测集摘要」拼接 */
  name?: string;
  model: string;
  baseUrl: string;
  items: EvalItem[];
  current: number;
  status: 'starting' | 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  outputDir: string;
  resultJsonl: string;
  /** 完成后的逐集报告行 */
  report?: { dataset: string; rows: EvalReportRow[] }[];
  /** 插件来源（--external_plugins），登记于 plugins.json */
  plugins?: string[];
  /** 「将要执行」直写的附加参数原文（逐集 spawn 时 tokenize 追加） */
  extraArgs?: string;
  /** 本地直评模式：设了它就不走 eval_url/api key 路径 */
  local?: EvalLocalTarget;
}

/** EvalScope 数据集注册表（207 个基准，服务端缓存） */
export async function listEvalDatasets(): Promise<EvalDatasetInfo[]> {
  const res = await fetch(apiBase() + '/api/eval/datasets');
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.readDatasetListFailed', { status: res.status }));
  return (await res.json()).datasets;
}

export async function listEvals(): Promise<EvalTaskInfo[]> {
  const res = await fetch(apiBase() + '/api/eval');
  if (!res.ok) throw new Error(tStatic('api.loadEvalListFailed', { status: res.status }));
  return (await res.json()).tasks;
}

export async function startEval(input: {
  /** api 模式的被测模型（models.json 条目 id）；本地直评时不传 */
  modelId?: string;
  items: EvalItem[];
  /** 本地直评（与 modelId 互斥）：底座 + checkpoint 直接评，本地加载模型 */
  local?: EvalLocalTarget;
  /** 插件来源（--external_plugins） */
  plugins?: string[];
  /** 「将要执行」直写的附加参数原文（按空白切分追加） */
  extraArgs?: string;
}): Promise<string> {
  const res = await fetch(apiBase() + '/api/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.startFailed'));
  return (await res.json()).id;
}

export async function stopEval(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/eval/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopFailed', { status: res.status }));
}

/** 重命名：只改 webui 里的显示名，不触碰任务本体与结果文件 */
export async function renameEval(id: string, name: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/eval/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.renameFailed'));
}

export async function getEvalLog(id: string): Promise<string[]> {
  const res = await fetch(`${apiBase()}/api/eval/${encodeURIComponent(id)}/log`);
  if (!res.ok) throw new Error(tStatic('api.readLogFailed', { status: res.status }));
  return (await res.json()).lines;
}
