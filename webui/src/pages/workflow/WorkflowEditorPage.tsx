import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Bot, ChevronDown, ChevronLeft, Code, FileText, Play, PowerOff, Save, Settings2, Square, Terminal, TriangleAlert, Workflow } from 'lucide-react';
import { NodeCanvas } from './NodeCanvas';
import { NodePalette } from './NodePalette';
import { NodeInspector } from './NodeInspector';
import type { InspectorTab } from './NodeInspector';
import { FlowAssistant } from './FlowAssistant';
import type { RunState } from './FlowAssistant';
import type { AiAction } from './aiAssist';
import { NODE_TYPES, NODE_W, findPort, findPortOf, nodeDefOf, nodeLabel } from './nodeTypes';
import type { TFn } from './nodeTypes';
import type { GraphEdge, GraphFrame, GraphNode } from './nodeTypes';
import { useT } from '@/i18n';
import { DEFAULT_PRESET, PRESETS, clonePreset } from './presets';
import { getWorkflowLog, getWorkflowSession, getWorkflowSessionByKey, pauseWorkflowRun, releaseWorkflowSession, resumeWorkflowRun, startWorkflowRun, stopWorkflowRun } from '../../api/workflow';
import type { WorkflowEvent, WorkflowResourceDecl, WorkflowRunSubmission, WorkflowSessionSnapshot } from '../../api/workflow';
import { createFlow, getFlow, saveFlow } from '../../api/flows';

import { CodeBlock } from '@/components/CodeBlock';
import { LogViewer } from '@/components/LogViewer';
import { Hint } from '@/components/Hint';
import { SegmentedControl } from '@/components/FormField';
import { EMPTY_GPU_SELECTION, GpuPicker, type GpuSelection } from '@/components/GpuPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { contentHeight } from '@/layout/metrics';
import { useSettings } from '@/settings/SettingsContext';
import { MODULES } from '@/theme/modules';

/**
 * 给每个节点起一个能在 YAML 和代码里被引用的名字。
 * 同类型出现多次才加序号——只有一个 loss 时就叫 loss，不叫 loss_1。
 */
function stepNames(nodes: GraphNode[]): Map<string, string> {
  const seen: Record<string, number> = {};
  return new Map(
    nodes.map((n) => {
      seen[n.type] = (seen[n.type] ?? 0) + 1;
      return [n.id, seen[n.type] > 1 ? `${n.type}_${seen[n.type]}` : n.type];
    }),
  );
}

/** 某个节点的上游名字。YAML 的 needs: 和代码里的 needs= 用的是同一份 */
function upstream(edges: GraphEdge[], nameOf: Map<string, string>, id: string): string[] {
  return edges
    .filter((e) => e.to === id)
    .map((e) => nameOf.get(e.from))
    .filter((n): n is string => !!n);
}

/** 图 → YAML。图形是唯一事实来源，YAML 与代码都由它生成 */
function graphToYaml(
  nodes: GraphNode[],
  edges: GraphEdge[],
  frames: GraphFrame[],
  name: string,
  t: TFn,
): string {
  const nameOf = stepNames(nodes);
  const lines = [
    '# workflow.yaml —— 图形编辑器的序列化产物（定义，可反复运行）',
    `name: ${name}`,
  ];
  /* 循环框在图上只是视觉分区，落到 YAML 里也只能是注释 */
  frames.forEach((f) => {
    lines.push(`# ${t(f.label)}：${f.note ? t(f.note) : ''}`);
  });
  lines.push('steps:');
  nodes.forEach((n) => {
    const def = NODE_TYPES[n.type];
    const needs = upstream(edges, nameOf, n.id);
    lines.push(`  - id: ${nameOf.get(n.id)}`);
    lines.push(`    run: ${n.type}`);
    if (needs.length) lines.push(`    needs: [${needs.join(', ')}]`);
    if (def.lockedPorts) lines.push('    locked: true  # 连线不允许改，只能改参数');
    (n.params ?? def.params).forEach((p) => lines.push(`    ${p.label}: ${p.value}`));
    /* 代码节点：把片段原样带上，否则它就只剩一个类型名 */
    const code = n.code ?? def.code;
    if (code) {
      lines.push('    code: |');
      code.split('\n').forEach((l) => lines.push(`      ${l}`));
    }
  });
  return lines.join('\n');
}

function graphToCode(nodes: GraphNode[], edges: GraphEdge[], name: string): string {
  const nameOf = stepNames(nodes);
  const out = [
    '# 由 workflow.yaml 生成（generated）',
    '# 手改本文件后，图形与代码将不再一致，UI 会给出提示',
    'from swift.workflow import Workflow',
    '',
  ];
  /* 代码节点的函数体先定义在前面，后面的装配语句才能引用 */
  nodes.forEach((n) => {
    const code = n.code ?? NODE_TYPES[n.type].code;
    if (!code) return;
    out.push(`# 代码节点 ${nameOf.get(n.id)}`, code, '');
  });
  out.push(`wf = Workflow("${name}")`);
  nodes.forEach((n) => {
    const needs = upstream(edges, nameOf, n.id);
    const args = needs.length ? `needs=[${needs.join(', ')}]` : '';
    out.push(`${nameOf.get(n.id)} = wf.${n.type}(${args})`);
  });
  out.push('', 'if __name__ == "__main__":', '    wf.run()');
  return out.join('\n');
}

type ViewKey = 'graph' | 'yaml' | 'code';

const VIEWS = [
  { value: 'graph', labelKey: 'wf.viewGraph' },
  { value: 'yaml', labelKey: null },
  { value: 'code', labelKey: 'wf.viewCode' },
] as const;

/**
 * 编排编辑器。图形 / YAML / 代码 三视图，图形是事实来源。
 *
 * 图形改动重新生成 YAML 与代码；手改代码后指纹不匹配则提示不一致，
 * 此时再动图形会弹「fork / 覆盖」二选一。不做代码 → 图形的反向解析。
 */
export function WorkflowEditorPage() {
  const mod = MODULES.workflow;
  const { settings } = useSettings();
  const { t } = useT();
  const navigate = useNavigate();
  /** 路由上的实验 id（/workflow/:id/edit）。/workflow/new 没有它：脚手架即初始画布，保存时才落第一条记录 */
  const { id: flowId } = useParams();
  const [view, setView] = useState<ViewKey>('graph');
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [graph, setGraph] = useState(() => clonePreset(DEFAULT_PRESET));
  /** 实验名：列表展示与落盘名。空时回落来源脚手架的名（placeholder 同步体现） */
  const [flowName, setFlowName] = useState('');
  /* 刚在本实例里创建的实验：路由跳过来时不用再从持久层回读一遍自己刚写的图 */
  const createdLocally = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [codeDirty, setCodeDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 右侧检查面板：开合 + 当前 tab。tab 由节点上的入口决定 */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('params');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [runState, setRunState] = useState<RunState>('idle');
  /**
   * 当前常驻会话 id（vite 会话表的键）。run 结束后仍保留：输出页的 preview
   * 打的就是这个常驻会话（run_end 不携带输出，点击查看是唯一物化通道）；
   * 只有切换示例才丢弃。
   */
  const [runId, setRunId] = useState<string | null>(null);
  /** 运行日志：与状态同一拍拉回；失败时这里是唯一能看到「为什么」的地方 */
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const activeRun = useRef<WorkflowRunSubmission | null>(null);
  const [activeEdges, setActiveEdges] = useState<string[] | null>(null);
  const [usedEdges, setUsedEdges] = useState<string[]>([]);
  /** 单个在途轮询；代次使切图前已发出的响应失效。 */
  const pollRef = useRef<number | undefined>(undefined);
  const pollGeneration = useRef(0);
  const stopPoll = () => {
    pollGeneration.current += 1;
    if (pollRef.current !== undefined) {
      clearTimeout(pollRef.current);
      pollRef.current = undefined;
    }
  };
  useEffect(() => stopPoll, []);

  /*
   * 按路由 :id 加载实验：脚手架只是初始状态，实验本体（画布形态 + 名称）
   * 来自 flows 持久层，刷新页面也不丢。加载完成前先显示默认画布再整图替换——
   * 首次挂载到已保存实验时会短暂闪一下默认图，换来的是不用再画「加载中」空态。
   */
  useEffect(() => {
    if (!flowId || createdLocally.current) {
      createdLocally.current = false;
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const flow = await getFlow(flowId);
        if (cancelled) return;
        setFlowName(flow.name);
        /* graph state 的形态是 Preset（画布三件套 + 脚手架元信息）：只换三件套 */
        setGraph((g) => ({
          ...g,
          nodes: Array.isArray(flow.graph.nodes) ? (flow.graph.nodes as GraphNode[]) : [],
          edges: Array.isArray(flow.graph.edges) ? (flow.graph.edges as GraphEdge[]) : [],
          frames: Array.isArray(flow.graph.frames) ? (flow.graph.frames as GraphFrame[]) : [],
        }));
        const p = PRESETS.find((x) => x.key === flow.preset);
        if (p) setPreset(p);
        setFitSignal((s) => s + 1);
        /* 画布就位后接管会话：setNodes 的恢复要落到加载后的节点上 */
        restoreSession(flowId);
      } catch (error) {
        if (!cancelled) toast.error(String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  /* 未落盘的编辑（/workflow/new）：按当前脚手架 key 接管会话（切脚手架换 key 也走这里） */
  useEffect(() => {
    if (flowId) return;
    restoreSession(preset.key);
  }, [flowId, preset.key]);
  /** 单点运行结束后自动摊开输出面板的目标节点（settings.autoOpenOutput） */
  const openOnDone = useRef<string | null>(null);
  /** 变一下就让画布重新 fit，切示例时用 */
  const [fitSignal, setFitSignal] = useState(0);
  const seq = useRef(100);
  /** 画布往里写当前视口中心，点组件面板新增的节点就落在眼前 */
  const viewCenter = useRef({ x: 380, y: 260 });

  const { nodes, edges, frames = [] } = graph;
  const selectedNode = nodes.find((n) => n.id === selected) ?? null;
  /** 展示与序列化共用的实验名：用户起的名优先，未命名回落来源脚手架的名 */
  const displayName = flowName.trim() || t(preset.label);
  const setNodes = (fn: (ns: GraphNode[]) => GraphNode[]) =>
    setGraph((g) => ({ ...g, nodes: fn(g.nodes) }));
  const setEdges = (fn: (es: GraphEdge[]) => GraphEdge[]) =>
    setGraph((g) => ({ ...g, edges: fn(g.edges) }));

  const yaml = useMemo(
    () => graphToYaml(nodes, edges, frames, displayName, t),
    [nodes, edges, frames, displayName, t],
  );
  const code = useMemo(() => graphToCode(nodes, edges, displayName), [nodes, edges, displayName]);

  /** 画布三件套的持久化形态（frames 为空时不带键，与 FlowGraph 契约一致） */
  const graphOut = () => ({ nodes, edges, ...(frames.length ? { frames } : {}) });

  /*
   * 保存实验：画布形态连同名称写回 flows 持久层。带 :id 的路由直接覆盖；
   * /workflow/new（无 id）先落一条新记录，再原地跳转到它的编辑地址——
   * 此后同一实例继续编辑，保存就稳定在「覆盖」这一档。
   */
  const saveFlowNow = () => {
    const name = flowName.trim();
    if (flowId) {
      saveFlow(flowId, { ...(name ? { name } : {}), graph: graphOut() })
        .then(() => toast.success(t('wf.savedToast')))
        .catch((error) => toast.error(String(error)));
      return;
    }
    createFlow(graphOut(), { name: name || t(preset.label), preset: preset.key })
      .then((id) => {
        createdLocally.current = true;
        navigate(`/workflow/${id}/edit`, { replace: true });
        toast.success(t('wf.savedToast'));
      })
      .catch((error) => toast.error(String(error)));
  };

  /** 切示例：整图换掉并重新 fit 视角（在跑的运行不跟过去——产物留在它自己的 run 目录） */
  const loadPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    stopPoll();
    activeRun.current = null;
    submittingRef.current = false;
    setSubmitting(false);
    setRunId(null);
    setActiveEdges(null);
    setUsedEdges([]);
    openOnDone.current = null;
    setPreset(p);
    setGraph(clonePreset(p));
    setSelected(null);
    setInspectorOpen(false);
    setRunState('idle');
    setLogLines([]);
    setLogOpen(false);
    setCodeDirty(false);
    setFitSignal((s) => s + 1);
    toast.success(t('wf.presetLoaded', { name: t(p.label) }), { description: t(p.desc) });
  };

  /** 任何图形改动都要过这里：代码被手改过时先问 fork 还是覆盖 */
  const guard = (fn: () => void) => {
    if (codeDirty) {
      setConfirmOpen(true);
      return;
    }
    fn();
  };

  const addNode = (typeKey: string, x: number, y: number) =>
    guard(() => {
      const id = `n${seq.current++}`;
      setNodes((ns) => [...ns, { id, type: typeKey, x, y, status: 'idle' }]);
      setSelected(id);
    });

  /**
   * 加节点到当前视野中心。组件面板和 AI 的「加个节点」都走这里。
   * 减掉半个节点的宽高是因为落点是左上角——不减的话新节点会偏在视野的右下角。
   */
  const addAtViewCenter = (typeKey: string) =>
    addNode(typeKey, viewCenter.current.x - NODE_W / 2, viewCenter.current.y - 60);

  const duplicate = (id: string) =>
    guard(() => {
      const src = nodes.find((n) => n.id === id);
      if (!src) return;
      const nid = `n${seq.current++}`;
      setNodes((ns) => [...ns, { ...src, id: nid, x: src.x + 34, y: src.y + 34, status: 'idle' }]);
      setSelected(nid);
      toast.success(t('wf.duplicated'));
    });

  /*
   * 整对翻转顺序口朝向：正向 after左/then右（流从左穿到右），
   * 反向 then左/after右（流从右穿到左）——环下方那一段反向后整个环闭合。
   * 只有带 CTRL 口的节点可翻，已反向则回默认。
   */
  const flipNode = (id: string) =>
    guard(() => {
      setNodes((ns) =>
        ns.map((n) => {
          if (n.id !== id) return n;
          const def = NODE_TYPES[n.type];
          if (![...(def?.inputs ?? []), ...(def?.outputs ?? [])].some((p) => p.type === 'CTRL')) return n;
          const flipped = n.portSides?.after === 'right' && n.portSides?.then === 'left';
          return flipped ? { ...n, portSides: undefined } : { ...n, portSides: { after: 'right', then: 'left' } };
        }),
      );
    });

  const remove = (id: string) =>
    guard(() => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.from !== id && e.to !== id));
      /* 成员驱动的框：删节点同步剔除成员；循环框至少要两个成员，剩下的不足就散框 */
      setGraph((g) => ({
        ...g,
        frames: (g.frames ?? [])
          .map((f) => (f.memberIds ? { ...f, memberIds: f.memberIds.filter((m) => m !== id) } : f))
          .filter((f) => !f.memberIds || f.memberIds.length >= 2),
      }));
      setSelected(null);
    });

  const connect = (from: string, fromPort: string, to: string, toPort: string) =>
    guard(() => {
      setEdges((es) => {
        /** 一个输入口只接一条线，重连时替换旧的；many 口除外（多路即多槽） */
        const many = findPortOf(nodes.find((n) => n.id === to), toPort, 'in')?.many ?? false;
        const kept = many ? es : es.filter((e) => !(e.to === to && e.toPort === toPort));
        if (es.some((e) => e.from === from && e.fromPort === fromPort && e.to === to && e.toPort === toPort)) {
          return es;
        }
        /*
         * many 口的边必须带 slot：slot 是消费端参数名（train_step.arguments 的
         * loss 实参、signal_combine.signals 的具名输入）。手连的边先以源节点 id
         * 落名（与后端显式升级器的 name_slot 同语义），检查面板里可改。
         */
        const slot = many ? from : undefined;
        return [...kept, { id: `e${seq.current++}`, from, fromPort, to, toPort, ...(slot ? { slot } : {}) }];
      });
      /*
       * 迭代边闭合即成框，三类迭代器同一条规则：流式（driver/challenger 的
       * 流向打分链）、离线（loader 的 batch 流向 encode——数据集是声明在框外，
       * loader 是迭代器在框内）与同步生成（loader 的 batch 流向 generate）。
       * 不是拖出迭代器就出框——消费者还没落位时循环无从闭合，框跟着边走才不悬空。
       * 框成员沿数据边收集环内阶段组件（lifecycle 判定，新增组件自动跟随）。
       */
      const fromType = nodes.find((n) => n.id === from)?.type;
      const toType = nodes.find((n) => n.id === to)?.type;
      const streaming = (fromType === 'streaming_driver' || fromType === 'challenger') && toPort !== 'after';
      /* 离线：loader 的 batch 流向任何每批阶段（train_step / model_forward…）即闭环 */
      const offline = fromType === 'dataloader' && !!toType
        && NODE_TYPES[toType]?.lifecycle === 'Stage';
      const colocate = fromType === 'dataloader' && toType === 'generate' && toPort === 'prompts';
      if (streaming || offline || colocate) {
        setGraph((g) => {
          if ((g.frames ?? []).some((f) => f.memberIds?.includes(to))) return g;
          const mids = streaming
            ? edges
                .flatMap((e) => (e.from === from && e.to !== to ? [e.to] : []).concat(e.to === from && (e.toPort === 'after' || e.toPort === 'prompts') ? [e.from] : []))
                .filter((id) => nodes.some((n) => n.id === id && nodeDefOf(n)?.lifecycle === 'Stage'))
            : [];
          return {
            ...g,
            frames: [
              ...(g.frames ?? []),
              {
                id: `f${seq.current++}`,
                label: 'wf.frameTrainLoop',
                note: streaming
                  ? 'wf.noteGrpo'
                  : colocate
                    ? 'wf.noteColocateAuto'
                    : 'wf.noteOfflineAuto',
                x: 222,
                y: -40,
                w: streaming || colocate ? 812 : 550,
                h: streaming || colocate ? 760 : 520,
                memberIds: [from, ...mids, to],
              },
            ],
          };
        });
        toast.success(t('wf.loopClosed'), { description: t('wf.loopClosedDesc') });
      }
    });

  /**
   * 选中节点：把右侧面板开出来。
   *
   * 只有真的换了节点才回到参数页。无条件重置会把 openInspector 刚指定的那一页
   * 顶掉——点节点上的「问 AI」本来要直接开到 AI 页，被顶一下就只能看到参数页。
   *
   * 没选中节点时面板自然就不渲染了（靠 selectedNode 为空卡住），
   * 不需要再额外写一次 inspectorOpen。
   */
  const selectNode = (id: string | null) => {
    setSelected(id);
    if (!id) return;
    if (id !== selected) setInspectorTab('params');
    setInspectorOpen(true);
  };

  const openInspector = (id: string, tab: InspectorTab) => {
    setSelected(id);
    setInspectorTab(tab);
    setInspectorOpen(true);
  };

  /**
   * 画布 → 声明 JSON：params 数组转 dict（label 即参数名，与 registry 的
   * ParamSpec.name 对齐）、边字段名对齐 python 侧声明格式、循环框转训练帧
   * 声明（成员 + 把闭合回环的 CTRL 边登记为 feedback——环必须显式声明，
   * 同轮数据依赖成环会被校验拒绝）。只如实携带，闭包补全与拓扑在
   * python 会话里算。
   */
  const serializeGraph = () => {
    const typeOf = (id: string) => nodes.find((n) => n.id === id)?.type ?? '';
    const defOf = (id: string) => NODE_TYPES[typeOf(id)];
    /*
     * 面板值恒为字符串，v3 契约要类型化参数：按 registry 声明的类型在提交
     * 边界转换（preset 覆盖的参数没有 ptype，按名字回落 registry 默认表）。
     * 转不动的保持原字符串——后端会点名拒绝，绝不静默猜一个值。
     */
    const coerceParam = (value: string, ptype?: string): unknown => {
      if (!ptype || ptype === 'str') return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    const paramTypeOf = (nodeType: string, name: string): string | undefined =>
      (NODE_TYPES[nodeType]?.params ?? []).find((p) => p.label === name)?.ptype;
    /*
     * 资源页声明（左上角 GpuPicker）：本机模式给卡号（会话据此设
     * CUDA_VISIBLE_DEVICES 并规划 DeviceGroup），集群模式给 ray 地址 + 总卡数。
     * 只如实携带；空本机卡表会被会话响亮拒绝（空分配 = 没有 GPU）。
     */
    const resource: WorkflowResourceDecl = gpuSel.mode === 'cluster'
      ? { mode: 'cluster', cluster_address: clusterAddress.trim(), cluster_gpus: gpuSel.count ?? 1 }
      : { mode: 'local', cards: gpuSel.cards };
    return {
      version: 4,
      /* 声明身份跟实验走（flow id）：同一预设开两个实验各自有会话与声明身份 */
      workflow_id: flowId ?? preset.key,
      resource,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        params: Object.fromEntries(
          (n.params ?? NODE_TYPES[n.type].params).map((p) => [
            p.label,
            coerceParam(p.value, p.ptype ?? paramTypeOf(n.type, p.label)),
          ]),
        ),
        ...(n.code ? { code: n.code } : {}),
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.from,
        source_port: e.fromPort,
        target: e.to,
        target_port: e.toPort,
        ...(e.slot ? { slot: e.slot } : {}),
      })),
      frames: frames.map((f) => {
        const members = f.memberIds ?? [];
        /* v3 帧契约：sources 必须明确列出全部 Iterator 成员；consumers 是全部
         * 非 source 成员（覆盖全部带 effects 的节点）；budget_owner 是其中
         * 真正的训练节点；feedback 只登记回到 source 的 CTRL 回环边——数据边
         * 绝不能进 feedback（那会被豁免出同轮依赖，图就断了）。 */
        const sources = members.filter((id) => defOf(id)?.lifecycle === 'Iterator');
        const consumers = members.filter((id) => defOf(id)?.lifecycle !== 'Iterator');
        const owner = consumers.find((id) => (defOf(id)?.effects ?? []).includes('train'));
        return {
          /* 帧身份必须带上：后端 FrameSpec 要求非空 id（会话拒绝空身份），
           * 画布的 frame id 就是这个身份，序列化层无权丢字段。 */
          id: f.id,
          name: f.label,
          members,
          sources,
          consumers,
          budget_owner: owner ?? consumers[0] ?? '',
          /* feedback 只登记「回到本框 source 的 CTRL 回环」；成员内其余 CTRL 边
           * （如 train.then→sync.after）是正向顺序，属同轮依赖，绝不能豁免。 */
          feedback: edges
            .filter((e) => members.includes(e.from) && sources.includes(e.to))
            .filter((e) => findPortOf(nodes.find((n) => n.id === e.to), e.toPort, 'in')?.type === 'CTRL')
            .map((e) => e.id),
        };
      }),
    };
  };

  /** 串行读本次请求快照；历史终态与冷启动 idle 都不能结束本次等待。 */
  const poll = (submission: WorkflowRunSubmission, generation: number) => {
    const current = () => pollGeneration.current === generation
      && activeRun.current?.request_id === submission.request_id;
    const schedule = () => {
      if (current()) pollRef.current = window.setTimeout(tick, 250);
    };
    const tick = async () => {
      let snapshot;
      let lines: string[];
      try {
        [snapshot, lines] = await Promise.all([
          getWorkflowSession(submission.id), getWorkflowLog(submission.id),
        ]);
      } catch {
        schedule();
        return;
      }
      if (!current()) return;
      const session = snapshot.session;
      setLogLines(lines);
      const sameRequest = session.request_id === submission.request_id;
      const runEnd = sameRequest && session.runEnd?.request_id === submission.request_id
        ? session.runEnd : undefined;
      const unavailable = ['lost', 'released', 'reset_required', 'failed'].includes(session.state);
      const ended = !!runEnd || unavailable || !sameRequest;
      if (sameRequest) {
        const running = new Set(ended ? [] : session.nodesRunning);
        const done = new Set(session.nodesDone);
        const failed = new Set(session.nodesFailed);
        setNodes((ns) => ns.map((n) => {
          const status: GraphNode['status'] = running.has(n.id) ? 'running'
            : failed.has(n.id) ? 'failed' : done.has(n.id) ? 'done' : 'idle';
          return n.status === status ? n : { ...n, status };
        }));
        setActiveEdges(session.activeEdges);
        setUsedEdges(session.usedEdges);
        /* 会话状态机推进暂停/恢复（按钮之外还有 AI 控制卡这条入口） */
        if (!ended) {
          setRunState(session.state === 'paused' ? 'paused' : 'running');
        }
      } else {
        setNodes((ns) => ns.map((n) => n.status === 'idle' ? n : { ...n, status: 'idle' }));
        setActiveEdges([]);
        setUsedEdges([]);
      }
      if (!ended) {
        schedule();
        return;
      }
      stopPoll();
      activeRun.current = null;
      /* runId 故意保留：输出页的 preview 继续打这个常驻会话。 */
      setRunState('idle');
      const outputTarget = openOnDone.current;
      openOnDone.current = null;
      if (!runEnd || runEnd.state === 'failed') {
        setLogOpen(true);
        toast.error(runEnd?.error ?? t('wf.runFailedToast'));
      } else if (runEnd.state === 'stopped') {
        toast.warning(t('wf.stoppedToast'));
      } else {
        toast.success(t('wf.runDoneToast'));
        if (outputTarget) openInspector(outputTarget, 'output');
      }
    };
    void tick();
  };

  /*
   * 回到页面时接管本实验的常驻会话：切走再回来（组件卸载重挂）或刷新后，
   * 运行态（在途运行、节点灯、停止/释放入口）从服务端会话快照恢复。会话
   * 本体常驻 vite 侧不受页面切换影响，丢的只是前端引用——这里把引用接回。
   */
  const restoreSession = (key: string) => {
    void (async () => {
      let snapshot: WorkflowSessionSnapshot | null;
      try {
        snapshot = await getWorkflowSessionByKey(key);
      } catch {
        return; /* 网关故障不挡编辑，保持全新状态 */
      }
      if (!snapshot || activeRun.current || submittingRef.current) return;
      const session = snapshot.session;
      if (['released', 'lost'].includes(session.state)) return;
      setRunId(session.id);
      /* 资源页按最近一次提交生效的声明回填：切页回来选卡不丢，重新运行
       * 不会因为「选卡丢了只勾了一张」而被放置规划拒绝。 */
      if (session.resource?.mode === 'cluster') {
        setGpuSel({ mode: 'cluster', cards: [], count: session.resource.cluster_gpus });
        if (session.resource.cluster_address) setClusterAddress(session.resource.cluster_address);
      } else if (session.resource?.mode === 'local' && session.resource.cards?.length) {
        setGpuSel({ mode: 'local', cards: session.resource.cards, count: undefined });
      }
      if (['queued', 'running', 'pausing', 'paused', 'stopping'].includes(session.state) && session.request_id) {
        activeRun.current = {
          id: session.id,
          request_id: session.request_id,
          command_seq: session.command_seq ?? 0,
        };
        setRunState(session.state === 'paused' ? 'paused' : 'running');
        poll(activeRun.current, pollGeneration.current);
        return;
      }
      /* 已结束的运行：一次性恢复节点灯、用过的边与日志，不启动轮询 */
      const done = new Set(session.nodesDone);
      const failed = new Set(session.nodesFailed);
      setNodes((ns) => ns.map((n) => {
        const status: GraphNode['status'] = failed.has(n.id) ? 'failed' : done.has(n.id) ? 'done' : 'idle';
        return n.status === status ? n : { ...n, status };
      }));
      setActiveEdges(session.activeEdges);
      setUsedEdges(session.usedEdges);
      try {
        setLogLines(await getWorkflowLog(session.id));
      } catch {
        /* 日志拉不到不影响其余恢复 */
      }
    })();
  };

  /** 悬浮全局配置：资源页（本机选卡 / 集群地址+卡数），进声明的 resource 段 */
  const [gpuSel, setGpuSel] = useState<GpuSelection>(EMPTY_GPU_SELECTION);
  const [clusterAddress, setClusterAddress] = useState('');
  const [panelOpen, setPanelOpen] = useState(true);

  /** 提交与执行分开：提交中只锁入口，节点转动必须等真实 node.running。 */
  const beginRun = (target?: string) => {
    if (submittingRef.current || activeRun.current) return;
    stopPoll();
    const generation = pollGeneration.current;
    submittingRef.current = true;
    setSubmitting(true);
    setNodes((ns) => ns.map((n) => n.status === 'idle' ? n : { ...n, status: 'idle' }));
    setActiveEdges([]);
    setUsedEdges([]);
    openOnDone.current = target && settings.autoOpenOutput ? target : null;
    setLogLines([]);
    setLogOpen(true);
    /* 已落盘的实验：把这次跑的画布形态先写回持久层，列表页看到的与跑的一致 */
    if (flowId) {
      saveFlow(flowId, { graph: graphOut() })
        .catch((error) => toast.error(String(error)));
    }
    void (async () => {
      try {
        const submission = await startWorkflowRun(serializeGraph(), {
          /* 会话 key 跟实验走：同预设的多个实验不共享常驻会话，update 不互相顶 */
          workflowKey: flowId ?? preset.key, target,
        });
        if (pollGeneration.current !== generation) return;
        activeRun.current = submission;
        setRunId(submission.id);
        setRunState('running');
        poll(submission, generation);
      } catch (error) {
        if (pollGeneration.current !== generation) return;
        openOnDone.current = null;
        setRunState('idle');
        toast.error(String(error));
      } finally {
        if (pollGeneration.current === generation) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    })();
  };

  /** 单点与整体提交共享入口；目标闭包只由后端实际执行计划决定。 */
  const runNode = (id: string) => {
    if (nodes.some((n) => n.id === id)) beginRun(id);
  };

  /**
   * 启停控制。AI 的控制卡片和工具条上的按钮走的是同一条路。
   *
   * pause/resume/stop 都发会话命令，不关闭常驻资源；pause 在下一个
   * 节点边界生效（运行中的节点完成），resume 立即恢复调度。
   */
  const control = (op: 'start' | 'pause' | 'resume' | 'stop') => {
    if (op === 'start') {
      beginRun();
      return;
    }
    /* 刷新后 activeRun 已丢：停不下东西，得让点按钮的人知道而不是静默吞掉 */
    if (!activeRun.current) {
      toast.warning(t('wf.noActiveRun'));
      return;
    }
    if (op === 'stop') {
      stopWorkflowRun(activeRun.current.id).catch((error) => toast.error(String(error)));
      return;
    }
    if (op === 'pause') {
      pauseWorkflowRun(activeRun.current.id)
        .then(() => setRunState('paused'))
        .catch((error) => toast.error(String(error)));
      return;
    }
    resumeWorkflowRun(activeRun.current.id)
      .then(() => setRunState('running'))
      .catch((error) => toast.error(String(error)));
  };

  /**
   * 释放常驻会话：终止 source、关闭模型/采样器/工具，GPU 归还。会话与
   * 资源常驻（刷新不释放）的代价由这里兑现——不再需要现场时显式释放。
   * 释放后同 key 再提交会自动重建会话；运行中须先停止再释放。
   */
  const releaseSession = () => {
    if (!activeRun.current || runState === 'running') return;
    const id = activeRun.current.id;
    stopPoll();
    releaseWorkflowSession(id)
      .then(() => {
        activeRun.current = null;
        setRunId('');
        setRunState('idle');
        setNodes((ns) => ns.map((n) => n.status === 'idle' ? n : { ...n, status: 'idle' }));
        setActiveEdges([]);
        setUsedEdges([]);
        toast.success(t('wf.releasedToast'));
      })
      .catch((error) => toast.error(String(error)));
  };

  /** 按下标改参数。节点本来没有 params 时，先从类型默认值实体化一份 */
  const setParamAt = (nodeId: string, index: number, value: string) =>
    guard(() =>
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                params: (n.params ?? NODE_TYPES[n.type].params).map((p, i) =>
                  i === index ? { ...p, value } : p,
                ),
              }
            : n,
        ),
      ),
    );

  /** AI 提议被点了应用。注意这是唯一一条 AI 能改到图上的路径 */
  const applyAction = (a: AiAction) => {
    if (a.kind === 'control') {
      control(a.op);
      return;
    }
    if (a.kind === 'addNode') {
      addAtViewCenter(a.typeKey);
      toast.success(t('wf.nodeAdded', { label: nodeLabel(NODE_TYPES[a.typeKey], t) || a.typeKey }));
      return;
    }
    const target = nodes.find((n) => n.id === a.nodeId);
    if (!target) {
      toast.warning(t('wf.nodeGone'));
      return;
    }
    const idx = (target.params ?? NODE_TYPES[target.type].params).findIndex(
      (p) => p.label === a.label,
    );
    if (idx < 0) {
      toast.warning(t('wf.paramMissing', { label: nodeLabel(NODE_TYPES[target.type], t), param: a.label }));
      return;
    }
    setParamAt(a.nodeId, idx, a.to);
    toast.success(t('wf.paramChanged', { param: a.label, value: a.to }));
  };

  return (
    <div className="flex flex-col" style={{ height: contentHeight() }}>
      {/* 画布应用用细工具条，不用大标题页头 */}
      <div className="bg-background border-border/60 flex h-[46px] flex-none items-center gap-2.5 border-b px-3">
        <Link
          to={mod.path}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
        >
          <ChevronLeft className="size-3" />
          {t(mod.label)}
        </Link>
        {/* 实验名就地可改：输入为空时回落来源脚手架的名（placeholder），保存时一并落盘 */}
        <Input
          className="h-7 w-44 text-sm font-medium"
          value={flowName}
          placeholder={t(preset.label)}
          title={displayName}
          onChange={(e) => setFlowName(e.target.value)}
        />

        {/* 示例切换：拆成组件后「怎么接」本身就是知识，先给几张能跑的 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground gap-1.5">
              {t('wf.switchPreset')}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          {/* 用单选组而不是普通菜单项：这是「当前在看哪张图」，得有个选中标记 */}
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuRadioGroup value={preset.key} onValueChange={loadPreset}>
              {PRESETS.map((p) => (
                <DropdownMenuRadioItem key={p.key} value={p.key} className="items-start py-1.5">
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[13px]">{t(p.label)}</span>
                    <span className="text-muted-foreground text-[11.5px]">{t(p.desc)}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <SegmentedControl
          value={view}
          onChange={(v) => setView(v as ViewKey)}
          options={VIEWS.map((v) => ({
            value: v.value,
            label: (
              <>
                {v.value === 'graph' && <Workflow className="size-3.5" />}
                {v.value === 'yaml' && <FileText className="size-3.5" />}
                {v.value === 'code' && <Code className="size-3.5" />}
                {v.labelKey ? t(v.labelKey) : 'YAML'}
              </>
            ),
          }))}
        />

        {codeDirty && (
          <Hint title={t('wf.dirtyHint')}>
            {/*
              警示色直接用 amber 而不是主题色：这是「有件事没对齐」的通用信号。
              底色用半透明的同色，这样深浅两套皮肤下都不用各配一个值。
            */}
            <span className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-3" /> {t('wf.dirtyBadge')}
            </span>
          </Hint>
        )}

        <div className="ms-auto flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {t('wf.statCount', { n: nodes.length, m: edges.length })}
          </span>
          <Button variant="outline" size="sm" className="rounded-full" onClick={saveFlowNow}>
            <Save /> {t('wf.saveFlow')}
          </Button>
          {settings.aiEnabled && (
            <Hint title={t('wf.askGraphHint')}>
              <Button
                variant={assistantOpen ? 'secondary' : 'ghost'}
                size="sm"
                className="rounded-full"
                onClick={() => setAssistantOpen(true)}
              >
                <Bot /> {t('wf.assistant')}
              </Button>
            </Hint>
          )}
          {runState === 'running' ? (
            <Button size="sm" className="rounded-full" onClick={() => control('stop')}>
              <Square /> {t('task.stop')}
            </Button>
          ) : (
            <>
              <Button size="sm" className="rounded-full" disabled={submitting} onClick={() => control('start')}>
                <Play /> {t('wf.runAll')}
              </Button>
              {runId && (
                <Hint title={t('wf.releaseHint')}>
                  <Button variant="outline" size="sm" className="rounded-full" onClick={releaseSession}>
                    <PowerOff /> {t('wf.release')}
                  </Button>
                </Hint>
              )}
            </>
          )}
        </div>
      </div>

      {view === 'graph' ? (
        <div className="relative flex min-h-0 flex-1">
          <NodePalette onAdd={addAtViewCenter} />
          {/* 悬浮全局配置面板：左上角常驻入口，可收起；提交运行时生效 */}
          {panelOpen ? (
            <div className="border-border bg-card/95 absolute left-56 top-2 z-30 w-72 rounded-xl border p-3 shadow-lg">
              <div className="flex w-full items-center justify-between">
                <span className="text-foreground text-[13px] font-medium">{t('wf.globalConfig')}</span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setPanelOpen(false)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </div>
              <p className="text-muted-foreground mt-0.5 text-[11px]">
                {t('wf.globalConfigHint')}
              </p>
              <div className="mt-2">
                <GpuPicker value={gpuSel} onChange={setGpuSel} />
                {gpuSel.mode === 'cluster' && (
                  <label className="mt-2.5 block">
                    <span className="text-muted-foreground mb-1 block text-xs">{t('wf.clusterAddress')}</span>
                    <Input
                      className="h-8"
                      placeholder="ray://127.0.0.1:10001"
                      value={clusterAddress}
                      onChange={(e) => setClusterAddress(e.target.value)}
                    />
                  </label>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="border-border bg-card/95 text-muted-foreground hover:text-foreground absolute left-56 top-2 z-30 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] shadow"
            >
              <Settings2 className="h-3.5 w-3.5" /> {t('wf.globalConfig')}
            </button>
          )}
          <NodeCanvas
            nodes={nodes}
            edges={edges}
            activeEdges={activeEdges}
            usedEdges={usedEdges}
            frames={frames}
            selected={selected}
            fitSignal={fitSignal}
            viewCenterRef={viewCenter}
            aiEnabled={settings.aiEnabled}
            onSelect={selectNode}
            onMoveNode={(id, x, y) =>
              setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, x, y } : n)))
            }
            onAddNode={addNode}
            onConnect={connect}
            onDeleteEdges={(ids) =>
              guard(() => setEdges((es) => es.filter((e) => !ids.includes(e.id))))
            }
            onRunNode={runNode}
            onOpenOutput={(id) => openInspector(id, 'output')}
            onAskAi={(id) => openInspector(id, 'ai')}
            onDuplicate={duplicate}
            onDelete={remove}
            onFlipNode={flipNode}
          />
          {inspectorOpen && selectedNode && (
            <NodeInspector
              node={selectedNode}
              nodes={nodes}
              edges={edges}
              presetLabel={displayName}
              running={submitting || runState === 'running'}
              aiEnabled={settings.aiEnabled}
              confirmBeforeApply={settings.aiConfirmBeforeApply}
              tab={inspectorTab}
              sessionId={runId ?? undefined}
              onClose={() => setInspectorOpen(false)}
              onRun={runNode}
              onParamChange={setParamAt}
              onAction={applyAction}
              onTabChange={setInspectorTab}
            />
          )}
        </div>
      ) : (
        <div className="bg-background flex-1 overflow-auto p-5">
          {view === 'code' && (
            <div className="mb-2.5 flex items-center gap-2.5">
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                onClick={() => {
                  setCodeDirty(true);
                  toast.info(t('wf.simulateDirtyToast'));
                }}
              >
                {t('wf.simulateDirty')}
              </Button>
              <span className="text-muted-foreground text-xs">
                {t('wf.simulateDirtyHint')}
              </span>
            </div>
          )}
          {/* 换成 CodeBlock 之后顺带有了复制——这两份内容本来就是要拿去用的 */}
          <CodeBlock code={view === 'yaml' ? yaml : code} label={view === 'yaml' ? 'YAML' : t('wf.viewCode')} />
          <div className="text-muted-foreground mt-2.5 text-xs">
            {t('wf.genHint')}
          </div>
        </div>
      )}

      {/*
       * 运行日志抽屉：跨全宽钉在页面底部。启动即展开并跟随滚动；失败时强制摊开
       * （报错文案、Traceback、compile 期拒绝都在这里）；[workflow] 边界行着色成
       * 节段标记，扫一眼就知道跑到哪个节点。收起后留一条细横条可随时再摊开。
       */}
      {logOpen ? (
        <div className="bg-background border-border/60 flex-none border-t">
          <div className="flex h-9 flex-none items-center gap-2 px-3">
            <Terminal className="text-muted-foreground size-3.5" />
            <span className="text-foreground text-xs font-medium">{t('wf.runLog')}</span>
            <span className="text-muted-foreground text-xs">
              {t('wf.logMeta', { n: logLines.length, state: runState !== 'idle' ? t('task.running') : t('wf.logEnded') })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground ms-auto h-7 rounded-full px-2.5"
              onClick={() => setLogOpen(false)}
            >
              {t('chat.collapse')}
            </Button>
          </div>
          <LogViewer lines={logLines} height={216} />
        </div>
      ) : (
        logLines.length > 0 && (
          <button
            type="button"
            className="bg-background border-border/60 text-muted-foreground hover:text-foreground flex h-7 flex-none items-center gap-2 border-t px-3 text-xs transition-colors"
            onClick={() => setLogOpen(true)}
          >
            <Terminal className="size-3.5" />
            {t('wf.logCollapsed', { n: logLines.length })}
          </button>
        )
      )}

      <FlowAssistant
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        nodes={nodes}
        edges={edges}
        presetLabel={displayName}
        runState={runState}
        confirmBeforeApply={settings.aiConfirmBeforeApply}
        onControl={control}
        onAction={applyAction}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('wf.dirtyBadge')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('wf.dirtyDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="text-muted-foreground list-disc space-y-1 ps-5 text-[13px]">
            <li>{t('wf.forkOption')}</li>
            <li>{t('wf.overwriteOption')}</li>
          </ul>
          <AlertDialogFooter>
            {/*
              「先不动」得自己占一个按钮：原来「覆盖手改」挂在弹窗的取消位上，
              于是按 Esc 或点遮罩关掉弹窗，手改的代码就被静默丢掉了。
              会丢东西的动作不能是关窗口的副作用。
            */}
            <AlertDialogCancel>{t('wf.keepForNow')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setCodeDirty(false);
                toast.warning(t('wf.overwrittenToast'));
              }}
            >
              {t('wf.overwriteBtn')}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setCodeDirty(false);
                toast.success(t('wf.forkedToast'));
              }}
            >
              {t('wf.forkBtn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
