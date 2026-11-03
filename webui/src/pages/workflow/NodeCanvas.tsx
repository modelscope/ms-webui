import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useConnection,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react';
import type {
  Connection,
  ConnectionState,
  Edge,
  FitViewOptions,
  Node,
  NodeProps,
  OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeftRight,
  Bot,
  Check,
  Copy,
  FileText,
  Loader2,
  Lock,
  Maximize2,
  Minus,
  Play,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from 'cn';
import { Hint } from '@/components/Hint';
import { useT } from '@/i18n';
import { NODE_TYPES, NODE_W, PORT_TYPES, findPortOf, nodeDefOf, nodeLabel } from './nodeTypes';
import type { TFn } from './nodeTypes';
import { ROLE_HINTS } from './registryNodes';
import type { GraphEdge, GraphFrame, GraphNode, PortDef } from './nodeTypes';

/** 框与成员之间的留白。两边各留这些，框不至于贴着节点 */
const FRAME_PAD = 40;

/**
 * 节点名义高度：头部 + 端口行 + 参数行的粗估。框是背景标注不是精确容器，
 * 宁可框大不可框不全，估高一点无妨。
 */
function nominalHeight(node: GraphNode): number {
  const def = nodeDefOf(node);
  if (!def) return 220;
  return 48 + Math.max(def.inputs.length, def.outputs.length) * 30 + def.params.length * 32 + 24;
}

/** 口身份的展示文案：有映射的 role 翻译，没映射的原样显示 */
function roleText(role: string | undefined, t: TFn): string | undefined {
  if (!role) return undefined;
  const key = ROLE_HINTS[role];
  return key ? t(key) : role;
}

/**
 * 框的位置：有成员就按成员 bbox 自动包裹（每次渲染重算，拖节点框跟着走），
 * 没成员用手排坐标。手排坐标在两种情况下仍是后备：成员全部被删、或没声明成员。
 */
function frameBox(f: GraphFrame, nodes: GraphNode[]) {
  const members = f.memberIds?.length ? nodes.filter((n) => f.memberIds!.includes(n.id)) : [];
  if (!members.length) return { x: f.x, y: f.y, w: f.w, h: f.h };
  const x = Math.min(...members.map((n) => n.x)) - FRAME_PAD;
  const y = Math.min(...members.map((n) => n.y)) - FRAME_PAD;
  const w = Math.max(...members.map((n) => n.x)) + NODE_W + FRAME_PAD - x;
  const h = Math.max(...members.map((n) => n.y + nominalHeight(n))) + FRAME_PAD - y;
  return { x, y, w, h };
}

/**
 * 节点画布。深底 + 点阵网格，节点是厚边框的卡片，连线是粗贝塞尔曲线。
 *
 * 平移、缩放、拖节点、拉连线、框选、适应视图这些全部交给 React Flow，
 * 这个文件只负责两件事：把编排的「作者格式」翻译成 React Flow 的结构，
 * 以及画节点长什么样。
 *
 * 翻译只发生在这里一处 —— 示例图、YAML/代码生成、AI 上下文、输出模拟
 * 读到的都还是 GraphNode / GraphEdge，它们不认识 React Flow。
 */

/** 节点里塞的就是原始的作者格式，画节点时直接拿出来用 */
type SwiftNodeData = { node: GraphNode };
type FrameNodeData = { frame: GraphFrame };

/**
 * 单节点上的操作走 context 而不是塞进 node.data。
 *
 * 塞进 data 的话，父组件每次重渲染这几个回调的引用都变，
 * 于是每个节点的 data 都成了新对象，整张图跟着重建。
 */
interface NodeActions {
  onRunNode: (id: string) => void;
  onOpenOutput?: (id: string) => void;
  onAskAi?: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** 翻转整对顺序口的朝向（after左/then右 ↔ then左/after右），让环闭合 */
  onFlipNode: (id: string) => void;
}
const ActionsCtx = createContext<NodeActions | null>(null);

/** 切示例后的复位视角：留出边距但不缩太小，从数据流起点开始看 */
const FIT_ON_LOAD: FitViewOptions = { padding: 0.1, minZoom: 0.72, maxZoom: 1 };
/** 手点「适应」时才真缩到装下全图——GRPO 那张图展开有两千多像素宽 */
const FIT_ALL: FitViewOptions = { padding: 0.08, minZoom: 0.3, maxZoom: 1 };

export interface NodeCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 本次执行的边范围；null 表示尚无执行记录，不由节点历史状态推断。 */
  activeEdges: string[] | null;
  usedEdges: string[];
  /** 循环容器。画在最底层，只标出“这一块每步重跑”，不参与交互 */
  frames?: GraphFrame[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onAddNode: (typeKey: string, x: number, y: number) => void;
  onConnect: (from: string, fromPort: string, to: string, toPort: string) => void;
  onRunNode: (id: string) => void;
  /** 打开这个节点的输出（跳到检查面板的输出 tab） */
  onOpenOutput?: (id: string) => void;
  /** 就这个节点问 AI */
  onAskAi?: (id: string) => void;
  /** 来自偏好设置。关掉时节点上不出现问 AI 入口 */
  aiEnabled?: boolean;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** 把顺序口（after/then）整对左右对调，让环闭合 */
  onFlipNode: (id: string) => void;
  /** 删连线。选中一根线按 Del 就走这里 */
  onDeleteEdges?: (ids: string[]) => void;
  /** 值变化时自动缩放到刚好装下整张图，切换示例后用它复位视角 */
  fitSignal?: number;
  /** 画布把当前视口中心（图坐标）写进来，点组件面板时把节点加在看得见的地方 */
  viewCenterRef?: React.MutableRefObject<{ x: number; y: number }>;
}

/** React Flow 的 hook 都要在 Provider 里面用，所以画布本体包一层 */
export function NodeCanvas(props: NodeCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  nodes,
  edges,
  activeEdges,
  usedEdges,
  frames = [],
  selected,
  onSelect,
  onMoveNode,
  onAddNode,
  onConnect,
  onRunNode,
  onOpenOutput,
  onAskAi,
  aiEnabled = true,
  onDuplicate,
  onDelete,
  onFlipNode,
  onDeleteEdges,
  fitSignal = 0,
  viewCenterRef,
}: NodeCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const { fitView, screenToFlowPosition, zoomIn, zoomOut } = useReactFlow();
  const store = useStoreApi();
  const { t } = useT();

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  /*
   * 节点对象引用复用：没变的节点沿用上一轮的对象引用。
   *
   * React Flow 受控模式下，传入新对象会触发 re-adopt；若这一拍 ResizeObserver
   * 没派发（预览面板不可见、窗口失焦），节点会永久停在 visibility:hidden。
   * 引用不变则 RF 跳过该节点的 re-adopt，测量结果天然保留。
   *
   * 引用必然变化的对象（被拖的那个，拖动逐帧回写坐标）用另一道保险：构造时
   * 直接从 RF store 的 nodeLookup 读出上一帧的 measured 带上——adopt 源码里
   * measured 从受控对象上读，带了就不重置，handleBounds 也从旧内部节点解析保留。
   * 不能事后用 effect 读回：effect 在 render 之后才跑，而 re-adopt 在 render 时
   * 已经发生，第一帧读到的永远是空。
   */
  const lastFlow = useRef<Node[]>([]);
  const flowNodes = useMemo<Node[]>(
    () => {
      const prev = new Map(lastFlow.current.map((n) => [n.id, n]));
      const built: Node[] = [];
      /*
       * 循环框做成压在最底下的节点（zIndex -1 会落到连线层下面），
       * 这样它跟着平移缩放走，不用自己算坐标。
       *
       * 有成员的框按成员 bbox 自动包裹（拖动跟随），没成员的用手排坐标。
       */
      built.push(
        ...frames.map((f): Node => {
          const box = frameBox(f, nodes);
          const p = prev.get(`frame:${f.id}`);
          if (
            p &&
            p.position.x === box.x &&
            p.position.y === box.y &&
            p.width === box.w &&
            p.height === box.h &&
            (p.data as { frame: GraphFrame }).frame === f
          ) {
            return p;
          }
          return {
            id: `frame:${f.id}`,
            type: 'frame',
            position: { x: box.x, y: box.y },
            width: box.w,
            height: box.h,
            data: { frame: f },
            zIndex: -1,
            selectable: false,
            draggable: false,
            deletable: false,
            focusable: false,
            /* 事件全部放过去，点框里的空白仍然是在拖画布 */
            style: { pointerEvents: 'none' as const },
          };
        }),
      );
      built.push(
        ...nodes.map((n): Node => {
          const p = prev.get(n.id);
          if (
            p &&
            p.position.x === n.x &&
            p.position.y === n.y &&
            (p.data as { node: GraphNode }).node === n &&
            p.selected === (n.id === selected)
          ) {
            return p;
          }
          return {
            id: n.id,
            type: 'swift',
            position: { x: n.x, y: n.y },
            data: { node: n },
            selected: n.id === selected,
            measured: store.getState().nodeLookup.get(n.id)?.measured,
            /* 只能拖标题栏移动节点，body 里有可点的东西 */
            dragHandle: '.swift-node-header',
            style: { width: NODE_W },
          };
        }),
      );
      return built;
    },
    [nodes, frames, selected],
  );
  useEffect(() => {
    lastFlow.current = flowNodes;
  }, [flowNodes]);

  const flowEdges = useMemo<Edge[]>(
    () => {
      /* 本次范围内，真实运行者的出线流动；下游等待不影响上游指示。
       * 已使用的边常亮静止；范围外和未使用的边压暗，不借用历史节点状态。 */
      const active = new Set(activeEdges ?? []);
      const used = new Set(usedEdges);
      return edges.map((ed) => {
        const src = byId.get(ed.from);
        const p = findPortOf(src, ed.fromPort, 'out');
        /* 连线颜色取端口数据类型，不取节点色——一眼看出这根线在传什么 */
        const color = p ? PORT_TYPES[p.type].color : '#6B7280';
        /* 空 token 线只表先后不传数据：细一档、虚线，和数据线一眼分开 */
        const isCtrl = p?.type === 'CTRL';
        const flowing = active.has(ed.id) && src?.status === 'running';
        const dim = activeEdges !== null && !(flowing || (active.has(ed.id) && used.has(ed.id)));
        return {
          id: ed.id,
          source: ed.from,
          sourceHandle: ed.fromPort,
          target: ed.to,
          targetHandle: ed.toPort,
          /* 源节点实际运行时，其本次出线向前流动（animated 是 RF 自带的）。 */
          animated: flowing,
          style: {
            /*
             * 设 --xy-edge-stroke 而不是直接写 stroke：直接写是内联样式，
             * 会压掉 RF 那条「选中时换色」的规则，选中就看不出来了。
             */
            '--xy-edge-stroke': color,
            strokeWidth: isCtrl ? 2 : 3.5,
            strokeDasharray: isCtrl ? '6 5' : undefined,
            /* 深底点阵上连线要有厚度，原来靠垫一条更粗的暗线，一个投影就够 */
            filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.85))',
            opacity: dim ? 0.3 : 1,
          } as CSSProperties,
        };
      });
    },
    [edges, byId, activeEdges, usedEdges],
  );

  /**
   * 连线合法性。三道校验的原因文案是有信息量的，所以不用 isValidConnection——
   * 那个只会静默不让连，用户只看到线弹回去，不知道为什么。
   * 这里放它连上、在 onConnect 里拦下来并把原因说出来。
   */
  const check = useCallback(
    (from: string, fromPort: string, to: string, toPort: string) => {
      if (from === to) return t('wf.errSelf');
      const a = byId.get(from);
      const b = byId.get(to);
      if (!a || !b) return t('wf.errNodeMissing');
      const pa = findPortOf(a, fromPort, 'out');
      const pb = findPortOf(b, toPort, 'in');
      if (!pa || !pb) return t('wf.errPortMissing');
      if (pa.type !== pb.type) {
        return t('wf.errTypeMismatch', { a: t(PORT_TYPES[pa.type].label), b: t(PORT_TYPES[pb.type].label) });
      }
      /*
       * 锁定节点拒收任何手拉的连线。轨迹过滤就是这种：它的两路数据必须
       * 同进同出、且优势必须在它上游算好。这两条被改了训练会错但不报错——
       * 类型全匹配，上面那两道检查都拦不住。
       */
      if (NODE_TYPES[b.type]?.lockedPorts) {
        return t('wf.errLockedTarget', { label: nodeLabel(NODE_TYPES[b.type], t) });
      }
      if (NODE_TYPES[a.type]?.lockedPorts) {
        return t('wf.errLockedSource', { label: nodeLabel(NODE_TYPES[a.type], t) });
      }
      return null;
    },
    [byId, t],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.targetHandle) return;
      const err = check(c.source, c.sourceHandle, c.target, c.targetHandle);
      if (err) toast.warning(err);
      else onConnect(c.source, c.sourceHandle, c.target, c.targetHandle);
    },
    [check, onConnect],
  );

  /*
   * 尺寸变化由 RF 自己在内部记着；选中态是受控的（flowNodes 里按 selected 写死），
   * 所以这里只需要把拖动后的坐标写回去。
   *
   * 受控模式下拖动中必须逐帧回写：RF 不做乐观位置更新，位置跟随完全靠
   * 外部 state 驱动（试过只往松开那帧写，结果拖动中节点钉在原地、松开才跳过去）。
   * 逐帧 re-adopt 的测量丢失由 measured 保险兑住。
   */
  const handleNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          onMoveNode(c.id, Math.round(c.position.x), Math.round(c.position.y));
        }
      }
    },
    [onMoveNode],
  );

  /** 把视口中心同步给外面，点组件面板新增节点时要用 */
  const syncCenter = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!viewCenterRef || !r) return;
    const p = screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    viewCenterRef.current = { x: Math.round(p.x), y: Math.round(p.y) };
  }, [screenToFlowPosition, viewCenterRef]);

  const firstFit = useRef(true);
  useEffect(() => {
    /* 首次复位交给 <ReactFlow fitView>：这会儿节点还没量出尺寸，这里算不准 */
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    fitView(FIT_ON_LOAD);
    syncCenter();
  }, [fitSignal, fitView, syncCenter]);

  /* Del 删除由 RF 的 deleteKeyCode 管，⌘D 复制它不管，自己留一个 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!selected || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'd') return;
      e.preventDefault();
      onDuplicate(selected);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, onDuplicate]);

  const actions = useMemo<NodeActions>(
    () => ({
      onRunNode,
      onOpenOutput,
      onAskAi: aiEnabled ? onAskAi : undefined,
      onDuplicate,
      onDelete,
      onFlipNode,
    }),
    [onRunNode, onOpenOutput, onAskAi, aiEnabled, onDuplicate, onDelete, onFlipNode],
  );

  /** 当前图里出现过的数据类型，给图例用 */
  const legendTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const ed of edges) {
      const src = byId.get(ed.from);
      const p = findPortOf(src, ed.fromPort, 'out');
      if (p) seen.add(p.type);
    }
    return [...seen] as (keyof typeof PORT_TYPES)[];
  }, [edges, byId]);

  const legendLabel = (pt: keyof typeof PORT_TYPES) => t(PORT_TYPES[pt].label);

  return (
    <div ref={wrapRef} className="bg-titlebar relative min-w-0 flex-1">
      <ActionsCtx.Provider value={actions}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_VIEWS}
          onNodesChange={handleNodesChange}
          onConnect={handleConnect}
          onNodesDelete={(deleted) => deleted.forEach((n) => onDelete(n.id))}
          onEdgesDelete={(deleted) => onDeleteEdges?.(deleted.map((e) => e.id))}
          /*
           * 用「用户点了什么」驱动选中，而不是 onSelectionChange。
           *
           * onSelectionChange 反映的是 RF store 的状态，而 selected 又被我们写回
           * flowNodes——于是我们自己的每一次同步都会把这个回调再触发一遍，
           * 形成一个环。RF 在同步 prop 的间隙会瞬时清空选中，回调就带着 null 进来，
           * 右侧面板被这个回弹反复开关（看起来就是一直闪），
           * 顺便还会把 openInspector 刚指定的 tab 顶回参数页。
           *
           * onNodeClick / onPaneClick 只在真实点击时触发，不会被我们自己的同步引发。
           * 这里不加 id !== selected 的判断：重复点同一个节点要能把关掉的面板重新叫出来。
           */
          onNodeClick={(_, n) => {
            if (n.type === 'swift') onSelect(n.id);
          }}
          onPaneClick={() => onSelect(null)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/swift-node')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            const key = e.dataTransfer.getData('application/swift-node');
            if (!key) return;
            e.preventDefault();
            const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            /* 让指针落在标题栏中间，看起来就是「拖到哪放到哪」 */
            onAddNode(key, Math.round(p.x - NODE_W / 2), Math.round(p.y - 15));
          }}
          onInit={syncCenter}
          onMoveEnd={syncCenter}
          fitView
          fitViewOptions={FIT_ON_LOAD}
          deleteKeyCode={['Delete', 'Backspace']}
          minZoom={0.3}
          maxZoom={1.6}
          /* 画布跟侧栏一样永远是深色壳，跟 app 的明暗主题无关 */
          colorMode="dark"
          /* 拉线时不给它上色：颜色每帧都变会把整张图重渲染一遍，兼容的输入口已经在亮了 */
          connectionLineStyle={{ strokeWidth: 3.5, stroke: 'rgba(255,255,255,0.8)', strokeDasharray: '7 6' }}
          attributionPosition="top-right"
        >
          {/* 点阵网格：两层不同疏密的点，跟原来的双层 radial-gradient 一样 */}
          <Background id="fine" variant={BackgroundVariant.Dots} gap={28} size={1.2} color="rgba(255,255,255,0.14)" />
          <Background id="coarse" variant={BackgroundVariant.Dots} gap={140} size={2.4} color="rgba(255,255,255,0.10)" />

          {/* 图例：只列当前图里真用到的数据类型，十五种颜色堆在那里反而没人看 */}
          {legendTypes.length > 0 && (
            <Panel position="bottom-left">
              <div className="border-sidebar-border flex max-w-85 flex-wrap gap-x-3 gap-y-1 rounded-[10px] border bg-black/55 px-2.5 py-1.5 backdrop-blur-sm">
                {legendTypes.map((pt) => (
                  <span
                    key={pt}
                    className="text-sidebar-foreground/60 inline-flex items-center gap-1.5 text-[11px]"
                  >
                    <span
                      className="h-[3px] w-3.5 rounded-sm"
                      style={{ background: PORT_TYPES[pt].color }}
                    />
                    {legendLabel(pt)}
                  </span>
                ))}
              </div>
            </Panel>
          )}

          {/* 三个按钮自己写而不是用 Controls 自带的：自带的提示文案是英文的 */}
          <Controls showZoom={false} showFitView={false} showInteractive={false}>
            <ControlButton onClick={() => zoomOut()} title={t('wf.zoomOut')}>
              <Minus />
            </ControlButton>
            <ControlButton onClick={() => zoomIn()} title={t('wf.zoomIn')}>
              <Plus />
            </ControlButton>
            <ControlButton onClick={() => fitView(FIT_ALL)} title={t('wf.fitAll')}>
              <Maximize2 />
            </ControlButton>
          </Controls>
        </ReactFlow>
      </ActionsCtx.Provider>
    </div>
  );
}

/**
 * 正在拉的线是什么类型、从哪个节点出发，用来给兼容的输入口亮一下。
 *
 * 返回一个字符串而不是对象：指针每动一下这个选择器都会重算，
 * 返回对象的话引用每次都变，图上所有节点都会跟着重渲染。
 */
function linkSelector(c: ConnectionState) {
  if (!c.inProgress || !c.fromHandle?.id) return '';
  const g = (c.fromNode.data as SwiftNodeData).node;
  /* 拖线可以从输出口出发，也可以从输入口倒着找源——两个方向都要引导 */
  const dir = c.fromHandle.type === 'source' ? 'out' : 'in';
  const p = findPortOf(g, c.fromHandle.id, dir);
  return p ? `${dir}|${p.type}|${g.id}` : '';
}

const HEADER_BTN =
  'inline-flex size-[18px] cursor-pointer items-center justify-center rounded text-white/85 transition-colors hover:bg-black/25 hover:text-white [&>svg]:size-3';

/** 单个节点。厚边框 + 饱和色标题栏 + 端口圆点 */
const SwiftNodeView = memo(function SwiftNodeView({ id, data, selected }: NodeProps) {
  /* nodeTypes 那边只认 NodeProps 这一种签名，泛型在这个边界上丢了，转回来 */
  const { node } = data as SwiftNodeData;
  const def = nodeDefOf(node) ?? NODE_TYPES[node.type];
  const act = useContext(ActionsCtx);
  const link = useConnection(linkSelector);
  const { t } = useT();
  const [linkDir, linkType, linkFrom] = link.split('|');

  const params = node.params ?? def.params;
  const code = node.code ?? def.code;
  const running = node.status === 'running';
  const hasOutput = node.status === 'done' || node.status === 'failed';
  /** 连线锁定：输出口拖不出来，标题栏挂个锁把原因说在提示里 */
  const locked = !!def.lockedPorts;
  /** 有顺序口才有朝向可翻：正向 after左/then右，反向 then左/after右 */
  const hasCtrl = [...def.inputs, ...def.outputs].some((p) => p.type === 'CTRL');

  /*
   * 端口分侧：数据口按惯例（输入左、输出右）；顺序口（CTRL）整对读朝向——
   * 反向时 after 到右列、then 到左列，环下方那一段就顺了。
   */
  const sideOf = (p: PortDef, dir: 'in' | 'out') =>
    p.type === 'CTRL' && node.portSides?.[p.key]
      ? node.portSides[p.key]
      : dir === 'in'
        ? 'left'
        : 'right';
  const allPorts: Array<{ p: PortDef; dir: 'in' | 'out' }> = [
    ...def.inputs.map((p) => ({ p, dir: 'in' as const })),
    ...def.outputs.map((p) => ({ p, dir: 'out' as const })),
  ];
  const leftPorts = allPorts.filter((x) => sideOf(x.p, x.dir) === 'left');
  const rightPorts = allPorts.filter((x) => sideOf(x.p, x.dir) === 'right');

  return (
    <div
      className={cn(
        'bg-sidebar w-full overflow-hidden rounded-xl border-2 select-none',
        selected ? 'shadow-2xl' : 'border-white/12 shadow-lg',
      )}
      style={
        selected
          ? { borderColor: def.color, boxShadow: `0 0 0 4px ${def.color}33, 0 14px 30px rgba(0,0,0,0.5)` }
          : undefined
      }
    >
      {/* 标题栏：拖这里移动节点 */}
      <div
        className="swift-node-header flex h-[30px] cursor-grab items-center gap-[7px] px-2"
        style={{ background: def.color }}
      >
        <span className="inline-flex text-white/95 [&>svg]:size-3.5">{def.icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-wide text-white">
          {nodeLabel(def, t)}
        </span>

        <StatusDot status={node.status} />

        {locked && (
          <Hint title={t('wf.lockedHint')}>
            <span className="shrink-0 text-white/90 [&>svg]:size-3">
              <Lock />
            </span>
          </Hint>
        )}

        {/*
          单节点操作。
          nodrag 让 RF 别把这里当拖动把手；停掉冒泡是为了别顺手把节点选中——
          「看输出」本来要把面板开到输出页，被选中一挤就跳回参数页了。

          复制/删除藏到鼠标移上来才出现：标题栏只有 208px 宽，
          五个图标一起排完，节点名字就只剩一个字了。
        */}
        <div
          className="nodrag group/act flex shrink-0 gap-px"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {hasCtrl && (
            <Hint title={t('wf.flipHint')}>
              <span
                className={cn(HEADER_BTN, !selected && 'opacity-0 group-hover/act:opacity-100')}
                onClick={() => act?.onFlipNode(id)}
              >
                <ArrowLeftRight />
              </span>
            </Hint>
          )}
          <Hint title={def.runnable ? t('wf.runNodeHint') : t('wf.declaredHint')}>
            <span className={HEADER_BTN} onClick={() => act?.onRunNode(id)}>
              {running ? <Loader2 className="animate-spin" /> : <Play />}
            </span>
          </Hint>
          {act?.onOpenOutput && (
            <Hint title={hasOutput ? t('wf.outputHint') : t('wf.noOutputHint')}>
              <span
                className={cn(HEADER_BTN, !hasOutput && 'opacity-45')}
                onClick={() => act.onOpenOutput?.(id)}
              >
                <FileText />
              </span>
            </Hint>
          )}
          {act?.onAskAi && (
            <Hint title={t('wf.askAiHint')}>
              <span className={HEADER_BTN} onClick={() => act.onAskAi?.(id)}>
                <Bot />
              </span>
            </Hint>
          )}
          <Hint title={t('wf.duplicateHint')}>
            <span
              className={cn(HEADER_BTN, !selected && 'opacity-0 group-hover/act:opacity-100')}
              onClick={() => act?.onDuplicate(id)}
            >
              <Copy />
            </span>
          </Hint>
          <Hint title={t('wf.deleteHint')}>
            <span
              className={cn(HEADER_BTN, !selected && 'opacity-0 group-hover/act:opacity-100')}
              onClick={() => act?.onDelete(id)}
            >
              <X />
            </span>
          </Hint>
        </div>
      </div>

      {/*
        端口区。左右两列各排一路，数据口的第 i 个输入和第 i 个输出自然对齐；
        翻了侧的顺序口会跨到另一列尾上——列内按口在类型里声明的顺序。
      */}
      <div className="grid min-h-5.5 grid-cols-2 gap-x-2 pt-1.5">
        <div className="flex flex-col gap-[7px]">
          {leftPorts.map(({ p, dir }) => (
            <PortRow
              key={p.key}
              port={p}
              dir={dir}
              side="left"
              highlight={linkType === p.type && linkFrom !== id && (linkDir === 'out') === (dir === 'in')}
              roleHint={roleText(p.role, t)}
              connectable={dir === 'out' ? !locked : true}
            />
          ))}
        </div>
        <div className="flex flex-col gap-[7px]">
          {rightPorts.map(({ p, dir }) => (
            <PortRow
              key={p.key}
              port={p}
              dir={dir}
              side="right"
              highlight={linkType === p.type && linkFrom !== id && (linkDir === 'out') === (dir === 'in')}
              roleHint={roleText(p.role, t)}
              connectable={dir === 'out' ? !locked : true}
            />
          ))}
        </div>
      </div>

      {/* 代码节点显代码，其余显参数摘要 */}
      {code ? (
        <pre className="bg-titlebar mx-2 mt-1.5 mb-2.5 overflow-hidden rounded-lg border border-white/8 px-2 py-1.5 font-mono text-[11px] leading-[14px] text-[#C3C7D1]">
          {code}
        </pre>
      ) : (
        <div className="px-2.5 pt-0.5 pb-2.5">
          {params.map((p, i) => (
            <div
              key={`${p.label}-${i}`}
              className="flex justify-between gap-2 text-[11.5px] leading-[19px]"
            >
              <span className="text-sidebar-foreground/45 shrink-0">{p.label}</span>
              <span className="text-sidebar-foreground truncate font-mono">{p.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function PortRow({
  port,
  dir,
  side,
  highlight,
  roleHint,
  connectable = true,
}: {
  port: PortDef;
  dir: 'in' | 'out';
  /** 口在哪一侧：翻转过的顺序口会跨到另一侧，Handle 跟着贴那条边 */
  side: 'left' | 'right';
  /** 正在拉的线类型对得上，圆点放大并发光 */
  highlight?: boolean;
  /** 口身份的中文说明：接线引导时亮出来，回答「这根线在算法里扮演什么」 */
  roleHint?: string;
  connectable?: boolean;
}) {
  const { t } = useT();
  const color = PORT_TYPES[port.type].color;
  const size = highlight ? 14 : 12;
  return (
    <div
      className={cn(
        'relative flex h-3.5 items-center gap-1.5',
        side === 'left' ? 'ps-2.5' : 'justify-end pe-2.5',
      )}
    >
      <Handle
        id={port.key}
        type={dir === 'in' ? 'target' : 'source'}
        position={side === 'left' ? Position.Left : Position.Right}
        isConnectableStart={connectable}
        title={
          dir === 'out'
            ? connectable
              ? t('wf.dragOut')
              : t('wf.lockedOut')
            : roleHint
              ? t('wf.portRole', { port: port.label, role: roleHint })
              : t('wf.dragIn')
        }
        style={{
          ...(side === 'left' ? { left: -7 } : { right: -7 }),
          top: '50%',
          transform: 'translateY(-50%)',
          width: size,
          height: size,
          minWidth: 0,
          minHeight: 0,
          background: color,
          /* 描边用画布底色，圆点看起来是嵌在节点边上的 */
          border: '2.5px solid var(--titlebar)',
          borderRadius: '50%',
          cursor: dir === 'out' && !connectable ? 'not-allowed' : undefined,
          boxShadow: highlight ? `0 0 0 3px ${color}66, 0 0 10px ${color}` : `0 0 0 1px ${color}`,
          transition: 'width 0.1s ease, height 0.1s ease, box-shadow 0.1s ease',
        }}
      />
      <span className="text-sidebar-foreground/60 text-[11px]">{port.label}</span>
      {highlight && roleHint && (
        <span
          className="rounded-full px-1.5 py-px text-[10px] font-medium leading-tight text-white"
          style={{ background: `${color}CC` }}
        >
          {roleHint}
        </span>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: GraphNode['status'] }) {
  if (status === 'idle') return null;
  const icon = {
    running: <Loader2 className="animate-spin" />,
    done: <Check />,
    failed: <TriangleAlert />,
  }[status];
  return (
    <span
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-white [&>svg]:size-2.5',
        status === 'failed' ? 'bg-[#B03A3A]' : 'bg-white/20',
      )}
    >
      {icon}
    </span>
  );
}

function FrameNodeView({ data }: NodeProps) {
  const { frame } = data as FrameNodeData;
  const { t } = useT();
  const c = frame.color ?? '#6366F1';
  return (
    <div
      className="size-full rounded-2xl border-2 border-dashed"
      style={{ borderColor: `${c}88`, background: `${c}12` }}
    >
      <div className="absolute -top-3 left-3 flex max-w-[calc(100%-24px)] items-center gap-2">
        <span
          className="shrink-0 rounded-[7px] px-2.5 py-0.5 text-[11.5px] font-semibold tracking-wide text-white"
          style={{ background: c }}
        >
          {t(frame.label)}
        </span>
        {frame.note && (
          <span
            className="bg-titlebar text-sidebar-foreground/60 truncate rounded-[7px] border px-2 py-0.5 text-[11px]"
            style={{ borderColor: `${c}55` }}
          >
            {t(frame.note)}
          </span>
        )}
      </div>
    </div>
  );
}

/** 必须是模块级常量：每次渲染换一个新对象，RF 会把所有节点重新挂载一遍 */
const NODE_VIEWS = { swift: SwiftNodeView, frame: FrameNodeView };
