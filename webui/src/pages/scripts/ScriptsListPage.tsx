import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TaskListPage } from '@/components/TaskListPage';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import { MODULES } from '@/theme/modules';
import { mapTaskStatus, type TaskItem } from '@/mock/types';
import { listScripts, renameScript, startScript, stopScript, type ScriptTaskInfo } from '@/api/scripts';
import { useT } from '@/i18n';

/** 后端脚本状态 -> 列表页任务状态；stopped 也是终态 */
function toTaskItem(t: ScriptTaskInfo): TaskItem {
  const status = mapTaskStatus(t.status);
  return {
    id: t.id,
    type: 'scripts',
    label: t.name ?? `${t.script}${t.args.length ? ` ${t.args.join(' ')}` : ''}`,
    status,
    createdAt: t.startedAt,
    runner: 'local',
    model: t.script,
  };
}

/**
 * 脚本任务列表：首页 agent 的 run_script 启动的后台脚本（前处理/数据分析），
 * 2s 轮询。新建页承接「已有脚本再跑/换参跑」（写新脚本在对话里找 agent）。
 */
export function ScriptsListPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /* 原始任务表：重跑要从这里拿 script/args（TaskListPage 回调只给 id） */
  const [raw, setRaw] = useState<ScriptTaskInfo[]>([]);
  /* 页面 AI 助手：任务管理工具（列出/停止/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('script'), []);

  const refresh = useCallback(async () => {
    try {
      const list = await listScripts();
      setRaw(list);
      setTasks(list.map(toTaskItem));
    } catch {
      /* 后端暂不可达时保持上一帧列表 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <TaskListPage
        module={MODULES.scripts}
        tasks={tasks}
        onAssistant={() => setAssistantOpen(true)}
        options={{
          sourceLabel: t('sc.script'),
          createText: t('sc.newScript'),
          onRefresh: refresh,
          /* 重跑：同 script/args 再起一个新任务，跳到它的日志页 */
          onRerun: async (id) => {
            const src = raw.find((x) => x.id === id);
            if (!src) throw new Error(t('sc.gone'));
            const newId = await startScript(src.script, src.args.length ? src.args : undefined);
            navigate(`/scripts/${newId}/log`);
          },
          onRename: async (id, name) => {
            await renameScript(id, name);
            await refresh();
          },
          onStop: async (id) => {
            await stopScript(id);
            await new Promise((r) => setTimeout(r, 1000));
            await refresh();
          },
        }}
      />
      <PageAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        module={MODULES.scripts.key}
        tools={assistantTools}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
      />
    </>
  );
}
