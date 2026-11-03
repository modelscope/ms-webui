import { useEffect, useRef } from 'react';
import { ArrowUp, Bot, Check, Loader2, Square, User, X, Zap } from 'lucide-react';
import { cn } from 'cn';
import { Hint } from '@/components/Hint';
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
}) {
  const tail = useRef<HTMLDivElement>(null);
  const { t } = useT();

  // 新消息进来滚到底。依赖里带上最后一条的 id，避免只改 states 时也滚
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lastId, messages.length]);

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
              <div
                className={cn(
                  'text-foreground max-w-[86%] rounded-xl px-3 py-2 text-[13px] leading-[21px] whitespace-pre-wrap',
                  m.role === 'user' ? 'bg-secondary' : 'bg-muted',
                )}
              >
                {m.pending ? <span className="text-muted-foreground">{t('chatPanel.thinking')}</span> : m.text}
                {m.offline && (
                  <span className="text-muted-foreground mt-1.5 block border-t border-dashed pt-1 text-[11px]">
                    {t('chatPanel.demoHint')}
                  </span>
                )}
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
              if (e.key === 'Enter' && !e.shiftKey) {
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
