/**
 * 技能清单（GET /api/skills）的前端客户端。
 *
 * 技能在服务端解析：swift 组来自 swift 仓的 skills/（本仓开发时即时反映编辑），
 * modelscope 组来自 fetch-skills 拷进 public/ 的副本。system 注入采用索引式
 * 按需展开：每份技能只常驻一行用途说明（frontmatter description），正文
 * （SKILL.md 主文档与附属文档）经 read_skill 工具按需读取。
 */

import { apiBase } from './base';
import { tStatic } from '../i18n/static';

/** 一份技能。description 是 frontmatter 的一行用途说明；content 是 SKILL.md 全文 */
export interface SkillEntry {
  group: 'swift' | 'modelscope';
  name: string;
  description: string;
  content: string;
  files: string[];
}

/** 一页技能文档（行窗口，与 fs read 同语义） */
export interface SkillDocPage {
  content: string;
  offset: number;
  lines: number;
  reachedEnd: boolean;
}

export async function listSkills(): Promise<SkillEntry[]> {
  const res = await fetch(apiBase() + '/api/skills');
  if (!res.ok) throw new Error(tStatic('api.skillListFailed', { status: res.status }));
  const body = (await res.json()) as { skills: SkillEntry[] };
  return body.skills ?? [];
}

/**
 * 读一份技能的文档（agent 的 read_skill 工具用）：SKILL.md 主文档或附属 .md。
 * offset/limit 是行窗口（默认前 200 行、上限 2000）——主文档可达几万字符，
 * 整读会一次灌穿上下文。
 */
export async function readSkillDoc(
  skill: string,
  file: string,
  opts?: { offset?: number; limit?: number },
): Promise<SkillDocPage> {
  /* agent 的 read_skill 工具在引擎（node）侧同用：必须过 apiBase 拼绝对地址 */
  const res = await fetch(
    `${apiBase()}/api/skills/doc?skill=${encodeURIComponent(skill)}&file=${encodeURIComponent(file)}` +
      `${opts?.offset ? `&offset=${opts.offset}` : ''}` +
      `${opts?.limit ? `&limit=${opts.limit}` : ''}`,
  );
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.skillDocFailed', { status: res.status }));
  return (await res.json()) as SkillDocPage;
}

/** 组名 → 展示标签 */
const GROUP_LABEL: Record<SkillEntry['group'], string> = {
  swift: 'swift',
  modelscope: 'modelscope',
};

/** description 缺失时的兜底：SKILL.md 正文（去 frontmatter）前 240 字符 */
function fallbackDescription(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return body ? `${body.slice(0, 240)}${body.length > 240 ? '…' : ''}` : '（无描述——读主文档了解用途）';
}

/**
 * 把技能清单拼成 system 注入段：索引式按需展开。每份 skill 只注入一行用途
 * 说明 + 可读文档清单；正文全部经 read_skill 工具读取（主文档 path 形如
 * "swift-usage/SKILL.md"，长文带 offset/limit 分段）。
 *
 * 此前的全文常驻形态（三份 SKILL.md 合计约 6 万字符 ≈ 1.5 万 token）长期
 * 占据上下文预算——压缩阈值被迫扣掉它、每轮请求都被顶大，长会话下大段常驻
 * 指令还会加剧模型「刚收到指令、没有进行中任务」的错觉。索引把常驻面压到
 * 千字符级。上限仍是失控保护不是日常截断。
 */
export function buildSkillsSystem(skills: SkillEntry[], maxLength = 120000): string {
  if (!skills.length) return '';
  const sections = skills.map((s) => {
    const desc = s.description.trim() || fallbackDescription(s.content);
    const docs = [
      `主文档：${s.name}/SKILL.md`,
      ...(s.files.length
        ? [`附属深度文档（CLI 全参数、组件、插件、server-client、平台操作等）：${s.files.map((f) => `${s.name}/${f}`).join('、')}`]
        : []),
    ].join('\n');
    return [`### [${GROUP_LABEL[s.group]}] ${s.name}`, `用途：${desc}`, `可读文档（用 read_skill 工具，长文带 offset/limit 分段）：\n${docs}`].join('\n');
  });
  let text = [
    '## 附带的技能（skills，索引式按需展开）',
    '本工作台附带以下技能；上下文里只保留每份的一行用途说明，正文不常驻。',
    '当前任务命中某份技能的用途描述时，先用 read_skill 读它的主文档',
    '（path 形如 "swift-usage/SKILL.md"），再按其中指引读附属深度文档——',
    '回答 swift 用法、插件开发、自定义数据集、ModelScope 平台操作等问题前',
    '先查对应技能，不要凭记忆或 swift --help 猜测。',
    '',
    ...sections,
  ].join('\n');
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n\n（技能索引过长，已截断；完整清单以工作台文件为准）`;
  }
  return text;
}
