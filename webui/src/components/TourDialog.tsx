import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { useSettings } from '@/settings/SettingsContext';

/** 「已看过导览」标记（非敏感，落 localStorage；展览模式无导览） */
const TOUR_KEY = 'swift-webui.tour-done';

/** 每步锚到真实界面元素上（Sidebar 的 data-tour 标记），找不到则居中降级 */
const STEPS = [
  { target: '[data-tour="chat"]', titleKey: 'tour.step1Title', descKey: 'tour.step1Desc' },
  { target: '[data-tour="train"]', titleKey: 'tour.step2Title', descKey: 'tour.step2Desc' },
  { target: '[data-tour="workflow"]', titleKey: 'tour.step3Title', descKey: 'tour.step3Desc' },
  { target: '[data-tour="ms-token"]', titleKey: 'tour.step4Title', descKey: 'tour.step4Desc' },
] as const;

/** 高亮框相对目标元素的外扩（px），虚线圈得比目标大一圈更醒目 */
const PAD = 6;
/** 气泡宽度（px），定位计算用 */
const CARD_W = 300;

/**
 * 本地模式的首次导览（展览模式没有导览，走 TokenIntroDialog）：每步把
 * 目标元素用虚线框圈出来、周围压暗（巨型 box-shadow 挖洞），旁边给说明
 * 气泡。可跳过、可回看，仅第一次进入出现。步骤切换与窗口 resize 都会
 * 重测目标位置。
 */
export function TourDialog() {
  const { t } = useT();
  const { mode } = useSettings();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  /* null = 目标元素还没挂上（侧栏未渲染完）：先不画，下一帧重测 */
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (mode !== 'normal') return;
    try {
      if (localStorage.getItem(TOUR_KEY)) return;
    } catch {
      /* 存储受限：本次会话内不再弹 */
    }
    setOpen(true);
  }, [mode]);

  /* 测量当前步骤的目标位置；渲染后下一帧再测一次吸收布局抖动 */
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(STEPS[step].target);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [open, step]);

  const close = () => {
    try {
      localStorage.setItem(TOUR_KEY, '1');
    } catch {
      /* 同上 */
    }
    setOpen(false);
  };

  if (!open) return null;

  const last = step === STEPS.length - 1;
  /* 高亮框四界；目标缺席时框退化为屏幕中央的占位框（气泡跟着居中） */
  const left = rect ? rect.left - PAD : Math.max(16, window.innerWidth / 2 - CARD_W / 2);
  const top = rect ? rect.top - PAD : Math.max(16, window.innerHeight / 2 - 60);
  const width = rect ? rect.width + PAD * 2 : CARD_W;
  const height = rect ? rect.height + PAD * 2 : 48;
  /* 气泡：默认在框下方；放不下（近底部）就挪到框上方 */
  const below = top + height + 12 + 210 < window.innerHeight;
  const cardTop = below ? top + height + 12 : Math.max(12, top - 210 - 12);
  const cardLeft = Math.min(Math.max(12, left), Math.max(12, window.innerWidth - CARD_W - 12));

  return (
    /* 全屏拦截层：点空白处=下一步（导览期防误操作），按钮点击各自 stopPropagation */
    <div
      className="fixed inset-0 z-50"
      onClick={() => (last ? close() : setStep((s) => s + 1))}
    >
      {/* 挖洞遮罩：虚线高亮框 + 巨型阴影把四周压暗，目标本身保持可读 */}
      <div
        className="border-primary pointer-events-none absolute rounded-lg border-2 border-dashed"
        style={{
          left,
          top,
          width,
          height,
          boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
        }}
      />
      {/* 说明气泡 */}
      <div
        className="bg-card border-border absolute rounded-xl border p-4 shadow-xl"
        style={{ left: cardLeft, top: cardTop, width: CARD_W }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-foreground text-[14px] font-semibold">{t(STEPS[step].titleKey)}</div>
        <p className="text-muted-foreground mt-1.5 text-[13px] leading-5">{t(STEPS[step].descKey)}</p>
        <div className="mt-3 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.titleKey}
              className={i === step ? 'bg-primary h-1.5 w-4 rounded-full' : 'bg-muted-foreground/30 h-1.5 w-1.5 rounded-full'}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={close}>
            {t('tour.skip')}
          </Button>
          <div className="flex gap-1.5">
            {step > 0 && (
              <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={() => setStep((s) => s - 1)}>
                {t('tour.prev')}
              </Button>
            )}
            <Button size="sm" className="h-7 px-3 text-xs" onClick={() => (last ? close() : setStep((s) => s + 1))}>
              {last ? t('tour.done') : t('tour.next')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
