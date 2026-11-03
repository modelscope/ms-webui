/**
 * 跨页预填：AI 创建工具（首页对话里的 create_train 等）与目标 New 页之间
 * 的一次性传参通道。
 *
 * 走 sessionStorage 而不是路由参数：载荷是一整份表单字段（含数组和 KV），
 * 塞进 URL 既丑又撞长度上限；会话级存储天然「刷新后不复活半填表单」。
 * 读取即清——预填只该发生一次，用户中途刷新不应把旧值再盖回已改的表单。
 */

import { useEffect, useState } from 'react';
import type { ModuleKey } from '@/theme/modules';

/** 需要预填通道的模块（workflow 本轮无工具，不在此列） */
export type PrefillModule = Extract<ModuleKey, 'train' | 'eval' | 'export' | 'deploy'>;

/** 对话上下文：存在时目标页自动打开本页 AI 助手并续聊首页那段对话 */
export interface PrefillContext {
  /** 触发创建工具的用户原话（需求复述的素材） */
  userRequest: string;
  /** 发起创建的首页会话 id：目标页助手加载该会话的 turns 桶续聊 */
  conv?: string;
  /** 发起创建的模型 id：turns 按会话 × 模型分桶，续聊要加载对应桶 */
  model?: string;
}

export interface PrefillPayload {
  /** 表单字段。key 由各 New 页的预填应用逻辑约定（与页面 state 名对齐） */
  fields: Record<string, unknown>;
  context?: PrefillContext;
}

const keyOf = (module: PrefillModule) => `swift-webui-prefill.${module}`;

/*
 * 模块级载荷缓存：writePrefill 同步写入，takePrefill 优先命中。
 * 为什么需要它：usePrefill 的「读取即清」活在 useState 惰性初始化器里，
 * StrictMode 双渲染会把初始化器跑两次并保留第二次的结果——没有缓存时
 * 第一次读就把 sessionStorage 清了，第二次拿到 null，预填整份丢失。
 * 有缓存后两次调用都拿到同一份载荷；后续 mount（缓存与存储都已清）拿
 * null，一次性语义不变。writePrefill 两边同步写，下一次写入的载荷下一次
 * 挂载照样可见。
 */
const prefillCache = new Map<PrefillModule, PrefillPayload>();

/** 写入预填（AI 工具执行侧调用）；同模块的旧载荷直接覆盖 */
export function writePrefill(module: PrefillModule, payload: PrefillPayload): void {
  prefillCache.set(module, payload);
  try {
    sessionStorage.setItem(keyOf(module), JSON.stringify(payload));
  } catch {
    /* 存储被禁用等写失败：内存缓存仍在，本页会话内跳转仍能收到预填 */
  }
}

/** 读取并清除预填（目标页 mount 时调用一次）；没有载荷返回 null */
export function takePrefill(module: PrefillModule): PrefillPayload | null {
  if (prefillCache.has(module)) {
    const cached = prefillCache.get(module) ?? null;
    prefillCache.delete(module);
    return cached;
  }
  try {
    const raw = sessionStorage.getItem(keyOf(module));
    if (!raw) return null;
    sessionStorage.removeItem(keyOf(module));
    const parsed = JSON.parse(raw) as PrefillPayload;
    return parsed && typeof parsed === 'object' && parsed.fields && typeof parsed.fields === 'object'
      ? parsed
      : null;
  } catch {
    /* 载荷损坏（手改过）：当没有预填处理 */
    return null;
  }
}

/**
 * New 页的预填入口：mount 时取一次载荷（读取即清），返回给页面做字段映射。
 * 字段缺失由各页自己静默忽略——这里不做校验，校验属于页面表单语义。
 *
 * 挂载后的兜底清理：缓存命中路径不动 sessionStorage（要留给双调用的第二
 * 次），生产模式只调用一次时副本就靠这个 effect 收走，否则下次 mount 会
 * 从存储里复活已消费的预填。removeItem 幂等，双跑无害。
 */
export function usePrefill(module: PrefillModule): PrefillPayload | null {
  const [payload] = useState(() => takePrefill(module));
  useEffect(() => {
    try {
      sessionStorage.removeItem(keyOf(module));
    } catch {
      /* 存储被禁用：缓存通道已经覆盖了本页会话 */
    }
  }, [module]);
  return payload;
}

/**
 * 预填带来的助手开场白：需求复述 + 已填参数概览。
 * 概览用字段 key 原文（与 CLI flag / 表单 key 同名），不做逐模块翻译——
 * 批三助手接真模型后由模型自己组织语言，这里只保证信息完整。
 */
export function prefillIntro(moduleLabel: string, payload: PrefillPayload): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(payload.fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) lines.push(`- ${k}: ${v.join(' ')}`);
    } else if (typeof v === 'object') {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        if (iv === undefined || iv === null || iv === '') continue;
        lines.push(`- ${k}.${ik}: ${Array.isArray(iv) ? iv.join(' ') : String(iv)}`);
      }
    } else {
      lines.push(`- ${k}: ${String(v)}`);
    }
  }
  return [
    `我从首页对话里带来了你的需求：「${payload.context?.userRequest ?? ''}」`,
    '',
    '已按需求预填了这些参数：',
    ...(lines.length ? lines : ['- （模型没有给出具体字段，表单是空的）']),
    '',
    `你可以在左侧表单继续调整这份新建${moduleLabel}配置，也可以直接告诉我要改哪里。`,
    '确认无误后在页面上点启动，提交动作由你完成。',
  ].join('\n');
}
