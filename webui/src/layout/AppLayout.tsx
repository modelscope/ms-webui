import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Titlebar } from './Titlebar';
import { TipsBar } from './TipsBar';
import { CONTENT_H_VAR, contentHeightValue } from './metrics';
import { useSettings } from '@/settings/SettingsContext';

/**
 * 应用外壳：标题栏（深）+ 侧栏（深）+ 内容区（浅）+ 底部 tips 条（深）。
 * 深外壳夹浅工作区是 IDE 的常见做法，也是这套界面「工具感」的主要来源。
 *
 * 原来外面还套了一层深色桌面、窗口带圆角和大阴影，现在去掉了，
 * 理由写在 metrics.ts 的 WINDOW_PAD 上。
 */
export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const { settings, tipsDismissed } = useSettings();

  /* 主题接线：.dark 挂在 <html> 上（index.css 的 @custom-variant 与 .dark 变量块
   * 都读它）。system 态订阅 prefers-color-scheme，系统切换实时生效 */
  useEffect(() => {
    const root = document.documentElement;
    const apply = (dark: boolean) => root.classList.toggle('dark', dark);
    if (settings.theme !== 'system') {
      apply(settings.theme === 'dark');
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.theme]);

  const tipsVisible = settings.tipsEnabled && !tipsDismissed;

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background"
      style={
        {
          /*
           * 整屏页面（对话、编排画布）用这个变量拿可用高度。
           * tips 条能被叉掉，高度是运行时变的，只有这里知道到底减不减那 26px。
           */
          [CONTENT_H_VAR]: contentHeightValue(tipsVisible),
        } as React.CSSProperties
      }
    >
      <Titlebar collapsed={collapsed} onToggleSidebar={() => setCollapsed((v) => !v)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar collapsed={collapsed} />
        <main className="min-w-0 flex-1 overflow-auto bg-background">
          <Outlet />
        </main>
      </div>
      {tipsVisible && <TipsBar />}
    </div>
  );
}
