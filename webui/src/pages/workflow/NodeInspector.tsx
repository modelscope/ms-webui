import { useEffect, useState } from 'react';
import { Loader2, Play, RotateCw, X } from 'lucide-react';
import { cn } from 'cn';
import { Hint } from '@/components/Hint';
import { AiChatPanel } from '@/components/AiChatPanel';
import { EngineApprovalCard } from '@/components/EngineApprovalCard';
import { SegmentedControl } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { GraphEdge, GraphNode } from './nodeTypes';
import { NODE_TYPES, nodeDefOf, nodeLabel } from './nodeTypes';
import { OutputPreview, OutputPreviewDialog } from './OutputPreview';

import type { AiAction, FlowMessage } from './aiAssist';
import { describeAction, nodeIntro, paramsOf, useFlowAiChat } from './aiAssist';
import { useT } from '@/i18n';
import type { MessageKey } from '@/i18n';

export type InspectorTab = 'params' | 'output' | 'ai';
type Tab = InspectorTab;

/**
 * 运行状态的说法和颜色。
 * 用 Tailwind 调色板里的 amber/emerald/red 而不是主题色：
 * 这几个是「跑得怎么样」的通用信号，跟品牌色换不换没关系。
 */
const STATUS: Record<GraphNode['status'], { text: MessageKey; tone: string }> = {
  idle: { text: 'wf.stIdle', tone: 'text-muted-foreground' },
  running: { text: 'task.running', tone: 'text-amber-500' },
  done: { text: 'task.done', tone: 'text-emerald-500' },
  failed: { text: 'task.failed', tone: 'text-red-500' },
};

/**
 * 节点检查面板。功能 1（看输出）和功能 2（问 AI）都落在这里。
 *
 * 三个 tab 的顺序是有意的：参数 → 输出 → 问 AI，
 * 正好是「我设了什么 → 它跑出了什么 → 这跟我想的不一样，帮我看看」这条路径。
 *
 * AI 会话由这个面板自己持有，切到别的节点就重置——
 * 问「这个参数为什么这么设」时，上一个节点的上下文留着只会误导。
 */
export function NodeInspector({
  node,
  nodes,
  edges,
  presetLabel,
  running,
  aiEnabled,
  confirmBeforeApply,
  tab,
  sessionId,
  onClose,
  onRun,
  onParamChange,
  onAction,
  onTabChange,
  baseConv,
  model,
}: {
  node: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  presetLabel: string;
  running: boolean;
  aiEnabled: boolean;
  confirmBeforeApply: boolean;
  /**
   * 开在哪一页。它由外面持有，而不是这里自己存一份再跟着 prop 同步——
   * 同一个东西两处各存一份，就会出现「点节点上的问 AI，面板却停在参数页」这种事。
   */
  tab: Tab;
  /** 常驻会话 id：输出页的 preview（lane 分页 + 拷贝）打这个会话；空 = 尚无会话 */
  sessionId?: string;
  onClose: () => void;
  onRun: (nodeId: string) => void;
  /**
   * 改参数。给的是下标而不是参数名——
   * traj_filter 那两个 drop_if 同名，按名字改会一次改掉两个。
   */
  onParamChange: (nodeId: string, index: number, value: string) => void;
  /** AI 提议被应用时上报。面板自己不改图 */
  onAction: (a: AiAction) => void;
  onTabChange: (t: Tab) => void;
  /** 会话锚点（wf-<flowId>）：与整图助手同一会话同一列，节点级与整图级上下文互通 */
  baseConv: string;
  /** 当前模型 id（'' = 无可用模型，发送回落离线剧本）；与整图助手共用一列 */
  model: string;
}) {
  const def = nodeDefOf(node) ?? NODE_TYPES[node.type];
  const { t } = useT();

  /* 设置里把 AI 关掉时，正停在 AI 页就退回参数页——不拦的话面板下半截是空的 */
  const active: Tab = tab === 'ai' && !aiEnabled ? 'params' : tab;

  const [draft, setDraft] = useState('');
  /* 输出预览的大窗：内容与内嵌版同一个组件，只是舞台更大 */
  const [previewOpen, setPreviewOpen] = useState(false);

  /*
   * 引擎式会话（与整图抽屉同一 hook 同一列）：回合由 server 引擎执行，
   * 节点级上下文经 ctx().node 点名。面板自己持会话内消息 state，切节点重置
   * ——问「这个参数为什么这么设」时，上一个节点的上下文留着只会误导。
   */
  const { messages, setMessages, streaming, send, stop, approvals, engineAlways, setEngineAlways, resolveEngineApproval } =
    useFlowAiChat({
      baseConv,
      model,
      ctx: () => ({ node, nodes, edges, presetLabel, running }),
      t,
      onControl: () => undefined,
    });

  // 换节点才重开会话。只认 node.id：拖动节点位置、切 tab 都不该把对话清掉
  useEffect(() => {
    setMessages([nodeIntro(node, { node, nodes, edges, presetLabel, running }, t)]);
    setDraft('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const params = paramsOf(node);
  /*
   * 分区渲染：带 group 的连续参数聚成一节、共用一个小标题。
   * 分区本身是定义在节点类型上的（主链 / 旋钮 / 观察），这里只负责把它画出来。
   */
  const sections: { name: MessageKey | ''; items: { p: (typeof params)[number]; i: number }[] }[] = [];
  params.forEach((p, i) => {
    const name = p.group ?? '';
    if (sections.length === 0 || sections[sections.length - 1].name !== name) {
      sections.push({ name, items: [] });
    }
    sections[sections.length - 1].items.push({ p, i });
  });

  const sendNow = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void send(text);
  };

  const handleAction = (msgId: string, index: number, next: 'applied' | 'ignored') => {
    const msg = messages.find((m) => m.id === msgId);
    const action = msg?.actions?.[index];
    if (next === 'applied' && action) onAction(action);
    setMessages((ms) =>
      ms.map((m) =>
        m.id === msgId
          ? { ...m, states: m.states?.map((s, i) => (i === index ? next : s)) }
          : m,
      ),
    );
  };

  const tabs = [
    { label: t('wf.tabParams'), value: 'params' },
    { label: t('wf.tabOutput'), value: 'output' },
    ...(aiEnabled ? [{ label: t('wf.tabAi'), value: 'ai' }] : []),
  ];

  const status = STATUS[node.status];

  return (
    <div className="bg-background border-border flex h-full w-87 flex-none flex-col border-s">
      {/* 头部：节点是谁 + 现在什么状态 */}
      <div className="border-border/60 border-b px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex size-5.5 flex-none items-center justify-center rounded-[7px] text-white [&>svg]:size-3.5"
            style={{ background: def.color }}
          >
            {def.icon}
          </span>
          <span className="text-foreground min-w-0 flex-1 truncate text-sm font-semibold">
            {nodeLabel(def, t)}
          </span>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
            <X />
          </Button>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <span className={cn('inline-flex items-center gap-1.5 text-xs', status.tone)}>
            {/* bg-current：点跟着文字同色，状态色只写一处 */}
            <span className="size-1.5 rounded-full bg-current" />
            {t(status.text)}
          </span>
          {/*
            所有节点都能单独跑。声明式节点（模型、优化器）跑一次的意思是
            「把它准备好」——加载权重、把生效配置定下来，这也是有输出可看的。
          */}
          <Hint
            title={
              def.runnable
                ? undefined
                : t('wf.declaredRunHint')
            }
          >
            <Button
              size="sm"
              variant={node.status === 'done' ? 'outline' : 'default'}
              className="ms-auto h-7 text-xs"
              disabled={node.status === 'running'}
              onClick={() => onRun(node.id)}
            >
              {node.status === 'running' ? (
                <Loader2 className="animate-spin" />
              ) : node.status === 'idle' ? (
                <Play />
              ) : (
                <RotateCw />
              )}
              {node.status === 'idle' ? t('wf.runBtn') : node.status === 'running' ? t('task.running') : t('wf.rerunBtn')}
            </Button>
          </Hint>
        </div>
      </div>

      <div className="px-3 pt-2.5">
        <SegmentedControl block value={active} onChange={(v) => onTabChange(v as Tab)} options={tabs} />
      </div>

      {active === 'params' && (
        <div className="min-h-0 flex-1 overflow-auto px-3 pt-3 pb-4">
          {params.length === 0 ? (
            <EmptyHint>{t('wf.noParams')}</EmptyHint>
          ) : (
            <div className="flex flex-col gap-3.5">
              {sections.map((s, si) => (
                <div key={si} className="flex flex-col gap-2.5">
                  {s.name && (
                    <div className="text-muted-foreground/80 border-b border-b-border/60 pb-1 text-[11px] font-medium tracking-wide">
                      {t(s.name)}
                    </div>
                  )}
                  {s.items.map(({ p, i }) => (
                    <label key={`${p.label}-${i}`} className="block">
                      <span className="text-muted-foreground mb-1 block text-xs">{p.label}</span>
                      {p.ptype === 'dict' || p.ptype === 'list' ? (
                        /* JSON 参数（编码配置、生成配置这类）给多行编辑：
                         * 单行输入框里改 JSON 是反人类操作，system 定制也走这里 */
                        <Textarea
                          className="min-h-[64px] resize-y font-mono text-[11.5px]"
                          value={p.value}
                          onChange={(e) => onParamChange(node.id, i, e.target.value)}
                        />
                      ) : (
                        <Input
                          className="h-8"
                          value={p.value}
                          onChange={(e) => onParamChange(node.id, i, e.target.value)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
          {def.hint && (
            <div className="bg-secondary text-muted-foreground mt-3.5 rounded-[10px] px-3 py-2.5 text-xs leading-[19px]">
              {t(def.hint)}
            </div>
          )}
        </div>
      )}

      {active === 'output' && (
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-3 pb-4">
          {node.status === 'idle' && <EmptyHint>{t('wf.noOutputHint')}</EmptyHint>}
          {node.status === 'running' && (
            <div className="text-muted-foreground flex items-center justify-center gap-1.5 py-5 text-xs">
              <Loader2 className="size-3.5 animate-spin" /> {t('wf.runningOutput')}
            </div>
          )}
          {node.status === 'done' && sessionId && (
            <OutputPreview
              sessionId={sessionId}
              nodeId={node.id}
              onPopup={() => setPreviewOpen(true)}
            />
          )}
        </div>
      )}

      {active === 'ai' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <AiChatPanel
            messages={messages}
            describe={(a) => describeAction(a, nodes, t)}
            draft={draft}
            onDraftChange={setDraft}
            onSend={sendNow}
            onStop={streaming ? stop : undefined}
            onAction={handleAction}
            confirmBeforeApply={confirmBeforeApply}
            accent={def.color}
            suggestions={suggestionsFor(node.type).map((s) => t(s))}
            placeholder={t('wf.aiPlaceholder', { label: nodeLabel(def, t) })}
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
        </div>
      )}
      {sessionId && (
        <OutputPreviewDialog
          sessionId={sessionId}
          nodeId={node.id}
          nodeLabel={nodeLabel(def, t)}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        />
      )}
    </div>
  );
}

/** 空状态就一行字。这里的空是「还没到时候」，不值得画一张插图去强调 */
function EmptyHint({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground py-6 text-center text-xs">{children}</div>;
}

/** 按节点类型给几个像样的追问。问不出问题的时候，这几个按钮就是入口 */
function suggestionsFor(type: string): MessageKey[] {
  if (type === 'train_step') return ['wf.sugOom', 'wf.sugSlow', 'wf.sugLr'];
  if (type === 'streaming_driver') return ['wf.sugStaleness', 'wf.sugRewardWire', 'wf.sugBatchFill'];
  if (type === 'advantage') return ['wf.sugGae', 'wf.sugQuad', 'wf.sugTeacherWire'];
  if (type === 'select') return ['wf.sugSelect', 'wf.sugSurvivors'];
  if (type === 'rollout' || type === 'generate') return ['wf.sugSlow', 'wf.sugTurns'];
  return ['wf.sugWhatIs', 'wf.sugHowToTune'];
}
