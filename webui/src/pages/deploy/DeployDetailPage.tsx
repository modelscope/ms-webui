import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { TaskDetailShell, ArtifactRow, MetaCell, Panel, ActionButton, StatCell } from '@/components/TaskDetailShell';
import { CodeBlock } from '@/components/CodeBlock';
import { LogViewer } from '@/components/LogViewer';
import { MODULES } from '@/theme/modules';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import { mapTaskStatus, type TaskItem } from '@/mock/types';
import { getDeployLog, listDeploys, renameDeploy, stopDeploy, type DeployTaskInfo } from '@/api/deploy';
import { useT } from '@/i18n';

/** 后端部署状态 -> 详情页任务状态 */
function toTaskItem(t: DeployTaskInfo): TaskItem {
  const status = mapTaskStatus(t.status);
  /* 卡数：本机模式取卡号数，集群模式取声明的卡数；进 --nproc_per_node */
  const nproc = t.gpus?.length ?? t.gpuCount ?? 0;
  return {
    id: t.id,
    type: 'deploy',
    label: t.name ?? t.servedName,
    status,
    createdAt: t.startedAt,
    runner: 'local',
    model: t.model,
    endpoint: `http://127.0.0.1:${t.port}/v1`,
    /*
     * 创建命令：与 vite 任务执行器实际 spawn 的参数一致（那里用
     * python -m swift.dev.cli.deploy 等价于 swift deploy，环境变量钉 v5 路由），
     * 用户复制到终端即可复现同一服务。本机模式带 CUDA_VISIBLE_DEVICES 前缀，
     * 集群模式只给卡数（远端卡由集群调度）；卡数进 --nproc_per_node（Ray
     * 据此给 sampler 分 N 张卡，张量并行由引擎从可见卡自动推出）。
     */
    createCommand: [
      ...(t.gpus?.length ? [`CUDA_VISIBLE_DEVICES=${t.gpus.join(',')}`] : []),
      'USE_SWIFT_V5=1 swift deploy',
      ...[
        `--model ${t.model}`,
        `--infer_backend ${t.engine}`,
        `--served_model_name ${t.servedName}`,
        ...(t.adapters?.length ? [`--adapters ${t.adapters.join(' ')}`] : []),
        `--port ${t.port}`,
        ...(nproc > 1 ? [`--nproc_per_node ${nproc}`] : []),
        ...(t.plugins?.length ? [`--external_plugins ${t.plugins.join(' ')}`] : []),
        ...(t.extraArgs ? [t.extraArgs] : []),
      ].map((arg) => `    ${arg}`),
    ].join(' \\\n'),
  };
}

/**
 * 部署详情。概览 Tab 给服务地址与开箱即用的调用示例（这是部署完最想拿到的东西），
 * 日志 Tab 轮询任务执行器的日志缓冲。
 */
export function DeployDetailPage({ tab }: { tab: 'overview' | 'log' }) {
  const { t } = useT();
  const { id } = useParams();
  /* 页面 AI 助手：任务管理工具（列出/停止/删除/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('deploy'), []);
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [infos, setInfos] = useState<DeployTaskInfo[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const infos = await listDeploys();
      setTasks(infos.map(toTaskItem));
      setInfos(infos);
      setRunning(infos.some((x) => x.id === id && x.status === 'running'));
      const current = infos.find((x) => x.id === id);
      if (current?.status === 'failed' || current?.status === 'stopped') setRunning(false);
    } catch {
      /* keep last frame */
    }
  }, [id]);

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
        const lines = await getDeployLog(id);
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

  const task = tasks.find((x) => x.id === id);
  const info = infos.find((x) => x.id === id);
  const base = task?.endpoint ?? 'http://127.0.0.1:8000/v1';
  const modelName = task?.label ?? 'model';

  const curl = `curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "messages": [{"role": "user", "content": "${t('dp.hello')}"}]
  }'`;

  const python = `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="EMPTY")
resp = client.chat.completions.create(
    model="${modelName}",
    messages=[{"role": "user", "content": "${t('dp.hello')}"}],
)
print(resp.choices[0].message.content)`;

  const overviewTab = (
    <>
      <div className="mb-4 flex flex-wrap gap-3">
        <StatCell label={t('dp.serviceStatus')} value={running ? t('dp.online') : task?.status === 'FAILED' ? t('task.failed') : t('task.stopped')} />
        <StatCell label={t('dp.engineLabel')} value={info?.engine ?? '—'} />
        <StatCell
          label="GPU"
          value={info?.gpus?.join(', ') ?? (info?.gpuCount ? t('dp.clusterCards', { n: info.gpuCount }) : t('dp.allVisible'))}
        />
        <StatCell label={t('dp.port')} value={task ? String(base.split(':').pop()) : '—'} />
      </div>

      {/* auto-fit + minmax：宽屏两段示例并排，窗口窄了自动堆成上下，不靠断点 */}
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]">
        <Panel title="curl">
          <CodeBlock code={curl} />
        </Panel>
        <Panel title={t('dp.pythonPanel')}>
          <CodeBlock code={python} />
        </Panel>
      </div>

      <div className="mt-3.5">
        <Panel title={t('dp.serverParams')}>
          <ArtifactRow
            done={running}
            title={t('dp.openapiRow')}
            desc={running ? `${base} · model = ${modelName}` : `${base}${t('dp.offlineSuffix')}`}
          />
          <ArtifactRow
            done={running}
            title={t('dp.registryRow')}
            desc={running ? t('dp.registered') : t('dp.unregistered')}
          />
        </Panel>
      </div>
    </>
  );

  const tabs = [
    { key: 'overview', label: t('dp.overviewTab'), content: overviewTab },
    { key: 'log', label: t('task.logs'), content: <LogViewer lines={log} /> },
  ];

  return (
    <>
      <TaskDetailShell
        module={MODULES.deploy}
        tasks={tasks}
        onAssistant={() => setAssistantOpen(true)}
        tabs={tabs}
        activeTab={tab}
        extraMeta={<MetaCell label={t('dp.protocol')} value={t('dp.protocolVal')} />}
        onRefresh={refresh}
        onRename={
          id
            ? async (_id, name) => {
                await renameDeploy(_id, name);
                await refresh();
              }
            : undefined
        }
        onStop={
          id
            ? async () => {
                await stopDeploy(id);
                toast.success(t('task.stopToast', { label: task?.label ?? id }));
                await new Promise((r) => setTimeout(r, 1500));
                await refresh();
              }
            : undefined
        }
        actions={
          running ? (
            <ActionButton
              icon={<MessageSquare />}
              tone="primary"
              tooltip={t('dp.tryTip')}
              onClick={() => {
                toast.info(t('dp.tryToast'));
                navigate('/chat');
              }}
            >
              {t('dp.tryBtn')}
            </ActionButton>
          ) : null
        }
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
