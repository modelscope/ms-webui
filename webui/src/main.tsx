import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { router } from '@/router/routes';
import { SettingsProvider } from '@/settings/SettingsContext';
import { LocaleProvider } from '@/i18n';
import { TokenIntroDialog } from '@/components/TokenIntroDialog';
import { TourDialog } from '@/components/TourDialog';
import { initConvSync } from '@/store/convsSync';
import './index.css';

/* 对话历史服务端镜像：boot 拉一次（补缺）+ 后续写穿透（防抖推送） */
void initConvSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
      delayDuration 给 400ms。shadcn 默认是 0，鼠标扫过工具栏就会连着弹几个气泡 ，
      而这个界面的图标按钮排得很密。放在最外层是因为提示要跨路由用，
      每个页面各包一个 Provider 的话延迟就各是各的。
    */}
    <TooltipProvider delayDuration={400}>
      {/*
        偏好设置包在路由外：tips 条在外壳上，开关在设置页里，两边都要读到；
        语言偏好同源（i18n 的 LocaleProvider 读 Settings，包在它内侧）。
        SettingsProvider 自己 boot 拉启动模式（展览/本地），探明前不渲染壳。
      */}
      <SettingsProvider>
        <LocaleProvider>
          {/*
            首次进入的引导按模式分流：本地模式走四步导览（可跳过）；展览模式
            没有导览，token 为空时弹令牌引导（可跳过）。
          */}
          <TourDialog />
          <TokenIntroDialog />
          <RouterProvider router={router} />
        </LocaleProvider>
      </SettingsProvider>
    </TooltipProvider>
    <Toaster position="bottom-center" />
  </React.StrictMode>,
);
