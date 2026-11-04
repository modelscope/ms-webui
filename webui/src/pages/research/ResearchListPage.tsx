import { useCallback, useEffect, useState } from 'react';
import { TaskListPage } from '@/components/TaskListPage';
import { MODULES } from '@/theme/modules';
import type { TaskItem } from '@/mock/types';
import { listResearch, stopResearch, deleteResearch, type ResearchSummary } from '@/api/research';
import { useT } from '@/i18n';

/**
 * 研究会话 -> 列表页任务形态。研究状态机没有 FAILED 档：训练/评测失败走事件
 * 上报主模型决策（resume 或收手），会话本身停在活跃态等决策；escalated /
 * stopped / done 都是「有结论的终态」，映射 DONE。
 */
export function researchTaskItem(s: ResearchSummary): TaskItem {
  const active =
    s.status === 'preparing' || s.status === 'training' || s.status === 'evaluating' || s.status === 'deciding';
  /*
   * 待唤醒判定与 watchResearchStall 的停摆阈值同源（30 分钟）：非终态且
   * 无任何在飞任务（stallSince 在场）超过 30 分钟 = 靠哨兵周期性叫醒的
   * 静默期，与「真在跑」分开显示——停摆数日的会话不再伪装成运行中。
   */
  const stalled = active && !!s.stallSince && Date.now() - s.stallSince >= 30 * 60_000;
  return {
    id: s.id,
    type: 'research',
    label: s.goal,
    status: stalled ? 'IDLE' : active ? 'RUNNING' : 'DONE',
    createdAt: s.createdAt,
    runner: 'local',
    model: s.baseModel,
  };
}

/**
 * 研究会话列表（autoresearch）。没有新建按钮——会话由对话里的 agent 经访谈
 * 收敛后 create_research 创建；页面的职责是可见（状态与迭代进度）、可停、可删。
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
        onDelete: deleteResearch,
        deleteDesc: t('rs.deleteDesc'),
      }}
    />
  );
}
