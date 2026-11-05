import { useState } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { cn } from 'cn';
import { useT } from '@/i18n';
import type { ToolCall } from '@/api/models';

/**
 * 对话页（ChatPage）与各助手面板（AiChatPanel）共用的消息附属块：
 * 思维链折叠卡、工具调用/结果折叠卡。抽出来是为了同一个产品里几处
 * 对话长得一样——见 AiChatPanel 头注释，不再各画一套。
 */

/**
 * 思维链折叠块：默认收起，点标题行展开/收起。流式进行中（正文还没开始出）
 * 标题显示「思考中…」，此时也能点开看进度；字数提示让人不点开也能掂量长短。
 */
export function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
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
export function ToolFold({ label, text }: { label: string; text: string }) {
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
export function fmtCallArgs(c: ToolCall): string {
  try {
    return JSON.stringify(JSON.parse(c.arguments), null, 2);
  } catch {
    return c.arguments;
  }
}
