/**
 * 脚本任务的 webui 后端客户端。
 *
 * 后端是 vite 任务执行器：工作空间里的 python 脚本以后台任务形态执行
 * （长作业——前处理/数据分析，不受 shell 工具 30 秒超时限制），环形日志、
 * SIGTERM 停止、终态由退出码判定。任务由首页 agent 的 run_script 工具创建。
 */

import { tStatic } from '@/i18n';

/** 脚本任务的公开形态（后端 publicScriptTask 的镜像） */
export interface ScriptTaskInfo {
  id: string;
  /** 用户改的显示名；不设时列表用脚本路径 */
  name?: string;
  /** 工作空间内的脚本路径（相对根形态） */
  script: string;
  /** 命令行参数（逐个传给子进程） */
  args: string[];
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  /** 发起任务的对话（脚本唤醒通道的归属；页面直接启动的任务不带） */
  conv?: string;
  /** 发起任务的模型列（唤醒时钉回同一列，多列对比不串台） */
  modelId?: string;
}

export async function listScripts(): Promise<ScriptTaskInfo[]> {
  const res = await fetch('/api/scripts');
  if (!res.ok) throw new Error(tStatic('api.loadScriptsFailed', { status: res.status }));
  return (await res.json()).tasks;
}

/**
 * 启动一个脚本任务；返回任务 id（供日志轮询与停止）。conv/modelId 是
 * 对话唤醒归属：由 agent 的 run_script 传入，页面直接启动的不传。
 */
export async function startScript(
  script: string,
  args?: string[],
  conv?: string,
  modelId?: string,
): Promise<string> {
  const res = await fetch('/api/scripts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      script,
      ...(args?.length ? { args } : {}),
      ...(conv ? { conv } : {}),
      ...(modelId ? { modelId } : {}),
    }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.startFailed'));
  return (await res.json()).id;
}

export async function getScriptLog(id: string): Promise<string[]> {
  const res = await fetch(`/api/scripts/${encodeURIComponent(id)}/log`);
  if (!res.ok) throw new Error(tStatic('api.readLogFailed', { status: res.status }));
  return (await res.json()).lines;
}

/** 停止（幂等：终态任务不改状态） */
export async function stopScript(id: string): Promise<void> {
  const res = await fetch(`/api/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.stopFailed', { status: res.status }));
}

/** 重命名：只改 webui 里的显示名 */
export async function renameScript(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/scripts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.renameFailed'));
}
