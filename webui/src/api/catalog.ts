/**
 * 新建页候选清单（模型/数据集）：真相源是 swift 的两个注册表——
 * MODEL_MAPPING 展开的全部 hub id 与 DATASET_MAPPING 的数据集 id（后端
 * spawn python 探测一次并缓存，swift 新增模型后重启 webui 即自动出现），
 * 另并入本机 modelscope 缓存里已下载的模型。清单是「捷径不是白名单」——
 * SearchSelect/TagInput 都接受任意自由输入（本地路径、清单外的 hub id）。
 */

import { tStatic } from '@/i18n';

/** 一条候选：id 是落进命令行的值，modelType/tags 仅辅助展示 */
export interface CatalogEntry {
  id: string;
  /** 模型：注册表里的 model_type */
  modelType?: string;
  tags: string[];
  /** 注册表里没有、只在本机缓存里的模型 */
  cached?: boolean;
}

export async function listCatalog(): Promise<{ models: CatalogEntry[]; datasets: CatalogEntry[] }> {
  const res = await fetch('/api/catalog');
  if (!res.ok) throw new Error(tStatic('api.readCatalogFailed', { status: res.status }));
  return await res.json();
}

/** 模型条目 -> 搜索下拉候选（hint 显示 model_type 与能力标签） */
export function modelOption(m: CatalogEntry): { value: string; hint?: string } {
  if (m.cached) return { value: m.id, hint: tStatic('api.cached') };
  const hint = [m.modelType, ...m.tags.slice(0, 2)].filter(Boolean).join(' · ');
  return { value: m.id, ...(hint ? { hint } : {}) };
}

/** 数据集条目 -> 搜索下拉候选（hint 显示标签，🔥 即 legacy docs 标的重要数据集） */
export function datasetOption(d: CatalogEntry): { value: string; hint?: string } {
  const hint = d.tags.slice(0, 3).join(' · ');
  return { value: d.id, ...(hint ? { hint } : {}) };
}
