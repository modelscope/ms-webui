/**
 * Challenger 组件模板库的 webui 后端客户端。
 *
 * 模板库在服务端只读（webui/challenger-templates/，随 npm 包发布）；
 * install 拷进 workspace/challenger/ 后模型可 read_file/edit_file 可见
 * 可继承。护栏内置在组件里（评测集隔离 / 新目录强制 / schema 校验）。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

export interface ChallengerTemplate {
  name: string;
  desc: string;
  usage: string;
  guards: string;
}

export async function listChallengers(): Promise<ChallengerTemplate[]> {
  const res = await fetch(apiBase() + '/api/challenger');
  if (!res.ok) throw new Error(tStatic('api.loadTemplatesFailed', { status: res.status }));
  return (await res.json()).challengers;
}

/** 安装模板到 workspace/challenger/<name>.py；已存在（继承版）返回错误文案 */
export async function installChallenger(name: string): Promise<string> {
  const res = await fetch(apiBase() + '/api/challenger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? tStatic('api.installFailed'));
  return (await res.json()).path;
}
