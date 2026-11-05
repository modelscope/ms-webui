import { useEffect, useState } from 'react';
import { Bot, Pause, Play, Square } from 'lucide-react';
import { cn } from 'cn';
import { Hint } from '@/components/Hint';
import { Button } from '@/components/ui/button';
import { SelectInput } from '@/components/FormField';
import { EngineApprovalCard } from '@/components/EngineApprovalCard';
import { AiChatPanel } from '@/components/AiChatPanel';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { GraphEdge, GraphNode } from './nodeTypes';
import type { AiAction, FlowMessage } from './aiAssist';
import { describeAction, flowIntro, useFlowAiChat } from './aiAssist';
import { useT, type MessageKey } from '@/i18n';

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
 * 所以 AI 回答的是「这张图」的事——启动、暂停、整体为什么慢。回合由
 * server 引擎执行（useFlowAiChat），动作提议（改参数/加节点/启停）经
 * 页面工具挂起协议上抛成本页卡片，用户点「应用」才落图。
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
  baseConv,
  model,
  modelOptions,
  onModelChange,
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
  /** 会话锚点（wf-<flowId>）：turns 按会话×模型分桶，重开画布续上历史 */
  baseConv: string;
  /** 当前模型 id（'' = 无可用模型，发送回落离线剧本） */
  model: string;
  modelOptions: { value: string; label: string }[];
  onModelChange: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const running = runState === 'running';
  const { t } = useT();
  const { messages, setMessages, streaming, send, stop, approvals, engineAlways, setEngineAlways, resolveEngineApproval } =
    useFlowAiChat({
      baseConv,
      model,
      ctx: () => ({ nodes, edges, presetLabel, running }),
      t,
      onControl,
    });

  // 第一次打开时给一句开场白。之后再开保留上次的对话
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([flowIntro({ nodes, edges, presetLabel, running }, t)]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sendNow = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void send(text);
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

        {/* 模型选择：引擎回合的执行列（无可用模型时发送回落离线剧本） */}
        <div className="border-border/60 border-y px-4 py-2.5">
          <SelectInput
            value={model}
            onChange={onModelChange}
            options={modelOptions}
            placeholder={t('assistant.noModel')}
            disabled={!modelOptions.length || streaming}
            className="text-muted-foreground h-7 w-full gap-1.5 truncate border-0 px-2 text-xs shadow-none"
          />
        </div>

        {/* 状态条 + 手动启停。AI 能做的事，用户自己也得能做 */}
        <div className="border-border/60 bg-secondary flex flex-wrap items-center gap-2 border-b px-3.5 py-2.5">
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
          onSend={sendNow}
          onStop={streaming ? stop : undefined}
          onAction={handleAction}
          confirmBeforeApply={confirmBeforeApply}
          suggestions={
            running
              ? [t('wf.sugPause'), t('wf.sugSlow'), t('wf.sugOom')]
              : [t('wf.sugRun'), t('wf.sugWhatGraph'), t('wf.sugAdvZero')]
          }
          placeholder={t('wf.flowPlaceholder')}
        />

        {/* 引擎回合挂起的审批（flow_control 等）：决定后引擎恢复回合 */}
        {approvals.map((a) => (
          <EngineApprovalCard
            key={a.id}
            approval={a}
            checked={engineAlways[a.id] === true}
            onCheck={(v) => setEngineAlways((prev) => ({ ...prev, [a.id]: v }))}
            onResolve={resolveEngineApproval}
          />
        ))}
      </SheetContent>
    </Sheet>
  );
}
