import { defineTool, type AgentTool, type ToolContext } from './tools';
import { clipFeedback } from './builtin';
import type { PrefillModule, PrefillPayload } from '../store/prefill';
import { getTrainLog, listTrains, renameTrain, startTrain, stopTrain, trainTaskLabel } from '../api/train';
import { getEvalLog, listEvals, renameEval, stopEval, type EvalTaskInfo } from '../api/eval';
import { getExportLog, listExports, renameExport, stopExport } from '../api/export';
import { listDeploys, getDeployLog, renameDeploy, stopDeploy } from '../api/deploy';
import { listScripts, renameScript, stopScript } from '../api/scripts';

/**
 * 首页（对话页）的任务工具集：创建四类任务、批量启动消融实验、列出现有任务、停止任务。
 *
 * 三类执行语义：create_* 是填参类（准备好预填载荷上抛给页面，回复区渲染
 * 「前往查看」按钮，跳转与启动都由用户自己决定）；start_train_batch 是立即
 * 执行类（一次审批后逐个 spawn，消融实验一起创建一起跑）；list_tasks 只读；
 * delete_task 立即执行类（审批卡确认后发停止 API）。
 */

/** 首页场景的 system 注入：引导先收集参数再调工具 */
export const HOME_SYSTEM =
  '你可以通过工具操作这个 swift 工作台：创建训练/评测/导出/部署任务、批量启动消融实验、列出现有任务、停止任务。' +
  'create_* 是填参类：页面会话里调用后回复区会出现「前往查看」按钮，由用户自己决定点它跳到目标页启动还是继续对话调整——不要代替用户跳转，把按钮的事告诉用户即可。' +
  '注意：服务端后台唤醒回合（无页面在听）里调用 create_* 不会出现按钮，回执会说明这一点——把整理好的参数转告用户即可，不要声称按钮已出现。' +
  '要一次跑多个训练（消融实验，共享基础配置只变差异点）用 start_train_batch：一次审批后全部立即启动。' +
  '调用前先把必要参数收集齐（模型、数据集等），缺的就先问用户，不要拿猜测值填。' +
  '停止任务与批量启动属于立即执行类操作，会先弹审批卡等用户确认。';

/** 参数清洗：字符串数组（容错非数组输入） */
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];

/** 参数清洗：非负整数数组（GPU 卡号） */
const gpuArr = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0)
    : [];

/** 参数清洗：标量 KV（训练旋钮，key = CLI flag 名） */
const scalarKv = (v: unknown): Record<string, string | number | boolean> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = val;
  }
  return out;
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 评测任务一行列表文案：完成态带逐集分数与报告路径（事实 + 建议动作同包） */
function evalTaskLine(t: EvalTaskInfo): string {
  const head = `- ${t.id} · ${t.status} · ${t.name ?? t.modelId}`;
  const scores = (t.report ?? [])
    .map((r) => `${r.dataset}: ${r.rows.find((x) => x.score !== undefined)?.score ?? '?'}`)
    .join('，');
  return scores ? `${head} · ${scores}（报告 ${t.resultJsonl}）` : head;
}

/** 创建类工具执行后的回喂文案：模型据此把按钮和后续选择权交代给用户 */
function createdReply(
  moduleLabel: string,
  given: string[],
  missing: string[],
  hasButton: boolean,
  fields?: Record<string, unknown>,
): string {
  /*
   * hasButton=false（服务端唤醒回合，无 onCreate 上抛通道）时不能声称按钮
   * 已出现——诚实回执 + 参数载荷，由模型转告用户或等页面回合再建。
   */
  if (!hasButton) {
    const payload = JSON.stringify(fields ?? {});
    const shown = payload.length > 2000 ? `${payload.slice(0, 2000)}…（截断）` : payload;
    return [
      `已整理好新建${moduleLabel}的参数${given.length ? `（${given.join('、')}）` : ''}。`,
      missing.length ? `还没提供的参数：${missing.join('、')}——补齐后用户在对应页面创建时更顺。` : '',
      '本回合在后台执行（没有页面在听），不会出现「前往查看」按钮；请把上述参数转告用户，由用户在对应页面创建并启动，或等用户打开对话后再创建。',
      `参数载荷：${shown}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `已准备好新建${moduleLabel}配置${given.length ? `（${given.join('、')}）` : ''}，回复区出现了「前往查看」按钮。`,
    missing.length ? `还没提供的参数：${missing.join('、')}——用户可以点按钮到页面上补填，也可以继续在对话里告诉你。` : '',
    '跳转和启动都由用户自己决定：点按钮去目标页启动，或继续对话调整配置。',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface CreatedLink {
  /** 目标 New 页的模块（预填通道按模块分键） */
  module: PrefillModule;
  /** 跳转路由（如 /train/new） */
  to: string;
  /** 模块中文名（按钮文案） */
  label: string;
  /** 点击按钮时才写入的预填载荷（含会话续聊上下文） */
  payload: PrefillPayload;
}

export interface HomeToolOptions {
  /** 触发本轮工具调用的用户原话（进预填载荷，目标页助手用它做需求复述） */
  userRequest: string;
  /** 创建意图上抛入口（ChatPage 传入：存为待挂按钮，用户点击才跳转） */
  onCreate?: (link: CreatedLink) => void;
  /** 发起创建的会话 id：随预填带给目标页，助手加载该会话的 turns 桶续聊 */
  conv?: string;
  /** 发起创建的模型 id：turns 按会话 × 模型分桶，续聊要加载对应桶 */
  model?: string;
}

export function homeTools({ userRequest, onCreate, conv, model }: HomeToolOptions): AgentTool[] {
  /* create_* 共用骨架：备好预填载荷 → 上抛创建意图（页面渲染跳转按钮）→ 回喂说明 */
  const createTool = (
    name: string,
    module: 'train' | 'eval' | 'export' | 'deploy',
    moduleLabel: string,
    description: string,
    parameters: Record<string, unknown>,
    toFields: (args: Record<string, unknown>) => { fields: Record<string, unknown>; given: string[]; missing: string[] },
  ): AgentTool =>
    defineTool(
      { type: 'function', function: { name, description, parameters } },
      async (args) => {
        const { fields, given, missing } = toFields(args);
        onCreate?.({
          module,
          to: `/${module}/new`,
          label: moduleLabel,
          payload: {
            fields,
            context: {
              userRequest,
              ...(conv ? { conv } : {}),
              ...(model ? { model } : {}),
            },
          },
        });
        return createdReply(moduleLabel, given, missing, onCreate !== undefined, fields);
      },
    );

  const createTrain = createTool(
    'create_train',
    'train',
    '训练',
    '新建训练任务：准备新建训练页的预填表单（模型/数据集/训练方式等），回复区出现「前往查看」按钮，用户点击后跳转，提交由用户完成。' +
      '训练旋钮（学习率、epoch 等）放 params，key 即 CLI flag 名。' +
      '要一次启动多个训练（消融实验）请改用 start_train_batch',
    {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 hub id 或本地路径，如 Qwen/Qwen2.5-7B-Instruct' },
        task_type: { type: 'string', enum: ['sft', 'pt', 'rl'], description: '训练命令，默认 sft' },
        rl_type: { type: 'string', description: 'task_type=rl 时的算法：dpo/kto/orpo/cpo/simpo/rm/grpo/ppo/rft/gkd/opsd/mopd' },
        datasets: { type: 'array', items: { type: 'string' }, description: '训练数据集 id 或本地路径' },
        val_datasets: { type: 'array', items: { type: 'string' }, description: '验证数据集（可选）' },
        tuner: { type: 'string', enum: ['lora', 'full', 'trainable_tokens'], description: '训练方式，默认 lora' },
        params: {
          type: 'object',
          description: '其余训练旋钮（key = CLI flag 名，标量值），如 {"learning_rate": "1e-4", "num_train_epochs": 3}',
        },
        gpus: { type: 'array', items: { type: 'integer' }, description: '本机 GPU 卡号（CUDA_VISIBLE_DEVICES）' },
      },
    },
    (args) => {
      const model = str(args.model);
      const datasets = strArr(args.datasets);
      const params = scalarKv(args.params);
      const fields: Record<string, unknown> = {
        ...(model ? { model } : {}),
        taskType: args.task_type === 'pt' || args.task_type === 'rl' ? args.task_type : 'sft',
        ...(str(args.rl_type) ? { rlType: str(args.rl_type) } : {}),
        datasets,
        valDatasets: strArr(args.val_datasets),
        tuner: args.tuner === 'full' || args.tuner === 'trainable_tokens' ? args.tuner : 'lora',
        params,
        ...(gpuArr(args.gpus).length ? { gpus: gpuArr(args.gpus) } : {}),
      };
      return {
        fields,
        given: [
          ...(model ? ['模型'] : []),
          ...(datasets.length ? ['数据集'] : []),
          ...(Object.keys(params).length ? ['训练旋钮'] : []),
        ],
        missing: [...(model ? [] : ['模型']), ...(datasets.length ? [] : ['训练数据集'])],
      };
    },
  );

  /*
   * 消融实验批量启动：与 create_train 同一套参数清洗，但走立即执行语义——
   * 一次审批通过后逐个 POST /api/train 真正 spawn。这是与「填参类」的
   * 分界：多个实验一起创建时页面预填通道只能装一份，逐个跳转亲手启动不可
   * 行，所以由 agent 直接启动，代价是必须过审批卡。
   */
  const startTrainBatch = defineTool(
    {
      type: 'function',
      function: {
        name: 'start_train_batch',
        description:
          '一次创建并启动多个训练任务（消融实验）：共享基础配置，每个实验只声明差异点。' +
          '执行前弹一次审批卡，用户确认后全部立即启动。适合“同一底座/数据集、变学习率或 LoRA 秩”这类对比实验；' +
          '单个训练或用户想自己检查配置时改用 create_train',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '实验组名（可选，会作为每个任务显示名的公共前缀，如 lr-sweep）' },
            base: {
              type: 'object',
              description: '所有实验共享的基础配置，字段与 create_train 相同：model/datasets/val_datasets/task_type/rl_type/tuner/params/gpus',
            },
            experiments: {
              type: 'array',
              description: '实验列表（2 个起步才有消融意义）：每项含 name（实验短名，进显示名）与 overrides（仅声明与 base 不同的字段；params 会与 base 的逐键合并，实验键优先）',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '实验短名（如 lr1e-4）' },
                  overrides: { type: 'object', description: '差异字段，如 {"params": {"learning_rate": "1e-4"}}' },
                },
                required: ['name'],
              },
            },
          },
          required: ['base', 'experiments'],
        },
      },
    },
    async (args, ctx: ToolContext) => {
      /* base + overrides 合并出一个实验的完整入参：顶层字段覆盖，params 逐键深合 */
      const mergeExp = (ov: Record<string, unknown>): Record<string, unknown> => ({
        ...base,
        ...ov,
        params: { ...baseParams, ...scalarKv(ov.params) },
      });
      const base = (args.base && typeof args.base === 'object' ? args.base : {}) as Record<string, unknown>;
      const baseParams = scalarKv(base.params);
      const group = str(args.name);
      const exps = Array.isArray(args.experiments)
        ? args.experiments
            .map((it) => {
              const e = it && typeof it === 'object' ? (it as Record<string, unknown>) : {};
              const name = str(e.name);
              const ov = (e.overrides && typeof e.overrides === 'object' ? e.overrides : {}) as Record<string, unknown>;
              return name ? { name, merged: mergeExp(ov) } : null;
            })
            .filter((it): it is { name: string; merged: Record<string, unknown> } => !!it)
        : [];
      const model = str(base.model);
      if (!model) return '缺少基础配置里的模型（base.model）；先向用户收集齐再调用。';
      if (!strArr(base.datasets).length) return '缺少基础配置里的训练数据集（base.datasets）；先向用户收集齐再调用。';
      if (!exps.length) return 'experiments 为空；每个实验需要 name 与 overrides（至少给 name）。';
      /* 把将要启动的实验清单亮给用户审批：差异点列全，用户看得见再确认 */
      const summary = exps
        .map((it) => {
          const ov = (args.experiments as Record<string, unknown>[]).find(
            (e) => e && typeof e === 'object' && str((e as Record<string, unknown>).name) === it.name,
          );
          const diffs = Object.entries((ov as Record<string, unknown> | undefined)?.overrides as Record<string, unknown> ?? {})
            .map(([k, v]) =>
              k === 'params'
                ? Object.entries(scalarKv(v)).map(([pk, pv]) => `params.${pk}=${String(pv)}`).join(' ')
                : `${k}=${String(v)}`,
            )
            .filter(Boolean)
            .join('；');
          return `- ${it.name}${diffs ? `：${diffs}` : '（与基础配置相同）'}`;
        })
        .join('\n');
      const ok = await ctx.requestApproval(
        `启动 ${exps.length} 个训练（消融实验${group ? `「${group}」` : ''}）`,
        summary,
      );
      if (!ok) return `用户拒绝了批量启动。可改用 create_train 逐个准备配置，由用户自己在页面上启动。`;
      const results: string[] = [];
      for (const it of exps) {
        const a = it.merged;
        try {
          const id = await startTrain({
            model: str(a.model),
            datasets: strArr(a.datasets),
            taskType: a.task_type === 'pt' || a.task_type === 'rl' ? a.task_type : 'sft',
            valDatasets: strArr(a.val_datasets),
            tuner: a.tuner === 'full' || a.tuner === 'trainable_tokens' ? a.tuner : 'lora',
            params: scalarKv(a.params),
            ...(gpuArr(a.gpus).length ? { gpus: gpuArr(a.gpus) } : {}),
            ...(group || it.name ? { name: [group, it.name].filter(Boolean).join('-') } : {}),
          });
          results.push(`- ${it.name} → ${id} 已启动`);
        } catch (e) {
          results.push(`- ${it.name} → 启动失败: ${String(e)}`);
        }
      }
      const failed = results.filter((l) => l.includes('启动失败')).length;
      return [
        `批量启动完成：${exps.length - failed}/${exps.length} 个实验在跑。`,
        ...results,
        failed ? '失败的那个可在对话里重试，或用 create_train 准备单份配置后由用户启动。' : '训练进度可在「训练」页查看。',
      ].join('\n');
    },
  );

  const createEval = createTool(
    'create_eval',
    'eval',
    '评测',
    '新建评测任务：跳转新建评测页并预填表单，提交由用户完成。被测模型必须是「模型」页已配置的条目 id',
    {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: '被测模型（模型配置页里的条目 id，不是 hub 路径）' },
        items: {
          type: 'array',
          description: '评测集清单',
          items: {
            type: 'object',
            properties: {
              dataset: { type: 'string', description: '评测集名，如 gsm8k / ceval / mmlu' },
              limit: { type: 'integer', description: '只评前 N 条（可选，默认全量）' },
            },
            required: ['dataset'],
          },
        },
        plugins: { type: 'array', items: { type: 'string' }, description: '插件来源路径（可选）' },
      },
    },
    (args) => {
      const modelId = str(args.model_id);
      const items = Array.isArray(args.items)
        ? args.items
            .map((it) => {
              const d = str((it as Record<string, unknown>).dataset);
              const limit = Number((it as Record<string, unknown>).limit);
              return d
                ? { dataset: d, ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}) }
                : null;
            })
            .filter((it): it is { dataset: string; limit?: number } => !!it)
        : [];
      const fields: Record<string, unknown> = {
        ...(modelId ? { modelId } : {}),
        items,
        ...(strArr(args.plugins).length ? { plugins: strArr(args.plugins) } : {}),
      };
      return {
        fields,
        given: [...(modelId ? ['被测模型'] : []), ...(items.length ? ['评测集'] : [])],
        missing: [...(modelId ? [] : ['被测模型']), ...(items.length ? [] : ['评测集'])],
      };
    },
  );

  const createExport = createTool(
    'create_export',
    'export',
    '导出',
    '新建导出任务：跳转新建导出页并预填表单（LoRA 合并/量化/推送 Hub），提交由用户完成',
    {
      type: 'object',
      properties: {
        model: { type: 'string', description: '底座模型 hub id 或本地路径' },
        adapters: { type: 'string', description: 'LoRA adapter（训练 checkpoint 目录）；合并时必填' },
        merge_lora: { type: 'boolean', description: '合并 LoRA 权重' },
        quant_method: { type: 'string', enum: ['awq', 'gptq', 'bnb'], description: '量化方式（可选）' },
        calib_dataset: { type: 'string', description: 'awq/gptq 的校准数据集 id' },
        push_to_hub: { type: 'boolean', description: '推送到 ModelScope Hub' },
        hub_model_id: { type: 'string', description: '推送目标 repo（org/name）' },
        gpus: { type: 'array', items: { type: 'integer' }, description: '本机 GPU 卡号' },
      },
    },
    (args) => {
      const model = str(args.model);
      const quant = args.quant_method === 'awq' || args.quant_method === 'gptq' || args.quant_method === 'bnb';
      const fields: Record<string, unknown> = {
        ...(model ? { model } : {}),
        ...(str(args.adapters) ? { adapters: str(args.adapters) } : {}),
        ...(typeof args.merge_lora === 'boolean' ? { mergeLora: args.merge_lora } : {}),
        ...(quant ? { quant: args.quant_method } : {}),
        ...(str(args.calib_dataset) ? { calibDataset: str(args.calib_dataset) } : {}),
        ...(typeof args.push_to_hub === 'boolean' ? { push: args.push_to_hub } : {}),
        ...(str(args.hub_model_id) ? { hubModelId: str(args.hub_model_id) } : {}),
        ...(gpuArr(args.gpus).length ? { gpus: gpuArr(args.gpus) } : {}),
      };
      return {
        fields,
        given: [
          ...(model ? ['底座模型'] : []),
          ...(typeof args.merge_lora === 'boolean' ? ['合并开关'] : []),
          ...(quant ? ['量化方式'] : []),
        ],
        missing: model ? [] : ['底座模型'],
      };
    },
  );

  const createDeploy = createTool(
    'create_deploy',
    'deploy',
    '部署',
    '新建部署任务：跳转新建部署页并预填表单，提交由用户完成。模型就绪后会自动登记进模型配置',
    {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 hub id 或本地路径（或导出产物目录）' },
        served_name: { type: 'string', description: '对外服务名（可选，默认取模型名尾部）' },
        engine: { type: 'string', enum: ['vllm', 'sglang'], description: '推理引擎，默认 vllm' },
        port: { type: 'integer', description: '端口（可选，0 = 自动挑选空闲端口）' },
        gpus: { type: 'array', items: { type: 'integer' }, description: '本机 GPU 卡号' },
        gpu_count: { type: 'integer', description: '集群卡数（远端资源只声明张数）' },
      },
    },
    (args) => {
      const model = str(args.model);
      const gpus = gpuArr(args.gpus);
      const gpuCount = Number(args.gpu_count);
      const fields: Record<string, unknown> = {
        ...(model ? { model } : {}),
        ...(str(args.served_name) ? { servedName: str(args.served_name) } : {}),
        engine: args.engine === 'sglang' ? 'sglang' : 'vllm',
        ...(Number.isInteger(args.port) ? { port: args.port } : {}),
        ...(gpus.length ? { gpus } : Number.isInteger(gpuCount) && gpuCount > 0 ? { gpuCount } : {}),
      };
      return { fields, given: model ? ['模型'] : [], missing: model ? [] : ['模型'] };
    },
  );

  const listTasks = defineTool(
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description:
          '列出一类现有任务（训练/评测/导出/部署/脚本）：id、状态、显示名。' +
          '脚本条目带运行时长与日志尾——一眼看全在飞脚本，不用逐个 read_script_log。删除前先核对用它',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['train', 'eval', 'export', 'deploy', 'script'], description: '任务类型' },
          },
          required: ['type'],
        },
      },
    },
    async (args) => {
      const type = args.type;
      const lines: string[] = [];
      try {
        if (type === 'train') {
          const tasks = await listTrains();
          /* 进度与续跑提示——事实 + 建议动作同包 */
          lines.push(
            ...tasks.map((t) => {
              const head = `- ${t.id} · ${t.status} · ${trainTaskLabel(t)}`;
              const pos = t.totalSteps ? `（${t.step ?? 0}/${t.totalSteps} 步）` : '';
              if (t.status === 'failed' || t.status === 'stopped') {
                return `${head}${pos} —— 用 list_checkpoints 查断点可 --resume_from_checkpoint 续跑`;
              }
              return `${head}${pos}`;
            }),
          );
        } else if (type === 'eval') {
          const tasks = await listEvals();
          /* 事实 + 建议动作同包：完成态带逐集分数与报告路径，对账不用翻研究页 */
          lines.push(...tasks.map(evalTaskLine));
        } else if (type === 'export') {
          const tasks = await listExports();
          lines.push(...tasks.map((t) => `- ${t.id} · ${t.status} · ${t.name ?? t.model}`));
        } else if (type === 'deploy') {
          const tasks = await listDeploys();
          lines.push(...tasks.map((t) => `- ${t.id} · ${t.status} · ${t.name ?? t.servedName}`));
        } else if (type === 'script') {
          const tasks = await listScripts();
          /* 运行中带时长，附日志尾一行：一次调用看全在飞脚本（替代反复 read_script_log 轮询） */
          lines.push(
            ...tasks.map((t) => {
              const mins = Math.max(1, Math.round((Date.now() - new Date(`${t.startedAt.replace(' ', 'T')}Z`).getTime()) / 60_000));
              const dur = t.status === 'running' ? `（已运行 ${mins} 分钟，完成会自动唤醒发起对话）` : '';
              return `- ${t.id} · ${t.status}${dur} · ${t.name ?? t.script}`;
            }),
          );
        } else {
          return `未知任务类型: ${String(type)}`;
        }
      } catch (e) {
        return `任务列表读取失败: ${String(e)}`;
      }
      return lines.length
        ? `${type} 任务 ${lines.length} 个：\n${lines.join('\n')}`
        : `没有 ${type} 任务。`;
    },
  );

  /*
   * 按需读任务日志：事件里只嵌尾几行，失败归因要深读时从这里拿。四类任务
   * 的 /log 端点同形态（环形缓冲，截尾 500 行）；脚本任务已有专用
   * read_script_log，不重复覆盖。
   */
  const readTaskLog = defineTool(
    {
      type: 'function',
      function: {
        name: 'read_task_log',
        description:
          '按需读一个任务的执行日志尾部（训练/评测/导出/部署；脚本任务用 read_script_log）。' +
          '失败归因深读用——唤醒事件里只嵌尾几行，这里能看全部保留行',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['train', 'eval', 'export', 'deploy'], description: '任务类型' },
            id: { type: 'string', description: '任务 id（list_tasks 给出的那个）' },
            tail: { type: 'integer', description: '读最近多少行（默认 50，上限 500）' },
          },
          required: ['type', 'id'],
        },
      },
    },
    async (args) => {
      const type = String(args.type ?? '');
      const id = String(args.id ?? '').trim();
      if (!id) return '缺少任务 id；先用 list_tasks 核对。';
      const tail = Math.min(Math.max(Number(args.tail) || 50, 1), 500);
      try {
        const lines =
          type === 'train'
            ? await getTrainLog(id)
            : type === 'eval'
              ? await getEvalLog(id)
              : type === 'export'
                ? await getExportLog(id)
                : type === 'deploy'
                  ? await getDeployLog(id)
                  : null;
        if (!lines) return `未知任务类型: ${type}`;
        const slice = lines.slice(-tail);
        /* 训练/评测日志行密且长，500 行上限仍可能上万字符——与 read_script_log 同构套回喂截断 */
        return slice.length
          ? clipFeedback(
              `${type} 任务 ${id} 日志最近 ${slice.length}/${lines.length} 行：\n${slice.join('\n')}`,
              '任务日志 ',
            )
          : `${type} 任务 ${id} 日志为空（可能刚创建，或收编恢复中）。`;
      } catch (e) {
        return `日志读取失败: ${String(e)}`;
      }
    },
  );

  const deleteTask = defineTool(
    {
      type: 'function',
      function: {
        name: 'delete_task',
        description:
          '停止/删除一个任务（向任务进程发 SIGTERM；已产出的 checkpoint 与报告不受影响）。' +
          '执行前需用户审批；id 用 list_tasks 核对',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['train', 'eval', 'export', 'deploy', 'script'], description: '任务类型' },
            id: { type: 'string', description: '任务 id（list_tasks 给出的那个）' },
          },
          required: ['type', 'id'],
        },
      },
    },
    async (args, ctx: ToolContext) => {
      const type = String(args.type ?? '');
      const id = String(args.id ?? '').trim();
      const stops: Record<string, (i: string) => Promise<void>> = {
        train: stopTrain,
        eval: stopEval,
        export: stopExport,
        deploy: stopDeploy,
        script: stopScript,
      };
      const stop = stops[type];
      if (!stop) return `未知任务类型: ${type}`;
      if (!id) return '缺少任务 id；先用 list_tasks 核对。';
      const labels: Record<string, string> = { train: '训练', eval: '评测', export: '导出', deploy: '部署', script: '脚本' };
      const ok = await ctx.requestApproval(
        `停止${labels[type]}任务 ${id}`,
        '停止会向任务进程发送 SIGTERM（优雅关停）；已产出的 checkpoint 与报告不受影响。',
      );
      if (!ok) return `用户拒绝了停止 ${type} 任务 ${id}。请向用户确认是否需要换一种做法。`;
      try {
        await stop(id);
        return `已停止 ${type} 任务 ${id}。`;
      } catch (e) {
        return `停止失败: ${String(e)}`;
      }
    },
  );

  return [createTrain, startTrainBatch, createEval, createExport, createDeploy, listTasks, readTaskLog, deleteTask];
}

/*
 * 任务页（列表/详情）助手的工具集：只作用于本页模块。停止与删除在 webui
 * 任务表里是同一操作（DELETE = SIGTERM 终止进程；已完成任务无进程可杀，
 * 调了也只是标记 stopped），两个名字都注册是有意的语义 affordance——模型
 * 说「停掉它」和「删掉它」都落在同一端点，不要当漂移去合并。
 */
export function moduleTaskTools(module: 'train' | 'eval' | 'export' | 'deploy' | 'script'): AgentTool[] {
  const labels: Record<typeof module, string> = {
    train: '训练',
    eval: '评测',
    export: '导出',
    deploy: '部署',
    script: '脚本',
  };
  const label = labels[module];

  const list = defineTool(
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: `列出当前${label}模块的任务：id、状态、显示名`,
        parameters: { type: 'object', properties: {} },
      },
    },
    async () => {
      try {
        const lines: string[] =
          module === 'train'
            ? (await listTrains()).map((t) => `- ${t.id} · ${t.status} · ${trainTaskLabel(t)}`)
            : module === 'eval'
              ? (await listEvals()).map(evalTaskLine)
              : module === 'export'
                ? (await listExports()).map((t) => `- ${t.id} · ${t.status} · ${t.name ?? t.model}`)
                : module === 'deploy'
                  ? (await listDeploys()).map((t) => `- ${t.id} · ${t.status} · ${t.name ?? t.servedName}`)
                  : (await listScripts()).map((t) => `- ${t.id} · ${t.status} · ${t.name ?? t.script}`);
        return lines.length ? `${label}任务 ${lines.length} 个：\n${lines.join('\n')}` : `没有${label}任务。`;
      } catch (e) {
        return `任务列表读取失败: ${String(e)}`;
      }
    },
  );

  const stop = (name: 'stop_task' | 'delete_task') =>
    defineTool(
      {
        type: 'function',
        function: {
          name,
          description:
            name === 'stop_task'
              ? `停止一个运行中的${label}任务（SIGTERM 优雅关停；已产出的 checkpoint 与报告不受影响）。执行前需用户审批`
              : `从任务表移除一个${label}任务。webui 的删除与停止是同一操作（终止进程、状态转 stopped），任务表本身在内存、webui 重启即清空。执行前需用户审批`,
          parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: '任务 id（list_tasks 给出的那个）' } },
            required: ['id'],
          },
        },
      },
      async (args, ctx: ToolContext) => {
        const id = String(args.id ?? '').trim();
        if (!id) return '缺少任务 id；先用 list_tasks 核对。';
        const ok = await ctx.requestApproval(
          `${name === 'stop_task' ? '停止' : '删除'}${label}任务 ${id}`,
          '会向任务进程发送 SIGTERM（优雅关停）；已产出的 checkpoint 与报告不受影响。',
        );
        if (!ok) return `用户拒绝了这次操作。请向用户确认是否需要换一种做法。`;
        try {
          if (module === 'train') await stopTrain(id);
          else if (module === 'eval') await stopEval(id);
          else if (module === 'export') await stopExport(id);
          else if (module === 'deploy') await stopDeploy(id);
          else await stopScript(id);
          return `已对 ${label}任务 ${id} 执行停止。`;
        } catch (e) {
          return `操作失败: ${String(e)}`;
        }
      },
    );

  const rename = defineTool(
    {
      type: 'function',
      function: {
        name: 'rename_task',
        description: `改一个${label}任务在 webui 里的显示名（不触碰任务本体与产物目录）`,
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 id' },
            name: { type: 'string', description: '新显示名' },
          },
          required: ['id', 'name'],
        },
      },
    },
    async (args) => {
      const id = String(args.id ?? '').trim();
      const name = String(args.name ?? '').trim();
      if (!id || !name) return '缺少 id 或新名字。';
      try {
        if (module === 'train') await renameTrain(id, name);
        else if (module === 'eval') await renameEval(id, name);
        else if (module === 'export') await renameExport(id, name);
        else if (module === 'deploy') await renameDeploy(id, name);
        else await renameScript(id, name);
        return `已把 ${label}任务 ${id} 改名为「${name}」。`;
      } catch (e) {
        return `重命名失败: ${String(e)}`;
      }
    },
  );

  return [list, stop('stop_task'), stop('delete_task'), rename];
}
