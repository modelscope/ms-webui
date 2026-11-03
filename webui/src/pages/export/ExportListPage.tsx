import { useCallback, useEffect, useMemo, useState } from 'react';
import { TaskListPage } from '@/components/TaskListPage';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import type { TaskItem } from '@/mock/types';
import { listExports, renameExport, stopExport, type ExportTaskInfo } from '@/api/export';
import { useT, type MessageKey } from '@/i18n';

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 操作摘要：合并 / 量化 / 推送的启用项串成一行；t 由调用方传入 */
function opSummary(task: ExportTaskInfo, t: TFn): string {
  const ops = [
    ...(task.mergeLora ? [t('exp.mergeLora')] : []),
    ...(task.quantMethod ? [t('exp.opQuant', { method: task.quantMethod })] : []),
    ...(task.pushToHub ? [t('exp.pushHub')] : []),
  ];
  return ops.join(' + ');
}

/** 后端导出状态 -> 列表页任务状态 */
function toTaskItem(task: ExportTaskInfo, t: TFn): TaskItem {
  const status = task.status === 'failed' ? 'FAILED' : task.status === 'running' ? 'RUNNING' : task.status === 'stopped' ? 'STOPPED' : 'DONE';
  return {
    id: task.id,
    type: 'export',
    label: task.name ?? `${task.adapters ?? task.model} · ${opSummary(task, t)}`,
    status,
    createdAt: task.startedAt,
    runner: 'local',
    model: task.model,
  };
}

/** 导出列表：真任务（vite 任务执行器持有的 swift export 子进程），2s 轮询。 */
export function ExportListPage() {
  const { t } = useT();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('export'), []);

  const refresh = useCallback(async () => {
    try {
      setTasks((await listExports()).map((x) => toTaskItem(x, t)));
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
        module={MODULES.export}
        tasks={tasks}
        onAssistant={() => setAssistantOpen(true)}
        options={{
          createText: t('exp.newExport'),
          sourceLabel: t('exp.sourceLabel'),
          onRefresh: refresh,
          onRename: async (id, name) => {
            await renameExport(id, name);
            await refresh();
          },
          onStop: async (id) => {
            await stopExport(id);
            await refresh();
          },
        }}
      />
      <PageAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        module={MODULES.export.key}
        tools={assistantTools}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
      />
    </>
  );
}
