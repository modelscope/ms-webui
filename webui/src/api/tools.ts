/**
 * agent 工具（文件读写 / shell）的后端客户端。
 *
 * 执行面在 vite 中间件（运行机器）：文件读写限定 ~/.swift/workspace，
 * shell 的 cwd 也钉在那里；只读白名单命令直接执行，其余先拿 needApproval
 * 回执——由 ChatPage 弹审批卡片，用户允许后带 ack 重发才真正执行。
 */

import { tStatic } from '@/i18n';

export interface FsEntry {
  name: string;
  dir: boolean;
}

export async function fsTool(body: {
  op: 'list' | 'read' | 'write' | 'edit' | 'grep' | 'profile';
  path: string;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  /**
   * workspace（默认，可写）| swift（当前 python 环境安装的 swift 包根，只读）|
   * external（用户登记的外部数据根，只读）
   */
  root?: 'workspace' | 'swift' | 'external';
  /* read 的行范围（1-based offset + 行数；不带则整读） */
  offset?: number;
  limit?: number;
  /* grep：正则 + 命中数上限 */
  pattern?: string;
  maxResults?: number;
  /* profile：统计哪个字段的值分布（可选） */
  field?: string;
}): Promise<{
  entries?: FsEntry[];
  content?: string;
  bytes?: number;
  replaced?: number;
  /* read 行范围形态的元信息 */
  lines?: number;
  offset?: number;
  reachedEnd?: boolean;
  /* grep 结果 */
  matches?: string[];
  truncated?: boolean;
  scanned?: number;
  /* profile 结果（fieldStats 只在传 field 时给出） */
  rows?: number;
  badRows?: number;
  columns?: string[];
  samples?: string[];
  fieldStats?: { distinct: number; truncated: boolean; top: [string, number][] };
  sizeBytes?: number;
}> {
  const res = await fetch('/api/tools/fs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.toolCallFailed', { status: res.status }));
  return (await res.json()) as { entries?: FsEntry[]; content?: string; bytes?: number; replaced?: number };
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export async function shellTool(
  cmd: string,
  ack?: boolean,
): Promise<
  (ShellResult & { needApproval?: false }) | { needApproval: true; reason: string; command?: string }
> {
  const res = await fetch('/api/tools/shell', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, ...(ack ? { ack: true } : {}) }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.cmdExecFailed', { status: res.status }));
  return (await res.json()) as (ShellResult & { needApproval?: false }) | { needApproval: true; reason: string; command?: string };
}
