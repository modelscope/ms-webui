import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { TaskDetailShell, Panel, StatCell } from '@/components/TaskDetailShell';
import { CodeBlock } from '@/components/CodeBlock';
import { LogViewer } from '@/components/LogViewer';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import { mapTaskStatus, type TaskItem } from '@/mock/types';
import { getEvalLog, listEvals, renameEval, stopEval, type EvalReportRow, type EvalTaskInfo } from '@/api/eval';
import { useT, type MessageKey } from '@/i18n';

/** 后端评测状态 -> 详情页任务状态 */
function toTaskItem(task: EvalTaskInfo, t: (key: MessageKey, vars?: Record<string, string | number>) => string): TaskItem {
  const status = mapTaskStatus(task.status);
  return {
    id: task.id,
    type: 'eval',
    label: task.name ?? `${task.modelId} · ${t('ev.itemCount', { n: task.items.length })}`,
    status,
    createdAt: task.startedAt,
    runner: 'local',
    model: task.modelId,
    /*
     * 创建命令：与任务执行器实际 spawn 的参数一致。逐集一条（每集独立的
     * swift eval 调用是 per-dataset limit 的实现方式），可分别复制执行；
     * 插件与附加参数对每个评测集都生效。
     */
    createCommand: task.items
      .map(
        (it) =>
          `USE_SWIFT_V5=1 swift eval \\\n` +
          `    --model ${task.model} \\\n` +
          `    --eval_url ${task.baseUrl} \\\n` +
          `    --eval_dataset ${it.dataset}` +
          (it.limit ? ` \\\n    --eval_limit ${it.limit}` : '') +
          (task.plugins?.length ? ` \\\n    --external_plugins ${task.plugins.join(' ')}` : '') +
          (task.extraArgs ? ` \\\n    ${task.extraArgs}` : ''),
      )
      .join('\n\n'),
  };
}

/**
 * 评测详情。结果 Tab 给逐集的分数报告（EvalScope Native 的报告行），
 * 日志 Tab 轮询任务执行器的日志缓冲。
 */
export function EvalDetailPage({ tab }: { tab: 'result' | 'log' }) {
  const { t } = useT();
  const { id } = useParams();
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('eval'), []);
  const [infos, setInfos] = useState<EvalTaskInfo[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setInfos(await listEvals());
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
    if (tab !== 'log' || !id) return;
    let alive = true;
    const pull = async () => {
      try {
        const lines = await getEvalLog(id);
        if (alive) setLog(lines);
      } catch {
        /* keep last frame */
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tab, id]);

  const info = infos.find((x) => x.id === id);
  const task = info ? toTaskItem(info, t) : undefined;
  const finished = info?.status === 'done' || info?.status === 'stopped' || info?.status === 'failed';

  /*
   * 单集报告：EvalScope Native 行的定向渲染——头部给模型名与总分，
   * 正文按 metric 逐行（name / 样本数 / 分数）。行里的长文本描述与嵌套
   * categories 不属于分数本体，不渲染。
   */
  const datasetPanel = (dataset: string, rows: EvalReportRow[]) => (
    <Panel key={dataset} title={dataset}>
      {rows.map((row, i) => (
        <div key={i} className="border-border/60 divide-border/60 divide-y border-b last:border-b-0">
          <div className="text-foreground/70 flex items-baseline justify-between py-1.5 text-[13px]">
            <span>{row.model_name ?? row.name ?? dataset}</span>
            <span className="text-foreground tabular-nums font-medium">
              {typeof row.score === 'number' ? row.score : '-'}
            </span>
          </div>
          {(row.metrics ?? []).map((m, j) => (
            <div key={j} className="text-muted-foreground grid grid-cols-[1fr_auto_auto] gap-4 py-1.5 text-[13px]">
              <span>{m.name ?? `metric ${j + 1}`}</span>
              <span className="tabular-nums">{t('ev.samples', { n: m.num ?? '-' })}</span>
              <span className="text-foreground tabular-nums">{typeof m.score === 'number' ? m.score : '-'}</span>
            </div>
          ))}
        </div>
      ))}
    </Panel>
  );

  const resultTab = (
    <>
      {info && (
        <div className="mb-4 flex flex-wrap gap-3">
          <StatCell
            label={t('exp.status')}
            value={info.status === 'done' ? t('task.done') : info.status === 'failed' ? t('task.failed') : info.status === 'stopped' ? t('task.stopped') : t('ev.stProgress', { cur: info.current + 1, total: info.items.length })}
          />
          <StatCell label={t('ev.modelUnderTest')} value={info.modelId} />
          <StatCell label={t('ev.datasetCount')} value={String(info.items.length)} />
        </div>
      )}
      {info?.report?.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] items-start gap-3.5">
          {info.report.map((r) => datasetPanel(r.dataset, r.rows))}
        </div>
      ) : (
        <Panel title={t('ev.report')}>
          <div className="text-muted-foreground py-6 text-center text-[13px]">
            {finished ? t('ev.noReport') : t('ev.running')}
          </div>
        </Panel>
      )}
    </>
  );

  const tabs = [
    { key: 'result', label: t('ev.resultTab'), content: resultTab },
    { key: 'log', label: t('task.logs'), content: <LogViewer lines={log} /> },
  ];

  return (
    <>
      <TaskDetailShell
        module={MODULES.eval}
        tasks={task ? [task] : []}
        onAssistant={() => setAssistantOpen(true)}
        tabs={tabs}
        activeTab={tab}
        onRefresh={refresh}
        onRename={
          id
            ? async (_id, name) => {
                await renameEval(_id, name);
                await refresh();
              }
            : undefined
        }
        onStop={
          id
            ? async (stopId) => {
                await stopEval(stopId);
                await refresh();
              }
            : undefined
        }
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
