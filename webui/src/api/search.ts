/**
 * 联网搜索（Tavily）的后端客户端。
 *
 * 与模型配置同一模式：key 存运行机器的 ~/.swift/search.json（vite 中间件
 * 转发调用），前端永远只见到掩码——浏览器既不该拿到 key，也常常直连不了
 * api.tavily.com。未配 key 时服务端自动走 Tavily 的免 key 免费通道。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

/** 一条搜索结果。content 是 Tavily 清洗过的摘要，适合直接注入上下文 */
export interface SearchHit {
  title: string;
  url: string;
  content: string;
}

/** 配置态：tavilyKey 为掩码（已配置）或空串（走免 key 通道） */
export interface SearchConfig {
  tavilyKey: string;
}

export async function getSearchConfig(): Promise<SearchConfig> {
  const res = await fetch(apiBase() + '/api/search-config');
  if (!res.ok) throw new Error(tStatic('api.readSearchConfigFailed', { status: res.status }));
  return (await res.json()) as SearchConfig;
}

/** 保存 key。传空串 = 沿用已存值（与模型配置同一约定） */
export async function saveSearchKey(key: string): Promise<void> {
  const res = await fetch(apiBase() + '/api/search-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tavilyKey: key }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.saveFailed'));
}

/** 清掉 key，退回免 key 通道 */
export async function clearSearchKey(): Promise<void> {
  const res = await fetch(apiBase() + '/api/search-config', { method: 'DELETE' });
  if (!res.ok) throw new Error(tStatic('api.clearFailed', { status: res.status }));
}

/** 搜一轮：query 用用户原话，返回 top 5（服务端固定），可能为空数组 */
export async function webSearch(query: string): Promise<SearchHit[]> {
  const res = await fetch(apiBase() + '/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.json().catch(() => null);
    throw new Error(text?.error ?? tStatic('api.searchFailed', { status: res.status }));
  }
  const data = (await res.json()) as { results: SearchHit[] };
  return data.results;
}
