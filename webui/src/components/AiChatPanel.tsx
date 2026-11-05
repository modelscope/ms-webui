import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, Bot, Check, Loader2, Square, User, X, Zap } from 'lucide-react';
import { cn } from 'cn';
import { Hint } from '@/components/Hint';
import { ThinkingBlock, ToolFold, fmtCallArgs } from '@/components/ChatBlocks';
import type { ChatMessage, ToolCall } from '@/api/models';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * 对话面板。编排页问节点、问整张图，新建页问配置，都用这一个。
 *
 * 气泡样式跟对话页保持一致：右侧用户淡紫、左侧助手浅灰、26px 头像。
 * 不重新设计一套是有意的——同一个产品里几处对话长得不一样，
 * 用户会以为它们是几个不同的东西。
 *
 * 完全受控：自己不存消息、不调 AI。谁用它谁负责推进对话，
 * 这样每个使用方可以各存一份互不干扰的会话。
 *
 * 对提议（动作卡片）只认三件事：怎么写成一句人话、要不要醒目、点了应用干什么。
 * 提议的内部结构留给使用方——编排页的提议是「改图上某个节点的参数」，
 * 新建页的是「改表单里某个字段」，两者没有公共结构，硬凑一个反而两边都别扭。
 */

export type ActionState = 'pending' | 'applied' | 'ignored';

export interface AiMessage<A> {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 附带的提议。每条独立确认，不是打包应用 */
  actions?: A[];
  /** 与 actions 同长度，记录每条被点了什么 */
  states?: ActionState[];
  /** 生成中的占位 */
  pending?: boolean;
  /**
   * 离线剧本产出（无可用模型时的关键词匹配回复）。挂在消息级而不是
   * footer 级：同一次会话里 LLM 与剧本可以混排（模型中途被删/失联回落），
   * 每条消息各自标各自的事实。
   */
  offline?: boolean;
  /** 用户消息附带的图片（data URL，多模态输入随回合提交） */
  images?: string[];
  /*
   * 下面三个结构化字段与对话页 ChatPage 的消息形态对齐：思维链/工具调用
   * 折叠成卡（ChatBlocks），不再由调用方拼成一行文本。使用方可以不给——
   * 纯文本消息照旧只走 text。
   */
  /** 思维链（推理模型流式产出）。pending 且正文未出时折叠卡显示「思考中…」 */
  reasoning?: string;
  /** 本条 assistant 消息发起的工具调用（含页面工具之外的注册表工具） */
  toolCalls?: ToolCall[];
  /** 引擎落盘的工具结果全文（不截断，折叠卡里滚动看） */
  toolResult?: string;
}

/** 一条提议在卡片上长什么样。翻译权在提议方，面板不认识动作的内部结构 */
export interface ProposalView {
  /** 卡片上那句人话 */
  label: string;
  /** 启停这类动作比改个参数更重，给个更醒目的颜色 */
  heavy?: boolean;
}

let seq = 0;

/** 消息 id。只用来做 React key 和定位某一条，够区分同一次会话里的消息就行 */
export const messageId = () => `ai${Date.now().toString(36)}${seq++}`;

/**
 * 用户说的一句话。
 *
 * 提议类型给 never 而不是泛型：用户消息永远不带提议，
 * 而 never[] 能塞进任何一种消息列表，调用处就不用写类型参数。
 */
export function userMessage(text: string): AiMessage<never> {
  return { id: messageId(), role: 'user', text };
}

/**
 * 会话桶里的 ChatMessage → 面板展示消息（通用基础版）。思维链/工具调用/
 * 工具结果以结构化字段交给面板渲染折叠卡（与对话页同一套）。需要还原
 * user 图片的调用方（配置助手）在此之上补 images 字段。
 */
export function toEngineDisplay<A>(m: ChatMessage): AiMessage<A> {
  if (m.role === 'user') return { id: messageId(), role: 'user', text: m.content };
  if (m.role === 'tool') {
    /* text 留空：面板对只有工具结果的消息不画正文气泡，折叠卡独立成行 */
    return { id: messageId(), role: 'assistant', text: '', toolResult: m.content };
  }
  return {
    id: messageId(),
    role: 'assistant',
    text: m.content,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
  };
}

/**
 * turn-done 对账合并：桶是唯一真相源，但页面工具产出的卡片消息只活在本地
 * （引擎桶里只有回执文本，卡片结构不落盘）——整列重置会把它抹掉，用户就
 * 看到「模型说已列卡片、面板却没动」的断层。仍含 pending 的卡片消息按原
 * 顺序插回重建列末尾（已 applied/ignored 的沉没：结果已在表单/图上）；
 * 切会话/重开面板走全新建，不保留卡片。
 */
export function reconcileEngineMessages<A>(
  prev: AiMessage<A>[],
  bucket: ChatMessage[],
  toDisplay: (m: ChatMessage) => AiMessage<A> = toEngineDisplay,
): AiMessage<A>[] {
  const rebuilt = bucket.map(toDisplay);
  const cards = prev.filter((m) => m.actions?.length && m.states?.some((s) => s === 'pending'));
  return cards.length ? [...rebuilt, ...cards] : rebuilt;
}

export function AiChatPanel<A>({
  messages,
  describe,
  onSend,
  onStop,
  stopping,
  onAction,
  draft,
  onDraftChange,
  suggestions,
  confirmBeforeApply,
  accent = 'var(--primary)',
  placeholder,
  footerNote,
  trailing,
}: {
  messages: AiMessage<A>[];
  describe: (a: A) => ProposalView;
  onSend: () => void;
  /** 流式进行中的停止入口；不传则发送键不变形 */
  onStop?: () => void;
  /** 已点停止、流尚未结束：按钮转圈（配合 onStop） */
  stopping?: boolean;
  onAction: (msgId: string, index: number, next: Exclude<ActionState, 'pending'>) => void;
  draft: string;
  onDraftChange: (v: string) => void;
  /** 快捷追问。空着就不显示那一排 */
  suggestions?: string[];
  /** 来自偏好设置。关掉时动作卡片不再等确认，直接呈现为已应用 */
  confirmBeforeApply: boolean;
  /** 头像颜色。节点面板里传节点主色，认得出这段对话是在问谁 */
  accent?: string;
  placeholder?: string;
  /**
   * 输入框下的说明行。不传不渲染：真模型与离线剧本的区分已下沉到消息级
   * offline 标记，footer 不再承担「这套回答是不是本地示意」的判断。
   */
  footerNote?: string;
  /*
   * 消息流末尾的固定插槽（输入框上方、随对话一起滚动）：审批卡这类
   * 「要用户决定」的面挂在这里——盖在消息区上方会遮挡对话，藏在底部
   * 又看不见，跟在最新消息后面才是它的自然位置。
   */
  trailing?: ReactNode;
}) {
  const tail = useRef<HTMLDivElement>(null);
  const { t } = useT();

  // 新消息进来滚到底。依赖里带上最后一条的 id，避免只改 states 时也滚；
  // 尾部插槽出现（如审批卡）同样要滚到底，否则要手翻才能看见
  const lastId = messages[messages.length - 1]?.id;
  const hasTrailing = trailing != null;
  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lastId, messages.length, hasTrailing]);

  const send = () => {
    if (draft.trim()) onSend();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-3.5 pt-3.5 pb-1">
        {messages.map((m) => (
          <div key={m.id}>
            <div className={cn('flex gap-2.5', m.role === 'user' && 'flex-row-reverse')}>
              <span
                className="inline-flex size-6.5 flex-none items-center justify-center rounded-full text-white [&>svg]:size-3.5"
                style={{ background: m.role === 'user' ? '#e5e7eb' : accent }}
              >
                {m.role === 'user' ? <User className="text-neutral-500" /> : <Bot />}
              </span>
              {/* pre-wrap：剧本里是带换行的多行文本，得让它保留 */}
              <div className="flex min-w-0 max-w-[86%] flex-col">
                {/* 附属块（思维链/工具调用）与正文气泡是兄弟节点，层级与对话页一致 */}
                {m.role === 'assistant' && m.reasoning ? (
                  <ThinkingBlock text={m.reasoning} active={Boolean(m.pending) && !m.text} />
                ) : null}
                {m.role === 'assistant' &&
                  m.toolCalls?.map((c) => (
                    <ToolFold key={c.id} label={t('chat.toolCall', { name: c.name })} text={fmtCallArgs(c)} />
                  ))}
                {/* 工具结果全文折叠卡：没有正文时不画空气泡，卡片独立成行 */}
                {m.role === 'assistant' && m.toolResult ? (
                  <ToolFold label={t('chat.toolResult')} text={m.toolResult} />
                ) : null}
                {m.role === 'user' || m.text || !!m.images?.length || (m.pending && !m.reasoning) ? (
                  <div
                    className={cn(
                      'text-foreground max-w-full rounded-xl px-3 py-2 text-[13px] leading-[21px] whitespace-pre-wrap',
                      m.role === 'user' ? 'bg-secondary' : 'bg-muted',
                    )}
                  >
                    {m.role === 'user' && !!m.images?.length && (
                      <div className="mb-1 flex flex-wrap justify-end gap-1.5">
                        {m.images.map((src, j) => (
                          <img key={j} src={src} alt="" className="border-border max-h-32 rounded-lg border object-contain" />
                        ))}
                      </div>
                    )}
                    {m.text}
                    {/* 流式光标：与对话页同款，pending 且已有正文时跟在末尾 */}
                    {m.role === 'assistant' && m.pending && m.text ? <span className="animate-pulse">▍</span> : null}
                    {m.pending && !m.text ? (
                      <span className="text-muted-foreground">{t('chatPanel.thinking')}</span>
                    ) : null}
                    {m.offline && (
                      <span className="text-muted-foreground mt-1.5 block border-t border-dashed pt-1 text-[11px]">
                        {t('chatPanel.demoHint')}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            {/* 动作卡片。缩进到跟气泡左边缘对齐 */}
            {!!m.actions?.length && (
              <div className="mt-2 ms-9 flex flex-col gap-1.5">
                {m.actions.map((a, i) => (
                  <ActionCard
                    key={i}
                    view={describe(a)}
                    state={confirmBeforeApply ? (m.states?.[i] ?? 'pending') : 'applied'}
                    onApply={() => onAction(m.id, i, 'applied')}
                    onIgnore={() => onAction(m.id, i, 'ignored')}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
        {/* 尾部插槽（审批卡等）：跟在最新消息后面，输入框上方 */}
        {trailing}
        <div ref={tail} />
      </div>

      {!!suggestions?.length && (
        <div className="flex flex-wrap gap-1.5 px-3.5 pt-1.5">
          {suggestions.map((s) => (
            <Button
              key={s}
              variant="outline"
              size="sm"
              className="text-muted-foreground h-7 rounded-full text-xs"
              onClick={() => {
                onDraftChange(s);
                // 让 onSend 拿到的是这条，而不是上一帧的 draft
                requestAnimationFrame(onSend);
              }}
            >
              {s}
            </Button>
          ))}
        </div>
      )}

      <div className="border-border/60 border-t p-3">
        <div className="bg-background border-border flex items-end gap-2 rounded-[14px] border px-2.5 py-2">
          {/* 高度靠 textarea 自带的 field-sizing-content 长，max-h 兜住上限 */}
          <Textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              /* Enter 发送、Shift+Enter 换行；输入法组词中的 Enter 是选字，不当发送（与首页同判据） */
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder ?? t('chatPanel.placeholder')}
            className="max-h-28 min-h-6 resize-none border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
          />
          {onStop ? (
            /* 停止键与首页同款触感：按压缩放 + 呼吸光晕 + 点击后转圈 */
            <Button
              size="icon"
              className="bg-state-failed hover:bg-state-failed/90 relative size-7 flex-none rounded-full text-white transition-transform active:scale-90"
              onClick={onStop}
              disabled={stopping}
              title={stopping ? t('chatPanel.stopping') : t('chatPanel.stopGen')}
            >
              {stopping ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <>
                  <span className="bg-state-failed/40 pointer-events-none absolute inset-0 animate-ping rounded-full" />
                  <Square size={12} className="relative" />
                </>
              )}
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-7 flex-none rounded-full transition-transform active:scale-90"
              disabled={!draft.trim()}
              onClick={send}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
        {footerNote && <div className="text-muted-foreground mt-1.5 text-[11px]">{footerNote}</div>}
      </div>
    </div>
  );
}

/**
 * 一条提议。
 *
 * 关键在于它长得不像一句话，而像一个待办：有边框、有明确的两个出口。
 * AI 说「建议把 micro_batch_size 降到 1」和真把它降到 1 之间，
 * 必须隔着一次点击——配置是任务的唯一事实来源，不能被静默改写。
 */
function ActionCard({
  view,
  state,
  onApply,
  onIgnore,
}: {
  view: ProposalView;
  state: ActionState;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const { t } = useT();
  const done = state !== 'pending';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-xs',
        done ? 'bg-muted border-border/60 text-muted-foreground' : 'bg-secondary border-border text-foreground',
      )}
    >
      <Zap
        className={cn(
          'size-3 flex-none',
          done ? 'text-muted-foreground' : view.heavy ? 'text-amber-600' : 'text-primary',
        )}
      />
      <span className={cn('min-w-0 flex-1', state === 'ignored' && 'line-through')}>{view.label}</span>

      {state === 'pending' ? (
        <span className="flex flex-none gap-1">
          <Button size="sm" className="h-6 px-2.5 text-xs" onClick={onApply}>
            {t('chatPanel.apply')}
          </Button>
          <Hint title={t('chatPanel.discard')}>
            <Button variant="ghost" size="icon" className="size-6" onClick={onIgnore}>
              <X />
            </Button>
          </Hint>
        </span>
      ) : (
        <span className="text-muted-foreground inline-flex flex-none items-center gap-1 text-[11px]">
          {state === 'applied' ? (
            <>
              <Check className="size-2.5" />
              {t('chatPanel.applied')}
            </>
          ) : (
            t('chatPanel.discarded')
          )}
        </span>
      )}
    </div>
  );
}
