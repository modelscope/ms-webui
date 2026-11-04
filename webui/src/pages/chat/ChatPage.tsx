import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { ArrowUp, Bot, ChevronRight, Columns2, FlaskConical, Globe, History, Loader2, Paperclip, Plus, ShieldAlert, SlidersHorizontal, Square, Terminal, Trash2, User, Wrench, X } from 'lucide-react';
import { cn } from 'cn';
import { toast } from 'sonner';
import { PageHeader } from '@/components/PageHeader';
import { CheckboxGroup, NumberInput, SegmentedControl, SelectInput } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { contentHeight } from '@/layout/metrics';
import { MODULES } from '@/theme/modules';
import { features } from '@/config/features';
import { deleteChat, pushChat, useChats, type ChatMeta } from '@/store/chats';
import { pushRecent, removeRecent } from '@/store/recent';
import { loadTurns, moveTurns, removeTurns, saveTurns } from '@/store/turns';
import { listModels, listMsModels, type ChatMessage, type ModelConfig, type ToolCall } from '@/api/models';
import { RESEARCH_GUIDANCE, WEB_SEARCH_SYSTEM, WORKBENCH_GUIDE, envInfoTool, listCatalogTool, readSkillDocTool, readSwiftSourceTool, webSearchTool, workspaceTools } from '@/agent/builtin';
import { HOME_SYSTEM, homeTools, type CreatedLink } from '@/agent/taskTools';
import { writePrefill } from '@/store/prefill';
import { AUTORESEARCH_GUIDE, researchTools } from '@/agent/researchTools';
import {
  RESEARCH_STATUS_LABELS,
  consumeResearchEvents,
  getResearch,
  listResearch,
  stopResearch,
  type ResearchSession,
  type ResearchSummary,
} from '@/api/research';
import { EVAL_MODE_LABELS, EventLogPanel, IterationsPanel } from '@/pages/research/panels';
import { tStatic, useT, type MessageKey } from '@/i18n';
import { runAgentLoop } from '@/agent/runAgentLoop';
import { compressHistory, moveSummaries, removeSummaries } from '@/agent/history';
import { composeWakeupMessage } from '@/agent/wakeup';
import { useApproval } from '@/agent/useApproval';
import { buildSkillsSystem, listSkills } from '@/api/skills';
import { fsTool } from '@/api/tools';
import { resolvePersona } from '@/store/systemPrompts';
import { useSettings } from '@/settings/SettingsContext';

/**
 * 思考档位：与温度同款的三档滑杆（左/中/右），右侧直接显示 无/低/高。
 * 状态里仍存语义值 off/mid/high，滑杆下标与它按位互转。
 */
/** 首页默认提示语：标准占位——浅色、不可编辑、开始输入即消失 */
const DEFAULT_PROMPT_KEY: MessageKey = 'chat.defaultPrompt';

/** 会话当前绑定的研究会话（convId 匹配，取最新一个；stopped 视为解绑） */
function boundResearch(list: ResearchSummary[], convId: string): ResearchSummary | null {
  return [...list].reverse().find((s) => s.convId === convId && s.status !== 'stopped') ?? null;
}

const THINKING_VALUES = ['off', 'mid', 'high'];
const THINKING_LABEL_KEYS = ['settings.thinkingOff', 'settings.thinkingMid', 'settings.thinkingHigh'] as const;

/**
 * 对比模式下三列各自的底色。取自 logo 渐变上采样出的靛 / 蓝 / 紫（chart-1..3），
 * 作用是让人一眼看出某句话出自哪个模型——单列时不需要区分，直接走品牌色。
 */
const COLUMN_TONES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3'];

/** 可开关的工具胶囊，选中时染上品牌淡色 */
function Chip({
  active,
  onClick,
  icon,
  label,
}: {
  active?: boolean;
  onClick?: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        'h-7 rounded-full px-2.5 text-xs font-normal',
        active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary font-medium',
      )}
    >
      {icon}
      {label}
    </Button>
  );
}

interface ComposerState {
  value: string;
  onChange: (v: string) => void;
  web: boolean;
  setWeb: (v: boolean) => void;
  code: boolean;
  setCode: (v: boolean) => void;
  model: string;
  setModel: (v: string) => void;
  modelOptions: { value: string; label: string }[];
  thinking: string;
  setThinking: (v: string) => void;
  temperature: number;
  setTemperature: (v: number) => void;
  topP: number;
  setTopP: (v: number) => void;
  /** 回复长度（max_tokens），默认 8192；手动清空则不传、走服务端默认 */
  maxTokens: number | undefined;
  setMaxTokens: (v: number | undefined) => void;
  /** 待发送的图片附件（data URL），随下一条消息一起发出、发出后清空 */
  attachments: string[];
  addImages: (files: File[]) => void;
  removeAttachment: (i: number) => void;
  onSend: () => void;
  /** 流式进行中：发送键变停止键 */
  streaming: boolean;
  /** 已点停止、流尚未真正结束：按钮转圈 */
  stopping: boolean;
  onStop: () => void;
  /**
   * 会话级「无需审批」：开启后本会话所有后续工具操作（含训练启动）直接
   * 执行不再弹卡。组件态不落盘——刷新/切会话即回到默认关闭，避免忘关。
   */
  noApproval: boolean;
  setNoApproval: (v: boolean) => void;
}

/** 配置浮层里的一行：固定宽度的标签 + 自适应的控件 */
function ParamRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground w-14 flex-none text-xs">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 大对话框：hero 用大号（big），会话进行中用普通号贴底 */
function Composer({ big, placeholder, state }: { big?: boolean; placeholder?: string; state: ComposerState }) {
  const { t } = useT();
  return (
    <div
      className={cn(
        'bg-card border-border w-full rounded-2xl border p-3.5',
        big && 'max-w-[720px] shadow-lg',
      )}
    >
      {/*
        高度不用 antd 那套 autoSize：shadcn 的 textarea 自带 field-sizing-content，
        跟着内容长，只要给一个 max-h 兜住就等于原来的 maxRows。
      */}
      <Textarea
        value={state.value}
        onChange={(e) => state.onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          /* Enter 发送、Shift+Enter 换行；输入法组词中的 Enter 是选字，不当发送 */
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            state.onSend();
          }
        }}
        className={cn(
          'max-h-40 resize-none border-0 bg-transparent px-1.5 py-0.5 shadow-none focus-visible:ring-0 md:text-[15px]',
          big ? 'min-h-12' : 'min-h-7',
        )}
      />
      {/*
        待发附件缩略图：选完即显示，hover 出移除叉，发出前可以反悔。
        大小钉在 size-16——这里只做「确认带上哪些图」，看大图靠发出后
        消息里的图。
      */}
      {state.attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {state.attachments.map((src, i) => (
            <span key={i} className="group relative">
              <img
                src={src}
                alt={t('chat.attachmentAlt', { i: i + 1 })}
                className="border-border size-16 rounded-lg border object-cover"
              />
              <button
                type="button"
                title={t('settings.remove')}
                onClick={() => state.removeAttachment(i)}
                className="bg-foreground/80 text-background absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {/*
          上传按钮是 label 包隐藏 input 而非 Button onClick：文件选择框没有
          程序化打开的可靠 API（必须由用户手势触发）。选中后清 value，
          同一张图移除再选也能触发 onChange。
        */}
        <label
          title={t('chat.addImage')}
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 cursor-pointer items-center justify-center rounded-full [&>svg]:size-4"
        >
          <Paperclip />
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              state.addImages(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </label>
        <Chip active={state.web} onClick={() => state.setWeb(!state.web)} icon={<Globe />} label={t('chat.webSearch')} />
        <Chip active={state.code} onClick={() => state.setCode(!state.code)} icon={<FlaskConical />} label={t('nav.research')} />
        <div className="ms-auto flex items-center gap-2">
          {/* 没有任何模型配置时占住位并禁用——空下拉会让人以为加载坏了 */}
          <SelectInput
            value={state.model}
            onChange={state.setModel}
            options={state.modelOptions}
            placeholder={t('assistant.noModel')}
            disabled={state.modelOptions.length === 0}
            className="text-muted-foreground h-7 max-w-56 w-auto gap-1.5 truncate border-0 px-2 text-xs shadow-none"
          />
          {/*
            采样配置收进一个浮层：四个旋钮摊在工具行会占满一整排。
            温度/top_p/回复长度随请求发送（OpenAI 标准字段，服务端透传）；
            思考档位目前只有前端状态——部署网关尚未放行 enable_thinking 一类
            chat_template_kwargs，传了也会被丢，先不做假接线。
          */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                className="text-muted-foreground h-7 gap-1.5 rounded-full px-2.5 text-xs font-normal"
              >
                <SlidersHorizontal size={12} /> {t('chat.config')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-90">
              <div className="flex flex-col gap-3.5">
                <ParamRow label={t('chat.thinking')}>
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[Math.max(0, THINKING_VALUES.indexOf(state.thinking))]}
                      min={0}
                      max={2}
                      step={1}
                      onValueChange={([v]) => state.setThinking(THINKING_VALUES[v] ?? 'mid')}
                      className="min-w-0 flex-1"
                    />
                    <span className="text-foreground w-8 text-right text-xs">
                      {t(THINKING_LABEL_KEYS[Math.max(0, THINKING_VALUES.indexOf(state.thinking))] ?? 'settings.thinkingOff')}
                    </span>
                  </div>
                </ParamRow>
                <ParamRow label={t('chat.temperature')}>
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[state.temperature]}
                      min={0}
                      max={2}
                      step={0.1}
                      onValueChange={([v]) => state.setTemperature(v)}
                      className="min-w-0 flex-1"
                    />
                    {/* tabular：拖动时数字不等宽会让整行抖 */}
                    <span className="text-foreground tabular w-8 text-right text-xs">
                      {state.temperature.toFixed(1)}
                    </span>
                  </div>
                </ParamRow>
                <ParamRow label="Top-P">
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[state.topP]}
                      min={0}
                      max={1}
                      step={0.05}
                      onValueChange={([v]) => state.setTopP(v)}
                      className="min-w-0 flex-1"
                    />
                    <span className="text-foreground tabular w-8 text-right text-xs">
                      {state.topP.toFixed(2)}
                    </span>
                  </div>
                </ParamRow>
                <ParamRow label={t('chat.maxTokens')}>
                  {/*
                    默认给实值而不是占位：数字框的上下箭头在空值时只能从 min 起步，
                    有值才与当前数字联动。
                  */}
                  <NumberInput
                    value={state.maxTokens}
                    onChange={state.setMaxTokens}
                    min={256}
                    step={256}
                    className="h-8 w-30 text-[13px]"
                  />
                </ParamRow>
                {/*
                  会话级免审批总闸：长链 autoresearch（连环只读探查 + 训练启动）
                  逐条点同意太磨人。开启只作用于本会话后续，刷新/切会话即复位；
                  界面上红色高亮提示它处于开启态。
                */}
                <ParamRow label={t('chat.noApproval')}>
                  <div className="flex items-center gap-2">
                    <Switch checked={state.noApproval} onCheckedChange={state.setNoApproval} />
                    {state.noApproval && (
                      <span className="text-destructive text-xs">{t('chat.noApprovalOn')}</span>
                    )}
                  </div>
                </ParamRow>
              </div>
            </PopoverContent>
          </Popover>
          {/*
            * 发送键 / 停止键：流式进行中换成停止——没有它，一轮长生成或连环
            * 工具轮就只能干等。停止走 AbortController，已收增量保留。
            * 触感三件套：按压缩放（active:scale）、流式中的呼吸光晕（ping）、
            * 点击后的转圈「停止中」——abort 生效有延迟（如正在跑的工具），
            * 转圈让「已受理」在按钮上可见。
            */}
          {state.streaming ? (
            <Button
              size="icon"
              className="bg-state-failed hover:bg-state-failed/90 relative size-8 rounded-full text-white transition-transform active:scale-90"
              onClick={state.onStop}
              disabled={state.stopping}
              title={state.stopping ? t('chatPanel.stopping') : t('chatPanel.stopGen')}
            >
              {state.stopping ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <>
                  <span className="bg-state-failed/40 pointer-events-none absolute inset-0 animate-ping rounded-full" />
                  <Square size={14} className="relative" />
                </>
              )}
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-8 rounded-full transition-transform active:scale-90"
              onClick={state.onSend}
              title={t('chat.send')}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 单个对话列，多模型对比时并排放多列。tone 是一个背景色 class，见 COLUMN_TONES。
 * messages 是这一列（一个模型）与用户的完整对话；streaming 时末尾画一个光标。
 */
function ChatColumn({
  model,
  tone,
  messages,
  streaming,
  links,
  onGo,
}: {
  model: string;
  tone: string;
  messages: ChatMessage[];
  /* create_* 工具备好的跳转意图：渲染在消息流末尾，点击才落预填并跳转 */
  links?: CreatedLink[];
  /* 按钮点击回调（落预填 + 跳转 + 消费掉该意图）；无意图时不传 */
  onGo?: (link: CreatedLink) => void;
  streaming?: boolean;
}) {
  const { t } = useT();
  /*
   * 跟随滚动：用户停在底部时随流式输出自动下滚；上翻阅读则不打扰，
   * 滚回底部（距底 < 80px）自动恢复跟随。内容增高不会触发 scroll 事件，
   * 只有用户主动滚动才更新 atBottom，二者不互扰。
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  return (
    <div className="border-border/60 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
      <div className="border-border/60 bg-muted/50 flex items-center gap-2 border-b px-3.5 py-2">
        <Badge className={cn('gap-1.5 text-white', tone)}>
          <Bot /> {model}
        </Badge>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex flex-1 flex-col gap-3.5 overflow-auto p-4">
        {messages.length === 0 && (
          <div className="text-muted-foreground m-auto text-[13px]">
            {t('chat.emptyConv', { model })}
          </div>
        )}
        {messages.map((m, i) => {
          /* 工具结果消息：独立一行小卡片，与发起它的调用块前后呼应 */
          if (m.role === 'tool') {
            return (
              <div key={i} className="flex gap-2.5">
                <span className="bg-muted text-muted-foreground flex size-7 flex-none items-center justify-center rounded-full [&>svg]:size-3.5">
                  <Terminal />
                </span>
                <div className="flex min-w-0 max-w-[78%] flex-col">
                  <ToolFold label={t('chat.toolResult')} text={m.content} />
                </div>
              </div>
            );
          }
          /* 唤醒事件消息（脚本完成 / autoresearch）：进模型历史仍是 user role，
             渲染层识别固定前缀画成居中事件卡片——对人是系统通知而非用户发言 */
          if (m.role === 'user' && isWakeEvent(m.content)) {
            return <WakeEventCard key={i} text={m.content} />;
          }
          const mine = m.role === 'user';
          const isLast = i === messages.length - 1;
          /*
           * 思维链显示规则：流式思考中（正文未开始）→ 折叠块独占、标题「思考中…」；
           * 正文出现后 → 折叠块（收起）+ 正文气泡；流结束正文仍为空 → 思维链直接
           * 顶上当正文——这是非思考模型（整条流没标签、全落进思考桶）和思考被
           * max_tokens 截断两种情形的兜底，已发出的 delta 无法收回，只能在渲染层判。
           */
          const think = mine ? undefined : m.reasoning;
          const thinkingNow = Boolean(think) && streaming && isLast && !m.content;
          const showThink = Boolean(think) && (thinkingNow || Boolean(m.content));
          const body = m.content || (!thinkingNow && think ? think : '');
          return (
            <div key={i} className={cn('flex gap-2.5', mine && 'flex-row-reverse')}>
              <span
                className={cn(
                  'flex size-7 flex-none items-center justify-center rounded-full [&>svg]:size-3.5',
                  mine ? 'bg-secondary text-secondary-foreground' : cn('text-white', tone),
                )}
              >
                {mine ? <User /> : <Bot />}
              </span>
              <div className="flex min-w-0 max-w-[78%] flex-col">
                {showThink ? <ThinkingBlock text={think ?? ''} active={thinkingNow} /> : null}
                {m.toolCalls?.map((c) => (
                  <ToolFold key={c.id} label={t('chat.toolCall', { name: c.name })} text={fmtCallArgs(c)} />
                ))}
                {!thinkingNow && (
                  <div
                    className={cn(
                      'text-foreground rounded-lg px-3.5 py-2.5 text-sm leading-[22px]',
                      mine ? 'bg-primary/10' : 'bg-muted',
                    )}
                  >
                    {mine && m.images?.length ? (
                      /* 消息附带的图片：data URL 直接作 src；max-h 兜住长截图 */
                      <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                        {m.images.map((src, j) => (
                          <img
                            key={j}
                            src={src}
                            alt={t('chat.attachedImage', { j: j + 1 })}
                            className="border-border max-h-40 rounded-lg border object-contain"
                          />
                        ))}
                      </div>
                    ) : null}
                    {/* assistant 正文走 markdown；用户输入保持纯文本（无排版语义） */}
                    {mine || !body ? body : <MarkdownBody text={body} />}
                    {!mine && streaming && isLast && (
                      <span className="animate-pulse">▍</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {/* create_* 工具的跳转意图：不在流式期抢路由，等模型说完话用户自己决定 */}
        {!!links?.length && onGo && (
          <div className="flex flex-wrap gap-2 pl-9.5">
            {links.map((link, i) => (
              <Button
                key={`${link.to}-${i}`}
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-3 text-xs"
                onClick={() => onGo(link)}
              >
                {t('chat.goLink', { label: link.label })}
                <ChevronRight size={12} />
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/*
 * 唤醒事件消息的固定前缀：与合成侧成对维护（脚本泵拼「[脚本事件] …」、
 * 研究泵 composeWakeupMessage 拼「[autoresearch 唤醒] …」）。进模型历史仍是
 * user role（协议约束），渲染层只借前缀区分展示形态。
 */
const SCRIPT_EVENT_PREFIX = '[脚本事件]';
const RESEARCH_EVENT_PREFIX = '[autoresearch 唤醒]';

function isWakeEvent(text: string): boolean {
  return text.startsWith(SCRIPT_EVENT_PREFIX) || text.startsWith(RESEARCH_EVENT_PREFIX);
}

/** 唤醒事件卡片：居中系统通知形态，无头像不占用户位；正文等宽小字展示日志尾 */
function WakeEventCard({ text }: { text: string }) {
  const { t } = useT();
  const script = text.startsWith(SCRIPT_EVENT_PREFIX);
  const body = text.replace(script ? SCRIPT_EVENT_PREFIX : RESEARCH_EVENT_PREFIX, '').trim();
  return (
    <div className="mx-auto w-full max-w-[85%]">
      <div className="border-border/60 bg-muted/40 rounded-lg border px-3 py-2">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          {script ? <Terminal size={12} className="flex-none" /> : <FlaskConical size={12} className="flex-none" />}
          {script ? t('chat.scriptEvent') : t('chat.researchEvent')}
        </div>
        <pre className="text-muted-foreground mt-1.5 max-h-40 overflow-auto font-mono text-[11.5px] leading-[18px] break-all whitespace-pre-wrap">
          {body}
        </pre>
      </div>
    </div>
  );
}

/**
 * 思维链折叠块：默认收起，点标题行展开/收起。流式进行中（正文还没开始出）
 * 标题显示「思考中…」，此时也能点开看进度；字数提示让人不点开也能掂量长短。
 */
function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-border/60 bg-muted/40 mb-1.5 overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors"
      >
        <ChevronRight size={12} className={cn('flex-none transition-transform', open && 'rotate-90')} />
        <span className="flex-none">{active ? t('chat.thinkingActive') : t('chat.thinkingDone')}</span>
        {!active && (
          <span className="text-muted-foreground/60 truncate text-[11px]">{t('chat.chars', { n: text.length })}</span>
        )}
      </button>
      {open && (
        <div className="text-muted-foreground border-border/60 max-h-64 overflow-auto border-t px-3 py-2 text-[13px] leading-5 whitespace-pre-wrap">
          {text}
          {active && <span className="animate-pulse">▍</span>}
        </div>
      )}
    </div>
  );
}

/**
 * 工具调用 / 工具结果的折叠块：与 ThinkingBlock 同款交互（默认收起、点标题
 * 展开），收起时标题行给字数让人掂量要不要点开。mono 字体——内容要么是
 * 参数 JSON 要么是命令输出，不是自然语言。
 */
function ToolFold({ label, text }: { label: string; text: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-border/60 bg-muted/40 mb-1.5 overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors"
      >
        <Wrench size={12} className="flex-none" />
        <span className="flex-none">{label}</span>
        {!open && (
          <span className="text-muted-foreground/60 truncate text-[11px]">{t('chat.chars', { n: text.length })}</span>
        )}
      </button>
      {open && (
        <div className="text-muted-foreground border-border/60 max-h-64 overflow-auto border-t px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
          {text}
        </div>
      )}
    </div>
  );
}

/** 工具调用的参数转成可读的多行 JSON（坏 JSON 原样展示） */
function fmtCallArgs(c: ToolCall): string {
  try {
    return JSON.stringify(JSON.parse(c.arguments), null, 2);
  } catch {
    return c.arguments;
  }
}

/**
 * assistant 正文的 markdown 渲染。
 *
 * 样式用手写的 components 映射贴既有气泡体系（不为一个消费点引入
 * tailwind typography 整个插件）；react-markdown 默认转义 raw HTML，
 * 模型输出注入片段也不会被执行。流式期间未闭合的加粗/标题会短暂
 * 显示字面符号——所有流式 markdown 产品共有的过渡态，不额外处理。
 */
function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <ReactMarkdown
        components={{
          h1: ({ children }) => <h1 className="text-[15px] font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[14px] font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold">{children}</h4>,
          pre: ({ children }) => (
            <pre className="bg-muted overflow-auto rounded-lg p-3 font-mono text-xs leading-5">
              {children}
            </pre>
          ),
          code: ({ className, children }) =>
            String(className).includes('language-') ? (
              <code className="font-mono text-xs">{children}</code>
            ) : (
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-[13px]">{children}</code>
            ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-auto">
              <table className="border-border w-full border-collapse [&_td]:border-border [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border-border [&_th]:bg-muted/50 [&_th]:border [&_th]:px-2 [&_th]:py-1">
                {children}
              </table>
            </div>
          ),
          ul: ({ children }) => <ul className="list-disc ps-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal ps-5">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="border-primary/40 text-muted-foreground border-s-2 ps-3">{children}</blockquote>
          ),
          hr: () => <hr className="border-border" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 相对时间：会话列表用「x 分钟前」这档粗粒度足够；t 由调用方传入 */
function fmtAgo(at: number, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  const s = Math.max(0, Date.now() - at) / 1000;
  if (s < 60) return t('chat.justNow');
  if (s < 3600) return t('chat.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('chat.hoursAgo', { n: Math.floor(s / 3600) });
  return t('chat.daysAgo', { n: Math.floor(s / 86400) });
}

/**
 * 选中的图片统一过一遍 canvas：长边压到 1120、转 JPEG（透明区域垫白底）。
 * 两个动机——多模态模型的有效分辨率就在这一档，更大的图只是浪费 token；
 * data URL 还要随消息进 localStorage 持久化，原图动辄几 MB 会撞配额。
 */
async function normalizeImage(file: File, t: (key: MessageKey) => string): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1120 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(t('chat.canvasFail'));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * web_search 的工具结果：带编号的标题/链接/摘要块。引用处注明「来源 [n]」
 * 的引导写在工具 description 与 WEB_SEARCH_SYSTEM 里，这里只给数据本身。
 */
/**
 * 左侧会话列表：hero 态与会话态共用。hero 态也带出它——侧栏「最近」只有
 * 5 条，超过的历史对话必须在这里找得回来。hero 态本身即是新对话入口，
 * 所以那一档不再画「新对话」按钮（newButton=false）。
 */
function ConversationList({
  chats,
  activeConv,
  onOpen,
  onNew,
  onRemove,
  newButton = true,
}: {
  chats: ChatMeta[];
  activeConv: string;
  onOpen: (id: string) => void;
  onNew?: () => void;
  /** 删除一段对话；不传则不显示删除入口（hero 场景不需要） */
  onRemove?: (id: string) => void;
  newButton?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="border-border/60 flex w-62 flex-none flex-col border-e">
      {newButton && (
        <div className="p-3">
          <Button className="w-full rounded-full" onClick={onNew}>
            <Plus /> {t('common.newChat')}
          </Button>
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {chats.length === 0 && (
          <div className="text-muted-foreground px-3.5 py-2.5 text-[13px]">{t('chat.noChats')}</div>
        )}
        {chats.map((c) => (
          /*
            行是 div 而非 button：行内还有删除按钮，button 套 button 不合法。
            删除按钮 hover 才现身，标题行给它留出 pe-5 的位置。
          */
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(c.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onOpen(c.id);
            }}
            className={cn(
              'group relative flex w-full cursor-pointer flex-col gap-0.5 border-s-2 px-3.5 py-2.5 text-left outline-none',
              c.id === activeConv
                ? 'border-primary bg-primary/8'
                : 'hover:bg-muted border-transparent',
            )}
          >
            <span className="text-foreground truncate pe-5 text-[13px]">{c.title}</span>
            <span className="text-muted-foreground text-xs">{fmtAgo(c.updatedAt, t)}</span>
            {onRemove && (
              /*
                删除要二次确认，但不用 window.confirm：预览面板的 iframe 没有
                allow-modals 权限时它不弹窗且恒返回 false，按钮看起来就是「点了
                没反应」。AlertDialog 是 React 渲染的弹层，不受沙箱影响。
              */
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    title={t('chat.deleteChat')}
                    className="text-muted-foreground/60 hover:text-state-failed absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Trash2 size={12} />
                  </button>
                </AlertDialogTrigger>
                {/*
                  Content 渲染在 portal（DOM 在 body 下），但 React 的合成事件沿
                  React 树冒泡——它仍是列表行 div 的后代，点「取消/删除」会窜到
                  行的 onClick（切换会话/回首页），把弹窗连同删除一起拆走。
                  在这里截断，弹层内的点击不再影响外层。
                */}
                <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('chat.deleteChatTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('chat.deleteChatDesc', { title: c.title })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => onRemove(c.id)}>{t('common.delete')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 对话页。打开即见一个居中的大对话框（hero）；发一条或点开历史会话后，
 * 才切到左列表 + 右对话区。「对比模式」下右侧变多列——对应设计里的多模型并排对比。
 */
export function ChatPage() {
  const { t } = useT();
  const mod = MODULES.chat;
  const navigate = useNavigate();
  const [started, setStarted] = useState(false);
  const [compare, setCompare] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const convParam = searchParams.get('conv');

  /* 模型配置来自「模型」页管理的 ~/.swift/models.json；展览模式再前置注入默认模型 */
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([]);
  const ids = modelConfigs.map((m) => m.id);
  const [models, setModels] = useState<string[]>([]);
  const [single, setSingle] = useState('');
  /*
   * 登录会话与默认模型：msModelIds 标记哪些模型走会话 token 鉴权（提交时随
   * x-swift-api-key 头带给服务端）。未登录恒为空集合——两种模式同一条链。
   */
  /* 全局设置（机器侧）：人格 prompt 从这里解；默认采样在 loaded 后同步一次；令牌同源 */
  const { settings, loaded: settingsLoaded } = useSettings();
  const token = settings.msToken;
  const [msModelIds, setMsModelIds] = useState<Set<string>>(new Set());
  /* 当前会话：'' = 尚未开始（hero 态或刚点「新对话」），首条消息发送时建档 */
  const [activeConv, setActiveConv] = useState('');
  const chats = useChats();

  /*
   * autoresearch 绑定：当前会话关联的研究会话。切换会话时发现一次；每轮
   * 发送结束后再补一次（create_research 发生在流式往返里，往返结束才在
   * 服务端落盘可见）。绑定在 → 事件轮询（见 send 下方的唤醒 effect）+ 对话
   * 区模型选择器旁的研究状态徽标 + autoresearch 指引与工具常驻注入。
   */
  const [research, setResearch] = useState<ResearchSummary | null>(null);
  /* 研究面板（对话区内嵌的迭代账本+事件流）：徽标点开/收起；详情态另拉全量 */
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);
  const [researchDetail, setResearchDetail] = useState<ResearchSession | null>(null);
  useEffect(() => {
    if (!activeConv) {
      setResearch(null);
      return;
    }
    listResearch()
      .then((list) => setResearch(boundResearch(list, activeConv)))
      .catch(() => {
        /* 服务端研究面暂不可用：本轮不带绑定，不拦对话 */
      });
  }, [activeConv]);
  const refreshResearchBinding = (conv: string) => {
    listResearch()
      .then((list) => setResearch(boundResearch(list, conv)))
      .catch(() => {});
  };

  /*
   * 会话消息：会话 × 模型两维。对比模式的每一列是独立对话（各列各看各的
   * 上下文），所以消息按 modelId 分桶而不是全图共享一份。持久化经
   * store/turns 按桶写穿透（见 send 里的 patch）——组件卸载后仍在跑的
   * 流式循环照常落盘，也不会整图写回覆盖别的桶。
   */
  const [turns, setTurns] = useState<Record<string, Record<string, ChatMessage[]>>>(loadTurns);
  const [streaming, setStreaming] = useState(false);
  /*
   * create_* 工具上抛的跳转意图，按「会话 :: 模型列」分桶存。点击按钮时才
   * 落预填并跳转（工具本身不再抢路由——消融场景下用户可能想先继续对话，
   * 自动跳转会打断）。点掉的按钮即消费，不点就一直在那，刷新后不复活
   * （组件态；跳转与否本来就是即时决策，不进 turns 持久化）。
   */
  const [pendingLinks, setPendingLinks] = useState<Record<string, CreatedLink[]>>({});
  /** 技能注入段：mount 时拉一次清单拼好，send() 直接消费（空串 = 无技能不注入） */
  const [skillsSystem, setSkillsSystem] = useState('');

  /*
   * URL 的 conv 参数是会话态的唯一开关：有值进对应会话；被清空（点侧栏「对话」
   * 导航、点「新对话」、再点当前会话的 toggle）即回首页。依赖只有 convParam，
   * hero 态发送消息不触碰 URL，所以不会被误拉回首页。
   *
   * 进会话时顺带恢复该会话实际用过的模型：默认选中（清单第一条或官方默认
   * 模型）与会话存消息的桶未必是同一个——不恢复的话右侧是空列（消息都在
   * 另一个模型的桶里，看着像「历史丢了」）。当前选中桶有消息就不动；否则
   * 切到消息最多的桶（对比会话的主力列，单模型会话就是唯一桶）。只读此处
   * 闭包里的镜像：会话切换发生在挂载后、turns 全量在手，而流式中途不重跑
   * （依赖只有 convParam），不会把用户手切的模型又拨回去。
   */
  useEffect(() => {
    if (convParam) {
      setActiveConv(convParam);
      setStarted(true);
      const buckets = turns[convParam];
      if (buckets && !(buckets[single] ?? []).length) {
        let best = '';
        let bestLen = 0;
        for (const [m, msgs] of Object.entries(buckets)) {
          if (msgs.length > bestLen) {
            best = m;
            bestLen = msgs.length;
          }
        }
        if (best) setSingle(best);
      }
      /*
       * headless 拉回（会话激活时，visibility 恢复时同函数重做，见下方监听）。
       */
      void pullServerTurns();
    } else {
      setActiveConv('');
      setStarted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convParam]);

  /*
   * headless 拉回（会话激活与页面重新可见共用）：浏览器关闭/休眠期间 server
   * 可能直写过研究轮次（convs.json 的桶比本地长）。比对后采用 server 版——
   * 否则一直开着的旧标签页看不到 headless 轮次，还会在下次推送时用旧桶盖掉
   * 它们（服务端 PUT 守卫兜底，但这里先拉回就无竞态）。切回标签页/电脑唤醒
   * 后组件不会重新 mount，拉回必须跟着 visibility 重做——否则页面在旧基础
   * 上续写新回合，与 headless 轮次分叉，守卫按长度二选一时必丢一边。
   */
  const pullServerTurns = async (): Promise<void> => {
    if (!convParam) return;
    try {
      const res = await fetch('/api/convs');
      if (!res.ok) return;
      const srv = (await res.json()) as { turns?: Record<string, Record<string, ChatMessage[]>> };
      const srvBuckets = srv.turns?.[convParam];
      if (!srvBuckets) return;
      setTurns((prev) => {
        let changed = false;
        const localBuckets = prev[convParam] ?? {};
        const merged: Record<string, ChatMessage[]> = { ...localBuckets };
        for (const [m, msgs] of Object.entries(srvBuckets)) {
          if (!Array.isArray(msgs)) continue;
          if (!merged[m] || msgs.length > merged[m].length) {
            merged[m] = msgs;
            changed = true;
            /* 拉回的桶逐个写穿透（读-改-写全量，不动其他桶）并触发镜像推送 */
            saveTurns(convParam, m, msgs);
          }
        }
        if (!changed) return prev;
        return { ...prev, [convParam]: merged };
      });
    } catch {
      /* 服务端不可达：本地态照常 */
    }
  };
  const pullServerTurnsRef = useRef(pullServerTurns);
  pullServerTurnsRef.current = pullServerTurns;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void pullServerTurnsRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        /*
         * 已登录时把服务端选出的默认模型（dolphin 的 DeepSeek/Kimi/Qwen 各一）
         * 前置到下拉首位，默认选中整体最前那条；清单拉取失败不拦对话——
         * 退回 models.json 条目。未登录只加载 models.json，行为不变。
         */
        const [configs, ms] = await Promise.all([
          listModels(),
          token ? listMsModels().catch(() => null) : Promise.resolve(null),
        ]);
        const msConfigs: ModelConfig[] = (ms?.models ?? []).map((m) => ({
          id: m.model,
          baseUrl: 'https://api-inference.modelscope.cn/v1',
          model: m.model,
        }));
        if (ms) setMsModelIds(new Set(msConfigs.map((c) => c.id)));
        const merged = [...msConfigs, ...configs];
        setModelConfigs(merged);
        setSingle((prev) => prev || ms?.default || merged[0]?.id || '');
        setModels((prev) => (prev.length ? prev : merged.slice(0, 2).map((c) => c.id)));
      } catch (e) {
        toast.error(String(e));
      }
    })();
  }, [token]);

  /*
   * 技能清单：mount 拉一次拼成 system 注入段。失败静默（技能是增强不是依赖，
   * 端点异常不该挡对话）；拉到空清单同样不注入。
   */
  useEffect(() => {
    listSkills()
      .then((skills) => setSkillsSystem(buildSkillsSystem(skills)))
      .catch(() => {
        /* 服务端技能面暂不可用：本轮会话不带技能上下文 */
      });
  }, []);

  const modelOptions = ids.map((m) => ({ value: m, label: m }));
  const columnTurns = (modelId: string): ChatMessage[] => turns[activeConv]?.[modelId] ?? [];

  /*
   * 研究静默期的下次自动唤醒（分钟）：stallSince 在场 = 无在飞且非终态（server
   * 哨兵 2s 维护，有任务/回合在跑即清零），下次触发 = 无在飞满 30 分钟，且距
   * 上次 stall 事件至少 1 小时（冷却）——两参数镜像自 vite.config.ts 的哨兵。
   * 决策徽标带上它，用户才不用猜「后台还活着没有」。
   */
  const idleWakeMin = (() => {
    if (!research || research.status !== 'deciding' || !research.stallSince) return null;
    const next = Math.max(research.stallSince + 30 * 60_000, (research.lastStallAt ?? 0) + 60 * 60_000);
    return Math.max(Math.ceil((next - Date.now()) / 60_000), 1);
  })();

  /* 按钮点击：落预填（含会话续聊上下文）→ 跳转 → 消费掉这个意图 */
  const goCreatedLink = (conv: string, modelId: string, link: CreatedLink) => {
    writePrefill(link.module, link.payload);
    navigate(link.to);
    setPendingLinks((prev) => {
      const rest = (prev[`${conv}::${modelId}`] ?? []).filter((l) => l !== link);
      const next = { ...prev };
      if (rest.length) next[`${conv}::${modelId}`] = rest;
      else delete next[`${conv}::${modelId}`];
      return next;
    });
  };

  /*
   * 发送防重入：streaming / draft / activeConv 全是异步提交的 React state——双击
   * 发送按钮、或在 state 提交生效前再按一次 Enter，第二次调用读到的守卫仍是旧值
   * （streaming 仍 false、activeConv 仍空），同一条消息会生成两个会话，列表里
   * 出现成对同名条目。ref 同步生效，锁住整次流式往返。
   */
  const sending = useRef(false);

  /* shell 会话级允许集：审批卡勾过「总是允许」的命令名，后续同名命令直接执行 */
  const allowedCommands = useRef(new Set<string>());

  /*
   * 会话级「无需审批」总闸（配置浮层里开）：开启后 requestApproval 直接放行，
   * 覆盖 shell / 训练启动等全部审批面。记忆存 sessionStorage 按会话 id 分键：
   * 同一会话刷新/整页 reload 后保持开启（一个会话期间稳定）；关闭标签页即
   * 清零、切换会话按新会话 id 重读——忘关风险不出标签页。
   */
  const [noApproval, setNoApprovalState] = useState(false);
  const prevConv = useRef('');
  useEffect(() => {
    try {
      /*
       * hero（'' 键）上开的总闸是「接下来要进行的会话」的意图：从 hero 进入任一
       * 会话（首条消息建档或点开历史）时把它带进该会话的键——否则建档那一刻的
       * activeConv 切换会把开关静默复位，主页设了等于白设。只携带开启态、不
       * 反向清除：会话自身记住的开启值不因路过 hero 而丢；会话与会话之间的
       * 直接切换仍各自重读各自的键。
       */
      if (!prevConv.current && activeConv) {
        if (sessionStorage.getItem('swift-webui-noapproval:') === '1') {
          sessionStorage.setItem(`swift-webui-noapproval:${activeConv}`, '1');
        }
      }
      prevConv.current = activeConv;
      setNoApprovalState(sessionStorage.getItem(`swift-webui-noapproval:${activeConv}`) === '1');
    } catch {
      setNoApprovalState(false);
    }
  }, [activeConv]);
  const setNoApproval = (v: boolean) => {
    setNoApprovalState(v);
    try {
      if (v) sessionStorage.setItem(`swift-webui-noapproval:${activeConv}`, '1');
      else sessionStorage.removeItem(`swift-webui-noapproval:${activeConv}`);
    } catch {
      /* 隐私模式等 sessionStorage 不可用：退化为纯组件态（刷新即关） */
    }
  };

  /* shell 等立即执行类操作的审批状态机（统一 agent 层的 hook，卡片渲染在下方） */
  const { approval, alwaysAllow, setAlwaysAllow, requestApproval, settleApproval } = useApproval({
    onAlwaysAllow: (command) => {
      allowedCommands.current.add(command);
      /* 同步 server 白名单：浏览器关闭后的 headless 续轮按同一份放行 */
      void fetch('/api/headless/approvals/allow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      }).catch(() => undefined);
    },
  });
  /*
   * headless 审批：浏览器关闭期间 server 侧研究回合挂起的审批，打开页面时
   * 拉回来渲染（决定走 POST，挂起的 server 回合 1s 内恢复）；同拍把共用白名单
   * 灌进本地允许集——「总是允许」跨 headless/浏览器一致生效。
   */
  const [headlessApprovals, setHeadlessApprovals] = useState<
    { id: string; title: string; reason: string; command?: string }[]
  >([]);
  const [headlessAlways, setHeadlessAlways] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!activeConv) {
      setHeadlessApprovals([]);
      return;
    }
    const tick = async () => {
      try {
        const res = await fetch(`/api/headless/approvals?conv=${encodeURIComponent(activeConv)}`);
        if (!res.ok) return;
        const r = (await res.json()) as {
          approvals?: { id: string; title: string; reason: string; command?: string }[];
          allowed?: string[];
        };
        for (const c of r.allowed ?? []) allowedCommands.current.add(c);
        setHeadlessApprovals(r.approvals ?? []);
      } catch {
        /* 审批面暂不可达：下一拍重试 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => clearInterval(timer);
  }, [activeConv]);
  const resolveHeadlessApproval = (id: string, approve: boolean, allowCommand: boolean) => {
    setHeadlessApprovals((prev) => prev.filter((a) => a.id !== id));
    void fetch(`/api/headless/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve, ...(allowCommand ? { alwaysAllow: true } : {}) }),
    }).catch(() => undefined);
  };
  /* 总闸放行版审批入口：交给 agent 工具层的统一形态 */
  const approveOrBypass = (title: string, reason: string, command?: string) =>
    noApproval ? Promise.resolve(true) : requestApproval(title, reason, command);

  /*
   * 停止键句柄：一次 send 一个 controller，对比模式的所有列共用——停就全停。
   * 停止时连带把未决审批按拒绝结算，卡片不悬空（拒绝文案回喂，模型换路收尾）。
   * stopping 标记「已点停止、流还没真正结束」——abort 生效有延迟（正在执行的
   * 工具任其跑完），按钮在这期间转圈，流结束由 effect 复位。
   */
  const abortRef = useRef<AbortController | null>(null);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!streaming) setStopping(false);
  }, [streaming]);
  const stop = () => {
    if (!abortRef.current) return;
    setStopping(true);
    abortRef.current.abort();
    settleApproval(false);
  };

  /*
   * 发送：给每个目标列追加 user 消息（文字 + 图片附件）并各自流式拉回复。
   * preset 是 autoresearch 唤醒通道的合成消息——文字与目标列固定（会话绑定的
   * 研究模型），不吃输入框的草稿与附件；返回是否真的发出（唤醒侧据此判定
   * 事件是否已交付，没发出就留在 pending 下一拍重试）。
   */
  const send = async (preset?: { text: string; modelId?: string }): Promise<boolean> => {
    /*
     * hero 态（还没开始任何会话）空输入点发送 = 直接把默认提示语当第一条
     * 消息发出——placeholder 本体保持原生形态（浅色、不可编辑、输入即消失），
     * 只在发送这一刻取它的文案。会话已开始后空输入仍然无动作（防误触）。
     */
    const text = preset ? preset.text : draft.trim() || (!started ? t(DEFAULT_PROMPT_KEY) : '');
    /* 纯图消息合法：文字可以空，但至少得有一张图或一句话 */
    if ((!text && !attachments.length) || streaming || sending.current) return false;
    const targets = preset?.modelId ? [preset.modelId] : compare ? models : [single];
    if (!targets.length) {
      toast.error(compare ? t('chat.errCompareModels') : t('chat.errPickModel'));
      return false;
    }
    /* 默认模型走会话 token 鉴权：没登录就没有可用凭据（双模式同规则） */
    if (!token && targets.some((x) => msModelIds.has(x))) {
      toast.error(t('chat.errLoginDefault'));
      return false;
    }
    sending.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    /* 无会话（hero 首发 / 刚点「新对话」）时建档，标题取首句；续聊只刷新时间 */
    const conv = activeConv || `c${Date.now().toString(36)}`;
    if (!activeConv) setActiveConv(conv);
    const title = text
      ? text.length > 16
        ? `${text.slice(0, 16)}…`
        : text
      : t('chat.imageTitle', { n: attachments.length });
    pushChat(conv, title);
    setStarted(true);
    /* 合成消息不清用户的草稿与附件（它们还在输入框里等下一次正常发送） */
    if (!preset) {
      setDraft('');
      setAttachments([]);
    }
    setStreaming(true);
    /*
     * 会话入侧栏「最近」：以会话为去重键，续聊只上浮不占新位。path 带 conv
     * 参数——点击直达这段对话（本页监听 ?conv= 切换会话），不再是无效的同路由跳转。
     */
    pushRecent({
      id: `chat:${conv}`,
      label: title,
      path: `/chat?conv=${encodeURIComponent(conv)}`,
    });

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      ...(!preset && attachments.length ? { images: [...attachments] } : {}),
    };
    /*
     * 列消息的内存镜像 + 写穿透持久化：render 走 setTurns，落盘走 saveTurns
     * （按桶读改写）。为什么镜像而不是 setTurns(prev => …)：流式期间用户可能
     * 自己切路由（create_* 已改成按钮跳转，但用户点按钮/点侧栏同样会卸载本
     * 组件），updater 形态的更新在卸载后整体失效，对话尾部（工具结果与最终
     * 回复）会静默丢失；闭包镜像 + 直接落盘让循环写穿到存储，与组件生命
     * 周期解耦。
     */
    const msgsByModel = new Map<string, ChatMessage[]>();
    const syncColumn = (modelId: string, msgs: ChatMessage[]) => {
      msgsByModel.set(modelId, msgs);
      saveTurns(conv, modelId, msgs);
      setTurns((prev) => ({ ...prev, [conv]: { ...(prev[conv] ?? {}), [modelId]: msgs } }));
    };
    for (const x of targets) {
      syncColumn(x, [...(turns[conv]?.[x] ?? []), userMsg]);
    }

    /*
     * 基础 system 从全局设置的提示词库解出（机器侧持久、改完即生效）：默认
     * 形态注入「对话基础」prompt，点「研究」胶囊即切换为研究模式 prompt——
     * 对话页的两个作用（测训练效果 / auto-research 协助）就差在这一条 system
     * 上。被清空 = 不注入（人格留白）。研究模式另附行为引导（文档优先、少翻
     * 本地文件）——代码级注入，不随用户设置里的旧预设文案漂移。
     */
    const { base: basePrompt, research: researchPrompt } = resolvePersona(settings.systemPrompts);
    const persona = (code ? researchPrompt : basePrompt).trim();

    /*
     * 踩坑教训常驻注入（研究/代码模式）：workspace/EXPERIMENTS.md 头部 60 行
     * （条目约定 prepend 在文件头，最新在前）。跨会话的失败根因不靠模型记忆、
     * 也不靠对话摘要——摘要有损，而 system 注入每轮原样在场（compressHistory
     * 只压对话本体）。文件不存在则静默跳过：第一次踩坑后由指引教模型建它。
     */
    let lessonsSystem = '';
    if (code || research) {
      try {
        const r = await fsTool({ op: 'read', path: 'EXPERIMENTS.md', root: 'workspace', limit: 60 });
        const c = (r.content ?? '').trim();
        if (c) lessonsSystem = `## 过往实验与踩坑记录（workspace/EXPERIMENTS.md 头部，最新在前；更早的条目用 read_file 读全文件）\n${c}`;
      } catch {
        /* 文件不存在或不可读：没有教训可注入 */
      }
    }

    try {
      await Promise.all(
        targets.map(async (modelId) => {
          const apiKey = msModelIds.has(modelId) ? token : undefined;
          /*
           * 对话本体先过压缩：token 估算超阈值时，旧消息折成一条摘要 system
           * 消息 + 保留最近几轮原文（rolling summary，摘要结果单独持久化、
           * 跨轮复用）。失败或未超阈值原样返回。渲染与 turns 持久化仍是
           * 全量原文——压缩只影响发出去的请求体。
           */
          const dialogue = await compressHistory({
            convId: conv,
            modelId,
            dialogue: msgsByModel.get(modelId) ?? [],
            ...(apiKey ? { apiKey } : {}),
          });
          const history: ChatMessage[] = [
            ...(persona ? [{ role: 'system' as const, content: persona }] : []),
            ...(web ? [{ role: 'system' as const, content: WEB_SEARCH_SYSTEM }] : []),
            ...(code ? [{ role: 'system' as const, content: RESEARCH_GUIDANCE }] : []),
            /* autoresearch 指引：研究模式（访谈阶段）或会话已绑定研究会话（循环阶段）时常驻 */
            ...(code || research ? [{ role: 'system' as const, content: AUTORESEARCH_GUIDE }] : []),
            /* 踩坑教训文件头部（同上常驻；内容为空时不注入） */
            ...(lessonsSystem ? [{ role: 'system' as const, content: lessonsSystem }] : []),
            { role: 'system' as const, content: HOME_SYSTEM },
            /* 工作台行动指引：swift 用法/数据集入口/模型选型/算力分片的正确路标 */
            { role: 'system' as const, content: WORKBENCH_GUIDE },
            /* 技能文档随首页常驻注入（与任务工具同定位：工作台的固有上下文） */
            ...(skillsSystem ? [{ role: 'system' as const, content: skillsSystem }] : []),
            ...dialogue,
          ];
          const patch = (fn: (msgs: ChatMessage[]) => ChatMessage[]) =>
            syncColumn(modelId, fn(msgsByModel.get(modelId) ?? []));
          /*
           * 工具集按胶囊组合：「研究」给文件/shell 四件套、「联网搜索」给检索工具；
           * 任务工具（创建/列出/停止）常驻——首页的定位就是工作台入口，不随胶囊
           * 开关。read_skill / list_catalog / env_info 与 skills 注入、行动指引
           * 同定位（常驻）：文档要够得着、数据集有入口、环境事实不用 shell 试探。
           * homeTools 每列各建一份：预填上下文要带上本列模型，目标页助手续聊
           * 时才知道加载哪个桶。
           * 研究会话绑定的对话也挂 workspace 工具：循环里的数据准备（自写预处理
           * 脚本、跑 Challenger 组件、继承改写）靠 write_file/run_script，不能
           * 依赖用户记得开「研究」胶囊——事件唤醒时胶囊可能关着。
           */
          const tools = [
            readSkillDocTool(),
            listCatalogTool(),
            envInfoTool(),
            readSwiftSourceTool(),
            ...((code || research) ? workspaceTools(conv, modelId) : []),
            /* autoresearch 工具与指引同定位：访谈要它、事件唤醒后的循环决策更要它 */
            ...((code || research) ? researchTools(conv, modelId) : []),
            ...(web ? [webSearchTool()] : []),
            ...homeTools({
              userRequest: text,
              /* 创建意图上抛：不跳转，渲染成回复区的「前往查看」按钮 */
              onCreate: (link) =>
                setPendingLinks((prev) => ({
                  ...prev,
                  [`${conv}::${modelId}`]: [...(prev[`${conv}::${modelId}`] ?? []), link],
                })),
              conv,
              model: modelId,
            }),
          ];
          /*
           * agent 循环（统一层）：模型发起调用就执行、结果回喂再续一轮，直到
           * 不再调用或撞轮次上限；无工具模式首轮即终轮。turns 的落库通过
           * events 回调同步——渲染与持久化同一条流。
           */
          await runAgentLoop({
            model: modelId,
            history,
            tools,
            ctx: { requestApproval: approveOrBypass, allowedCommands: allowedCommands.current },
            sampling: { temperature, topP, maxTokens },
            /* 登录后的默认模型随请求带会话 token；其余模型不带头（服务端查 models.json） */
            ...(apiKey ? { apiKey } : {}),
            signal: abort.signal,
            /* 页面回合标记：模型思考中途关页面时，中间件据此登记断口并触发续轮 */
            convId: conv,
            events: {
              onAssistantStart: () => patch((msgs) => [...msgs, { role: 'assistant', content: '' }]),
              onDelta: (parts) =>
                patch((msgs) => {
                  const last = msgs[msgs.length - 1];
                  return [
                    ...msgs.slice(0, -1),
                    {
                      role: 'assistant' as const,
                      content: last.content + parts.content,
                      reasoning: (last.reasoning ?? '') + parts.reasoning,
                      toolCalls: parts.toolCalls?.length
                        ? [...(last.toolCalls ?? []), ...parts.toolCalls]
                        : last.toolCalls,
                    },
                  ];
                }),
              onToolResult: (call, result) =>
                patch((msgs) => [...msgs, { role: 'tool', content: result, toolCallId: call.id }]),
              onError: (text) =>
                patch((msgs) => [
                  ...msgs.slice(0, -1),
                  { role: 'assistant', content: msgs[msgs.length - 1].content || text },
                ]),
              /* 非致命提示（截断等）：追加到末尾消息尾部，不覆盖已收内容 */
              onNotice: (text) =>
                patch((msgs) => {
                  const last = msgs[msgs.length - 1];
                  if (!last || last.role !== 'assistant' || !last.content) return msgs;
                  return [...msgs.slice(0, -1), { ...last, content: `${last.content}\n\n${text}` }];
                }),
            },
          });
          /* 被停止的流：末条 assistant 正文补一个停止标记（工具结果结尾就不加） */
          if (abort.signal.aborted) {
            patch((msgs) => {
              const last = msgs[msgs.length - 1];
              if (!last || last.role !== 'assistant' || !last.content) return msgs;
              return [...msgs.slice(0, -1), { ...last, content: `${last.content}\n\n${t('assistant.stopped')}` }];
            });
          }
        }),
      );
      /*
       * 本轮流结束补一次绑定发现：create_research 在往返内落盘，这里刷新
       * 才能让事件轮询立即接上（否则要等下次会话切换）。返回 true = 消息
       * 确已发出（唤醒侧据此清 pending）。
       */
      refreshResearchBinding(conv);
      return true;
    } finally {
      sending.current = false;
      setStreaming(false);
      if (abortRef.current === abort) abortRef.current = null;
    }
  };

  /*
   * autoresearch 唤醒轮询：会话绑定了研究会话就 2s 一拍。先 peek（GET :id
   * 带 events）看到有事件才 consume——取走即删，流式进行中不动队列；事件
   * 拼成合成 user 消息自动触发 send（目标列 = 会话绑定的研究模型，审批照
   * 常弹，用户不在就停在审批卡）。取走与发出之间用户恰好发消息的竞态由
   * pending 兠住：send 没接（false）就留在 pending 下一拍重试，事件不丢。
   * sendRef 每渲染同步最新闭包（send 读的 streaming/turns 都是当渲染的 state）。
   */
  const pendingWakeup = useRef<string | null>(null);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    const id = research?.id;
    const modelId = research?.modelId ?? '';
    if (!id) return;
    /*
     * 投递至多一次：send 抛异常（上游断流等）时合成消息已在列里，重试只会
     * 每 2 秒重复一条相同消息无限刷屏——事件弃置并显式报错，唤醒丢失是
     * 本通道已接受的取舍（内存队列、服务重启即清零）。
     */
    const flush = async (text: string) => {
      try {
        const ok = await sendRef.current({ text, ...(modelId ? { modelId } : {}) });
        if (ok) pendingWakeup.current = null;
      } catch {
        pendingWakeup.current = null;
        toast.error(tStatic('chat.wakeDrop'));
      }
    };
    const tick = async () => {
      try {
        if (pendingWakeup.current) {
          await flush(pendingWakeup.current);
          return;
        }
        /* peek：完整会话（含 events）。顺带刷状态（研究徽标），仅在变化时 setState */
        const s = await getResearch(id);
        setResearch((prev) => {
          if (!prev || prev.id !== id || prev.status === s.status) return prev;
          const { events: _pending, ...summary } = s;
          return summary;
        });
        if (!s.events.length) return;
        const events = await consumeResearchEvents(id);
        if (!events.length) return;
        pendingWakeup.current = composeWakeupMessage(s, events);
        await flush(pendingWakeup.current);
      } catch {
        /* 研究面暂不可用：事件留在服务端队列，下一拍重试 */
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => clearInterval(timer);
  }, [research?.id]);

  /*
   * 脚本唤醒轮询：本会话经 run_script 启动的后台脚本到达终态（done/failed）
   * 时，中间件把事件推入会话队列；这里 2s 一拍取走（take=1 消费即删），拼成
   * 合成消息自动触发 send（目标列 = 启动脚本的那列，由事件带回）。与研究
   * 唤醒同构：取走与发出之间流式进行中的竞态由 pending 兜住重试，事件文本
   * 已在手上不丢。脚本唤醒不依赖研究胶囊——run_script 挂在代码模式下，
   * 模型回合在脚本运行中自然结束，完成事件把它拉回来继续决策。
   */
  const pendingScriptWakeup = useRef<{ text: string; modelId?: string } | null>(null);
  useEffect(() => {
    if (!activeConv) return;
    const flush = async () => {
      const pending = pendingScriptWakeup.current;
      if (!pending) return;
      /* 同研究泵：send 抛异常时事件弃置（合成消息已入列，重试只会重复刷屏） */
      try {
        const ok = await sendRef.current({ text: pending.text, ...(pending.modelId ? { modelId: pending.modelId } : {}) });
        if (ok) pendingScriptWakeup.current = null;
      } catch {
        pendingScriptWakeup.current = null;
        toast.error(tStatic('chat.wakeDrop'));
      }
    };
    const tick = async () => {
      try {
        await flush();
        if (pendingScriptWakeup.current) return;
        const res = await fetch(`/api/conv-events?conv=${encodeURIComponent(activeConv)}&take=1`);
        if (!res.ok) return;
        const { events } = (await res.json()) as { events: { text: string; modelId?: string }[] };
        if (!events.length) return;
        pendingScriptWakeup.current = {
          text: events.map((e) => `[脚本事件] ${e.text}`).join('\n\n'),
          modelId: events[0].modelId,
        };
        await flush();
      } catch {
        /* 事件面暂不可用：已取走的由 pending 兑住，未取走的下一拍重试 */
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => clearInterval(timer);
  }, [activeConv]);

  /*
   * 后台脚本存在性提示：模型回合随脚本转入后台而自然结束（发送按钮恢复），
   * 「还有任务在跑」这件事必须在界面上可见。2s 轮询 /api/scripts 按 conv
   * 过滤 running 态；完成通知由事件泵负责，这里只做执行中状态条。
   */
  const [bgScripts, setBgScripts] = useState<{ id: string; script: string }[]>([]);
  useEffect(() => {
    if (!activeConv) {
      setBgScripts([]);
      return;
    }
    const tick = async () => {
      try {
        const res = await fetch('/api/scripts');
        if (!res.ok) return;
        const { tasks } = (await res.json()) as {
          tasks: { id: string; script: string; status: string; conv?: string }[];
        };
        const running = tasks
          .filter((x) => x.conv === activeConv && x.status === 'running')
          .map(({ id, script }) => ({ id, script }));
        setBgScripts((prev) =>
          prev.length === running.length && prev.every((p, i) => p.id === running[i]?.id && p.script === running[i]?.script)
            ? prev
            : running,
        );
      } catch {
        /* 状态面暂不可用：保留上一帧 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => clearInterval(timer);
  }, [activeConv]);

  /*
   * 研究面板详情：面板展开时 2s 拉全量会话（含 eventLog）——迭代账本与
   * 事件流在对话内即可见，不必跳研究页；收起即停拉。
   */
  useEffect(() => {
    const id = research?.id;
    if (!id || !researchPanelOpen) {
      setResearchDetail(null);
      return;
    }
    let alive = true;
    const pull = async () => {
      try {
        const s = await getResearch(id);
        if (alive) setResearchDetail(s);
      } catch {
        /* keep last frame */
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [research?.id, researchPanelOpen]);

  // composer 共享状态（胶囊开关持久化：刷新后不丢——对话历史还带着工具使用记录，
  // 胶囊意外回默认关闭会让模型继续调工具而全部报「未知工具」，体验即「工具坏了」）
  const [draft, setDraft] = useState('');
  const [web, setWeb] = useState(() => localStorage.getItem('chat:web') !== '0');
  const [code, setCode] = useState(() => localStorage.getItem('chat:code') === '1');
  useEffect(() => {
    localStorage.setItem('chat:web', web ? '1' : '0');
    localStorage.setItem('chat:code', code ? '1' : '0');
  }, [web, code]);
  const [thinking, setThinking] = useState('mid');
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.8);
  const [maxTokens, setMaxTokens] = useState<number | undefined>(8192);
  const [attachments, setAttachments] = useState<string[]>([]);
  /*
   * 默认采样来自全局设置（偏好页可配）：设置是异步加载的，加载完成后做
   * 一次性同步；此后用户在滑杆上的手调不再被覆盖（synced 只翻一次）。
   */
  const samplingSynced = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || samplingSynced.current) return;
    samplingSynced.current = true;
    const d = settings.chatDefaults;
    setThinking(d.thinking);
    setTemperature(d.temperature);
    setTopP(d.topP);
    setMaxTokens(d.maxTokens);
  }, [settingsLoaded, settings.chatDefaults]);
  /*
   * 附件逐张异步规范化（canvas 压缩），完成一张进一张；解码头失败只报
   * 那一张，不拖垮同批其他图。非图片项静默跳过（input 的 accept 已挡，
   * 这里兜拖拽等旁路）。
   */
  const addImages = (files: File[]) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      normalizeImage(f, t)
        .then((url) => setAttachments((prev) => [...prev, url]))
        .catch((e) => toast.error(t('chat.readImageFail', { name: f.name, err: String(e) })));
    }
  };
  const removeAttachment = (i: number) =>
    setAttachments((prev) => prev.filter((_, j) => j !== i));

  /*
   * 切换模型 = 会话不换、消息流跟着模型走：把当前桶（连同压缩摘要）整体搬到
   * 新模型桶，右侧继续显示完整历史，后续消息发给新模型。目标桶已有消息时不搬
   * （那是该会话在新模型下的既有流，覆盖会丢数据），直接切过去显示。流式进行
   * 中禁止切换——后台循环仍在写旧桶，搬走会造成同一会话分裂成两条流。
   */
  const switchModel = (v: string) => {
    if (v === single) return;
    if (streaming) {
      toast.error(tStatic('chat.noSwitchStreaming'));
      return;
    }
    if (started && activeConv) {
      moveTurns(activeConv, single, v);
      moveSummaries(activeConv, single, v);
      setTurns((prev) => {
        const buckets = { ...(prev[activeConv] ?? {}) };
        const moving = buckets[single];
        if (moving?.length && !buckets[v]?.length) {
          delete buckets[single];
          buckets[v] = moving;
          return { ...prev, [activeConv]: buckets };
        }
        return prev;
      });
    }
    setSingle(v);
  };

  const composer: ComposerState = {
    value: draft,
    onChange: setDraft,
    web,
    setWeb,
    code,
    setCode,
    model: single,
    setModel: switchModel,
    modelOptions,
    thinking,
    setThinking,
    temperature,
    setTemperature,
    topP,
    setTopP,
    maxTokens,
    setMaxTokens,
    attachments,
    addImages,
    removeAttachment,
    /* send 自身只有 finally 没有 catch：throw（建连失败/上游拒绝）在这里兜住
     * 并可见化——裸 void 会把 rejection 吞成 unhandled，表现为「消息入列但
     * 毫无反馈、按钮秒回空闲」，排障时无从分辨是发了没响还是根本没发。 */
    onSend: () => void send().catch((e) => toast.error(String(e))),
    streaming,
    stopping,
    onStop: stop,
    noApproval,
    setNoApproval,
  };

  /*
   * 回首页：清 conv 参数并退出会话态。URL 本就无 query 时（经「历史对话」按钮
   * 进入的会话态）setSearchParams 不触发变化，靠手动收状态兜底。
   */
  const goHome = () => {
    setSearchParams({});
    setActiveConv('');
    setStarted(false);
  };

  /* 删除一段对话（确认弹窗在列表组件里）：注册表、「最近」、消息本体（含摘要）三处同步清理；
     删的是当前会话则回首页 */
  const removeChat = (id: string) => {
    deleteChat(id);
    removeRecent(`chat:${id}`);
    removeTurns(id);
    removeSummaries(id);
    setTurns((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (id === activeConv) goHome();
  };

  // 未开始：整屏居中的大对话框；输入框上方靠右给一个历史对话入口
  if (!started) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-6 p-6"
        style={{ height: contentHeight() }}
      >
        <div className="flex flex-col items-center gap-4">
          {/* 字标（public/ms-webui5.png，Exo2 斜体：正文 18° 右倾，5 加粗 800 + 28° + 深青→深紫渐变） */}
          <img src="/ms-webui5.png" alt="MS-WebUI 5" className="h-15 w-auto" />
          <div className="text-foreground text-[26px] font-semibold">{t('chat.heroTitle')}</div>
        </div>
        {/*
          历史对话入口贴着输入框上方右侧（间距取外层节奏的一半，聚成一组），
          与输入框同宽对齐。没有历史时不占位——首页保持一张干净的大输入框。
        */}
        <div className="flex w-full max-w-[720px] flex-col items-center gap-3">
          {chats.length > 0 && (
            <div className="flex w-full justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-7 gap-1.5 px-2.5 text-xs font-normal"
                onClick={() => setStarted(true)}
              >
                <History size={13} /> {t('chat.history')}
              </Button>
            </div>
          )}
          <Composer big placeholder={t(DEFAULT_PROMPT_KEY)} state={composer} />
        </div>
        {/*
          固定的一句定位语：双框架共用的工作台。刻意不展开品牌细节——
          这里要传达的是「swift 与 twinkle 都归这套 UI 管」，而非让用户分心去想两者的关系。
        */}
        <div className="text-muted-foreground text-xs">
          {t('chat.positioning')}
        </div>
      </div>
    );
  }

  // 会话进行中：左会话列表 + 右对话区
  return (
    <>
      <PageHeader
        module={mod}
        title={t(mod.label)}
        desc={t(mod.desc)}
        extra={
          features.chatCompare ? (
            <SegmentedControl
              value={compare ? 'compare' : 'single'}
              onChange={(v) => setCompare(v === 'compare')}
              options={[
                { value: 'single', label: t('chat.single') },
                {
                  value: 'compare',
                  label: (
                    <span className="flex items-center gap-1.5">
                      <Columns2 size={13} /> {t('chat.compare')}
                    </span>
                  ),
                },
              ]}
            />
          ) : undefined
        }
      />

      {/* 74px 是上面那截页头 */}
      <div className="flex" style={{ height: contentHeight(74) }}>
        <ConversationList
          chats={chats}
          activeConv={activeConv}
          onOpen={(id) => {
            /* 点当前会话无操作（主流聊天语义——toggle 回首页被实测用户当 bug 报）；
             * 回首页走「新建对话」按钮或侧栏「对话」导航 */
            if (id === activeConv) return;
            setStarted(true);
            setSearchParams({ conv: id });
          }}
          onNew={goHome}
          onRemove={removeChat}
        />

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="mb-3">
            {compare ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="text-muted-foreground text-[13px]">{t('chat.compareModels')}</span>
                {/*
                  原来是 mode="multiple" 的下拉 + maxCount。摊开成多选框的理由和表单页一样：
                  只有 5 个选项，勾选比「点开、勾、点空白收起」少两步。max=3 是布局上限，
                  再多一列每列就窄到读不下一句完整的回答了。
                */}
                <CheckboxGroup value={models} onChange={setModels} options={modelOptions} max={3} />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="cursor-help">
                      {t('chat.fromDeploy')}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{t('chat.fromDeployHint')}</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <SelectInput value={single} onChange={switchModel} options={modelOptions} className="w-80" />
                {/* 研究状态徽标兼面板开关：点开在对话区内嵌迭代账本+事件流 */}
                {research && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 px-2.5 text-xs font-normal"
                        onClick={() => setResearchPanelOpen((v) => !v)}
                      >
                        <FlaskConical size={12} />
                        {t(RESEARCH_STATUS_LABELS[research.status])}
                        {idleWakeMin !== null && (
                          <span className="text-muted-foreground font-normal">
                            {' · '}
                            {t('rs.idleWakeShort', { min: idleWakeMin })}
                          </span>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('chat.researchTooltip', {
                        goal: research.goal,
                        done: research.iterations.length,
                        max: research.budget.maxIterations,
                        action: researchPanelOpen ? t('chat.collapse') : t('chat.expand'),
                      })}
                      {idleWakeMin !== null && <div>{t('rs.idleWake', { min: idleWakeMin })}</div>}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 gap-3.5">
            {compare ? (
              models.length ? (
                models.map((m, i) => (
                  <ChatColumn
                    key={m}
                    model={m}
                    tone={COLUMN_TONES[i % COLUMN_TONES.length]}
                    messages={columnTurns(m)}
                    links={pendingLinks[`${activeConv}::${m}`]}
                    onGo={(link) => goCreatedLink(activeConv, m, link)}
                    streaming={streaming}
                  />
                ))
              ) : (
                <div className="text-muted-foreground m-auto text-[13px]">{t('chat.selectCompare')}</div>
              )
            ) : (
              <ChatColumn
                model={single || t('chat.noModelSel')}
                tone="bg-primary"
                messages={columnTurns(single)}
                links={pendingLinks[`${activeConv}::${single}`]}
                onGo={(link) => goCreatedLink(activeConv, single, link)}
                streaming={streaming}
              />
            )}
          </div>

          {/*
           * 研究面板（内嵌账本）：绑定会话的研究状态在对话内直接看——迭代表
           * + 事件流 + 评测计划 + 停止。与研究页共用同一套面板组件；这里不
           * 承担跨会话清单，那还在研究页。高度封顶滚动，不挤压聊天区。
           */}
          {research && researchPanelOpen && (
            <div className="border-border bg-card mb-3 max-h-[55vh] overflow-auto rounded-xl border p-3.5">
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <FlaskConical size={14} className="text-primary flex-none" />
                <span className="text-foreground text-[13.5px] font-medium">{research.goal}</span>
                <Badge variant="outline">{t(RESEARCH_STATUS_LABELS[research.status])}</Badge>
                <span className="text-muted-foreground tabular text-xs">
                  {t('chat.iterations', { done: research.iterations.length, max: research.budget.maxIterations })}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2.5 text-xs font-normal"
                    onClick={() => navigate(`/research/${research.id}/iterations`)}
                  >
                    {t('chat.researchPage')}
                  </Button>
                  {research.status !== 'done' && research.status !== 'escalated' && research.status !== 'stopped' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-state-failed hover:text-state-failed h-7 px-2.5 text-xs font-normal"
                      onClick={() =>
                        void stopResearch(research.id)
                          .then(() => {
                            toast.success(t('chat.stopResearchDone'));
                            refreshResearchBinding(activeConv);
                          })
                          .catch((e) => toast.error(String(e)))
                      }
                    >
                      {t('chat.stopResearch')}
                    </Button>
                  )}
                </div>
              </div>
              {(() => {
                /* 详情未到（首拉在路上）：用绑定摘要拼个等价形态先渲染 */
                const view: ResearchSession = researchDetail ?? { ...research, events: [], eventLog: [] };
                const m = view.evalPlan.metric;
                return (
                  <>
                    <div className="text-muted-foreground mb-3 text-xs">
                      {t(EVAL_MODE_LABELS[view.evalPlan.mode])} · {m.dataset} → {m.metricName}
                      {m.limit ? t('chat.evalLimit', { n: m.limit }) : ''} · {t('chat.threshold', { v: view.evalPlan.threshold })}
                      （{view.evalPlan.direction === 'higher' ? t('chat.higherBetter') : t('chat.lowerBetter')}）
                    </div>
                    <IterationsPanel s={view} />
                    <div className="h-3" />
                    <EventLogPanel s={view} />
                  </>
                );
              })()}
            </div>
          )}

          {/*
           * 后台脚本执行中状态条：脚本还在跑时让人看见「任务未结束」；
           * 全部终态即消失。完成通知走事件泵的唤醒卡片，与这里互不重叠。
           */}
          {!!bgScripts.length && (
            <div className="border-border/60 bg-muted/40 mb-3 flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs">
              <Loader2 size={13} className="text-primary animate-spin flex-none" />
              <span className="text-muted-foreground flex-none">{t('chat.bgScripts', { n: bgScripts.length })}</span>
              <span className="text-muted-foreground/70 truncate font-mono text-[11px]">
                {bgScripts.map((s) => s.script).join(' · ')}
              </span>
            </div>
          )}

          {/*
           * shell 审批卡片：危险命令在这里等用户点头。放在输入框正上方——
           * 对话进行中视线聚焦的位置，不弹浮层盖住刚生成的工具调用块。
           * 拒绝不是终点：拒绝文案会作为工具结果回喂，模型可以换路走。
           * command 存在 = shell 审批，多给一个「会话内总是允许此类命令」
           * 勾选：勾上并允许后，同名命令直接执行不再弹卡（任务停止/提交类
           * 审批没有 command，每次都由人点头）。
           */}
          {approval && (
            <div className="border-state-failed/50 bg-card mb-3 rounded-xl border p-3.5">
              <div className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
                <ShieldAlert size={14} className="text-state-failed flex-none" />
                {t('approval.title')}
              </div>
              <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-lg p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
                {approval.title}
              </pre>
              {/* pre-line：批量启动审批的 reason 是多行实验清单，保留换行 */}
              <div className="text-muted-foreground mt-1.5 text-xs whitespace-pre-line">{approval.reason}</div>
              {approval.command && (
                <label className="text-muted-foreground mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs">
                  <Checkbox checked={alwaysAllow} onCheckedChange={(v) => setAlwaysAllow(v === true)} />
                  {t('approval.alwaysAllow', { command: approval.command })}
                </label>
              )}
              <div className="mt-2.5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => settleApproval(false)}>
                  {t('approval.deny')}
                </Button>
                <Button size="sm" onClick={() => settleApproval(true)}>
                  {t('approval.allow')}
                </Button>
              </div>
            </div>
          )}

          {/*
           * headless 挂起审批：浏览器关闭期间 server 侧研究回合等的就是它——
           * 决定后 server 回合恢复，研究继续自动迭代。样式与本地审批卡同构。
           */}
          {headlessApprovals.map((a) => (
            <div key={a.id} className="border-state-failed/50 bg-card mb-3 rounded-xl border p-3.5">
              <div className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
                <ShieldAlert size={14} className="text-state-failed flex-none" />
                {t('approval.title')}
              </div>
              <div className="text-muted-foreground mt-1 text-[11px]">{t('approval.headlessBadge')}</div>
              <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-lg p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
                {a.title}
              </pre>
              <div className="text-muted-foreground mt-1.5 text-xs whitespace-pre-line">{a.reason}</div>
              {a.command && (
                <label className="text-muted-foreground mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={headlessAlways[a.id] === true}
                    onCheckedChange={(v) => setHeadlessAlways((prev) => ({ ...prev, [a.id]: v === true }))}
                  />
                  {t('approval.alwaysAllow', { command: a.command })}
                </label>
              )}
              <div className="mt-2.5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => resolveHeadlessApproval(a.id, false, false)}>
                  {t('approval.deny')}
                </Button>
                <Button size="sm" onClick={() => resolveHeadlessApproval(a.id, true, a.command ? headlessAlways[a.id] === true : false)}>
                  {t('approval.allow')}
                </Button>
              </div>
            </div>
          ))}

          <div className="mt-3.5">
            <Composer state={composer} />
          </div>
        </div>
      </div>
    </>
  );
}
