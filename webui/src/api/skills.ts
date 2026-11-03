/**
 * 技能清单（GET /api/skills）的前端客户端。
 *
 * 技能在服务端解析：swift 组来自 swift 仓的 skills/（本仓开发时即时反映编辑），
 * modelscope 组来自 fetch-skills 拷进 public/ 的副本。首页把每份 SKILL.md 注入
 * system 上下文，附属文件只报路径清单。
 */

import { tStatic } from '@/i18n';

/** 一份技能。content 是 SKILL.md 全文；files 是同目录其余 markdown 的相对路径 */
export interface SkillEntry {
  group: 'swift' | 'modelscope';
  name: string;
  content: string;
  files: string[];
}

export async function listSkills(): Promise<SkillEntry[]> {
  const res = await fetch('/api/skills');
  if (!res.ok) throw new Error(tStatic('api.skillListFailed', { status: res.status }));
  const body = (await res.json()) as { skills: SkillEntry[] };
  return body.skills ?? [];
}

/** 读一份技能的附属文档（agent 的 read_skill 工具用；skill 名 + 清单里的相对路径） */
export async function readSkillDoc(skill: string, file: string): Promise<string> {
  const res = await fetch(
    `/api/skills/doc?skill=${encodeURIComponent(skill)}&file=${encodeURIComponent(file)}`,
  );
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? tStatic('api.skillDocFailed', { status: res.status }));
  return ((await res.json()) as { content: string }).content;
}

/** 组名 → 展示标签 */
const GROUP_LABEL: Record<SkillEntry['group'], string> = {
  swift: 'swift',
  modelscope: 'modelscope',
};

/**
 * 把技能清单拼成 system 注入段：每份 skill 的 SKILL.md 全文 + 附属文件清单。
 * 上限是失控保护不是日常截断：当前三份全文约 6 万字符（≈1.5 万 token），
 * 正常远够不到上限；膨胀到上限时截断并注明。
 */
export function buildSkillsSystem(skills: SkillEntry[], maxLength = 120000): string {
  if (!skills.length) return '';
  const sections = skills.map((s) =>
    [
      `### [${GROUP_LABEL[s.group]}] ${s.name}`,
      s.content.trim(),
      ...(s.files.length
        ? [
            `附属深度文档（需要 CLI 全参数、组件、插件、server-client 等细节时，用 read_skill 工具读取）: ${s.files
              .map((f) => `${s.name}/${f}`)
              .join('、')}`,
          ]
        : []),
    ].join('\n\n'),
  );
  let text = [
    '## 附带的技能文档（skills）',
    '以下是本工作台附带的技能说明，包含 swift 命令行、代码开发、组件、插件、',
    'server-client、Ray 用法与 ModelScope 平台能力。回答相关问题时应参考这些内容；',
    'SKILL.md 全文在下面，附属深度文档用 read_skill 工具按需读取。',
    '',
    ...sections,
  ].join('\n');
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n\n（技能文档过长，已截断；完整内容以工作台文件为准）`;
  }
  return text;
}
