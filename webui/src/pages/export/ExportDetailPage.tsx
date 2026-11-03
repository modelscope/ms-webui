import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { Rocket } from 'lucide-react';
import { TaskDetailShell, ArtifactRow, MetaCell, Panel, ActionButton, StatCell } from '@/components/TaskDetailShell';
import { CodeLine } from '@/components/CodeBlock';
import { LogViewer } from '@/components/LogViewer';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import type { TaskItem } from '@/mock/types';
import { getExportLog, listExports, renameExport, stopExport, type ExportTaskInfo } from '@/api/export';
import { useT, type MessageKey } from '@/i18n';

/** 字节数 -> 人类可读（B/KB/MB/GB），产物表用 */
function formatSize(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(2)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** 操作摘要：合并 / 量化 / 推送的启用项串成一行；t 由调用方传入 */
function opSummary(task: ExportTaskInfo, t: TFn): string {
  const ops = [
    ...(task.mergeLora ? [t('exp.mergeLora')] : []),
    ...(task.quantMethod ? [t('exp.opQuant', { method: task.quantMethod })] : []),
    ...(task.pushToHub ? [t('exp.pushHub')] : []),
  ];
  return ops.join(' + ') || t('exp.noOp');
}

/** 后端导出状态 -> 详情页任务状态 */
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
    /*
     * 创建命令：与任务执行器实际 spawn 的参数一致（那里用 python -m
     * swift.dev.cli.export 等价于 swift export，环境变量钉 v5 路由）。
     */
    createCommand: [
      ...(task.gpus?.length ? [`CUDA_VISIBLE_DEVICES=${task.gpus.join(',')}`] : []),
      'USE_SWIFT_V5=1 swift export',
      ...[
        `--model ${task.model}`,
        ...(task.adapters ? [`--adapters ${task.adapters}`] : []),
        ...(task.mergeLora ? ['--merge_lora true'] : []),
        ...(task.quantMethod
          ? [`--quant_method ${task.quantMethod}`, `--quant_bits ${task.quantMethod === 'bnb' ? 8 : 4}`]
          : []),
        ...(task.calibDataset ? [`--dataset ${task.calibDataset}`] : []),
        ...(task.pushToHub
          ? ['--push_to_hub true', ...(task.hubModelId ? [`--hub_model_id ${task.hubModelId}`] : [])]
          : []),
        ...(task.plugins?.length ? [`--external_plugins ${task.plugins.join(' ')}`] : []),
        ...(task.extraArgs ? [task.extraArgs] : []),
        `--output_dir ${task.outputDir}`,
      ].map((arg) => `    ${arg}`),
    ].join(' \\\n'),
  };
}

/**
 * 导出详情。产物 Tab 把导出拆成可见的几步（加载 / 合并 / 量化 / 写出 / 推送）
 * 并列出产物目录的文件清单；日志 Tab 轮询任务执行器的日志缓冲。
 */
export function ExportDetailPage({ tab }: { tab: 'artifact' | 'log' }) {
  const { t } = useT();
  const { id } = useParams();
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('export'), []);
  const navigate = useNavigate();
  const [infos, setInfos] = useState<ExportTaskInfo[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setInfos(await listExports());
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
        const lines = await getExportLog(id);
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
  const done = info?.status === 'done';

  /* 步骤流水按本任务实际启用的操作渲染；无步骤级进度，未完成统一不勾 */
  const steps = [
    {
      title: t('exp.stepLoad'),
      desc: info?.adapters ? `${info.model} + ${info.adapters}` : (info?.model ?? ''),
    },
    ...(info?.mergeLora ? [{ title: t('exp.mergeLabel'), desc: t('exp.stepMergeDesc') }] : []),
    ...(info?.quantMethod
      ? [
          {
            title: t('exp.stepQuant', { method: info.quantMethod }),
            desc: `int${info.quantMethod === 'bnb' ? 8 : 4}${info.calibDataset ? t('exp.calibSuffix', { dataset: info.calibDataset }) : ''}`,
          },
        ]
      : []),
    { title: t('exp.stepWrite'), desc: info?.outputDir ?? '' },
    ...(info?.pushToHub ? [{ title: t('exp.secHub'), desc: info.hubModelId ?? '' }] : []),
  ];

  const artifactTab = (
    <>
      {info && (
        <div className="mb-4 flex flex-wrap gap-3">
          <StatCell
            label={t('exp.status')}
            value={done ? t('task.done') : info.status === 'failed' ? t('task.failed') : info.status === 'stopped' ? t('task.stopped') : t('exp.stExporting')}
          />
          <StatCell label={t('exp.baseModel')} value={info.model} />
          <StatCell label={t('exp.secOps')} value={opSummary(info, t)} />
        </div>
      )}
      <Panel title={t('exp.steps')}>
        {steps.map((s) => (
          <ArtifactRow key={s.title} title={s.title} desc={s.desc} done={done} />
        ))}
      </Panel>
      <div className="mt-3.5">
        <Panel title={t('exp.outputDir')}>
          <CodeLine text={info?.outputDir ?? ''} label={t('exp.copyPath')} />
          {done ? (
            <>
              <div className="mt-3 border-t pt-2">
                {(info?.artifacts ?? []).map((f) => (
                  <div
                    key={f.name}
                    className="border-border/60 text-[13px] flex items-baseline justify-between border-t py-1.5 first:border-t-0"
                  >
                    <span className="text-foreground/80 truncate font-mono text-[12.5px]">{f.name}</span>
                    <span className="text-muted-foreground tabular-nums flex-none ps-4">{formatSize(f.size)}</span>
                  </div>
                ))}
                {!info?.artifacts?.length && (
                  <div className="text-muted-foreground py-2 text-[13px]">{t('exp.emptyDir')}</div>
                )}
              </div>
              <div className="text-muted-foreground mt-2.5 text-[12.5px]">
                {t('exp.dirReady')}
              </div>
            </>
          ) : (
            <div className="text-muted-foreground mt-2.5 text-[12.5px]">
              {info?.status === 'running'
                ? t('exp.stillRunning')
                : t('exp.notDone')}
            </div>
          )}
        </Panel>
      </div>
    </>
  );

  const tabs = [
    { key: 'artifact', label: t('exp.artifactTab'), content: artifactTab },
    { key: 'log', label: t('task.logs'), content: <LogViewer lines={log} /> },
  ];

  return (
    <>
      <TaskDetailShell
        module={MODULES.export}
        tasks={task ? [task] : []}
        onAssistant={() => setAssistantOpen(true)}
        tabs={tabs}
        activeTab={tab}
        extraMeta={<MetaCell label={t('exp.outputDir')} value={info?.outputDir ?? ''} />}
        onRefresh={refresh}
        onRename={
          id
            ? async (_id, name) => {
                await renameExport(_id, name);
                await refresh();
              }
            : undefined
        }
        onStop={
          id
            ? async () => {
                await stopExport(id);
                await refresh();
              }
            : undefined
        }
        actions={
          done && info ? (
            <ActionButton
              icon={<Rocket />}
              tone="primary"
              tooltip={t('exp.deployTip')}
              onClick={() => navigate(`/deploy/new?model=${encodeURIComponent(info.outputDir)}`)}
            >
              {t('exp.goDeploy')}
            </ActionButton>
          ) : null
        }
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
