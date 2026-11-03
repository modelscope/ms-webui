/**
 * System 提示词库：对话页的基础 system 与「研究」胶囊的 system 都从这里取。
 *
 * 状态本体存在全局设置里（Settings.systemPrompts，机器侧 ~/.swift/webui-settings.json），
 * 本文件只提供类型、两条预设和纯函数——不再自带存储。
 */

import type { MessageKey } from '@/i18n';

/** 一条命名的 system 提示词 */
export interface SystemPrompt {
  id: string;
  name: string;
  /** 出厂预设的展示名翻译 key；用户自建条目没有，展示时回落 name 原文 */
  nameKey?: MessageKey;
  text: string;
}

/** 库 + 绑定的完整状态 */
export interface SystemPromptsState {
  prompts: SystemPrompt[];
  /** 普通对话注入的 prompt id */
  baseId: string;
  /** 「研究」胶囊开启后注入的 prompt id */
  researchId: string;
}

/** 预设：最简单的通用助手 */
const DEFAULT_PROMPT: SystemPrompt = {
  id: 'default',
  name: '通用助手',
  nameKey: 'assistant.generalPersona',
  text: 'You are a helpful assistant.',
};

/** 预设：auto-research 协助（英文；研究胶囊的默认绑定） */
const AUTO_RESEARCH_PROMPT: SystemPrompt = {
  id: 'auto-research',
  name: 'Auto-Research',
  text: [
    'You are an auto-research assistant running on a Linux workstation inside the swift workbench.',
    'Your job is to help design, run, and analyze ML experiments end to end: propose hypotheses and',
    'experiment plans, prepare data and training scripts, launch and monitor runs, inspect logs and',
    'artifacts, and summarize results with concrete numbers.',
    '',
    'Act through your tools instead of guessing: read a file before modifying it, write scripts with',
    'write_file, verify conclusions with shell, and prefer measured evidence over assumptions. The',
    'bundled skill documents describe what the workbench can do (swift CLI, recipes, components,',
    'plugins, server-client, Ray) — consult them when choosing an approach.',
    '',
    'Keep iterations small, record what you tried and what happened, and report failures honestly',
    'instead of working around them.',
  ].join('\n'),
};

/** 出厂状态：两条预设 + 默认绑定 */
export const PRESET_SYSTEM_PROMPTS: SystemPromptsState = {
  prompts: [DEFAULT_PROMPT, AUTO_RESEARCH_PROMPT],
  baseId: DEFAULT_PROMPT.id,
  researchId: AUTO_RESEARCH_PROMPT.id,
};

/** send() 的消费面：从状态解出两个模式的 prompt 文本（空文本解析为空串 = 不注入）。 */
export function resolvePersona(state: SystemPromptsState): { base: string; research: string } {
  return {
    base: state.prompts.find((p) => p.id === state.baseId)?.text ?? '',
    research: state.prompts.find((p) => p.id === state.researchId)?.text ?? '',
  };
}

/** 生成不与现有条目撞车的新 id（新增 prompt 用）。 */
export function newPromptId(prompts: SystemPrompt[]): string {
  let i = prompts.length + 1;
  while (prompts.some((p) => p.id === `custom-${i}`)) i++;
  return `custom-${i}`;
}
