import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from '@/layout/AppLayout';
import { ChatPage } from '@/pages/chat/ChatPage';
import { TrainListPage } from '@/pages/train/TrainListPage';
import { TrainNewPage } from '@/pages/train/TrainNewPage';
import { TrainDetailPage } from '@/pages/train/TrainDetailPage';
import { TrainComparePage } from '@/pages/train/TrainComparePage';
import { EvalListPage } from '@/pages/eval/EvalListPage';
import { EvalNewPage } from '@/pages/eval/EvalNewPage';
import { EvalDetailPage } from '@/pages/eval/EvalDetailPage';
import { ExportListPage } from '@/pages/export/ExportListPage';
import { ExportNewPage } from '@/pages/export/ExportNewPage';
import { ExportDetailPage } from '@/pages/export/ExportDetailPage';
import { DeployListPage } from '@/pages/deploy/DeployListPage';
import { DeployNewPage } from '@/pages/deploy/DeployNewPage';
import { DeployDetailPage } from '@/pages/deploy/DeployDetailPage';
import { WorkflowListPage } from '@/pages/workflow/WorkflowListPage';
import { WorkflowEditorPage } from '@/pages/workflow/WorkflowEditorPage';
import { ResearchListPage } from '@/pages/research/ResearchListPage';
import { ResearchDetailPage } from '@/pages/research/ResearchDetailPage';
import { ScriptsListPage } from '@/pages/scripts/ScriptsListPage';
import { ScriptsNewPage } from '@/pages/scripts/ScriptsNewPage';
import { ScriptsDetailPage } from '@/pages/scripts/ScriptsDetailPage';
import { PluginsPage } from '@/pages/plugins/PluginsPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { ModelsPage } from '@/pages/models/ModelsPage';

/**
 * 路由表。列表 / 新建 / 详情三段式；详情用 :tab 段承载 Tab，
 * 这样刷新或分享链接都能停在同一个 Tab。加模块时在此挂节点即可。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },

      { path: 'chat', element: <ChatPage /> },

      { path: 'train', element: <TrainListPage /> },
      { path: 'train/new', element: <TrainNewPage /> },
      /* 实验对比：列表多选进入，ids 全在 query（可分享/刷新）；须在 train/:id 之前 */
      { path: 'train/compare', element: <TrainComparePage /> },
      { path: 'train/:id/metrics', element: <TrainDetailPage tab="metrics" /> },
      { path: 'train/:id/log', element: <TrainDetailPage tab="log" /> },
      { path: 'train/:id', element: <Navigate to="metrics" replace /> },

      { path: 'eval', element: <EvalListPage /> },
      { path: 'eval/new', element: <EvalNewPage /> },
      { path: 'eval/:id/result', element: <EvalDetailPage tab="result" /> },
      { path: 'eval/:id/log', element: <EvalDetailPage tab="log" /> },
      { path: 'eval/:id', element: <Navigate to="result" replace /> },

      { path: 'export', element: <ExportListPage /> },
      { path: 'export/new', element: <ExportNewPage /> },
      { path: 'export/:id/artifact', element: <ExportDetailPage tab="artifact" /> },
      { path: 'export/:id/log', element: <ExportDetailPage tab="log" /> },
      { path: 'export/:id', element: <Navigate to="artifact" replace /> },

      { path: 'deploy', element: <DeployListPage /> },
      { path: 'deploy/new', element: <DeployNewPage /> },
      { path: 'deploy/:id/overview', element: <DeployDetailPage tab="overview" /> },
      { path: 'deploy/:id/log', element: <DeployDetailPage tab="log" /> },
      { path: 'deploy/:id', element: <Navigate to="overview" replace /> },

      { path: 'workflow', element: <WorkflowListPage /> },
      { path: 'workflow/new', element: <WorkflowEditorPage /> },
      { path: 'workflow/:id/edit', element: <WorkflowEditorPage /> },

      /*
       * 研究会话没有新建页：会话由对话 agent 的 create_research 创建。
       * new 路由仅兑住列表/详情里「以此为模板新建」的跳转（元动作无意义，回列表）。
       */
      { path: 'research', element: <ResearchListPage /> },
      { path: 'research/new', element: <Navigate to="/research" replace /> },
      { path: 'research/:id/iterations', element: <ResearchDetailPage tab="iterations" /> },
      { path: 'research/:id/events', element: <ResearchDetailPage tab="events" /> },
      { path: 'research/:id', element: <Navigate to="iterations" replace /> },

      /* 脚本任务主要由首页 agent 的 run_script 工具创建；新建页承接「已有脚本再跑/换参跑」 */
      { path: 'scripts', element: <ScriptsListPage /> },
      { path: 'scripts/new', element: <ScriptsNewPage /> },
      { path: 'scripts/:id/log', element: <ScriptsDetailPage /> },
      { path: 'scripts/:id', element: <Navigate to="log" replace /> },

      { path: 'plugins', element: <PluginsPage /> },

      { path: 'models', element: <ModelsPage /> },

      /* 不属于任何模块，不进侧边导航，从品牌下拉菜单进 */
      { path: 'settings', element: <SettingsPage /> },

      { path: '*', element: <Navigate to="/chat" replace /> },
    ],
  },
]);
