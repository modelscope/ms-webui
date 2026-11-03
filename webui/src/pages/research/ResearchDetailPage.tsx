import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { MetaCell, TaskDetailShell } from '@/components/TaskDetailShell';
import { MODULES } from '@/theme/modules';
import type { TaskItem } from '@/mock/types';
import { getResearch, listResearch, stopResearch, type ResearchSession } from '@/api/research';
import { EVAL_MODE_LABELS, EventLogPanel, IterationsPanel } from './panels';
import { useT } from '@/i18n';
import { researchTaskItem } from './ResearchListPage';

/**
 * 研究会话详情：迭代账本 + 事件流两个 Tab，评测计划与预算进元信息条。
 * 会话本体的推进在对话侧（主模型）与服务端 watcher；这个页面是账本的
 * 可见面——用户在这里看谱系与结论，停止也只是断关联。
 */
export function ResearchDetailPage({ tab }: { tab: 'iterations' | 'events' }) {
  const { t } = useT();
  const { id } = useParams();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [session, setSession] = useState<ResearchSession | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks((await listResearch()).map(researchTaskItem));
    } catch {
      /* keep last frame */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const pull = async () => {
      try {
        const s = await getResearch(id);
        if (alive) setSession(s);
      } catch {
        /* 会话不存在或后端暂不可达：保持上一帧（列表侧会给出「找不到」兜底） */
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id]);

  if (!id) return null;
  if (!session) {
    return (
      <TaskDetailShell module={MODULES.research} tasks={tasks} tabs={[]} activeTab={tab} onRefresh={refresh} />
    );
  }

  const tabs = [
    { key: 'iterations', label: t('rs.iterationsTab'), content: <IterationsPanel s={session} /> },
    { key: 'events', label: t('rs.eventsTab'), content: <EventLogPanel s={session} /> },
  ];

  return (
    <TaskDetailShell
      module={MODULES.research}
      tasks={tasks}
      tabs={tabs}
      activeTab={tab}
      onRefresh={refresh}
      onStop={
        /* 停止只在活跃态出现（Shell 的按钮逻辑）：断 watcher 关联，训练照常 */
        async () => {
          await stopResearch(id);
          await new Promise((r) => setTimeout(r, 1000));
          await refresh();
        }
      }
      stopTooltip={t('rs.stopTooltip')}
      extraMeta={
        <>
          <MetaCell
            label={t('rs.evalPlan')}
            value={`${t(EVAL_MODE_LABELS[session.evalPlan.mode])} · ${session.evalPlan.metric.dataset} → ${
              session.evalPlan.metric.metricName
            }${session.evalPlan.metric.limit ? t('chat.evalLimit', { n: session.evalPlan.metric.limit }) : ''}`}
          />
          <MetaCell
            label={t('rs.threshold')}
            value={`${session.evalPlan.threshold}（${session.evalPlan.direction === 'higher' ? t('chat.higherBetter') : t('chat.lowerBetter')}）`}
          />
          <MetaCell label={t('rs.mainModel')} value={session.modelId} />
          <MetaCell label={t('rs.boundConv')} value={<span className="font-mono text-[12.5px]">{session.convId}</span>} />
        </>
      }
    />
  );
}
