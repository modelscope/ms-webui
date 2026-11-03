import { useEffect, useState } from 'react';
import { Bot, Pause, Play, Square } from 'lucide-react';
import { cn } from 'cn';
import { Hint } from '@/components/Hint';
import { Button } from '@/components/ui/button';
import { AiChatPanel } from '@/components/AiChatPanel';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { GraphEdge, GraphNode } from './nodeTypes';
import type { AiAction, FlowMessage } from './aiAssist';
import { describeAction, flowIntro, makeAiSend } from './aiAssist';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n';

export type RunState = 'idle' | 'running' | 'paused';

const RUN: Record<RunState, { text: MessageKey; tone: string }> = {
  idle: { text: 'wf.runIdle', tone: 'text-muted-foreground' },
  running: { text: 'task.running', tone: 'text-emerald-500' },
  paused: { text: 'wf.runPaused', tone: 'text-amber-500' },
};

/**
 * 整图 AI 助手抽屉（功能 3）。
 *
 * 跟节点面板的区别不在于界面，而在于上下文：这里的 AiContext 不带 node，
 * 所以 AI 回答的是「这张图」的事——启动、暂停、整体为什么慢。
 *
 * 顶上那排启停按钮是有意放在这里的：AI 提议「暂停」的时候，
 * 用户可以选择点卡片让它代劳，也可以自己按按钮。
 * 不给手动出口的话，AI 就从助手变成了唯一通道。
 */
export function FlowAssistant({
  open,
  onClose,
  nodes,
  edges,
  presetLabel,
  runState,
  confirmBeforeApply,
  onControl,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  nodes: GraphNode[];
  edges: GraphEdge[];
  presetLabel: string;
  runState: RunState;
  confirmBeforeApply: boolean;
  onControl: (op: 'start' | 'pause' | 'resume' | 'stop') => void;
  /** 非控制类提议（改参数、加节点）交给页面处理 */
  onAction: (a: AiAction) => void;
}) {
  const [messages, setMessages] = useState<FlowMessage[]>([]);
  const [draft, setDraft] = useState('');
  const running = runState === 'running';
  const { t } = useT();

  // 第一次打开时给一句开场白。之后再开保留上次的对话
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([flowIntro({ nodes, edges, presetLabel, running }, t)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /*
   * 真后端优先：有已配置的模型就走流式 LLM（system 注入图上下文，末尾的
   * ```action 块解析成动作卡片，控制类卡片点了就代用户启停）；一个模型都
   * 没有时退回离线剧本，页面不空转。发送逻辑与节点面板共用 makeAiSend。
   */
  const aiSend = makeAiSend({
    ctx: () => ({ nodes, edges, presetLabel, running }),
    t,
    setMessages,
  });
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void aiSend(text);
  };

  const handleAction = (msgId: string, index: number, next: 'applied' | 'ignored') => {
    const action = messages.find((m) => m.id === msgId)?.actions?.[index];
    if (next === 'applied' && action) {
      if (action.kind === 'control') onControl(action.op);
      else onAction(action);
    }
    setMessages((ms) =>
      ms.map((m) =>
        m.id === msgId ? { ...m, states: m.states?.map((s, i) => (i === index ? next : s)) } : m,
      ),
    );
  };

  const done = nodes.filter((n) => n.status === 'done').length;
  const failed = nodes.filter((n) => n.status === 'failed').length;
  const state = RUN[runState];

  return (
    /*
      不盖遮罩、不夺焦点：开着助手还要能看着画布上的节点一个个点亮。
      onInteractOutside 也要拦下来，不然点一下画布抽屉就自己关了。
    */
    <Sheet modal={false} open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        showOverlay={false}
        className="w-105 gap-0 sm:max-w-none"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <SheetHeader className="px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Bot className="text-primary size-4" />
            {t('wf.assistant')}
          </SheetTitle>
        </SheetHeader>

        {/* 状态条 + 手动启停。AI 能做的事，用户自己也得能做 */}
        <div className="border-border/60 bg-secondary flex flex-wrap items-center gap-2 border-y px-3.5 py-2.5">
          <span className={cn('inline-flex items-center gap-1.5 text-[12.5px]', state.tone)}>
            <span
              className={cn('size-[7px] rounded-full bg-current', running && 'status-dot-live')}
            />
            {t(state.text)}
          </span>
          <span className="text-muted-foreground text-xs">
            {t('wf.doneCount', { done, total: nodes.length })}
            {failed > 0 && <span className="text-red-500">　{t('wf.failedCount', { n: failed })}</span>}
          </span>

          <span className="ms-auto flex gap-1.5">
            {running ? (
              <Hint title={t('wf.pauseHint')}>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onControl('pause')}>
                  <Pause />
                  {t('task.pause')}
                </Button>
              </Hint>
            ) : (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => onControl(runState === 'paused' ? 'resume' : 'start')}
              >
                <Play />
                {runState === 'paused' ? t('task.resume') : t('wf.startBtn')}
              </Button>
            )}
            <Hint title={t('wf.stopHint')}>
              <Button
                variant="outline"
                size="icon"
                className="text-destructive hover:text-destructive size-7"
                disabled={runState === 'idle'}
                onClick={() => onControl('stop')}
              >
                <Square />
              </Button>
            </Hint>
          </span>
        </div>

        <AiChatPanel
          messages={messages}
          describe={(a) => describeAction(a, nodes, t)}
          draft={draft}
          onDraftChange={setDraft}
          onSend={send}
          onAction={handleAction}
          confirmBeforeApply={confirmBeforeApply}
          suggestions={
            running
              ? [t('wf.sugPause'), t('wf.sugSlow'), t('wf.sugOom')]
              : [t('wf.sugRun'), t('wf.sugWhatGraph'), t('wf.sugAdvZero')]
          }
          placeholder={t('wf.flowPlaceholder')}
        />
      </SheetContent>
    </Sheet>
  );
}
