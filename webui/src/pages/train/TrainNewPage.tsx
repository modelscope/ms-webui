import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigFormShell } from '@/components/ConfigFormShell';
import { EMPTY_GPU_SELECTION, GpuPicker, type GpuSelection } from '@/components/GpuPicker';
import { SearchSelect, TagInput, type SearchOption } from '@/components/SearchSelect';
import type { ConfigField } from '@/components/PageAssistant';
import { Field, FieldStack, NumberInput, SegmentedControl, SelectInput } from '@/components/FormField';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { MODULES } from '@/theme/modules';
import { listCatalog, modelOption, datasetOption } from '@/api/catalog';
import { listPlugins } from '@/api/plugins';
import { listTrains, startCodeTrain, startTrain, type TrainTaskInfo, fetchDatasetPreview, fetchModelStructure, listOrmRules, type DatasetPreviewRow, type ModelStructure } from '@/api/train';
import { listGpus, type GpuInfo } from '@/api/deploy';
import { DatasetPreviewDialog, StructureDialog } from './TrainPreflight';
import { parseRlPlacement, RlGpuPlanner, type RlPlacement, type RlTeacherOpts } from './RlGpuPlanner';
import { ParallelPlanner } from './ParallelPlanner';
import { defaultPlan, deriveGroups, planFlags, type ParallelPlan } from './parallelSpec';
import { estimateMemorySharded } from './memoryEstimate';
import { pushRecent } from '@/store/recent';
import { fsTool } from '@/api/tools';
import { prefillIntro, usePrefill } from '@/store/prefill';
import {
  ALL_PARAMS, CODE_TRAIN_TEMPLATE, EXPO_SERVER_URL, LORA_PARAMS, ONLINE_RL_TYPES, RL_PARAMS, RL_TYPE_OPTIONS,
  TASK_TYPE_DESC, TRAIN_PARAMS,
  type ParamField, type TaskType, type Tuner,
} from '@/config/trainForm';
import { useT } from '@/i18n';
import { useSettings } from '@/settings/SettingsContext';

/*
 * 关注指标候选集（key = 训练日志行里的指标名，展示侧直接用它选曲线）：
 * 各算法控制台头部行会打出的收敛信号。base 三键对每个任务都有；偏好系（dpo
 * 有 reference）另看 margins/accuracies；reference-free 的 cpo/orpo/simpo 看
 * logps/chosen 升、logps/rejected 降；在线系看 reward；ppo 另有 critic 面板。
 * kto/rm/gkd/opsd/mopd 不注册算法 metric，头部行就是 base 三键。后续训练侧
 * 往日志行多打 key=value，这里补一项（或用户自由输入）即可上图。
 */
const WATCH_METRICS: Record<string, string[]> = {
  sft: ['loss', 'grad_norm', 'lr', 'accuracy'],
  pt: ['loss', 'grad_norm', 'lr'],
  dpo: ['loss', 'grad_norm', 'lr', 'rewards/margins', 'rewards/accuracies', 'logps/chosen', 'logps/rejected'],
  cpo: ['loss', 'grad_norm', 'lr', 'logps/chosen', 'logps/rejected'],
  orpo: ['loss', 'grad_norm', 'lr', 'logps/chosen', 'logps/rejected'],
  simpo: ['loss', 'grad_norm', 'lr', 'logps/chosen', 'logps/rejected'],
  kto: ['loss', 'grad_norm', 'lr'],
  rm: ['loss', 'grad_norm', 'lr'],
  grpo: ['loss', 'grad_norm', 'lr', 'reward'],
  ppo: ['loss', 'grad_norm', 'lr', 'reward', 'value_loss', 'explained_variance'],
  rft: ['loss', 'grad_norm', 'lr', 'reward'],
  gkd: ['loss', 'grad_norm', 'lr', 'accuracy'],
  opsd: ['loss', 'grad_norm', 'lr'],
  mopd: ['loss', 'grad_norm', 'lr'],
};

/**
 * 新建训练。两种形态：命令行表单（POST /api/train，核心字段结构化、其余
 * 旋钮以 params KV 携带）与代码（mode='code'，整份 Python 落盘执行）。
 * 表单没暴露的参数在「将要执行」的附加参数框直写。产物固定落
 * ~/.swift/train/<任务 id>/output/。
 */
export function TrainNewPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useT();
  const prefill = usePrefill('train');
  /*
   * 启动模式（重命名 launch 避开本页的 mode 形态开关）：展览模式下训练锁
   * remote——展览机多人共用，不允许在机器上起训练进程。
   */
  const { mode: launch, settings } = useSettings();
  const token = settings.msToken;
  /** 创建形态：命令行表单 / 直接写 Python（swift.dev 原生 API，整份落盘执行） */
  const [mode, setMode] = useState<'cli' | 'code'>('cli');
  const [model, setModel] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('sft');
  const [rlType, setRlType] = useState('dpo');
  const [datasets, setDatasets] = useState<string[]>([]);
  const [valDatasets, setValDatasets] = useState<string[]>([]);
  const [tuner, setTuner] = useState<Tuner>('lora');
  const [plugins, setPlugins] = useState<string[]>([]);
  const [params, setParams] = useState<Record<string, string | number | boolean>>({});
  const [extraArgs, setExtraArgs] = useState('');
  /*
   * 关注指标：候选集按任务类型/算法预置（各算法控制台头部行会打出的收敛信号），
   * 默认全选；切类型/算法时重置为新候选集——旧算法的指标（如 DPO 的
   * rewards/margins）对新算法是噪声。可自由输入补充：日志行里出现的任意
   * key=value 都能上图（后端解析器是通用的）。
   */
  const [watchMetrics, setWatchMetrics] = useState<string[]>(WATCH_METRICS.sft);
  useEffect(() => {
    setWatchMetrics(WATCH_METRICS[taskType === 'rl' ? rlType : taskType] ?? WATCH_METRICS.sft);
  }, [taskType, rlType]);
  const [gpuSel, setGpuSel] = useState<GpuSelection>(EMPTY_GPU_SELECTION);
  /* 在线 RL 的双组配卡（actor/sampler）：groups 是逗号串原文，解析在派生函数 */
  const [rlPlacement, setRlPlacement] = useState<RlPlacement>({ placement: 'disaggregated', groups: '' });
  /* 并行计划（「显卡与分片分组」弹窗调节、实时写回命令预览与提交）；缺省 = transformers 纯 DP */
  const [plan, setPlan] = useState<ParallelPlan>(defaultPlan());
  /* 奖励规则名注册表（判别 orm/prm 条目是规则名还是模型 id，决定是否占组） */
  const [ormRules, setOrmRules] = useState<{ orm: string[]; prm: string[] }>({ orm: [], prm: [] });
  /*
   * 代码形态自己的状态：编辑器内容（默认模板）与选卡。集群卡数对代码没有
   * 落点——并行规格由代码内的 DistributedConfig 声明，只有本机选卡。
   */
  const [code, setCode] = useState(CODE_TRAIN_TEMPLATE);
  const [codeGpuSel, setCodeGpuSel] = useState<GpuSelection>(EMPTY_GPU_SELECTION);
  const [submitting, setSubmitting] = useState(false);
  /** 候选清单：模型/数据集（catalog）、插件（plugins.json 登记名） */
  const [modelOptions, setModelOptions] = useState<SearchOption[]>([]);
  const [datasetOptions, setDatasetOptions] = useState<SearchOption[]>([]);
  const [pluginOptions, setPluginOptions] = useState<SearchOption[]>([]);
  /*
   * 训练预检（可视化）状态：模型结构与数据集样例都手动触发（hub 首次要联网/下载）；
   * gpuList 供显存预估拿对比基准（本机卡显存）。模型/数据集切换后旧结果作废。
   */
  const [structure, setStructure] = useState<ModelStructure | null>(null);
  const [structureLoading, setStructureLoading] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);
  const [previewRows, setPreviewRows] = useState<DatasetPreviewRow[] | null>(null);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewN, setPreviewN] = useState(5);
  const [gpuList, setGpuList] = useState<GpuInfo[]>([]);

  useEffect(() => {
    listGpus().then(setGpuList).catch(() => {
      /* 无驱动/无卡：显存预估退化为无对比基准 */
    });
  }, []);

  const loadStructure = () => {
    if (!model.trim()) return;
    setStructureLoading(true);
    setStructureError(null);
    fetchModelStructure(model.trim())
      .then(setStructure)
      .catch((e) => setStructureError(String(e instanceof Error ? e.message : e)))
      .finally(() => setStructureLoading(false));
  };

  const loadPreview = () => {
    const ds = datasets[0];
    if (!ds) return;
    setPreviewLoading(true);
    setPreviewError(null);
    fetchDatasetPreview(ds, previewN)
      .then((r) => {
        setPreviewRows(r.rows);
        setPreviewTruncated(r.truncated);
      })
      .catch((e) => {
        setPreviewError(String(e instanceof Error ? e.message : e));
        setPreviewRows(null);
      })
      .finally(() => setPreviewLoading(false));
  };

  useEffect(() => {
    setStructure(null);
    setStructureError(null);
  }, [model]);

  useEffect(() => {
    setPreviewRows(null);
    setPreviewError(null);
  }, [datasets[0]]);

  /* 显存预估的表单输入（未填项取 CLI 默认）：LoRA r / batch / seq / 检查点 */
  const loraRank = Number(params.lora_rank) > 0 ? Number(params.lora_rank) : 8;
  const mBatch = Number(params.per_device_train_batch_size) > 0 ? Number(params.per_device_train_batch_size) : 1;
  const mSeqLen = Number(params.max_length) > 0 ? Number(params.max_length) : 2048;
  const mGradCkpt = params.gradient_checkpointing === true;
  /* 对比基准：本机模式取所选卡的最小显存（卡型不均时以窄卡为准）；集群模式按本机卡型估。
   * GpuInfo.total/used 的单位是 MiB（nvidia-smi 口径），预估是字节——乘 1024² 对齐 */
  const selectedTotals = gpuSel.mode === 'local'
    ? gpuSel.cards.map((c) => gpuList.find((g) => g.index === c)?.total ?? 0).filter(Boolean)
    : [];
  const estCardBytes =
    gpuSel.mode === 'local'
      ? selectedTotals.length
        ? Math.min(...selectedTotals) * 1024 * 1024
        : 0
      : gpuSel.mode === 'cluster'
        ? (gpuList[0]?.total ?? 0) * 1024 * 1024
        : 0;
  const estCardLabel =
    gpuSel.mode === 'local' && gpuSel.cards.length
      ? t('tn.cardsList', { ids: gpuSel.cards.join(',') })
      : gpuSel.mode === 'cluster'
        ? t('tn.byLocalType', { name: gpuList[0]?.name ?? '' })
        : '';

  useEffect(() => {
    listCatalog()
      .then((c) => {
        setModelOptions(c.models.map(modelOption));
        setDatasetOptions(c.datasets.map(datasetOption));
      })
      .catch(() => {
        /* 清单不可达：SearchSelect 仍接受自由输入 */
      });
    listPlugins()
      .then((ps) =>
        setPluginOptions(
          ps.map((p) => ({
            value: p.source,
            label: p.id,
            /* 类型标签与备注一起进 hint：下拉里就能看出这个插件是干什么的 */
            hint: [p.tags.join(' · '), p.note].filter(Boolean).join(' — ') || undefined,
          })),
        ),
      )
      .catch(() => {
        /* 同上 */
      });
  }, []);

  /*
   * 「以此为模板新建」入口：?from=<任务 id> 预填该训练的全部表单字段
   * （params 只回填表单认识的 key；经附加参数直写的值原样回填）。
   */
  useEffect(() => {
    const from = searchParams.get('from');
    /* AI 预填与模板克隆是两个互斥入口：带了预填就不回填模板任务 */
    if (!from || prefill) return;
    listTrains()
      .then((tasks) => {
        const src = tasks.find((x) => x.id === from) as TrainTaskInfo | undefined;
        if (!src) return;
        /* 代码任务没有表单字段可回填：切到代码 tab，落盘文件读回来当模板 */
        if (src.taskType === 'code') {
          setMode('code');
          setCodeGpuSel(
            src.gpus?.length ? { mode: 'local', cards: src.gpus, count: undefined } : EMPTY_GPU_SELECTION,
          );
          fsTool({ op: 'read', path: `train-code/${src.id}.py` })
            .then((r) => setCode(String(r.content ?? '')))
            .catch(() => {
              /* 文件读不到（工作空间被清理过）：保持默认模板 */
            });
          return;
        }
        setModel(src.model);
        setTaskType(src.taskType);
        if (src.params.rl_type) setRlType(String(src.params.rl_type));
        setDatasets([...src.datasets]);
        setValDatasets(src.valDatasets ?? []);
        setTuner(src.tuner);
        setPlugins([...src.plugins]);
        const known: Record<string, string | number | boolean> = {};
        for (const f of ALL_PARAMS) {
          if (src.params[f.key] !== undefined && src.params[f.key] !== '') known[f.key] = src.params[f.key];
        }
        /* rl_type 是独立选择器管的，不进 params 表单面 */
        delete known.rl_type;
        setParams(known);
        setExtraArgs(src.extraArgs ?? '');
        setGpuSel(
          src.gpus?.length
            ? { mode: 'local', cards: src.gpus, count: undefined }
            : src.gpuCount
              ? { mode: 'cluster', cards: [], count: src.gpuCount }
              : EMPTY_GPU_SELECTION,
        );
      })
      .catch(() => {
        /* 后端暂不可达：保持空表单 */
      });
  }, [searchParams]);

  /*
   * 首页 AI 创建工具带来的预填：mount 时读取（读取即清），字段缺失静默忽略。
   * 代码字段（f.code）存在时直接切到代码 tab；否则回命令行表单。
   */
  useEffect(() => {
    if (!prefill) return;
    const f = prefill.fields;
    if (typeof f.code === 'string' && f.code.trim()) {
      setMode('code');
      setCode(f.code);
      if (Array.isArray(f.gpus) && f.gpus.length) {
        setCodeGpuSel({ mode: 'local', cards: f.gpus.map(Number).filter(Number.isInteger), count: undefined });
      }
      return;
    }
    if (typeof f.model === 'string' && f.model.trim()) setModel(f.model.trim());
    if (f.taskType === 'pt' || f.taskType === 'rl') setTaskType(f.taskType);
    if (typeof f.rlType === 'string' && f.rlType) setRlType(f.rlType);
    if (Array.isArray(f.datasets)) setDatasets(f.datasets.map(String).filter(Boolean));
    if (Array.isArray(f.valDatasets)) setValDatasets(f.valDatasets.map(String).filter(Boolean));
    if (f.tuner === 'full' || f.tuner === 'trainable_tokens') setTuner(f.tuner);
    if (Array.isArray(f.plugins)) setPlugins(f.plugins.map(String).filter(Boolean));
    if (f.params && typeof f.params === 'object' && !Array.isArray(f.params)) {
      const kv: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(f.params)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') kv[k] = v;
      }
      setParams(kv);
    }
    if (Array.isArray(f.gpus) && f.gpus.length) {
      setGpuSel({ mode: 'local', cards: f.gpus.map(Number).filter(Number.isInteger), count: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setParam = (key: string, v: string | number | boolean | undefined) =>
    setParams((prev) => {
      const next = { ...prev };
      if (v === undefined || v === '' || v === false) delete next[key];
      else next[key] = v;
      return next;
    });

  /*
   * 切算法 = 换一套参数面板：旧算法的专有 flag（如 mopd 的 teacher_model）
   * 不能跟着进新算法的命令行——opsd 是自蒸馏、dpo 没有 num_generations，
   * 残留的 flag 要么被 CLI 拒绝要么语义错位。gkd/mopd 共享 teacher 段、
   * 偏好族共享 beta，这些 key 在两侧面板都在，互切时自然保留。
   */
  const changeRlType = (next: string) => {
    setRlType(next);
    const nextKeys = new Set((RL_PARAMS[next] ?? []).map((f) => f.key));
    setParams((prev) => {
      const cleaned = { ...prev };
      let changed = false;
      for (const f of Object.values(RL_PARAMS).flat()) {
        if (!nextKeys.has(f.key) && cleaned[f.key] !== undefined) {
          delete cleaned[f.key];
          changed = true;
        }
      }
      return changed ? cleaned : prev;
    });
  };

  /*
   * 运行模式切换：本地是 CLI 默认形态，选「本地」不落 --mode flag（回到
   * 未选的默认展示）；切离 remote 时连带清掉 server 两个字段、切离 ray 时
   * 清掉 ray_exp_name——各自只在所属形态下有意义，残留值会变成命令行里
   * 被静默忽略的死 flag。
   */
  const changeMode = (next: string) => {
    setParam('mode', next === 'local' ? undefined : next);
    if (next !== 'remote') {
      setParams((prev) => {
        const cleaned = { ...prev };
        delete cleaned.server_base_url;
        delete cleaned.server_api_key;
        return cleaned;
      });
    }
    if (next !== 'ray') {
      setParam('ray_exp_name', undefined);
    }
  };

  /*
   * 远端 server 地址预填：展览模式锁定训练只能 remote（mode 钉 remote +
   * 预填默认地址）；已登录的正常模式同样预填（可改、不钉 mode）。token 都
   * 不进表单状态——提交时从登录会话注入，避免它出现在命令预览或任何可
   * 回显的地方。依赖 launch/token（登录状态中途变化时补预填）。
   */
  useEffect(() => {
    if (launch === 'expo') {
      setParams((prev) => ({
        ...prev,
        mode: 'remote',
        server_base_url: prev.server_base_url || EXPO_SERVER_URL,
      }));
      return;
    }
    if (token) {
      setParams((prev) => (prev.server_base_url ? prev : { ...prev, server_base_url: EXPO_SERVER_URL }));
    }
  }, [launch, token]);

  /* 卡池总量：本机取勾选数，集群取声明的张数 */
  const totalGpus = gpuSel.mode === 'local' ? gpuSel.cards.length : (gpuSel.count ?? 0);
  /* 在线 RL（rollout 走独立采样器的 6 个算法）需要 actor/sampler 双组配卡；
   * 离线族与 sft/pt 仍是单组：进程数 = 卡池全部 */
  const isOnlineRl = taskType === 'rl' && ONLINE_RL_TYPES.includes(rlType);
  /* distill 族（gkd/opsd/mopd）的教师组走 teacher_parallel_spec；教师数取
   * teacher_model 的个数（list 在表单里以空格 join 存 params） */
  const distillRl = isOnlineRl && ['gkd', 'opsd', 'mopd'].includes(rlType);
  /* gkd/opsd 恰 0/1 个教师（多教师被 CLI single_teacher_id 拒绝），配卡校验
   * 按 clamp 后的单教师走；mopd 取实际个数（spread 段数与之一一对应） */
  const teacherCount = distillRl && typeof params.teacher_model === 'string'
    ? params.teacher_model.trim().split(/\s+/).filter(Boolean).length > 0
      ? (rlType === 'mopd' ? params.teacher_model.trim().split(/\s+/).filter(Boolean).length : 1)
      : 0
    : 0;
  const teacherOpts: RlTeacherOpts = distillRl ? { teacherCount, teacherRequired: true } : {};
  const rlInfo = parseRlPlacement(rlPlacement, totalGpus, teacherOpts, t);
  /* 组清单（算法/字段推导，对齐各 recipe 的 group_requests）与并行计划 → CLI flag：
   * 「显卡与分片分组」弹窗、命令预览、提交三处同源；非在线 RL 退化为单训练组 */
  const groups = deriveGroups({
    taskType,
    rlType: isOnlineRl ? rlType : undefined,
    tuner,
    params,
    nproc: totalGpus,
    rlInfo: isOnlineRl && rlInfo.valid ? rlInfo : undefined,
    ormRules: ormRules.orm,
    prmRules: ormRules.prm,
  });
  const planFlagMap = planFlags(plan, groups);
  /* 用户需填的物理段数（RlGpuPlanner 对齐校验）：colocate = 训练 1 段，独立分片 = 训练+采样；
   * 辅助组按 count 展开（spread K 教师 / N orm 模型各占一段） */
  const expectedSegments = (rlPlacement.placement === 'colocate' ? 1 : 2)
    + groups.filter((g) => g.key !== 'model' && g.key !== 'sampler').reduce((a, g) => a + g.count, 0);
  /* 初次进入在线算法且未填过分组时给默认切分：训练组拿走其余、采样组 1 张 */
  useEffect(() => {
    if (isOnlineRl && rlPlacement.groups === '' && totalGpus >= 2) {
      setRlPlacement((prev) => ({ ...prev, groups: `${totalGpus - 1},1` }));
    }
  }, [isOnlineRl, rlPlacement.groups, totalGpus]);
  /* orm/prm 规则名注册表：一次拉取缓存（失败降级空清单——条目将全按模型 id 处理） */
  useEffect(() => {
    let alive = true;
    listOrmRules().then((r) => { if (alive) setOrmRules(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  /* 进程数（--nproc_per_node）：在线 RL 取训练组卡数，其余取卡池全部；>1 时才给 flag */
  const nproc = isOnlineRl && rlInfo.valid ? rlInfo.actorCards : totalGpus;

  /* 代码形态的「将要执行」：落盘文件名启动时才定 id，预览用占位路径 */
  const codePreview = useMemo(
    () =>
      [
        t('tn.cmdCommentCode'),
        ...(codeGpuSel.mode === 'local' && codeGpuSel.cards.length
          ? [`CUDA_VISIBLE_DEVICES=${codeGpuSel.cards.join(',')} \\`]
          : []),
        t('tn.cmdPythonPath'),
      ].join(' \\\n'),
    [codeGpuSel, t],
  );

  const preview = useMemo(() => {
    /* rl 的算法以 --rl_type 携带（params 的 key 就是 flag 名），sft/pt 无此项 */
    const effectiveParams: Record<string, string | number | boolean> =
      taskType === 'rl' ? { ...params, rl_type: rlType } : { ...params };
    /* 会话 token 作 server 凭据：占位符展示（真实值提交时注入）。展览钉 remote */
    if (launch === 'expo') {
      effectiveParams.mode = 'remote';
      effectiveParams.server_api_key = t('tn.cmdToken');
    } else if (token && params.mode === 'remote') {
      effectiveParams.server_api_key = t('tn.cmdToken');
    }
    const flagLines = [
      `--model ${model || t('tn.cmdModel')}`,
      datasets.length ? `--dataset ${datasets.join(' ')}` : `--dataset ${t('tn.cmdDatasetPh')}`,
      ...(valDatasets.length ? [`--val_dataset ${valDatasets.join(' ')}`] : []),
      `--tuner ${tuner}`,
      ...(plugins.length ? [`--external_plugins ${plugins.join(' ')}`] : []),
      ...(nproc > 1 ? [`--nproc_per_node ${nproc}`] : []),
      /* 在线 RL 的双组放置：CLI 缺省是 colocate，独立分片必须显式声明 */
      ...(isOnlineRl && rlInfo.valid ? [`--sampler_mode ${rlPlacement.placement}`] : []),
      /* 并行计划 flag（弹窗实时调节写回）：后端选择与各组 spec / vllm 引擎形状 */
      ...Object.entries(planFlagMap).map(([k, v]) => `--${k} ${v}`),
      ...Object.entries(effectiveParams).map(([k, v]) => `--${k} ${v}`),
      ...(extraArgs.trim() ? [extraArgs.trim()] : []),
      t('tn.cmdOutputDir'),
    ];
    return [
      t('tn.cmdComment'),
      ...(gpuSel.mode === 'local' && gpuSel.cards.length
        ? [`CUDA_VISIBLE_DEVICES=${gpuSel.cards.join(',')} \\`]
        : []),
      `USE_SWIFT_V5=1 swift ${taskType} \\`,
      ...flagLines.map((l) => `    ${l}`),
    ].join(' \\\n');
  }, [model, taskType, rlType, datasets, valDatasets, tuner, plugins, nproc, params, extraArgs, gpuSel, launch, token,
    isOnlineRl, rlPlacement, planFlagMap, t]);

  const submit = async () => {
    /*
     * 代码形态：唯一校验是非空——内容对错由解释器与 swift.dev 报错。
     * 用户在页面点「启动」即执行（与命令行训练同级信任），无额外审批。
     */
    if (mode === 'code') {
      if (!code.trim()) {
        toast.error(t('tn.errCodeEmpty'));
        return;
      }
      setSubmitting(true);
      try {
        const id = await startCodeTrain({
          code,
          ...(codeGpuSel.mode === 'local' && codeGpuSel.cards.length ? { gpus: codeGpuSel.cards } : {}),
        });
        pushRecent({
          id: `train:${id}`,
          label: t('tn.codeTrainLabel'),
          path: `/train/${id}/metrics`,
        });
        toast.success(t('tn.started'));
        navigate('/train');
      } catch (e) {
        toast.error(String(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (!model.trim()) {
      toast.error(t('tn.errModel'));
      return;
    }
    if (!datasets.length) {
      toast.error(t('tn.errDataset'));
      return;
    }
    /* 在线 RL：双组配卡不合法（未填/超卡数/不能整分）时拒绝提交并点名原因 */
    if (isOnlineRl && !rlInfo.valid) {
      toast.error(rlInfo.error ?? t('tn.errRlFirst'));
      return;
    }
    /* 展览模式的独占校验：remote 凭据来自登录会话，没登录就没有可用的 server token */
    if (launch === 'expo' && !token) {
      toast.error(t('tn.errLoginExpo'));
      return;
    }
    setSubmitting(true);
    try {
      /*
       * 会话 token 作 server 凭据（表单里不存）：展览钉 remote；已登录的
       * 正常模式在 remote 下同样注入，未登录手填值原样透传。
       */
      const submitParams =
        launch === 'expo'
          ? { ...params, mode: 'remote', server_api_key: token }
          : token && params.mode === 'remote'
            ? { ...params, server_api_key: token }
            : params;
      const id = await startTrain({
        model: model.trim(),
        taskType,
        datasets,
        ...(valDatasets.length ? { valDatasets } : {}),
        tuner,
        plugins,
        /* rl 时算法并入 params（key=rl_type → --rl_type）；sft/pt 原样 */
        ...(taskType === 'rl'
          ? {
              params: {
                ...submitParams,
                rl_type: rlType,
                /* 在线 RL 的双组放置 flag（与命令预览同源） */
                ...(isOnlineRl && rlInfo.valid ? { sampler_mode: rlPlacement.placement } : {}),
                /* 并行计划 flag（弹窗调节实时写回，与命令预览同源） */
                ...planFlagMap,
              },
            }
          : { params: submitParams }),
        ...(extraArgs.trim() ? { extraArgs: extraArgs.trim() } : {}),
        ...(watchMetrics.length ? { watchMetrics } : {}),
        /* 展览模式不占本机卡（训练在远端 server 上跑） */
        ...(launch !== 'expo' && gpuSel.mode === 'local'
          ? gpuSel.cards.length
            ? { gpus: gpuSel.cards }
            : {}
          : launch !== 'expo' && gpuSel.count
            ? { gpuCount: gpuSel.count }
            : {}),
      });
      pushRecent({
        id: `train:${id}`,
        label: t('tn.trainLabel', { name: model.trim().split('/').pop() || model.trim() }),
        path: `/train/${id}/metrics`,
      });
      toast.success(t('tn.started'));
      navigate('/train');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  /* 交给 AI 助手的字段 */
  const fields: ConfigField[] = [
    { key: 'model', label: t('tn.modelLabel'), value: model, apply: setModel },
    { key: 'dataset', label: t('tn.fDataset'), value: datasets.join(' '), apply: (v) => setDatasets(v.split(/[\s,]+/).filter(Boolean)) },
    { key: 'tuner', label: t('tn.tunerLabel'), value: tuner, apply: (v) => setTuner(v as Tuner) },
    { key: 'learning_rate', label: t('tf.lr'), value: String(params.learning_rate ?? ''), apply: (v) => setParam('learning_rate', v) },
  ];

  const paramInput = (f: ParamField) => {
    const value = params[f.key];
    if (f.kind === 'bool') {
      return (
        <Field label={t(f.label)} hint={f.hint && t(f.hint)}>
          {/* 开关带状态字：一格网格里只放一枚 Switch 会显得空 */}
          <div className="flex h-8 items-center gap-2.5">
            <Switch checked={value === true} onCheckedChange={(c) => setParam(f.key, c)} />
            <span className="text-muted-foreground text-[12px]">{value === true ? t('tn.switchOn') : t('tn.switchOff')}</span>
          </div>
        </Field>
      );
    }
    if (f.kind === 'list') {
      /* List[str] 型 flag（teacher_model）：值以空格 join 存 params，chip 输入 */
      const vals = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
      return (
        <Field label={t(f.label)} hint={f.hint && t(f.hint)}>
          <TagInput
            values={vals}
            onChange={(vs) => setParam(f.key, vs.join(' '))}
            options={modelOptions}
            placeholder={t('tn.teacherPh')}
          />
        </Field>
      );
    }
    if (f.kind === 'number') {
      return (
        <Field label={t(f.label)} hint={f.hint && t(f.hint)}>
          {/* 默认值直接灰字显示在框里：留空 = 走 CLI 默认，不用猜 */}
          <NumberInput
            value={typeof value === 'number' ? value : undefined}
            placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
            onChange={(n) => setParam(f.key, n)}
          />
        </Field>
      );
    }
    if (f.kind === 'select') {
      /* mode 是独占入口：切换要走 changeMode（连带隐藏/清理 server 字段） */
      const onChange = f.key === 'mode' ? changeMode : (v: string) => setParam(f.key, v);
      return (
        <Field label={t(f.label)} hint={f.hint && t(f.hint)}>
          <SelectInput
            value={typeof value === 'string' ? value : undefined}
            onChange={onChange}
            options={(f.options ?? []).map((o) => ({ value: o.value, label: o.labelKey ? t(o.labelKey) : o.label }))}
            placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
          />
        </Field>
      );
    }
    if (f.kind === 'password') {
      /*
       * 已登录时 server token 不走输入框：凭据来自登录会话，提交时注入。
       * 这里渲染的是状态行（已登录/未登录），避免把 token 放进可回显的表单值。
       */
      if (token && f.key === 'server_api_key') {
        return (
          <Field
            label={t(f.label)}
            hint={token ? t('tn.tokenAuto') : t('tn.tokenLogin')}
          >
            <div className="text-muted-foreground flex h-8 items-center text-[12px]">
              {token ? t('tn.tokenReady') : t('tn.notLoggedIn')}
            </div>
          </Field>
        );
      }
      return (
        <Field label={t(f.label)} hint={f.hint && t(f.hint)}>
          <Input
            type="password"
            value={typeof value === 'string' ? value : ''}
            placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
            onChange={(e) => setParam(f.key, e.target.value)}
            className="h-8 text-[13px]"
          />
        </Field>
      );
    }
    return (
      <Field label={t(f.label)} hint={f.hint && t(f.hint)}>
        <Input
          value={typeof value === 'string' ? value : ''}
          placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
          onChange={(e) => setParam(f.key, e.target.value)}
          className="h-8 text-[13px]"
        />
      </Field>
    );
  };

  /*
   * 参数组布局：wide（长输入）独占一行，其余进自适应网格（约三列，窄屏自动
   * 折成两列）。数值参数一格一枚，比逐字段整行堆叠紧凑得多。
   */
  const paramGrid = (list: ParamField[]) => {
    const rows: ParamField[][] = [];
    let cur: ParamField[] = [];
    for (const f of list) {
      if (f.wide) {
        if (cur.length) rows.push(cur);
        cur = [];
        rows.push([f]);
      } else {
        cur.push(f);
      }
    }
    if (cur.length) rows.push(cur);
    return rows.map((row, i) =>
      row.length === 1 ? (
        <div key={i}>{paramInput(row[0])}</div>
      ) : (
        <div key={i} className="grid gap-x-4 gap-y-3.5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
          {row.map((f) => (
            <Fragment key={f.key}>{paramInput(f)}</Fragment>
          ))}
        </div>
      ),
    );
  };

  /* 形态切换分区：两种形态共用的首分区（一枚开关） */
  const modeSection = {
    title: t('tn.secCreate'),
    content: (
      <FieldStack>
        <Field label={t('tn.formLabel')} hint={t('tn.formHint')}>
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v as 'cli' | 'code')}
            options={[
              { value: 'cli', label: t('tn.modeCli') },
              { value: 'code', label: t('tn.modeCode') },
            ]}
          />
        </Field>
      </FieldStack>
    ),
  };

  /*
   * 代码形态的分区：编辑器 + 本机选卡。不做插件选择器——代码模式的插件
   * 由代码里的 external_plugins 声明，页面上选了也没有注入落点（死参数）。
   */
  const codeSections = [
    modeSection,
    {
      title: t('tn.secCode'),
      content: (
        <FieldStack>
          <Field
            label="Python"
            hint={t('tn.codeHint')}
          >
            <textarea
              value={code}
              rows={22}
              spellCheck={false}
              onChange={(e) => setCode(e.target.value)}
              className="border-border bg-background text-foreground w-full resize-y rounded-md border px-3 py-2.5 font-mono text-xs leading-5 outline-none focus-visible:border-ring/40"
            />
          </Field>
        </FieldStack>
      ),
    },
    {
      title: t('tn.secGpu'),
      content: (
        <FieldStack>
          <Field label={t('tn.gpuLabel')} hint={t('tn.codeGpuHint')}>
            <GpuPicker value={codeGpuSel} onChange={setCodeGpuSel} allowCluster={false} />
          </Field>
        </FieldStack>
      ),
    },
  ];

  /* 命令行形态的分区（原有表单面） */
  /*
   * 关注指标小节：候选随任务类型/算法切换（state 的 useEffect 同步重置）；
   * TagInput 支持删减与自由输入——后端解析器对日志行里任意 key=value 通用。
   */
  const watchMetricsSection = {
    title: t('tn.secMetrics'),
    content: (
      <FieldStack>
        <Field
          label={t('tn.watchLabel')}
          hint={t('tn.watchHint')}
        >
          <TagInput
            values={watchMetrics}
            onChange={setWatchMetrics}
            options={(WATCH_METRICS[taskType === 'rl' ? rlType : taskType] ?? WATCH_METRICS.sft).map((k) => ({
              value: k,
              label: k,
            }))}
            placeholder={t('tn.watchPh')}
            emptyHint={t('tn.watchEmpty')}
          />
        </Field>
      </FieldStack>
    ),
  };

  const cliSections = [
    {
      title: t('tn.secType'),
      content: (
        <FieldStack>
          <Field label={t('tn.trainCmd')} hint={t('tn.trainCmdHint')}>
            <SegmentedControl
              value={taskType}
              onChange={(v) => setTaskType(v as TaskType)}
              options={[
                { value: 'sft', label: t('tn.optSft') },
                { value: 'pt', label: t('tn.optPt') },
                { value: 'rl', label: t('tn.optRl') },
              ]}
            />
          </Field>
          {/* 当前类型的一句话说明：先告诉用户该喂什么样的数据集，再去填 */}
          <p className="text-muted-foreground text-[12px] leading-relaxed">{t(TASK_TYPE_DESC[taskType])}</p>
          {taskType === 'rl' && (
            <div className="bg-muted/40 border-border/60 rounded-lg border p-3.5">
              <div className="text-muted-foreground/80 mb-2.5 text-[11px] font-medium tracking-[0.08em] uppercase">
                {t('tn.rlAlgo')}
              </div>
              <Field label="rl_type" hint={t('tn.rlTypeHint')}>
                <SelectInput
                  value={rlType}
                  onChange={changeRlType}
                  options={RL_TYPE_OPTIONS.flatMap((g) =>
                    g.items.map((i) => ({ value: i.value, label: `${i.labelKey ? t(i.labelKey) : i.label} · ${t(g.group)}` })),
                  )}
                />
              </Field>
              {/* 该算法的专有参数（RLConfig 对应分段）：切算法即换一套面板 */}
              {(RL_PARAMS[rlType]?.length ?? 0) > 0 && (
                <>
                  <div className="text-muted-foreground/80 mt-3.5 mb-2.5 text-[11px] font-medium tracking-[0.08em] uppercase">
                    {t('tn.rlSpecific', { algo: rlType })}
                  </div>
                  {paramGrid(RL_PARAMS[rlType])}
                </>
              )}
            </div>
          )}
        </FieldStack>
      ),
    },
    {
      title: t('tn.secModelData'),
      content: (
        <FieldStack>
          <Field label={t('tn.modelLabel')} hint={t('tn.modelHint')}>
            <SearchSelect
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder="Qwen/Qwen2.5-7B-Instruct"
            />
          </Field>
          {mode === 'cli' && (
            <StructureDialog
              model={model}
              structure={structure}
              loading={structureLoading}
              error={structureError}
              onFetch={loadStructure}
              tuner={tuner}
              loraRank={loraRank}
            />
          )}
          <Field label={t('tn.datasetLabel')} hint={t('tn.datasetHint')}>
            <TagInput
              values={datasets}
              onChange={setDatasets}
              options={datasetOptions}
              placeholder="AI-ModelScope/alpaca-gpt4-data-zh"
            />
          </Field>
          {mode === 'cli' && datasets.length > 0 && (
            <DatasetPreviewDialog
              dataset={datasets[0]}
              rows={previewRows}
              truncated={previewTruncated}
              loading={previewLoading}
              error={previewError}
              n={previewN}
              onN={setPreviewN}
              onFetch={loadPreview}
            />
          )}
          <Field label={t('tn.valLabel')} hint={t('tn.valHint')}>
            <TagInput
              values={valDatasets}
              onChange={setValDatasets}
              options={datasetOptions}
              placeholder={t('tn.optionalPh')}
            />
          </Field>
        </FieldStack>
      ),
    },
    {
      title: t('tn.tunerLabel'),
      content: (
        <FieldStack>
          <Field label="tuner" hint={t('tn.tunerHint')}>
            <SegmentedControl
              value={tuner}
              onChange={(v) => setTuner(v as Tuner)}
              options={[
                { value: 'lora', label: 'LoRA' },
                { value: 'full', label: t('tn.optFull') },
                { value: 'trainable_tokens', label: 'Tokens' },
              ]}
            />
          </Field>
          {tuner === 'lora' && (
            /* LoRA 专有参数收进浅底子块：与通用参数拉开层次，切到全参时整体消失 */
            <div className="bg-muted/40 border-border/60 rounded-lg border p-3.5">
              <div className="text-muted-foreground/80 mb-2.5 text-[11px] font-medium tracking-[0.08em] uppercase">
                {t('tn.loraSpecific')}
              </div>
              {paramGrid(LORA_PARAMS)}
            </div>
          )}
        </FieldStack>
      ),
    },
    ...TRAIN_PARAMS.map((g) => {
      /*
       * 运行位置：server 两字段只服务 remote 形态、ray_exp_name 只服务 ray
       * 形态，本地（默认）下都隐藏。展览模式锁 remote——mode 选择框与
       * ray_exp_name 都不渲染（无本地/集群可选），server 字段恒显。
       */
      if (g.group === 'tf.groupRun') {
        const fields = g.fields.filter((f) =>
          launch === 'expo'
            ? f.key !== 'mode' && f.key !== 'ray_exp_name'
            : f.key === 'mode'
              || (f.key === 'ray_exp_name' ? params.mode === 'ray' : params.mode === 'remote'),
        );
        return {
          title: t(g.group),
          content: (
            <FieldStack>
              {launch === 'expo' && (
                <p className="text-muted-foreground/90 text-[12px] leading-5">
                  {t('tn.expoRemoteNote')}
                </p>
              )}
              {paramGrid(fields)}
            </FieldStack>
          ),
        };
      }
      return { title: t(g.group), content: <FieldStack>{paramGrid(g.fields)}</FieldStack> };
    }),
    {
      title: t('tn.secPlugins'),
      content: (
        <FieldStack>
          <Field
            label={t('tn.pluginsLabel')}
            hint={t('tn.pluginsHint')}
          >
            <TagInput
              values={plugins}
              onChange={setPlugins}
              options={pluginOptions}
              placeholder="/path/to/plugin.py"
              emptyHint={t('tn.pluginsEmpty')}
            />
          </Field>
        </FieldStack>
      ),
    },
    /*
     * 关注指标候选集：key 与训练日志行的指标名同文。各算法的头部收敛信号——
     * rl 家族按算法分档（偏好系有 margins/accuracies，在线系有 reward，ppo 另有
     * critic 面板）；未来训练行多打的指标可自由输入补进来，前端解析器是通用的。
     */
    watchMetricsSection,
    /* 显卡分配：展览模式整组隐藏——训练锁 remote，本机无卡可分配 */
    ...(launch !== 'expo'
      ? [
          {
            title: t('tn.secGpu'),
            content: (
              <FieldStack>
                <Field
                  label={t('tn.gpuLabel')}
                  hint={t('tn.gpuPickHint')}
                >
                  <GpuPicker value={gpuSel} onChange={setGpuSel} />
                </Field>
                {isOnlineRl && (
                  <RlGpuPlanner totalGpus={totalGpus} value={rlPlacement} onChange={setRlPlacement} teacherOpts={teacherOpts} expectedSegments={expectedSegments} />
                )}
                {mode === 'cli' && (
                  <ParallelPlanner
                    model={model}
                    structure={structure}
                    structureLoading={structureLoading}
                    structureError={structureError}
                    onFetchStructure={loadStructure}
                    groups={groups}
                    plan={plan}
                    onPlanChange={setPlan}
                    cards={gpuSel.mode === 'local' ? gpuSel.cards : []}
                    totalCards={Math.max(1, isOnlineRl && rlInfo.valid ? rlInfo.totalCards : totalGpus)}
                    memory={{
                      tuner,
                      loraRank,
                      batch: mBatch,
                      seqLen: mSeqLen,
                      gradCheckpoint: mGradCkpt,
                      cardBytes: estCardBytes,
                      cardLabel: estCardLabel,
                      /* spec → 显存口径：fsdp>1 ≈ ZeRO3；cp 并入激活缩减 */
                      estimate: (spec, zero) => structure
                        ? estimateMemorySharded(
                            { structure, tuner, loraRank, batch: mBatch, seqLen: mSeqLen, gradCheckpoint: mGradCkpt, dtypeBytes: 2, optimizerBytes: 8 },
                            { dp: spec.dp, tp: spec.tp, pp: spec.pp, zero: (spec.fsdp > 1 ? 3 : zero) as 0 | 1 | 2 | 3 },
                          )
                        : null,
                    }}
                  />
                )}
              </FieldStack>
            ),
          },
        ]
      : []),
  ];

  return (
    <ConfigFormShell
      module={MODULES.train}
      title={t('tn.newTrain')}
      desc={
        mode === 'code'
          ? t('tn.descCode')
          : t('tn.descCli', { taskType })
      }
      preview={mode === 'code' ? codePreview : preview}
      fields={mode === 'code' ? [] : fields}
      extraArgs={mode === 'code' ? undefined : extraArgs}
      onExtraArgsChange={setExtraArgs}
      warning={
        mode === 'code'
          ? t('tn.tipCode')
          : t('tn.tipCli')
      }
      actions={
        <Button onClick={() => void submit()} disabled={submitting}>
          <Zap /> {submitting ? t('tn.launching') : t('tn.launchBtn')}
        </Button>
      }
      sections={mode === 'code' ? codeSections : [modeSection, ...cliSections]}
      onSubmit={() => void submit()}
      assistantAutoOpen={Boolean(prefill?.context)}
      assistantIntro={prefill?.context ? prefillIntro('训练', prefill) : undefined}
      assistantConv={prefill?.context?.conv}
      assistantModel={prefill?.context?.model}
    />
  );
}
