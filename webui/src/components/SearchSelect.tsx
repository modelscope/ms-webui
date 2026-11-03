import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';

/** 搜索候选的统一形状：value 是落进命令行的值，label/hint 仅辅助展示 */
export interface SearchOption {
  value: string;
  label?: string;
  hint?: string;
}

function matches(option: SearchOption, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  return (
    option.value.toLowerCase().includes(query) ||
    (option.label ?? '').toLowerCase().includes(query) ||
    (option.hint ?? '').toLowerCase().includes(query)
  );
}

/** 过滤后的候选（空关键词时截断到前 50 条，避免一次渲染几百条 DOM） */
function filterOptions(options: SearchOption[], q: string): SearchOption[] {
  const hit = options.filter((o) => matches(o, q));
  return q.trim() ? hit : hit.slice(0, 50);
}

/**
 * 可搜索下拉 + 自由输入的单值选择器。
 *
 * 候选来自 /api/catalog 等清单；用户键入的任意值（本地路径、清单外的 hub id）
 * 原样保留——「下拉是捷径，不是白名单」。失焦收起下拉，但不清空输入。
 */
export function SearchSelect({
  value,
  onChange,
  options,
  placeholder,
  allowCustom = true,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SearchOption[];
  placeholder?: string;
  /** false = 只允许候选里的值（如二选一引擎），输入不匹配时按钮不可用 */
  allowCustom?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const { t } = useT();
  const filtered = useMemo(() => filterOptions(options, value), [options, value]);
  const exact = options.some((o) => o.value === value);

  /* 点在组件外才收起：onBlur 会先于候选项的 click 触发，用 mousedown 抢跑 */
  const closeOnOutside = (e: MouseEvent) => {
    if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Input
        value={value}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          document.addEventListener('mousedown', closeOnOutside);
        }}
        onBlur={() => document.removeEventListener('mousedown', closeOnOutside)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && !allowCustom) {
            e.preventDefault();
            const hit = filtered[0];
            if (hit) onChange(hit.value);
            setOpen(false);
          }
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        className="h-8 text-[13px]"
      />
      {open && filtered.length > 0 && (
        <div className="bg-popover border-border absolute top-[calc(100%+4px)] z-50 max-h-64 w-full overflow-auto rounded-md border shadow-md">
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              className="hover:bg-secondary/60 flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-[13px]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="text-foreground truncate">{o.label ?? o.value}</span>
              {o.hint && <span className="text-muted-foreground flex-none text-[11px]">{o.hint}</span>}
            </button>
          ))}
          {!allowCustom && !exact && (
            <div className="text-muted-foreground border-border/60 border-t px-3 py-1.5 text-[12px]">
              {t('select.pick')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tag 式多值输入（训练数据集等 list 参数）：已选值排成 chip，输入框实时
 * 过滤候选，Enter / 点击候选追加；也接受任意自由值（本地路径、`id#N` 采样
 * 写法）。chip 上的 × 删除该值。
 */
export function TagInput({
  values,
  onChange,
  options,
  placeholder,
  emptyHint,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  options: SearchOption[];
  placeholder?: string;
  /**
   * 候选清单为空时聚焦显示的一行说明。清单来自外部登记（如插件页）时，
   * 空清单会让下拉整个消失——用户不知道「这里本可以选」，需要明示。
   */
  emptyHint?: string;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => filterOptions(options, draft).filter((o) => !values.includes(o.value)),
    [options, draft, values],
  );

  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft('');
  };

  const closeOnOutside = (e: MouseEvent) => {
    if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
  };

  return (
    <div ref={rootRef} className="border-border focus-within:border-ring/40 min-h-8 rounded-md border p-1">
      {values.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="bg-secondary text-foreground inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[12px]"
            >
              {/* 候选里带 label 时 chip 显示 label（如插件显示登记名），自由值显示原文 */}
              <span className="truncate">
                {options.find((o) => o.value === v)?.label ?? v}
              </span>
              <button
                type="button"
                aria-label={t('select.removeTag', { value: v })}
                className="text-muted-foreground hover:text-foreground flex-none cursor-pointer"
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          value={draft}
          placeholder={values.length ? t('select.continue') : placeholder}
          className="text-foreground placeholder:text-muted-foreground h-7 w-full bg-transparent px-1 text-[13px] outline-none"
          onFocus={() => {
            setOpen(true);
            document.addEventListener('mousedown', closeOnOutside);
          }}
          onBlur={() => document.removeEventListener('mousedown', closeOnOutside)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              add(filtered.find((o) => o.value === draft.trim()) ? draft : draft);
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
        />
        {open && (filtered.length > 0 ? (
          <div className="bg-popover border-border absolute top-[calc(100%+2px)] z-50 max-h-56 w-full overflow-auto rounded-md border shadow-md">
            {filtered.slice(0, 50).map((o) => (
              <button
                key={o.value}
                type="button"
                className="hover:bg-secondary/60 flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-[13px]"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(o.value)}
              >
                <span className="text-foreground truncate">{o.label ?? o.value}</span>
                {o.hint && <span className="text-muted-foreground flex-none text-[11px]">{o.hint}</span>}
              </button>
            ))}
          </div>
        ) : emptyHint ? (
          /* 空清单也要有反馈：一行不可点的说明，告诉用户候选从哪来、还能手输 */
          <div className="text-muted-foreground border-border bg-popover absolute top-[calc(100%+2px)] z-50 w-full rounded-md border px-3 py-1.5 text-[12px] shadow-md">
            {emptyHint}
          </div>
        ) : null)}
      </div>
    </div>
  );
}
