/**
 * 运行环境（GET /api/env）的前端客户端：GPU 清单 + swift 版本/安装路径 +
 * python 解释器。agent 的 env_info 工具用——规划训练/部署的用卡与分片前
 * 一次拿全环境事实，免得模型拿 shell 命令一条条试探。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

export interface EnvInfo {
  gpus: { index: number; name: string; used: number; total: number }[];
  python: string;
  swift: { version: string; path: string } | null;
  /** evalscope 安装探测（null = 未装）：模型搭评测链前先看这里 */
  evalscope: { version: string } | null;
  /**
   * evalscope 基准注册表：名 → subset 值域（--eval_dataset 的合法名 +
   * subset_list 可选值；null = 探测不可达）。subset 经 --eval_dataset_args 透传。
   */
  benchmarks: Record<string, string[]> | null;
  /** 模型缓存根目录（MODELSCOPE_CACHE 可改默认位置） */
  modelCache: string;
  /** 已落本机缓存的模型（org/name 形态）：起 vllm/部署需要磁盘权重路径 */
  cachedModels: string[];
}

export async function envInfo(): Promise<EnvInfo> {
  const res = await fetch(apiBase() + '/api/env');
  if (!res.ok) throw new Error(tStatic('api.readEnvFailed', { status: res.status }));
  return (await res.json()) as EnvInfo;
}
