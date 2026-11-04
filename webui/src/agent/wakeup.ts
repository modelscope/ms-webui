/**
 * 唤醒事件的合成消息：页面（ChatPage 双泵）与 server 侧 headless runner
 * 共用——同一份文本形态保证「浏览器驱动」与「server 驱动」的模型视角一致。
 */
import type { ResearchSession } from '../api/research';

/*
 * autoresearch 事件唤醒的合成消息：多条事件合并成一条 user 消息（页面关闭
 * 期间积压的在重开时一次交付）。末尾一行行动引导补齐语境——事件到达时
 * 对话里可能没有过任何研究相关的上下文。
 */
export function composeWakeupMessage(s: ResearchSession, events: ResearchSession['events']): string {
  return [
    `[autoresearch 唤醒] 研究会话 ${s.id} · ${s.goal}`,
    ...events.map((e) => `- [${e.kind}] ${e.text}`),
    '按 autoresearch 指引决策：先读最新 session 再动账本；未达标走 Challenger 迭代或 resume，需要用户拍板就直接问。',
  ].join('\n');
}

/** 脚本完成事件的合成消息（研究/代码模式的后台脚本；headless 与页面同构） */
export function composeScriptWakeupMessage(events: { text: string; modelId?: string }[]): string {
  return events.map((e) => `[脚本事件] ${e.text}`).join('\n\n');
}
