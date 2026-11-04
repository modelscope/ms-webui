/**
 * autoresearch 研究会话的 webui 后端客户端。
 *
 * 后端是 vite 中间件（~/.swift/research.json 持久化 + watcher 状态跃迁 +
 * 事件队列）。事件「取走即删」：对话页轮询 consume=1，拿到即注入合成消息
 * 唤醒主模型；页面关闭期间事件积压在服务端，回来时一次交付。
 */

import { apiBase } from './base';
import type { MessageKey } from '../i18n/static';
import { tStatic } from '../i18n/static';

export interface ResearchMetric {
  kind: 'evalscope' | 'custom';
  dataset: string;
  metricName: string;
  limit?: number;
  judge?: string;
}

export interface ResearchTrainConfig {
  taskType: 'sft' | 'pt' | 'rl';
  tuner: 'full' | 'lora' | 'trainable_tokens';
  params: Record<string, string | number | boolean>;
  gpus?: number[];
  gpuCount?: number;
  plugins?: string[];
}

export interface ResearchIteration {
  index: number;
  dataVersion?: string;
  trainTaskId?: string;
  evalTaskId?: string;
  score?: number;
  note?: string;
  /** watcher 防重字段：parallel 模式已评过的 checkpoint 名（整组回传时原样带回） */
  evaluatedCkpt?: string;
  /** watcher 防重字段：during 模式已记账的最后一个评测 step */
  lastEvalStep?: number;
}

export type ResearchStatus =
  | 'preparing'
  | 'training'
  | 'evaluating'
  | 'deciding'
  | 'done'
  | 'escalated'
  | 'stopped';

/** 状态徽标文案（研究页列表与对话侧绑定徽标共用）：i18n key，渲染处 t() */
export const RESEARCH_STATUS_LABELS: Record<ResearchStatus, MessageKey> = {
  preparing: 'rs.preparing',
  training: 'rs.training',
  evaluating: 'rs.evaluating',
  deciding: 'rs.deciding',
  done: 'rs.done',
  escalated: 'rs.escalated',
  stopped: 'rs.stopped',
};

export interface ResearchSession {
  id: string;
  convId: string;
  modelId: string;
  goal: string;
  baseModel: string;
  dataDir: string;
  evalPlan: {
    mode: 'during' | 'checkpoint' | 'parallel';
    metric: ResearchMetric;
    threshold: number;
    direction: 'higher' | 'lower';
  };
  budget: { maxIterations: number };
  trainConfig?: ResearchTrainConfig;
  status: ResearchStatus;
  iterations: ResearchIteration[];
  /** 唤醒事件队列：对话页轮询取走即删 */
  events: Array<{ at: string; kind: string; text: string }>;
  /** 事件历史（只增不删）：研究页事件流的展示源 */
  eventLog: Array<{ at: string; kind: string; text: string }>;
  createdAt: string;
}

/** 列表形态（不带 events / eventLog） */
export type ResearchSummary = Omit<ResearchSession, 'events' | 'eventLog'>;

export async function listResearch(): Promise<ResearchSummary[]> {
  const res = await fetch(apiBase() + '/api/research');
  if (!res.ok) throw new Error(tStatic('api.loadResearchListFailed', { status: res.status }));
  return (await res.json()).sessions;
}

export async function getResearch(id: string): Promise<ResearchSession> {
  const res = await fetch(`${apiBase()}/api/research/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.loadFailed'));
  return (await res.json()).session;
}

export async function createResearch(input: {
  convId: string;
  modelId: string;
  goal: string;
  baseModel: string;
  dataDir?: string;
  evalPlan: {
    mode: 'during' | 'checkpoint' | 'parallel';
    metric: ResearchMetric;
    threshold: number;
    direction: 'higher' | 'lower';
  };
  budget: { maxIterations: number };
  trainConfig?: ResearchTrainConfig;
}): Promise<ResearchSession> {
  const res = await fetch(apiBase() + '/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.createFailed'));
  return (await res.json()).session;
}

export async function updateResearch(
  id: string,
  patch: {
    /* 唤醒绑定改绑：模型在哪个会话/列维护研究（update_research 工具自动附带），
     * 训练/脚本完成事件就投到哪——用户换会话续研究时自愈绑定漂移 */
    convId?: string;
    modelId?: string;
    goal?: string;
    baseModel?: string;
    dataDir?: string;
    status?: ResearchStatus;
    budget?: { maxIterations: number };
    iterations?: ResearchIteration[];
    trainConfig?: ResearchTrainConfig;
  },
): Promise<ResearchSession> {
  const res = await fetch(`${apiBase()}/api/research/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.updateFailed'));
  return (await res.json()).session;
}

/** 取走即删：返回本次取到的事件（并发轮询只有一个能拿到） */
export async function consumeResearchEvents(
  id: string,
): Promise<Array<{ at: string; kind: string; text: string }>> {
  const res = await fetch(`${apiBase()}/api/research/${encodeURIComponent(id)}/events?consume=1`);
  if (!res.ok) throw new Error(tStatic('api.readEventsFailed', { status: res.status }));
  return (await res.json()).events;
}

/** 停止研究会话：只断 watcher 关联，不停训练/评测（走各自任务页） */
export async function stopResearch(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/research/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopFailed', { status: res.status }));
}
