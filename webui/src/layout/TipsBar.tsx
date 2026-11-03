import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Lightbulb, RotateCw, X } from 'lucide-react';
import { visibleTips } from '@/config/tips';
import { useSettings } from '@/settings/SettingsContext';
import { useT } from '@/i18n';
import { ChromeIconButton } from './ChromeIconButton';
import { TIPSBAR_H } from './metrics';

/**
 * 底部 tips 条。
 *
 * 放在窗口最下面一条 26px 的深色带里，跟标题栏呼应，把浅色内容区夹在中间。
 * 文案每隔一段时间换一条，淡入淡出。
 *
 * 带 url 的 tip 整条文字是链接（新开标签页跳原文博客），末尾一枚外链图标
 * 提示可点；不带 url 的保持纯文本。图标放在链接外面：嵌在 <a> 里的话
 * truncate 环境下 hover 区域和文字混在一起，点击目标含糊。
 *
 * 两个退出口分开设计：
 *  - 叉掉 = 这次别烦我，刷新后还会回来
 *  - 设置里关掉 = 以后都别出现
 * 所以叉的 tooltip 里要写清楚「去设置里可以永久关闭」，否则用户会反复叉。
 *
 * 原来那句提示里嵌了一个跳设置页的 <Link>。换到 Radix 的 Tooltip 之后不能这么写：
 * 气泡不是 hoverable 的，鼠标从按钮移向链接的路上气泡就关了，链接根本点不到。
 * 所以改成纯文字指路，去设置页走侧栏。
 */
export function TipsBar() {
  const { settings, dismissTips } = useSettings();
  const { t, locale } = useT();
  const pool = useMemo(() => visibleTips(settings.tipsBeginnerOnly), [settings.tipsBeginnerOnly]);

  /* 每次进来从随机一条开始，否则每次打开都是同一句 */
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * Math.max(1, pool.length)));
  /* 切换时先淡出再换字，避免文字直接跳变 */
  const [visible, setVisible] = useState(true);

  const next = () => {
    setVisible(false);
    window.setTimeout(() => {
      setIdx((i) => (i + 1) % Math.max(1, pool.length));
      setVisible(true);
    }, 220);
  };

  useEffect(() => {
    const ms = Math.max(4, settings.tipsInterval) * 1000;
    const timer = window.setInterval(next, ms);
    return () => window.clearInterval(timer);
  }, [settings.tipsInterval, pool.length]);

  /* 池子变小后当前下标可能越界；文案按语种取，en 缺翻回落中文 */
  const tip = pool[idx % Math.max(1, pool.length)];
  if (!tip) return null;
  const tipText = locale === 'en' ? (tip.en ?? tip.text) : tip.text;

  return (
    <div
      className="bg-sidebar border-sidebar-border text-sidebar-foreground/60 flex shrink-0 items-center gap-2 overflow-hidden border-t pr-2 pl-3 text-[11.5px]"
      style={{ height: TIPSBAR_H }}
    >
      <Lightbulb size={11} className="text-titlebar-accent shrink-0" />
      <div
        className="flex min-w-0 flex-1 items-center gap-1 transition-[opacity,transform] duration-200"
        style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(3px)',
        }}
      >
        {tip.url ? (
          <>
            <a
              href={tip.url}
              target="_blank"
              rel="noreferrer"
              title={t('tipsbar.viewSource')}
              className="text-sidebar-foreground/80 hover:text-sidebar-foreground min-w-0 truncate underline-offset-2 hover:underline"
            >
              {tipText}
            </a>
            <ExternalLink size={10} className="text-sidebar-foreground/50 shrink-0" />
          </>
        ) : (
          <span className="min-w-0 truncate">{tipText}</span>
        )}
      </div>

      {/* side=top：这一排贴着视口底边，气泡往下弹会被裁掉 */}
      <ChromeIconButton
        icon={<RotateCw size={10} />}
        label={t('tipsbar.next')}
        onClick={next}
        size={18}
        side="top"
      />
      <ChromeIconButton
        icon={<X size={10} />}
        label={t('tipsbar.dismissOnce')}
        onClick={dismissTips}
        size={18}
        side="top"
      />
    </div>
  );
}
