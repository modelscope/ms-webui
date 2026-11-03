import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RotateCw } from 'lucide-react';
import { ActionButton, TaskDetailShell, MetaCell } from '@/components/TaskDetailShell';
import { LogViewer } from '@/components/LogViewer';
import { PageAssistant } from '@/components/PageAssistant';
import { moduleTaskTools } from '@/agent/taskTools';
import { useSettings } from '@/settings/SettingsContext';
import { MODULES } from '@/theme/modules';
import type { TaskItem } from '@/mock/types';
import { getScriptLog, listScripts, renameScript, startScript, stopScript, type ScriptTaskInfo } from '@/api/scripts';
import { useT } from '@/i18n';
import { toast } from 'sonner';

/** 后端脚本状态 -> 详情页任务状态 */
function toTaskItem(t: ScriptTaskInfo): TaskItem {
  const status = t.status === 'failed' ? 'FAILED' : t.status === 'done' ? 'DONE' : t.status === 'stopped' ? 'STOPPED' : 'RUNNING';
  return {
    id: t.id,
    type: 'scripts',
    label: t.name ?? t.script,
    status,
    createdAt: t.startedAt,
    runner: 'local',
    model: t.script,
    /*
     * 创建命令：与执行器 spawn 的形态一致（工作空间根 + 解释器现读），
     * 复制到终端跑的是同一个脚本。args 含空格时逐个加引号还原。
     */
    createCommand: [
      `$ python ${t.script}`,
      ...t.args.map((a) => (/\s/.test(a) ? `    "${a}"` : `    ${a}`)),
    ].join(' \\\n'),
  };
}

/** 脚本任务详情：只有日志一个 Tab（脚本的产物落在工作空间里，由对话里的 agent 继续处理）。 */
export function ScriptsDetailPage() {
  const { t } = useT();
  const { id } = useParams();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  /* 原始任务表：重跑要拿 script/args */
  const [raw, setRaw] = useState<ScriptTaskInfo[]>([]);
  const [log, setLog] = useState<string[]>([]);
  /* 页面 AI 助手：任务管理工具（列出/停止/重命名），入口在页头 Bot 按钮 */
  const [assistantOpen, setAssistantOpen] = useState(false);
  const { settings } = useSettings();
  const assistantTools = useMemo(() => moduleTaskTools('script'), []);

  const refresh = useCallback(async () => {
    try {
      const list = await listScripts();
      setRaw(list);
      setTasks(list.map(toTaskItem));
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
        const lines = await getScriptLog(id);
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
  }, [id]);

  const tabs = [{ key: 'log', label: t('task.logs'), content: <LogViewer lines={log} /> }];
  const current = raw.find((x) => x.id === id);

  return (
    <>
      <TaskDetailShell
        module={MODULES.scripts}
        tasks={tasks}
        tabs={tabs}
        activeTab="log"
        onAssistant={() => setAssistantOpen(true)}
        /* 重跑：同 script/args 新任务，跳到它的日志页 */
        actions={
          current ? (
            <ActionButton
              icon={<RotateCw />}
              tooltip={t('sc.rerunTip')}
              onClick={() => {
                void startScript(current.script, current.args.length ? current.args : undefined)
                  .then((newId) => navigate(`/scripts/${newId}/log`))
                  .catch((e) => toast.error(String(e)));
              }}
            >
              {t('sc.rerun')}
            </ActionButton>
          ) : undefined
        }
        extraMeta={<MetaCell label={t('sc.workspace')} value="~/.swift/workspace" />}
        onRefresh={refresh}
        onRename={
          id
            ? async (_id, name) => {
                await renameScript(_id, name);
                await refresh();
              }
            : undefined
        }
        onStop={
          id
            ? async () => {
                await stopScript(id);
                await new Promise((r) => setTimeout(r, 1000));
                await refresh();
              }
            : undefined
        }
      />
      <PageAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        module={MODULES.scripts.key}
        tools={assistantTools}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
      />
    </>
  );
}
