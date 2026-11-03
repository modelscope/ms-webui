import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Pencil, Plus, PowerOff, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { Column } from '@/components/Column';
import { Hint } from '@/components/Hint';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { createFlow, deleteFlow, listFlows, type FlowSummary } from '@/api/flows';
import { releaseWorkflowSession } from '../../api/workflow';
import { PRESETS, clonePreset } from './presets';
import { useT, type MessageKey } from '@/i18n';

/**
 * 编排实验列表。脚手架只是初始状态：新建时弹出卡片选择（每个脚手架
 * 一张 + 空白），点击即以该脚手架为起点创建一个可拖动编辑、可保存的
 * 实验；实验本体持久在 ~/.swift/flows.json，跨浏览器刷新与 dev server
 * 重启存活。
 */
export function WorkflowListPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let alive = true;
    listFlows()
      .then((rows) => { if (alive) setFlows(rows); })
      .catch((error) => { if (alive) { toast.error(String(error)); setFlows([]); } });
    return () => { alive = false; };
  }, []);

  /** 从一张脚手架卡片（或空白）创建新实验并直接进入编辑 */
  const startFrom = async (presetKey: string) => {
    if (creating) return;
    setCreating(true);
    try {
      const preset = PRESETS.find((p) => p.key === presetKey);
      const graph = preset
        ? (() => {
            const copy = clonePreset(preset);
            return { nodes: copy.nodes, edges: copy.edges, ...(copy.frames ? { frames: copy.frames } : {}) };
          })()
        : { nodes: [], edges: [] };
      const id = await createFlow(graph, preset
        ? { name: t(preset.label), preset: presetKey }
        : {});
      navigate(`/workflow/${id}/edit`);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setCreating(false);
      setPicking(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteFlow(id);
      setFlows((rows) => (rows ?? []).filter((f) => f.id !== id));
    } catch (error) {
      toast.error(String(error));
    }
  };

  const reload = () => {
    listFlows()
      .then((rows) => setFlows(rows))
      .catch((error) => toast.error(String(error)));
  };

  /*
   * 释放实验的常驻会话：终止数据源、关闭模型与采样引擎，显存归还。
   * 运行中的不允许直接放（先停止本次运行），与编辑页同一档语义。
   */
  const release = async (flow: FlowSummary) => {
    if (!flow.session) return;
    try {
      await releaseWorkflowSession(flow.session.id);
      toast.success(t('wf.releasedToast'));
      reload();
    } catch (error) {
      toast.error(String(error));
    }
  };

  /** 会话在途（不允许直接释放，先去编辑页停止） */
  const inFlight = (state: string) =>
    ['queued', 'running', 'pausing', 'stopping', 'releasing'].includes(state);

  const presetLabelOf = (key: string): string => {
    const preset = PRESETS.find((p) => p.key === key);
    return preset ? t(preset.label) : '';
  };

  return (
    <div className="pb-10">
      <PageHeader
        title={t('nav.workflow')}
        desc={t('nav.workflow.desc')}
        extra={
          <Button size="sm" onClick={() => setPicking(true)}>
            <Plus /> {t('wf.newFlow')}
          </Button>
        }
      />

      <Column>
        {flows === null ? (
          <div className="text-muted-foreground px-1 py-8 text-center text-[13px]">{t('common.loading')}</div>
        ) : flows.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-1 py-10 text-center text-[13px]">
            <WorkflowIcon className="h-5 w-5 opacity-60" />
            {t('wf.flowsEmpty')}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {flows.map((flow) => (
              <div key={flow.id} className="border-border bg-card flex flex-col gap-2 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-foreground flex items-center gap-1.5 truncate text-sm font-medium">
                      <span className="truncate">{flow.name}</span>
                      {flow.session && (
                        <Hint title={t(inFlight(flow.session.state) ? 'wf.flowRunning' : 'wf.flowOccupied')}>
                          <span
                            className={
                              'inline-flex size-1.5 shrink-0 rounded-full '
                              + (inFlight(flow.session.state) ? 'bg-emerald-500' : 'bg-amber-500')
                            }
                          />
                        </Hint>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-[11px]">
                      {flow.preset ? t('wf.fromPreset', { name: presetLabelOf(flow.preset) }) : t('wf.fromBlank')}
                      <span className="mx-1">·</span>
                      {new Date(flow.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('wf.deleteFlowTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>{t('wf.deleteFlowDesc', { name: flow.name })}</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void remove(flow.id)}>{t('common.delete')}</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                <div className="flex items-center gap-2">
                  <Button asChild variant="outline" size="sm" className="w-fit">
                    <Link to={`/workflow/${flow.id}/edit`}>
                      <Pencil className="h-3.5 w-3.5" /> {t('wf.openFlow')}
                    </Link>
                  </Button>
                  {flow.session && (
                    <Hint title={t(inFlight(flow.session.state) ? 'wf.flowReleaseBusy' : 'wf.flowOccupied')}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        disabled={inFlight(flow.session.state)}
                        onClick={() => void release(flow)}
                      >
                        <PowerOff className="h-3.5 w-3.5" /> {t('wf.releaseFlow')}
                      </Button>
                    </Hint>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Column>

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('wf.pickScaffoldTitle')}</DialogTitle>
            <DialogDescription>{t('wf.pickScaffoldDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={creating}
              onClick={() => void startFrom('')}
              className="border-border bg-secondary/50 hover:border-foreground/30 flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:opacity-50"
            >
              <span className="text-foreground text-[13px] font-medium">{t('wf.blankCard')}</span>
              <span className="text-muted-foreground text-[11.5px]">{t('wf.blankCardDesc')}</span>
            </button>
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                disabled={creating}
                onClick={() => void startFrom(preset.key)}
                className="border-border bg-secondary/50 hover:border-foreground/30 flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors disabled:opacity-50"
              >
                <span className="text-foreground text-[13px] font-medium">{t(preset.label as MessageKey)}</span>
                <span className="text-muted-foreground line-clamp-2 text-[11.5px]">{t(preset.desc as MessageKey)}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
