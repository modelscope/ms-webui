import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { TaskDetailShell, MetaCell, Panel, StatCell } from '@/components/TaskDetailShell';
import { LogViewer } from '@/components/LogViewer';
import { LineChart } from '@/components/charts/LineChart';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { useSettings } from '@/settings/SettingsContext';
import { logo } from '@/theme/theme';
import { mapTaskStatus, type TaskItem } from '@/mock/types';
import {
  getTrainLog, listTrainCheckpoints, listTrains, renameTrain, startTrain, stopTrain,
  trainCreateCommand, trainTaskLabel,
  type TrainTaskInfo,
} from '@/api/train';
import { useT } from '@/i18n';

/** 后端训练状态 -> 详情页任务状态 */
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
    /*
     * 创建命令：args 是后端创建时拼好的完整 spawn 参数（spawn 与展示同源），
     * CLI 形态把首个 -m swift.dev.cli.<taskType> 换成用户可读的命令形态展示；
     * 代码形态就是 `python <落盘文件>`。拼装逻辑见 trainCreateCommand。
     */
    createCommand: trainCreateCommand(t),
    ...(t.step !== undefined && t.totalSteps ? { step: t.step, totalSteps: t.totalSteps } : {}),
  };
}

/**
 * 训练详情。两个 Tab：指标 / 日志。曲线与进度来自任务执行器对训练日志的
 * 实时解析（tqdm 帧 -> step/totalSteps，logging 行 -> loss/lr/gradNorm），
 * 日志 Tab 轮询任务执行器的日志缓冲。
 */
export function TrainDetailPage({ tab }: { tab: 'metrics' | 'log' }) {
  const { t } = useT();
  const { id } = useParams();
  const navigate = useNavigate();
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const [infos, setInfos] = useState<TrainTaskInfo[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setInfos(await listTrains());
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
        const lines = await getTrainLog(id);
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
  const task = info ? toTaskItem(info) : undefined;
  const metrics = info?.metrics ?? [];
  const last = metrics.at(-1);

  /*
   * 一键续跑：取最新断点，以原任务同参数 + resume_from_checkpoint 起新任务
   * （parentTaskId 把血缘指回原任务）。代码形态没有结构化参数可复用，不提供。
   */
  const resumeFromCheckpoint = useCallback(
    async (taskId: string) => {
      const { resumeFrom } = await listTrainCheckpoints(taskId);
      if (!resumeFrom) {
        toast.error(t('tdl.resumeNoCheckpoint'));
        return;
      }
      const source = infos.find((x) => x.id === taskId);
      if (!source || source.taskType === 'code') {
        toast.error(t('tdl.resumeCodeUnsupported'));
        return;
      }
      const newId = await startTrain({
        model: source.model,
        datasets: source.datasets,
        taskType: source.taskType,
        ...(source.valDatasets?.length ? { valDatasets: source.valDatasets } : {}),
        tuner: source.tuner,
        ...(source.plugins.length ? { plugins: source.plugins } : {}),
        ...(source.gpus?.length ? { gpus: source.gpus } : {}),
        ...(source.gpuCount ? { gpuCount: source.gpuCount } : {}),
        params: { ...source.params, resume_from_checkpoint: resumeFrom },
        ...(source.watchMetrics?.length ? { watchMetrics: source.watchMetrics } : {}),
        ...(source.extraArgs ? { extraArgs: source.extraArgs } : {}),
        parentTaskId: taskId,
      });
      toast.success(t('tdl.resumeStarted'));
      navigate(`/train/${newId}/metrics`);
    },
    [infos, navigate, t],
  );

  const pct = info?.totalSteps ? Math.round(((info.step ?? 0) / info.totalSteps) * 100) : 0;

  /*
   * 指标序列抽提：固定键（loss/gradNorm/lr）与 extra KV 统一收进「指标名 → 点列」
   * 的 Map——日志行里出现的任意 key=value 都是一张候选曲线，不维护算法名单。
   */
  const seriesOf = useMemo(() => {
    const out = new Map<string, Array<{ x: number; y: number }>>();
    for (const m of metrics) {
      for (const [key, v] of [
        ...(m.loss !== undefined ? [['loss', m.loss] as const] : []),
        ...(m.gradNorm !== undefined ? [['grad_norm', m.gradNorm] as const] : []),
        ...(m.lr !== undefined ? [['lr', m.lr] as const] : []),
        ...Object.entries(m.extra ?? {}).map(([k, v]) => [k, v] as const),
      ]) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const pts = out.get(key) ?? [];
        pts.push({ x: m.step, y: v });
        out.set(key, pts);
      }
    }
    return out;
  }, [metrics]);
  /* 关注指标 ∩ 实际出现；未配 watchMetrics = 全部实际键。顺序：loss 优先，其余按出现序 */
  const chartKeys = useMemo(() => {
    const keys = [...seriesOf.keys()];
    const watch = info?.watchMetrics;
    const filtered = watch?.length ? keys.filter((k) => watch.includes(k)) : keys;
    return filtered.sort((a, b) => (a === 'loss' ? -1 : b === 'loss' ? 1 : 0));
  }, [seriesOf, info?.watchMetrics]);

  const metricsTab = (
    <>
      {/* 四枚指标：软底方块，不套 Card（lr 在 v5 控制台行里现在会打印；没有时诚实显 —） */}
      <div className="mb-3.5 flex flex-wrap gap-3">
        <StatCell label={t('tdl.step')} value={info?.step ?? 0} suffix={`/ ${info?.totalSteps ?? 0}`} />
        <StatCell label={t('tdl.lastLoss')} value={last?.loss !== undefined ? last.loss.toFixed(4) : '—'} />
        <StatCell label={t('tf.lr')} value={last?.lr !== undefined ? last.lr.toExponential(2) : '—'} />
        <StatCell
          label="grad norm"
          value={last?.gradNorm !== undefined ? last.gradNorm.toFixed(3) : '—'}
        />
      </div>

      {/* 进度条：细一条，不用现成的进度条组件——它只需要是一条线 */}
      {info?.totalSteps ? (
        <div className="mb-5">
          <div className="text-muted-foreground mb-1.5 flex justify-between text-[12.5px]">
            <span>{t('tdl.progress')}</span>
            <span>{pct}%</span>
          </div>
          <div className="bg-border/60 h-1 overflow-hidden rounded-full">
            {/* 用 logo 的靛色而不是 --primary：跟下面那条 loss 曲线是同一件事 */}
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${pct}%`, background: logo.indigo }}
            />
          </div>
        </div>
      ) : null}

      {metrics.length > 1 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-3.5">
          {chartKeys.map((key) => (
            <Panel key={key} title={key}>
              <LineChart
                points={seriesOf.get(key) ?? []}
                color={key === 'loss' ? logo.indigo : logo.blue}
                yLabel={key}
              />
            </Panel>
          ))}
        </div>
      ) : (
        <Panel title={t('task.metrics')}>
          <div className="text-muted-foreground py-6 text-center text-[13px]">
            {info?.status === 'running'
              ? t('tdl.waitFirst')
              : t('tdl.noMetrics')}
          </div>
        </Panel>
      )}

      <div className="text-muted-foreground mt-3.5 text-[12.5px]">
        {t('tdl.chartNote')}
        {info?.watchMetrics?.length ? t('tdl.watchNote', { n: info.watchMetrics.length }) : t('tdl.showAll')}
      </div>
    </>
  );

  const tabs = [
    { key: 'metrics', label: t('tdl.metricsTab'), content: metricsTab },
    { key: 'log', label: t('task.logs'), content: <LogViewer lines={log} /> },
  ];

  return (
    <>
      <TaskDetailShell
        module={MODULES.train}
        tasks={task ? [task] : []}
        onAssistant={() => setAssistantOpen(true)}
        tabs={tabs}
        activeTab={tab}
        extraMeta={
          <>
            <MetaCell label={t('tdl.outputDir')} value={info?.outputDir ?? ''} />
            {info?.totalSteps ? (
              <MetaCell label={t('tdl.progressMeta')} value={`${info.step ?? 0} / ${info.totalSteps} step · ${pct}%`} />
            ) : null}
          </>
        }
        onRefresh={refresh}
        onRename={
          id
            ? async (_id, name) => {
                await renameTrain(_id, name);
                await refresh();
              }
            : undefined
        }
        onStop={
          id
            ? async () => {
                await stopTrain(id);
                await refresh();
              }
            : undefined
        }
        /* 续跑：失败/被停的 CLI 形态任务才传（shell 侧非 RUNNING 即显示按钮） */
        onResume={
          id && info && (info.status === 'failed' || info.status === 'stopped') && info.taskType !== 'code'
            ? resumeFromCheckpoint
            : undefined
        }
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
