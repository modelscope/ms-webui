/**
 * 编排实验的 webui 后端客户端。
 *
 * 后端是 vite 中间件的 flows 持久层（~/.swift/flows.json）：脚手架只是
 * 新建时的初始状态，实验本体（画布 nodes/edges/frames + 名称）落盘、
 * 跨浏览器刷新与 dev server 重启存活。
 */

import { tStatic } from '@/i18n';

/** 列表条目：不含画布声明（列表页载荷小） */
export interface FlowSummary {
  id: string;
  name: string;
  /** 创建来源的脚手架 key；空白创建为 '' */
  preset: string;
  updatedAt: string;
  /** 该实验的常驻会话（仅进程活着时有）：释放它即归还显存与后台资源 */
  session?: { id: string; state: string };
}

/** 画布状态（编辑页 graph state 的持久形态；声明性数据，形态由编辑页定义） */
export interface FlowGraph {
  nodes: unknown[];
  edges: unknown[];
  frames?: unknown[];
}

/** 单个实验的完整记录 */
export interface FlowRecord extends FlowSummary {
  graph: FlowGraph;
  createdAt: string;
}

export async function listFlows(): Promise<FlowSummary[]> {
  const res = await fetch('/api/flows');
  if (!res.ok) throw new Error(tStatic('api.loadFlowsFailed', { status: res.status }));
  return (await res.json()).flows;
}

/** 从一个脚手架（或空白画布）创建新实验；graph 由调用方按脚手架序列化 */
export async function createFlow(graph: FlowGraph, opts?: { name?: string; preset?: string }): Promise<string> {
  const res = await fetch('/api/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, ...opts }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.createFlowFailed'));
  return (await res.json()).id;
}

export async function getFlow(id: string): Promise<FlowRecord> {
  const res = await fetch(`/api/flows/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(tStatic('api.loadFlowFailed', { status: res.status }));
  return (await res.json()).flow;
}

export async function saveFlow(id: string, patch: { name?: string; graph?: FlowGraph }): Promise<void> {
  const res = await fetch(`/api/flows/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(tStatic('api.saveFlowFailed', { status: res.status }));
}

export async function deleteFlow(id: string): Promise<void> {
  const res = await fetch(`/api/flows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.deleteFlowFailed', { status: res.status }));
}
