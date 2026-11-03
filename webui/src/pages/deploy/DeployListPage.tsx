import { useCallback, useEffect, useMemo, useState } from 'react';
import { TaskListPage } from '@/components/TaskListPage';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import { mapTaskStatus, type TaskItem } from '@/mock/types';
import { listDeploys, renameDeploy, stopDeploy, type DeployTaskInfo } from '@/api/deploy';
import { useT } from '@/i18n';

/** 后端部署状态 -> 列表页任务状态；starting 也算运行中（正在拉起） */
function toTaskItem(t: DeployTaskInfo): TaskItem {
  const status = mapTaskStatus(t.status);
  return {
    id: t.id,
    type: 'deploy',
    label: t.name ?? t.servedName,
    status,
    createdAt: t.startedAt,
    runner: 'local',
    model: t.model,
    endpoint: `http://127.0.0.1:${t.port}/v1`,
  };
}

/** 部署列表：真任务（vite 任务执行器持有 attached 子进程），2s 轮询。 */
export function DeployListPage() {
  const { t } = useT();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('deploy'), []);

  const refresh = useCallback(async () => {
    try {
      setTasks((await listDeploys()).map(toTaskItem));
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
        module={MODULES.deploy}
        tasks={tasks}
        onAssistant={() => setAssistantOpen(true)}
        options={{
          createText: t('dp.newDeploy'),
          sourceLabel: t('tn.modelLabel'),
          showEndpoint: true,
          onRefresh: refresh,
          onRename: async (id, name) => {
            await renameDeploy(id, name);
            await refresh();
          },
          onStop: async (id) => {
            await stopDeploy(id);
            await new Promise((r) => setTimeout(r, 1500));
            await refresh();
          },
        }}
      />
      <PageAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        module={MODULES.deploy.key}
        tools={assistantTools}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
      />
    </>
  );
}
