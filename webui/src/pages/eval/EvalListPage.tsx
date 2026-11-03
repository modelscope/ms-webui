import { useCallback, useEffect, useMemo, useState } from 'react';
import { TaskListPage } from '@/components/TaskListPage';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import type { TaskItem } from '@/mock/types';
import { listEvals, renameEval, stopEval, type EvalTaskInfo } from '@/api/eval';
import { useT, type MessageKey } from '@/i18n';

/** 后端评测状态 -> 列表页任务状态；starting 也算运行中（正在启动链）；t 由调用方传入 */
function toTaskItem(task: EvalTaskInfo, t: (key: MessageKey, vars?: Record<string, string | number>) => string): TaskItem {
  const status =
    task.status === 'failed' ? 'FAILED' : task.status === 'done' ? 'DONE' : task.status === 'stopped' ? 'STOPPED' : 'RUNNING';
  return {
    id: task.id,
    type: 'eval',
    label: task.name ?? `${task.modelId} · ${task.items.map((it) => (it.limit ? `${it.dataset}(${it.limit})` : it.dataset)).join(' + ')}`,
    status,
    createdAt: task.startedAt,
    runner: 'local',
    model: task.modelId,
  };
}

/** 评测列表：真任务（vite 任务执行器逐集串行执行），2s 轮询。 */
export function EvalListPage() {
  const { t } = useT();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('eval'), []);

  const refresh = useCallback(async () => {
    try {
      setTasks((await listEvals()).map((x) => toTaskItem(x, t)));
    } catch {
      /* 后端暂不可达时保持上一帧列表 */
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <TaskListPage
        module={MODULES.eval}
        tasks={tasks}
        onAssistant={() => setAssistantOpen(true)}
        options={{
          createText: t('ev.newEval'),
          sourceLabel: t('ev.modelUnderTest'),
          showProgress: true,
          onRefresh: refresh,
          onRename: async (id, name) => {
            await renameEval(id, name);
            await refresh();
          },
          onStop: async (id) => {
            await stopEval(id);
            await new Promise((r) => setTimeout(r, 1500));
            await refresh();
          },
        }}
      />
      <PageAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        module={MODULES.eval.key}
        tools={assistantTools}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
      />
    </>
  );
}
