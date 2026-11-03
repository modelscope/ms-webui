import { useCallback, useEffect, useState } from 'react';
import { TaskListPage } from '@/components/TaskListPage';
import { MODULES } from '@/theme/modules';
import type { TaskItem } from '@/mock/types';
import { listResearch, stopResearch, type ResearchSummary } from '@/api/research';
import { useT } from '@/i18n';

/**
 * 研究会话 -> 列表页任务形态。研究状态机没有 FAILED 档：训练/评测失败走事件
 * 上报主模型决策（resume 或收手），会话本身停在活跃态等决策；escalated /
 * stopped / done 都是「有结论的终态」，映射 DONE。
 */
export function researchTaskItem(s: ResearchSummary): TaskItem {
  const active =
    s.status === 'preparing' || s.status === 'training' || s.status === 'evaluating' || s.status === 'deciding';
  return {
    id: s.id,
    type: 'research',
    label: s.goal,
    status: active ? 'RUNNING' : 'DONE',
    createdAt: s.createdAt,
    runner: 'local',
    model: s.baseModel,
  };
}

/**
 * 研究会话列表（autoresearch）。没有新建按钮——会话由对话里的 agent 经访谈
 * 收敛后 create_research 创建；页面的职责是可见（状态与迭代进度）与可停。
 */
export function ResearchListPage() {
  const { t } = useT();
  const [tasks, setTasks] = useState<TaskItem[]>([]);

  const refresh = useCallback(async () => {
    try {
      setTasks((await listResearch()).map(researchTaskItem));
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
    <TaskListPage
      module={MODULES.research}
      tasks={tasks}
      options={{
        sourceLabel: t('rs.sourceModel'),
        onRefresh: refresh,
        onStop: stopResearch,
        stopDesc: t('rs.stopDesc'),
      }}
    />
  );
}
