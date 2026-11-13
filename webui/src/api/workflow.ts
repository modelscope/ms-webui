/**
 * 编排页常驻会话的 webui 后端客户端。
 *
 * 后端是 vite dev server 的会话管理器（见 vite.config.ts）：一 workflow key
 * 对应一个常驻 `python -m swift.dev.webui.session` 子进程，模型/数据集/
 * 采样器/iterator 常驻其中。画布把「节点+边+参数」如实序列化成声明发过去；
 * 节点灯由事件流（真实调用前后）驱动。停止（DELETE）只停本次图调用；
 * release 才终止 source 并关闭资源。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

/** 画布节点的序列化形态（GraphNode 的 params 数组在这里转成 dict） */
export interface WorkflowNodeDecl {
  id: string;
  type: string;
  params: Record<string, unknown>;
  code?: string;
}

export interface WorkflowEdgeDecl {
  id?: string;
  source: string;
  source_port: string;
  target: string;
  target_port: string;
  slot?: string;
}

/** 训练帧声明：成员、feedback 边、预算 owner */
export interface WorkflowFrameDecl {
  id: string;
  name?: string;
  members: string[];
  sources: string[];
  consumers: string[];
  feedback?: string[];
  budget_owner?: string;
}

/** 资源页声明：本机选卡（卡号）或集群（地址 + 总卡数） */
export interface WorkflowResourceDecl {
  mode: 'local' | 'cluster';
  cards?: number[];
  cluster_address?: string;
  cluster_gpus?: number;
}

/** 会话状态机（session.py 的 STATES） */
export type WorkflowSessionState =
  | 'idle' | 'queued' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'failed'
  | 'reset_required' | 'releasing' | 'released' | 'lost';

/** 常驻会话的公开形态（GET /api/workflow/:id 的 session 字段镜像） */
export interface WorkflowSessionInfo {
  id: string;
  key: string;
  state: WorkflowSessionState;
  startedAt: string;
  /** node 事件推进的已完成节点（真实调用，非日志猜测） */
  nodesDone: string[];
  nodesRunning: string[];
  nodesFailed: string[];
  activeNodes: string[];
  activeEdges: string[];
  usedEdges: string[];
  request_id?: string;
  runEnd?: WorkflowEvent;
  command_seq?: number;
  lastRun?: { target?: string; mode: string };
  eventCount?: number;
  /** 最近一次提交生效的资源声明：页面回到实验时资源页按它回填 */
  resource?: WorkflowResourceDecl;
}

/** 一条 [workflow] 事件（node/run_begin/run_end/stop/release/reply...） */
export interface WorkflowEvent {
  event: string;
  seq?: number;
  request_id?: string;
  state?: string;
  node_id?: string;
  error?: string;
  [key: string]: unknown;
}

export interface WorkflowSessionSnapshot {
  session: WorkflowSessionInfo;
  events: WorkflowEvent[];
}

export interface WorkflowRunSubmission {
  id: string;
  request_id: string;
  command_seq: number;
}

/** 发起一次图调用：同 workflowKey 复用常驻会话（资源不重建） */
export async function startWorkflowRun(graph: {
  nodes: WorkflowNodeDecl[];
  edges: WorkflowEdgeDecl[];
  frames?: WorkflowFrameDecl[];
  resource?: WorkflowResourceDecl;
}, opts?: {
  workflowKey?: string;
  target?: string;
  mode?: 'component' | 'full';
  steps?: number;
}): Promise<WorkflowRunSubmission> {
  const res = await fetch(apiBase() + '/api/workflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, ...opts }),
  });
  if (!res.ok) throw new Error(tStatic('api.submitRunFailed', { detail: (await res.json()).error ?? res.status }));
  const submission: WorkflowRunSubmission = await res.json();
  if (!submission.id || !submission.request_id) {
    throw new Error('会话启动响应缺少 request_id，请更新后端后重新提交');
  }
  return submission;
}

export async function getWorkflowSession(id: string): Promise<WorkflowSessionSnapshot> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}`);
  if (!res.ok) throw new Error(tStatic('api.readRunFailed', { status: res.status }));
  return res.json();
}

/**
 * 按业务 key（实验 id / 脚手架 key）查会话：编辑页切走再回来时把运行态
 * （在途运行、节点灯、停止入口）从常驻会话接回来。无会话返回 null。
 */
export async function getWorkflowSessionByKey(key: string): Promise<WorkflowSessionSnapshot | null> {
  const res = await fetch(`${apiBase()}/api/workflow?key=${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(tStatic('api.readRunFailed', { status: res.status }));
  return res.json();
}

export async function getWorkflowLog(id: string): Promise<string[]> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}/log`);
  if (!res.ok) throw new Error(tStatic('api.readRunLogFailed', { status: res.status }));
  return (await res.json()).lines;
}

/** 停止本次图调用：会话与常驻资源保留 */
export async function stopWorkflowRun(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopRunFailed', { status: res.status }));
}

/** 暂停本次运行：运行中的节点完成，下一个节点边界起不再启动（回执立即） */
export async function pauseWorkflowRun(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(tStatic('api.stopRunFailed', { status: res.status }));
}

/** 继续被暂停的运行 */
export async function resumeWorkflowRun(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(tStatic('api.stopRunFailed', { status: res.status }));
}

/** 释放常驻会话：终止 source、关闭模型/采样器/工具 */
export async function releaseWorkflowSession(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}/release`, { method: 'POST' });
  if (!res.ok) throw new Error(tStatic('api.releaseRunFailed', { status: res.status }));
}

/** 一条输出通道的有界摘要：列表给 total + 头部样本，标量给有界值 */
export interface PreviewLaneSummary {
  total?: number;
  head?: unknown[];
  [key: string]: unknown;
}

/** preview 命令回执：三档——lane 清单 / 单 lane 摘要 / 单 lane 分页页 */
export interface PreviewReply {
  ok: boolean;
  error?: string;
  node?: string;
  type?: string;
  lanes?: Record<string, PreviewLaneSummary>;
  lane?: string;
  offset?: number;
  limit?: number;
  total?: number;
  rows?: unknown[];
  value?: unknown;
}

/** 有界输出预览：分页读取是会话里唯一物化重载荷引用的通道 */
export async function previewWorkflowOutput(
  id: string,
  opts: { nodeId: string; lane?: string; offset?: number; limit?: number },
): Promise<PreviewReply> {
  const res = await fetch(`${apiBase()}/api/workflow/${id}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      node_id: opts.nodeId,
      ...(opts.lane != null ? { lane: opts.lane } : {}),
      ...(opts.offset != null ? { offset: opts.offset } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
    }),
  });
  if (!res.ok) throw new Error(tStatic('api.readRunFailed', { status: res.status }));
  return res.json();
}

/** GraphUpgrade 的一次升级决策项：choices 未清零时不能确认运行 */
export interface WorkflowUpgradeChoice {
  location: string;
  reason: string;
  options: string[];
}

/** GraphUpgrade.preview 的后端结果镜像（graph.py GraphUpgrade._result） */
export interface WorkflowUpgradePreview {
  original: Record<string, unknown>;
  candidate: {
    version: number;
    workflow_id: string;
    nodes: WorkflowNodeDecl[];
    edges: WorkflowEdgeDecl[];
    frames?: WorkflowFrameDecl[];
    resource?: WorkflowResourceDecl;
  };
  changes: Record<string, unknown>[];
  choices: WorkflowUpgradeChoice[];
  validation_error: string;
  can_confirm: boolean;
}

/** 旧图升级：后端 GraphUpgrade 只在副本上展开，确认与否由页面决定 */
export async function upgradeWorkflowGraph(
  graph: Record<string, unknown>,
  selections?: Record<string, string>,
): Promise<WorkflowUpgradePreview | { error: string }> {
  const res = await fetch(apiBase() + '/api/workflow/upgrade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph, ...(selections ? { selections } : {}) }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail || body.error || tStatic('api.upgradeFailed', { status: res.status }));
  }
  return res.json();
}
