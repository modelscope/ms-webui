import {
  createResearch,
  getResearch,
  updateResearch,
  type ResearchIteration,
  type ResearchTrainConfig,
} from '../api/research';
import { installChallenger, listChallengers } from '../api/challenger';
import { startDeploy } from '../api/deploy';
import { startExport } from '../api/export';
import { pruneCheckpoints, startTrain } from '../api/train';
import { defineTool, type AgentTool } from './tools';

/*
 * 训练执行器的属地 flag（output_dir/model/dataset/tuner 等）：webui 启动任务时
 * 自己拼这些 CLI 键，params 里再带同名键会产出双份 argv 被 parser 以冲突拒收。
 * start_train 合并快照与调用参数时一律剥掉——存量脏快照也在这层自愈。
 */
const TRAIN_OWNED_KEYS = new Set([
  /* 与 vite.config.ts 的同名集合必须同步改（前后端无法共享 import，漏一边
   * 属地键防御就静默失效） */
  'model', 'dataset', 'val_dataset', 'tuner', 'external_plugins', 'nproc_per_node', 'output_dir',
]);

/**
 * autoresearch 的 agent 工具面：访谈收敛（create_research）、账本维护
 * （update_research）、断点查询（list_checkpoints）、循环内启动训练
 * （start_train，带审批）、Challenger 组件库（list/install）。
 *
 * 与 WORKBENCH_GUIDE 并列的 AUTORESEARCH_GUIDE 在下方导出，由 ChatPage
 * 在研究模式注入。执行面全部走 vite 中间件；watcher 负责状态跃迁与事件。
 */

/*
 * autoresearch 行为指引（研究模式常驻注入）。访谈四步 + 护栏——metric
 * 不设限但必须机械可执行（冻结数据 + 判分方式 + 阈值 + 方向），评测耗时
 * 是设计义务；Challenger 组件优先、继承次之、现写最后。
 */
export const AUTORESEARCH_GUIDE = [
  '## autoresearch 指引',
  '- 访谈四步收敛：①目标与数据现状（原始数据在哪、什么格式）②达标标准量化为 metric——必须机械可执行：冻结的 held-out 评测数据 + 判分方式（evalscope 基准或自定义判分脚本）+ 阈值 + 方向；主观标准就提议 rubric 让用户确认。评测耗时是设计义务：样本量（limit）、评测时机、基准大小都要权衡，宁可小而快。③评测时机三选一：during=训练自带评测省一次起卡（数据量小时）；parallel=有空卡时边训边评看中期趋势；checkpoint=训完对最新 ckpt 评（默认）。④预算（迭代轮数上限）与决策规则：达标收工 / 未达标 Challenger 迭代 / 预算耗尽或平台期上报用户。',
  '- 访谈完成后用 create_research 落研究会话（此后训练期间挂起，事件会自动唤醒你），然后准备第一版数据（预处理脚本 run_script / Challenger 组件），数据就绪后 start_train 首轮训练（会弹一次启动审批）。',
  '- 回合结束前必须处于三态之一，否则研究会停摆且无人唤醒你：①有后台任务在飞（run_script 脚本 / start_train 训练，终态事件会自动叫醒你）；②审批卡正在等用户点（直接调工具触发，如 start_train——不要用文字说「等用户审批」，那样既不弹卡也不会有任何事件）；③研究已达终态（done / escalated / stopped）并给出总结。需要用户拍板的决策用提问落进回复内容，但本轮能推进的动作（跑脚本、起训练）一律先挂上。启动后台脚本后回合就自然收尾等唤醒——不要留在回合里反复 read_script_log 盯进度，它只用于中途诊断（怀疑跑偏/失败归因）。',
  '- 每轮迭代用 update_research 记 note（改了什么、为什么）并维护 iterations 数组（index/dataVersion/trainTaskId/score 原样带回再加新条目）。事件文本里带的账本信息以服务端为准，改动前先读最新 session。',
  '- metric 用自建判分（metric_kind=custom）时：训练完成事件会把评测交还给你——对最新 checkpoint 用 run_script 跑自己的判分脚本（脚本完成会自动通知），分数写进该迭代的 score，达标与否由你对照阈值判断；evalscope 基准则由平台自动起评。',
  '- Challenger 数据生成组件优先：list_challengers 看可用组件，install_challenger 装进工作空间后 run_script 跑（带参）；不合适才 read_file 读组件源码、edit_file 继承改写。护栏不可拆：评测集冻结（生成组件绝不读评测数据）；新数据必须落新版本目录；生成数据过行级校验才进训练。',
  '- 控制调研面，别把研究做成源码考古：swift 的模板/loss/数据管线是框架既有能力，直接信任使用——不 read_swift_source 自证内部行为，数据验证三条即止（可编码、带监督 token、不超 max_length）；评测基准在数据集注册表里就交给平台自动评（evalscope），只有平台没有的指标才自建判分脚本。调研型脚本（探针/审计）累计超过三四个就停下来先推进主线训练。',
  '- 里程碑必须记账：每完成一版数据（构造+验证通过）、每次关键诊断结论，都用 update_research 记进 iterations（可只填 index/dataVersion/note）再继续下一步——研究页的进展可见性、停摆后的断点恢复、stall 唤醒的定位全部依赖账本，埋头干活不记账等于把进度藏起来。',
  '- 踩坑与结论沉淀进 workspace/EXPERIMENTS.md：排障确认根因后把「现象/根因/修法」三行 prepend 到文件头（先读再整写或 edit_file 顶部插入），研究收口时把实验结论（数据版本×分数×取舍）也补记——该文件头部会常驻注入你的上下文、跨研究跨会话生效，开新迭代前先看它避免重蹈已修过的坑。',
  '- 训练失败/失联先 list_checkpoints 查断点，倾向 --resume_from_checkpoint 续跑（start_train 的 params 里传 resume_from_checkpoint=<ckpt 绝对路径>）；事件里嵌的日志尾不够用时 read_task_log 深读归因；连续失败或无断点停止并上报。',
  '- 上报与收工同样走对话：达标总结（最终 checkpoint 路径、各轮分数、数据版本谱系），并可用 deploy_checkpoint 把最佳 checkpoint 直接部署成可对话服务（LoRA 免合并，就绪后对话页即可与它对话）或 export_checkpoint 固化/推 Hub；预算耗尽给出判断（数据问题还是方案上限）。研究随时可在「研究」页停止。',
].join('\n');

/** autoresearch 工具集（首页研究模式挂载；conv/model 来自当前会话与所选模型列） */
export function researchTools(conv: string, model: string): AgentTool[] {
  const str = (v: unknown): string => String(v ?? '').trim();

  const create = defineTool(
    {
      type: 'function',
      function: {
        name: 'create_research',
        description:
          '访谈收敛后创建研究会话：此后训练期间会话挂起，训练/评测的状态跃迁会以事件自动唤醒你继续决策。' +
          '四项必填齐备再调（详见指引）：量化 metric、评测时机、阈值方向、预算',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: '研究目标（一句话，研究页与事件里引用）' },
            base_model: { type: 'string', description: '被训练的底座模型（hub id 或本地路径）' },
            eval_mode: {
              type: 'string',
              enum: ['during', 'checkpoint', 'parallel'],
              description: '评测时机：during=训练自带评测；checkpoint=训完评最新 ckpt（默认）；parallel=有空卡时边训边评',
            },
            eval_dataset: {
              type: 'string',
              description:
                '评测数据。evalscope 通道必须填注册表精确名（全名单用 env_info 工具查「可用基准」一节，' +
                '小写下划线形，如 live_code_bench / humaneval / mbpp / gsm8k）——版本、subset、limit 等注记' +
                '不要写进名字（括号注记会被注册表拒绝，limit 走单独参数）；内置 live_code_bench 是固化' +
                'lite 版，要精确 release 版本就填自建标识并选 custom 判分通道。自定义 held-out 数据集' +
                '同理走 custom 通道。',
            },
            metric_name: {
              type: 'string',
              description: '判分指标名：evalscope 报告里的 metric 名（如 mean_acc / acc）；自定义判分时填判分输出的指标名',
            },
            metric_kind: { type: 'string', enum: ['evalscope', 'custom'], description: '默认 evalscope；custom=用 judge 组件等自定义判分' },
            threshold: { type: 'number', description: '达标阈值' },
            direction: { type: 'string', enum: ['higher', 'lower'], description: '分数越高越好（默认）还是越低越好' },
            eval_limit: { type: 'integer', description: '评测样本量上限（耗时权衡；不传=全量）' },
            max_iterations: { type: 'integer', description: '预算：最大迭代轮数（默认 3）' },
            train_config: {
              type: 'object',
              description:
                '首轮训练配置（可选；不填则从用户在训练页手动启动的首轮任务自动快照）：' +
                '{ task_type, tuner, params: {flag: value}, gpus?: [卡号], gpu_count?, plugins? }',
              properties: {
                task_type: { type: 'string', enum: ['sft', 'pt', 'rl'] },
                tuner: { type: 'string', enum: ['full', 'lora', 'trainable_tokens'] },
                params: { type: 'object', description: '训练旋钮，key = CLI flag 名' },
                gpus: { type: 'array', items: { type: 'integer' }, description: '本机卡号列表' },
                gpu_count: { type: 'integer', description: '集群卡数（与 gpus 互斥）' },
                plugins: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          required: ['goal', 'base_model', 'eval_dataset', 'metric_name', 'threshold'],
        },
      },
    },
    async (args) => {
      try {
        const tc = (args.train_config ?? {}) as Record<string, unknown>;
        const params: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries((tc.params ?? {}) as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
        }
        const session = await createResearch({
          convId: conv,
          modelId: model,
          goal: str(args.goal),
          baseModel: str(args.base_model),
          evalPlan: {
            mode: (args.eval_mode === 'during' || args.eval_mode === 'parallel' ? args.eval_mode : 'checkpoint') as
              | 'during'
              | 'checkpoint'
              | 'parallel',
            metric: {
              kind: args.metric_kind === 'custom' ? 'custom' : 'evalscope',
              dataset: str(args.eval_dataset),
              metricName: str(args.metric_name),
              ...(Number.isInteger(args.eval_limit) && Number(args.eval_limit) > 0
                ? { limit: Number(args.eval_limit) }
                : {}),
            },
            threshold: Number(args.threshold),
            direction: args.direction === 'lower' ? 'lower' : 'higher',
          },
          budget: {
            maxIterations:
              Number.isInteger(args.max_iterations) && Number(args.max_iterations) > 0 ? Number(args.max_iterations) : 3,
          },
          ...(str(tc.task_type) || Object.keys(params).length || Array.isArray(tc.gpus)
            ? {
                trainConfig: {
                  taskType: tc.task_type === 'pt' || tc.task_type === 'rl' ? tc.task_type : 'sft',
                  tuner: tc.tuner === 'full' || tc.tuner === 'trainable_tokens' ? tc.tuner : 'lora',
                  params,
                  ...(Array.isArray(tc.gpus)
                    ? { gpus: tc.gpus.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) }
                    : {}),
                  ...(Number.isInteger(tc.gpu_count) && Number(tc.gpu_count) > 0 ? { gpuCount: Number(tc.gpu_count) } : {}),
                  ...(Array.isArray(tc.plugins) ? { plugins: tc.plugins.map(String).filter(Boolean) } : {}),
                } satisfies ResearchTrainConfig,
              }
            : {}),
        });
        return [
          `研究会话已创建：${session.id}（状态 preparing）。「研究」页可见。`,
          `接下来：准备第一版数据 → start_train 首轮（会弹一次启动审批）→ update_research 挂接 iterations[{index:0, train_task_id, data_version}] 并置 training。`,
          `训练期间你会被事件自动唤醒（完成→自动评测；失败/失联→附日志）；事件驱动的决策都回这个会话。`,
        ].join('\n');
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const update = defineTool(
    {
      type: 'function',
      function: {
        name: 'update_research',
        description:
          '维护研究会话：追加/更新迭代条目（iterations 整组回传，先读最新再改）、置状态、更新训练配置或预算。' +
          '每轮迭代必须记 note（改了什么、为什么）',
        parameters: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '研究会话 id' },
            status: {
              type: 'string',
              enum: ['preparing', 'training', 'evaluating', 'deciding', 'done', 'escalated', 'stopped'],
              description: '新状态（事件决策后置：启动训练→training；收工→done；预算耗尽→escalated）',
            },
            iterations: {
              type: 'array',
              description: '迭代账本整组（把服务端已有的原样带回 + 新条目/修改）；index 必填',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  data_version: { type: 'string', description: '本轮数据版本（工作空间路径）' },
                  train_task_id: { type: 'string' },
                  eval_task_id: { type: 'string' },
                  score: { type: 'number' },
                  note: { type: 'string', description: '这轮改了什么、为什么' },
                  evaluated_ckpt: { type: 'string', description: '服务端回读的原样带回（watcher 防重字段，不要自己编）' },
                  last_eval_step: { type: 'integer', description: '服务端回读的原样带回（watcher 防重字段，不要自己编）' },
                },
                required: ['index'],
              },
            },
            train_config: { type: 'object', description: '训练配置快照（与 create_research 同形态，start_train 复用它）' },
            max_iterations: { type: 'integer', description: '调整预算上限' },
          },
          required: ['session_id'],
        },
      },
    },
    async (args) => {
      try {
        const id = str(args.session_id);
        const current = await getResearch(id);
        const tc = (args.train_config ?? null) as Record<string, unknown> | null;
        const params: Record<string, string | number | boolean> = {};
        if (tc) {
          for (const [k, v] of Object.entries((tc.params ?? {}) as Record<string, unknown>)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
          }
        }
        const iterations: ResearchIteration[] = Array.isArray(args.iterations)
          ? args.iterations
              .filter((x: Record<string, unknown>) => x && Number.isInteger(x.index))
              .map((x: Record<string, unknown>) => ({
                index: Number(x.index),
                ...(str(x.data_version) ? { dataVersion: str(x.data_version) } : {}),
                ...(str(x.train_task_id) ? { trainTaskId: str(x.train_task_id) } : {}),
                ...(str(x.eval_task_id) ? { evalTaskId: str(x.eval_task_id) } : {}),
                ...(Number.isFinite(Number(x.score)) ? { score: Number(x.score) } : {}),
                ...(str(x.note) ? { note: str(x.note) } : {}),
                /* watcher 防重字段透传：丢了 watcher 会对同一 ckpt/step 重复起评 */
                ...(str(x.evaluated_ckpt) ? { evaluatedCkpt: str(x.evaluated_ckpt) } : {}),
                ...(Number.isInteger(x.last_eval_step) ? { lastEvalStep: Number(x.last_eval_step) } : {}),
              }))
          : current.iterations;
        const s = await updateResearch(id, {
          /* 绑定跟随维护动作：本工具挂在当前会话/列上，改绑让训练/脚本完成事件
           * 投到这里（用户换会话续研究时唤醒不再投给旧会话） */
          convId: conv,
          modelId: model,
          ...(typeof args.status === 'string' ? { status: args.status as never } : {}),
          iterations,
          ...(Number.isInteger(args.max_iterations) && Number(args.max_iterations) > 0
            ? { budget: { maxIterations: Number(args.max_iterations) } }
            : {}),
          ...(tc
            ? {
                trainConfig: {
                  taskType: tc.task_type === 'pt' || tc.task_type === 'rl' ? tc.task_type : 'sft',
                  tuner: tc.tuner === 'full' || tc.tuner === 'trainable_tokens' ? tc.tuner : 'lora',
                  params,
                  ...(Array.isArray(tc.gpus)
                    ? { gpus: tc.gpus.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) }
                    : {}),
                  ...(Number.isInteger(tc.gpu_count) && Number(tc.gpu_count) > 0 ? { gpuCount: Number(tc.gpu_count) } : {}),
                  ...(Array.isArray(tc.plugins) ? { plugins: tc.plugins.map(String).filter(Boolean) } : {}),
                } satisfies ResearchTrainConfig,
              }
            : {}),
        });
        return `已更新：${s.id} 状态 ${s.status}，迭代 ${s.iterations.length} 条。`;
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const checkpoints = defineTool(
    {
      type: 'function',
      function: {
        name: 'list_checkpoints',
        description:
          '列出一个训练任务已产出的 checkpoint（v5 形态 v<N>-<时间戳>，最新在前）。' +
          'resume 续跑（--resume_from_checkpoint）与判断训练进度都用它',
        parameters: {
          type: 'object',
          properties: { train_task_id: { type: 'string', description: '训练任务 id' } },
          required: ['train_task_id'],
        },
      },
    },
    async (args) => {
      try {
        const res = await fetch(
          `/api/train/${encodeURIComponent(str(args.train_task_id))}/checkpoints`,
        );
        if (!res.ok) return `读取失败: ${(await res.json().catch(() => ({}))).error ?? res.status}`;
        const { checkpoints, resumeFrom, remote, warning } = (await res.json()) as {
          checkpoints: Array<{ name: string; path: string; mtimeMs: number }>;
          resumeFrom?: string;
          remote?: boolean;
          warning?: string;
        };
        if (remote && !checkpoints.length) {
          return warning ?? '远端形态训练：checkpoint 在 server 侧，本机不可枚举。';
        }
        if (!checkpoints.length) {
          return '（还没有 checkpoint——检查 save_steps/save_strategy 配置或训练是否已跑到保存点）';
        }
        /* 事实 + 建议动作同包返回：清单带路径与年龄，末尾附可直接复制的续跑模板 */
        const now = Date.now();
        const lines = checkpoints.map((c) => {
          const days = (now - c.mtimeMs) / 86_400_000;
          const age = days >= 1 ? `（${Math.floor(days)} 天前）` : '';
          return `- ${c.name}  ${c.path}${age}`;
        });
        const hint = resumeFrom
          ? `\n最新断点可直接续跑：start_train 的 params 里传 resume_from_checkpoint=${resumeFrom}` +
            '（或 CLI --resume_from_checkpoint 同值）。'
          : '';
        return `${lines.join('\n')}${hint}${remote ? `\n${warning ?? ''}` : ''}`;
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const pruneCheckpointsTool = defineTool(
    {
      type: 'function',
      function: {
        name: 'prune_checkpoints',
        description:
          '清理一个训练任务的旧 checkpoint（保留最新 N 个，其余删除）——磁盘吃紧时的出口。' +
          '删掉的不可恢复；续跑只需要最新断点，旧断点通常可安全清理',
        parameters: {
          type: 'object',
          properties: {
            train_task_id: { type: 'string', description: '训练任务 id' },
            keep: { type: 'integer', description: '保留最新几个（默认 1）' },
          },
          required: ['train_task_id'],
        },
      },
    },
    async (args) => {
      try {
        const { pruned, kept } = await pruneCheckpoints(str(args.train_task_id), Number(args.keep) || 1);
        return pruned.length
          ? `已删除 ${pruned.length} 个旧断点：${pruned.join('、')}。保留：${kept.join('、') ?? '（无）'}`
          : '没有可清理的断点（数量不超过保留数）。';
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const startTrainTool = defineTool(
    {
      type: 'function',
      function: {
        name: 'start_train',
        description:
          '启动一轮研究训练（autoresearch 循环内的迭代）。首次调用会弹用户审批' +
          '（勾「会话内总是允许」后循环内全自动）。启动成功后记得用 update_research ' +
          '把 iterations 加上 {index, train_task_id, data_version} 并置 training',
        parameters: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '研究会话 id（挂接迭代账本）' },
            data_version: { type: 'string', description: '本轮数据版本（工作空间路径，记进账本）' },
            iteration_index: { type: 'integer', description: '迭代序号（从 0 起）' },
            model: { type: 'string', description: '底座模型；缺省用会话的 base_model' },
            datasets: { type: 'array', items: { type: 'string' }, description: '训练数据（本轮数据版本路径）' },
            params: { type: 'object', description: '训练旋钮 key=flag 名（如 max_steps/learning_rate/resume_from_checkpoint）；缺省用会话快照。output_dir/model/dataset/tuner 等执行器属地键不可配（传了会被忽略——目录由任务执行器分配）' },
            gpus: { type: 'array', items: { type: 'integer' }, description: '本机卡号；缺省用会话快照' },
            gpu_count: { type: 'integer', description: '集群卡数（与 gpus 互斥）' },
            note: { type: 'string', description: '本轮注记（改了什么）' },
          },
          required: ['session_id'],
        },
      },
    },
    async (args, ctx) => {
      try {
        const sessionId = str(args.session_id);
        const session = await getResearch(sessionId);
        const tc = session.trainConfig;
        /* 快照 + 调用参数合并后剥属地键：执行器自拼这些 flag，params 带了就是双份 argv */
        const params: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries({ ...(tc?.params ?? {}) })) {
          if (TRAIN_OWNED_KEYS.has(k)) continue;
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
        }
        if (args.params && typeof args.params === 'object') {
          for (const [k, v] of Object.entries(args.params as Record<string, unknown>)) {
            if (TRAIN_OWNED_KEYS.has(k)) continue;
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
          }
        }
        const model = str(args.model) || session.baseModel;
        const datasets = Array.isArray(args.datasets)
          ? args.datasets.map(String).filter(Boolean)
          : [];
        if (!datasets.length) return '缺 datasets（本轮训练数据路径）。';
        const gpus = Array.isArray(args.gpus)
          ? args.gpus.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0)
          : tc?.gpus;
        const gpuCount = Number.isInteger(args.gpu_count) ? Number(args.gpu_count) : tc?.gpuCount;
        const iterationIndex = Number.isInteger(args.iteration_index) ? Number(args.iteration_index) : session.iterations.length;
        const dataVersion = str(args.data_version) || datasets[0];

        /* 授权：审批卡（command=start_train，勾「总是允许」后循环内免审批） */
        const command = 'start_train';
        if (!ctx.allowedCommands?.has(command)) {
          const ok = await ctx.requestApproval(
            `启动研究迭代 ${iterationIndex} 的训练`,
            `${model} · ${datasets.join(' ')}${Object.keys(params).length ? ` · ${Object.keys(params).slice(0, 5).join(' ')}…` : ''}`,
            command,
          );
          if (!ok) {
            return '用户拒绝了这次训练启动。向用户确认原因（预算？数据有疑虑？），不要擅自改参数重试。';
          }
        }

        const trainId = await startTrain({
          model,
          datasets,
          taskType: tc?.taskType ?? 'sft',
          tuner: tc?.tuner ?? 'lora',
          params,
          ...(gpus?.length ? { gpus } : {}),
          ...(gpuCount ? { gpuCount } : {}),
          ...(tc?.plugins?.length ? { plugins: tc.plugins } : {}),
        });
        /* 挂接账本：已有条目原样带回 + 本条 */
        const iterations = [
          ...session.iterations.filter((x) => x.index !== iterationIndex),
          {
            index: iterationIndex,
            dataVersion,
            trainTaskId: trainId,
            ...(str(args.note) ? { note: str(args.note) } : {}),
          },
        ].sort((a, b) => a.index - b.index);
        await updateResearch(sessionId, { iterations, status: 'training' });
        return [
          `训练任务 ${trainId} 已启动，迭代 ${iterationIndex} 已挂接，会话置 training。`,
          '训练完成会自动评测并唤醒你；失败/失联也会带日志唤醒。现在可以收尾本轮回复了。',
        ].join('\n');
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const listChallengerTool = defineTool(
    {
      type: 'function',
      function: {
        name: 'list_challengers',
        description: '列出可用的 Challenger 数据生成组件模板（失败案例增强 / 原始数据再加工 / 判分）。数据迭代优先用它们',
        parameters: { type: 'object', properties: {} },
      },
    },
    async () => {
      try {
        const list = await listChallengers();
        return list.length
          ? list.map((c) => `- ${c.name}：${c.desc}\n  用法 ${c.usage}\n  护栏 ${c.guards}`).join('\n')
          : '（模板库为空——服务端 challenger-templates/ 目录没有组件）';
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const installChallengerTool = defineTool(
    {
      type: 'function',
      function: {
        name: 'install_challenger',
        description:
          '把一个 Challenger 组件模板装进工作空间（workspace/challenger/<name>.py），之后 run_script 跑它、' +
          'read_file/edit_file 可见可继承。已存在说明装过（可能是改过的继承版）',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '组件名（list_challengers 里的名字）' } },
          required: ['name'],
        },
      },
    },
    async (args) => {
      try {
        const path = await installChallenger(str(args.name));
        return `已安装到工作空间 ${path}。先 read_file 读一遍参数，然后 run_script 执行（带参）；要改就 edit_file。`;
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  /*
   * 研究收口工具（达标后）：deploy 让最佳 checkpoint 直接变成可对话的服务
   * （LoRA 以 adapter 挂载、免合并），export 把它固化成完整模型（merge /
   * 量化 / 推 Hub）。研究产出从「报告一段文字」变成「可分享的模型」。
   * 与 start_train 同一套审批门（勾「总是允许」后免审批）。
   */
  const deployCheckpoint = defineTool(
    {
      type: 'function',
      function: {
        name: 'deploy_checkpoint',
        description:
          '把训练产出的 checkpoint 部署成可对话的服务：LoRA checkpoint 直接以 adapter 挂载（免合并），' +
          'full checkpoint 直接作为模型加载。就绪后 endpoint 自动登记进模型配置，对话页立即可与它对话（质化抽查也由此做）。' +
          '执行前需用户审批',
        parameters: {
          type: 'object',
          properties: {
            checkpoint: { type: 'string', description: 'checkpoint 目录的绝对路径（list_checkpoints 给出的）' },
            session_id: { type: 'string', description: '研究会话 id（取底座模型与 tuner 形态；研究收口部署用它）' },
            model: { type: 'string', description: '底座模型（LoRA adapter 的母模型）；缺省用会话 base_model' },
            served_name: { type: 'string', description: '服务名（登记进模型配置的名字；缺省自动生成）' },
            engine: { type: 'string', enum: ['vllm', 'sglang'], description: '推理引擎（默认 vllm）' },
            gpus: { type: 'array', items: { type: 'integer' }, description: '本机卡号；不传不限制' },
          },
          required: ['checkpoint'],
        },
      },
    },
    async (args, ctx) => {
      try {
        const ckpt = str(args.checkpoint);
        if (!ckpt) return '缺 checkpoint 路径（list_checkpoints 给出）。';
        let base = str(args.model);
        let isFull = false;
        const sessionId = str(args.session_id);
        if (sessionId) {
          const s = await getResearch(sessionId);
          base = base || s.baseModel;
          isFull = s.trainConfig?.tuner === 'full';
        }
        if (!isFull && !base) return 'LoRA checkpoint 部署需要底座模型：传 model 或 session_id。';
        const command = 'deploy_checkpoint';
        if (!ctx.allowedCommands?.has(command)) {
          const ok = await ctx.requestApproval(
            '部署 checkpoint 为可对话服务',
            `${isFull ? ckpt : `${base} + adapter ${ckpt}`} · ${args.engine === 'sglang' ? 'sglang' : 'vllm'}`,
            command,
          );
          if (!ok) return '用户拒绝了这次部署。确认顾虑（占卡？服务名？）后再试或放弃。';
        }
        const id = await startDeploy({
          ...(isFull ? { model: ckpt } : { model: base, adapters: [ckpt] }),
          ...(str(args.served_name) ? { servedName: str(args.served_name) } : {}),
          engine: args.engine === 'sglang' ? 'sglang' : 'vllm',
          ...(Array.isArray(args.gpus)
            ? { gpus: args.gpus.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) }
            : {}),
        });
        return [
          `部署任务 ${id} 已启动。就绪后 endpoint 自动登记进模型配置，对话页直接可与它对话。`,
          `启动有过程：read_task_log(type='deploy', id='${id}') 看就绪进度，list_tasks(type='deploy') 看状态。`,
        ].join('\n');
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  const exportCheckpoint = defineTool(
    {
      type: 'function',
      function: {
        name: 'export_checkpoint',
        description:
          '把研究产出的 checkpoint 固化成完整模型：LoRA 合并进底座（merge），full 训练直接整理导出；' +
          '可选量化与推送 ModelScope Hub。研究收口的可分享交付物。执行前需用户审批',
        parameters: {
          type: 'object',
          properties: {
            checkpoint: { type: 'string', description: 'checkpoint 目录的绝对路径（list_checkpoints 给出的）' },
            session_id: { type: 'string', description: '研究会话 id（取底座模型与 tuner 形态）' },
            model: { type: 'string', description: '底座模型（LoRA 合并的母模型）；缺省用会话 base_model' },
            quant_method: { type: 'string', enum: ['awq', 'gptq', 'bnb'], description: '量化方式（不传=不量化）' },
            push_to_hub: { type: 'boolean', description: '完成后推送 ModelScope Hub（需 hub_model_id）' },
            hub_model_id: { type: 'string', description: '推送目标 repo id' },
            gpus: { type: 'array', items: { type: 'integer' }, description: '本机卡号（合并/量化是 GPU 作业）；不传不限制' },
          },
          required: ['checkpoint'],
        },
      },
    },
    async (args, ctx) => {
      try {
        const ckpt = str(args.checkpoint);
        if (!ckpt) return '缺 checkpoint 路径（list_checkpoints 给出）。';
        let base = str(args.model);
        let isFull = false;
        const sessionId = str(args.session_id);
        if (sessionId) {
          const s = await getResearch(sessionId);
          base = base || s.baseModel;
          isFull = s.trainConfig?.tuner === 'full';
        }
        if (!isFull && !base) return 'LoRA 合并需要底座模型：传 model 或 session_id。';
        const pushToHub = args.push_to_hub === true;
        const hubModelId = str(args.hub_model_id);
        if (pushToHub && !hubModelId) return '勾了 push_to_hub 但缺 hub_model_id。';
        const command = 'export_checkpoint';
        if (!ctx.allowedCommands?.has(command)) {
          const ok = await ctx.requestApproval(
            '导出 checkpoint 为完整模型',
            `${isFull ? `full 权重整理：${ckpt}` : `合并 LoRA：${base} + ${ckpt}`}` +
              `${args.quant_method ? ` · 量化 ${args.quant_method}` : ''}${pushToHub ? ` · 推送 ${hubModelId}` : ''}`,
            command,
          );
          if (!ok) return '用户拒绝了这次导出。确认顾虑（磁盘？repo 名？）后再试或放弃。';
        }
        const id = await startExport({
          model: isFull ? ckpt : base,
          ...(isFull ? {} : { adapters: ckpt }),
          mergeLora: !isFull,
          ...(args.quant_method === 'awq' || args.quant_method === 'gptq' || args.quant_method === 'bnb'
            ? { quantMethod: args.quant_method }
            : {}),
          pushToHub,
          ...(hubModelId ? { hubModelId } : {}),
          ...(Array.isArray(args.gpus)
            ? { gpus: args.gpus.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) }
            : {}),
        });
        return [
          `导出任务 ${id} 已启动${isFull ? '（full 权重整理）' : '（LoRA 合并）'}。`,
          '完成后产物在导出页可见（list_tasks(type=export) 看状态）；失败用 read_task_log(type=export) 深读原因。',
        ].join('\n');
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );

  return [
    create,
    update,
    checkpoints,
    pruneCheckpointsTool,
    startTrainTool,
    listChallengerTool,
    installChallengerTool,
    deployCheckpoint,
    exportCheckpoint,
  ];
}
