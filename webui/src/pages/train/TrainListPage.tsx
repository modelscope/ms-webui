import { useCallback, useEffect, useState } from 'react';
import { TaskListPage } from '@/components/TaskListPage';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { useSettings } from '@/settings/SettingsContext';
import { mapTaskStatus, type TaskItem } from '@/mock/types';
import { listTrains, renameTrain, stopTrain, trainTaskLabel, type TrainTaskInfo } from '@/api/train';
import { useT } from '@/i18n';

/** 后端训练状态 -> 列表页任务状态 */
function toTaskItem(t: TrainTaskInfo): TaskItem {
  const status = mapTaskStatus(t.status);
  /* 远端形态（mode=remote）显示 server 地址：如实展示这轮训练跑在哪 */
  const serverUrl =
    t.params.mode === 'remote' && t.params.server_base_url ? String(t.params.server_base_url) : undefined;
  return {
    id: t.id,
    type: 'train',
    label: trainTaskLabel(t),
    status,
    createdAt: t.startedAt,
    runner: 'local',
    model: t.model,
    ...(serverUrl ? { serverUrl } : {}),
    /* 进度来自日志解析的 tqdm 帧；没有时 totalSteps 为空、列表只显示状态 */
    ...(t.step !== undefined && t.totalSteps ? { step: t.step, totalSteps: t.totalSteps } : {}),
  };
}

/** 训练列表：真任务（vite 任务执行器持有的 swift sft 子进程），2s 轮询。 */
export function TrainListPage() {
  const { t } = useT();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();

  const refresh = useCallback(async () => {
    try {
      setTasks((await listTrains()).map(toTaskItem));
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
        module={MODULES.train}
        tasks={tasks}
        onAssistant={() => setAssistantOpen(true)}
        options={{
          createText: t('tn.newTrain'),
          sourceLabel: t('tdl.sourceModel'),
          showProgress: true,
          showCompare: true,
          showMetrics: true,
          onRefresh: refresh,
          onRename: async (id, name) => {
            await renameTrain(id, name);
            await refresh();
          },
          onStop: async (id) => {
            await stopTrain(id);
            await refresh();
          },
        }}
      />
      <PageAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        module={MODULES.train.key}
        toolNames={['task:train']}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
      />
    </>
  );
}
