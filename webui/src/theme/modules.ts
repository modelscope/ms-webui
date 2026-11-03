import type { MessageKey } from '@/i18n';

/**
 * 模块注册表：全站唯一的「有哪些功能模块 / 挂在哪个路由」的定义源。
 *
 * 加一个新模块 = 在这里加一项 + 在 router/routes.tsx 挂上页面，
 * 侧边导航、面包屑会自动跟随，不需要改其它文件。
 *
 * 这里不再有强调色：整站单一强调色，模块不各用一色（学 unsloth 的做法），
 * 于是那个色值就是 --primary 本身，写在 CSS 变量里，不需要每个模块各存一份。
 */
export type ModuleKey = 'chat' | 'train' | 'eval' | 'export' | 'deploy' | 'workflow' | 'research' | 'scripts' | 'plugins' | 'models';

export interface ModuleMeta {
  key: ModuleKey;
  /** 侧边栏与标题上的显示名（i18n key，消费方用 t() 渲染） */
  label: MessageKey;
  /** 路由前缀，如 /train */
  path: string;
  /** 一句话说明，显示在页头（i18n key） */
  desc: MessageKey;
}

export const MODULES: Record<ModuleKey, ModuleMeta> = {
  chat: {
    key: 'chat',
    label: 'nav.chat',
    path: '/chat',
    desc: 'nav.chat.desc',
  },
  train: {
    key: 'train',
    label: 'nav.train',
    path: '/train',
    desc: 'nav.train.desc',
  },
  eval: {
    key: 'eval',
    label: 'nav.eval',
    path: '/eval',
    desc: 'nav.eval.desc',
  },
  export: {
    key: 'export',
    label: 'nav.export',
    path: '/export',
    desc: 'nav.export.desc',
  },
  deploy: {
    key: 'deploy',
    label: 'nav.deploy',
    path: '/deploy',
    desc: 'nav.deploy.desc',
  },
  workflow: {
    key: 'workflow',
    label: 'nav.workflow',
    path: '/workflow',
    desc: 'nav.workflow.desc',
  },
  research: {
    key: 'research',
    label: 'nav.research',
    path: '/research',
    desc: 'nav.research.desc',
  },
  scripts: {
    key: 'scripts',
    label: 'nav.scripts',
    path: '/scripts',
    desc: 'nav.scripts.desc',
  },
  plugins: {
    key: 'plugins',
    label: 'nav.plugins',
    path: '/plugins',
    desc: 'nav.plugins.desc',
  },
  models: {
    key: 'models',
    label: 'nav.models',
    path: '/models',
    desc: 'nav.models.desc',
  },
};

/** 侧边导航顺序 */
export const MODULE_ORDER: ModuleKey[] = ['chat', 'train', 'eval', 'export', 'deploy', 'workflow', 'research', 'scripts', 'plugins', 'models'];

/** 根据当前 pathname 反查所属模块，找不到时回落到 chat */
export function moduleOf(pathname: string): ModuleMeta {
  const hit = MODULE_ORDER.map((k) => MODULES[k]).find(
    (m) => pathname === m.path || pathname.startsWith(m.path + '/'),
  );
  return hit ?? MODULES.chat;
}

/**
 * 任务详情页路径。各模块默认 Tab 不同，统一交给路由里的 Navigate 决定，
 * 这里只给到 /{module}/{id}；编排没有详情页，点进去是编辑器。
 *
 * 列表行、侧栏「最近」都走这个函数，避免各处各拼一份路径拼错。
 */
export function taskDetailPath(task: { type: ModuleKey; id: string }): string {
  if (task.type === 'workflow') return `/workflow/${task.id}/edit`;
  /* 脚本只有日志一个 Tab，详情直达 log（与 deploy 直达 overview 同一模式） */
  if (task.type === 'scripts') return `/scripts/${task.id}/log`;
  /* 研究详情默认看迭代账本（事件流是第二 Tab） */
  if (task.type === 'research') return `/research/${task.id}/iterations`;
  return `${MODULES[task.type].path}/${task.id}`;
}
