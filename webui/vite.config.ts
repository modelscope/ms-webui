import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve, sep, dirname, extname, relative } from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, statfsSync, mkdirSync, existsSync, readdirSync, statSync, realpathSync, createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createTurnEngine, type TurnEngineHandle } from './server/turnEngine';
import { composeWakeupMessage, composeScriptWakeupMessage } from './src/agent/wakeup';
import type { ChatMessage } from './src/api/models';

/**
 * swift 侧 API：模型配置管理与 OpenAI 协议代理。
 *
 * 为什么长在 dev server 里：webui 当前没有独立后端进程，vite 的中间件就是
 * 运行机器上唯一的服务面；配置必须落在运行机器的 ~/.swift（key 不能进浏览器），
 * 对远端模型的请求也必须由服务端转发（否则 key 泄漏 + CORS）。
 * 路径根可用环境变量 SWIFT_HOME 覆盖。
 *
 * 协议刻意用标准 OpenAI 形状（/chat/completions、messages、SSE stream），
 * 这样任何 OpenAI 兼容服务（vLLM / twinkle-server / 商用 API）都能直接接。
 * 联网搜索（Tavily）同理：key 落在 ~/.swift/search.json，未配 key 时走
 * Tavily 的免 key 免费通道（X-Tavily-Access-Mode: keyless），搜索调用
 * 由服务端转发——浏览器既不该拿到 key，也常常直连不了 api.tavily.com。
 */

/** 单个模型连接配置。id 是用户起的名字，model 是远端真实模型名 */
interface StoredModel {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  note?: string;
}

const MASK = '***';

/*
 * swift 任务子进程的解释器：必须是装了 ray/vllm/twinkle 的那份 python（容器里
 * PATH 前排的解释器未必有）。优先级：SWIFT_PYTHON 环境变量 > 偏好设置里的
 * pythonPath（~/.swift/webui-settings.json，偏好页可改）> 内置默认。每次 spawn
 * 现读——设置页改完即生效，无需重启。
 */
function resolvePython(): string {
  const saved = loadWebuiSettings().pythonPath;
  return process.env.SWIFT_PYTHON || (saved && saved.trim()) || '/usr/local/bin/python';
}

/*
 * 任务子进程的环境：任务解释器的 bin 目录前置进 PATH。子进程里裸调
 * swift/python 等命令（脚本内部再起 CLI、训练/评测内部再起子进程）按
 * PATH 解析，机器上若装有多套环境（如 conda base 里的另一份 swift），
 * 不前置就会与任务解释器分裂成两层——外层跑对了、内层落到别人环境。
 * 解释器选谁，PATH 就优先谁的 bin，与 resolvePython 同一真相源。
 */
function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dirname(resolvePython())}:${process.env.PATH ?? ''}` };
}

function swiftHome(): string {
  return process.env.SWIFT_HOME || join(homedir(), '.swift');
}

function modelsFile(): string {
  return join(swiftHome(), 'models.json');
}

function loadModels(): StoredModel[] {
  const file = modelsFile();
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as StoredModel[];
  } catch {
    return [];
  }
}

function saveModels(models: StoredModel[]): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(modelsFile(), JSON.stringify(models, null, 2));
}

/*
 * webui 全局偏好：机器侧持久（与 models.json 同一个 ~/.swift 目录）——webui
 * 停止/换浏览器后仍然可用。UI 偏好、pythonPath、对话默认采样、system 提示词
 * 库都在这一份文件里；systemPrompts 的内部结构由前端定义，服务端只透传。
 */
function webuiSettingsFile(): string {
  return join(swiftHome(), 'webui-settings.json');
}

/** 服务端只需要 pythonPath 这个字段有默认；其余字段默认值由前端 Settings 补全 */
interface WebuiSettingsFile {
  pythonPath?: string | null;
  [key: string]: unknown;
}

function loadWebuiSettings(): WebuiSettingsFile {
  try {
    const raw = readFileSync(webuiSettingsFile(), 'utf-8');
    const saved = JSON.parse(raw) as WebuiSettingsFile;
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    /* 没建过/坏数据：全默认 */
    return {};
  }
}

function saveWebuiSettings(next: Record<string, unknown>): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(webuiSettingsFile(), JSON.stringify(next, null, 2));
}

/*
 * 启动模式：SWIFT_WEBUI_MODE=expo 进入展览模式（多用户共用一台运行机器，
 * ModelScope 访问令牌只随浏览器会话内存不落盘；训练锁 remote、机器侧配置
 * 面禁写）。默认 normal——单用户自用，令牌存本机设置文件。同一个 npm 包
 * 按部署环境切换，只认启动时的 env。
 */
function launchMode(): 'normal' | 'expo' {
  return process.env.SWIFT_WEBUI_MODE === 'expo' ? 'expo' : 'normal';
}

/** 展览模式首页注入的 modelscope 推理 API 模型（model 即远端真实模型名） */
interface MsModel {
  model: string;
  label: string;
}

const MS_INFERENCE_BASE = 'https://api-inference.modelscope.cn/v1';

/*
 * dolphin 模型列表接口：必须 PUT（网关只路由 PUT，POST/GET 一律 404）。
 * body 的 SingleCriterion inference_type=1 过滤推理服务模型，SortBy=Default
 * 的排序 = 置顶优先 + 下载热度。响应取 Data.Model.Models[]。
 */
const DOLPHIN_MODELS_URL = 'https://modelscope.cn/api/v1/dolphin/models';
const DOLPHIN_MODELS_BODY = {
  PageSize: 30,
  PageNumber: 1,
  SortBy: 'Default',
  Target: '',
  SingleCriterion: [
    { category: 'inference_type', DateType: 'int', predicate: 'equal', IntValue: 1 },
  ],
  Criterion: [],
};

/* 首页对话可用的 task（排除文生图/图生图类，它们在 chat 协议下不可用） */
const CHAT_TASKS = new Set(['text-generation', 'image-text-to-text']);

/* 默认注入的三个模型家族，各取列表排最前的一条；整体最前者为默认选中 */
const MS_MODEL_FAMILIES = ['deepseek', 'kimi', 'qwen'];

/* dolphin 不可达/无匹配时的兜底（与 2026-10 实测的 dolphin 排序一致） */
const MS_DEFAULTS_FALLBACK: MsModel[] = [
  { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', label: 'DeepSeek-V4.1-Flash-1017' },
  { model: 'moonshotai/Kimi-K3', label: 'Kimi-K3' },
  { model: 'Qwen/Qwen3.8-Flash-Next', label: 'Qwen3.8-Flash-Next' },
];

let msDefaultsCache: { at: number; models: MsModel[]; source: 'dolphin' | 'fallback' } | null =
  null;
const MS_DEFAULTS_TTL_MS = 5 * 60_000;

/**
 * 首页默认模型清单：PUT dolphin → 过滤对话可用 task → 按家族各取排最前一条。
 * 失败或无匹配走硬编码兜底。结果缓存数分钟——每次首页加载都打远端没有意义，
 * 模型热度的变化以分钟计也足够新鲜。
 */
async function listMsDefaultModels(): Promise<{
  models: MsModel[];
  default: string;
  source: 'dolphin' | 'fallback';
}> {
  if (msDefaultsCache && Date.now() - msDefaultsCache.at < MS_DEFAULTS_TTL_MS) {
    return {
      models: msDefaultsCache.models,
      default: msDefaultsCache.models[0]?.model ?? '',
      source: msDefaultsCache.source,
    };
  }
  let picked: { model: string; label: string; index: number }[] = [];
  let source: 'dolphin' | 'fallback' = 'dolphin';
  try {
    const res = await fetch(DOLPHIN_MODELS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DOLPHIN_MODELS_BODY),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`dolphin ${res.status}`);
    const json = (await res.json()) as {
      Data?: { Model?: { Models?: Record<string, unknown>[] } };
    };
    const entries = json.Data?.Model?.Models ?? [];
    const chatModels = entries
      .map((m, index) => ({ m, index }))
      .filter(
        ({ m }) =>
          Array.isArray(m.Tasks) &&
          (m.Tasks as { Name?: string }[]).some((t) => t && CHAT_TASKS.has(t.Name ?? '')),
      );
    for (const family of MS_MODEL_FAMILIES) {
      const hit = chatModels.find(({ m }) =>
        `${String(m.Path ?? '')}/${String(m.Name ?? '')}`.toLowerCase().includes(family),
      );
      if (hit) {
        picked.push({
          model: `${String(hit.m.Path)}/${String(hit.m.Name)}`,
          label: String(hit.m.ChineseName || hit.m.Name || ''),
          index: hit.index,
        });
      }
    }
    if (!picked.length) throw new Error('dolphin 无家族匹配');
    /* default = 列表里整体排最前的一条，而不是家族遍历顺序的第一条 */
    picked.sort((a, b) => a.index - b.index);
  } catch {
    picked = MS_DEFAULTS_FALLBACK.map((m, i) => ({ ...m, index: i }));
    source = 'fallback';
  }
  const models: MsModel[] = picked.map(({ model, label }) => ({ model, label }));
  msDefaultsCache = { at: Date.now(), models, source };
  return { models, default: models[0]?.model ?? '', source };
}

/*
 * 插件登记（~/.swift/plugins.json）。一条登记 = 一个 external_plugins 来源
 * （本地 .py / 本地文件夹 / hub id），训练等页面的插件选择下拉读它。
 */
interface StoredPlugin {
  /** 登记名（缺省取 source） */
  id: string;
  /** 本地 .py / 本地文件夹 / hub id（ms:// 或 hf://），进命令行 --external_plugins */
  source: string;
  /** 类型标注（model/dataset/template/reward/tool/sampler/loss/optimizer 等自由标签） */
  tags: string[];
  note?: string;
}

function pluginsFile(): string {
  return join(swiftHome(), 'plugins.json');
}

function loadPlugins(): StoredPlugin[] {
  const file = pluginsFile();
  if (!existsSync(file)) return [];
  try {
    return (JSON.parse(readFileSync(file, 'utf-8')) as StoredPlugin[]).filter((p) => p?.id && p?.source);
  } catch {
    return [];
  }
}

function savePlugins(plugins: StoredPlugin[]): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(pluginsFile(), JSON.stringify(plugins, null, 2));
}

/*
 * 外部数据根登记（~/.swift/data-roots.json）：用户原始数据所在的本机目录。
 * agent 的文件工具对它们只读放行（list/read），写与编辑恒 403——登记的目的
 * 是让模型能探查原始数据来写前处理脚本，不是给它写盘权限。GB 级数据靠它
 * 免掉拷进工作空间这一步。
 */
function dataRootsFile(): string {
  return join(swiftHome(), 'data-roots.json');
}

function loadDataRoots(): string[] {
  const file = dataRootsFile();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveDataRoots(roots: string[]): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(dataRootsFile(), JSON.stringify(roots, null, 2));
}

/*
 * 编排实验的持久层（~/.swift/flows.json）：脚手架只是初始状态，用户真正
 * 的工作是「实验」——画布状态（nodes/edges/frames）连同名称与来源脚手架
 * 落盘，跨浏览器刷新与 dev server 重启存活。读取遇损坏降级为空列表。
 */
interface StoredFlow {
  id: string;
  name: string;
  /** 创建来源的脚手架 key；空白创建为 '' */
  preset: string;
  /** 画布状态（前端 nodes/edges/frames 形态），纯声明性数据 */
  graph: unknown;
  createdAt: string;
  updatedAt: string;
}

function flowsFile(): string {
  return join(swiftHome(), 'flows.json');
}

function loadFlows(): StoredFlow[] {
  const file = flowsFile();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return (Array.isArray(raw) ? raw : []).filter(
      (f) => f && typeof f === 'object' && typeof (f as StoredFlow).id === 'string' && (f as StoredFlow).graph,
    );
  } catch {
    return [];
  }
}

function saveFlows(flows: StoredFlow[]): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(flowsFile(), JSON.stringify(flows, null, 2));
}

/** 外部根形态的 confineTo：路径落在任一登记根内（相对该根或绝对路径）且物理位置也在根内才放行 */
function confineExternal(p: string): string | null {
  const roots = loadDataRoots();
  for (const root of roots) {
    const abs = confineTo(root, p);
    if (abs && withinRealRoots(abs, roots)) return abs;
  }
  return null;
}

/* 已过守卫的 external 绝对路径属于哪个登记根（grep 算相对路径用） */
function externalRootOf(abs: string): string | null {
  for (const root of loadDataRoots()) {
    if (abs === root || abs.startsWith(root + sep)) return root;
  }
  return null;
}

/*
 * 工作空间插件目录（workspace/plugins/）顶层 .py 的扫描：agent 写出来的
 * plugin 直接以文件形态出现在插件页与各表单的候选里，不必再手动登记。
 * 只认顶层文件不递归——「一个 .py 一个插件」的约定，子目录不算。
 */
function workspacePlugins(): StoredPlugin[] {
  const dir = join(workspaceRoot(), 'plugins');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.py'));
  } catch {
    /* 目录还没建：没有 agent 产出的插件 */
    return [];
  }
  const registered = new Set(loadPlugins().map((p) => p.id));
  return names.map((n) => {
    const base = n.replace(/\.py$/, '');
    return {
      /* 与手动登记同名时加来源后缀区分，不覆盖登记条目 */
      id: registered.has(base) ? `${base} (workspace)` : base,
      source: join(dir, n),
      tags: ['workspace'],
      note: 'agent 写进工作空间 plugins/ 的插件文件',
    };
  });
}

/*
 * 新建页「附加参数」的 tokenizer：支持单/双引号包裹的带空格值，其余按空白切。
 * 引号内的内容原样保留（不做变量展开）——与用户在终端里写 run.sh 的直觉一致。
 */
function splitExtraArgs(raw: string): string[] {
  const out: string[] = [];
  for (const m of String(raw ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out.filter(Boolean);
}

/*
 * 任务执行器通用件：五类任务（deploy/eval/export/train/script）的日志与
 * 公开形态同构——环形 500 行截尾、可选逐行落盘、剥掉 proc 句柄再出 API。
 * 各执行器保留自己的 pushXxxLog / publicXxx 名字（调用点数十处），实现收拢
 * 在这里：五份拷贝各自漂移的形态（如 deploy 曾漏 error handler）就此绝迹。
 */

/** 环形日志（截尾保留最近 500 行）；persist 提供时逐行落盘（重启收编后可恢复） */
function pushTaskLog<T extends { log: string[] }>(task: T, line: string, persist?: (line: string) => void): void {
  task.log.push(line);
  if (task.log.length > 500) task.log.splice(0, task.log.length - 500);
  try {
    persist?.(line);
  } catch {
    /* 落盘失败不影响内存态，只是重启后不可恢复 */
  }
}

/** 公开形态：剥掉子进程句柄（proc 不能序列化，也不该出 API） */
function publicOf<T extends { proc?: unknown }>(t: T): Omit<T, 'proc'> {
  const { proc: _proc, ...rest } = t;
  return rest;
}

/*
 * 模型/数据集候选清单（新建页可搜索下拉的数据源）：真相源是 swift 的两个
 * 注册表——swift.model.MODEL_MAPPING（每个 ModelMeta 的 model_groups 展开
 * 出全部 hub id，约千余条，随 swift 新增模型自动长出来）与
 * swift.dataset.loader.DATASET_MAPPING（数据集 id + tags，tags 里带 🔥 的
 * 即 legacy docs 标的重要数据集）。探测一次后缓存；本机 modelscope 缓存里
 * 已下载的模型并入（hint 标「已在本机缓存」）。探测失败（python 环境坏）
 * 时降级为空清单——下拉仍可自由输入。
 */
interface CatalogEntry {
  id: string;
  /** 模型：注册表里的 model_type；数据集：无 */
  modelType?: string;
  tags: string[];
  /** 已下载到本机缓存（注册表内外的条目都会标）；仅模型有 */
  cached?: boolean;
}

let catalogCache: { models: CatalogEntry[]; datasets: CatalogEntry[] } | null = null;

const CATALOG_PROBE =
  'import json\n' +
  'from swift.model import MODEL_MAPPING\n' +
  'models = []\n' +
  'for model_type, meta in MODEL_MAPPING.items():\n' +
  '    tags = list(getattr(meta, "tags", None) or [])\n' +
  '    for group in (getattr(meta, "model_groups", None) or []):\n' +
  '        for model in (group.models or []):\n' +
  '            mid = getattr(model, "ms_model_id", None) or getattr(model, "hf_model_id", None)\n' +
  '            if mid:\n' +
  '                models.append({"id": mid, "modelType": model_type, "tags": tags})\n' +
  'from swift.dataset.loader import DATASET_MAPPING\n' +
  'datasets = []\n' +
  'for key, meta in DATASET_MAPPING.items():\n' +
  '    did = getattr(meta, "ms_dataset_id", None) or (key[0] if isinstance(key, tuple) else str(key))\n' +
  '    if did:\n' +
  '        datasets.append({"id": did, "tags": list(getattr(meta, "tags", None) or [])})\n' +
  'print(json.dumps({"models": models, "datasets": datasets}))\n';

const DATASET_PREVIEW_PROBE = "import sys, json\nds, n = sys.argv[1], int(sys.argv[2])\nfrom swift.dev.dataset.loader import load_dataset\ntrain, _ = load_dataset([ds], streaming=True)\nrows = []\nfor i, row in enumerate(train):\n    if i >= n: break\n    rows.append(row if isinstance(row, dict) else {'value': str(row)})\nprint(json.dumps({'rows': rows, 'truncated': len(rows) >= n}, ensure_ascii=False, default=str))\n";
const MODEL_STRUCTURE_PROBE = "import sys, json, os, glob, struct, re\nmodel = sys.argv[1]\nroots = []\nenv = os.environ.get('MODELSCOPE_CACHE')\nif env: roots.append(env)\nroots += [os.path.expanduser('~/.cache/modelscope'), '/mnt/workspace/.cache/modelscope']\nsnap = None\nfor root in roots:\n    for sub in ('hub/models', 'models'):\n        base = os.path.join(root, sub)\n        for cand in (os.path.join(base, model.replace('/', '--')), os.path.join(base, model)):\n            for s in sorted(glob.glob(os.path.join(cand, 'snapshots', '*'))):\n                if os.path.exists(os.path.join(s, 'config.json')):\n                    snap = s; break\n            if snap: break\n        if snap: break\n    if snap: break\ndef _fetch_cfg_from_hub(model):\n    # 非缓存模型：从 modelscope hub 只拉 config.json 小文件（HF 直连在本机\n    # 环境常不通，AutoConfig 会 30s 超时；modelscope 是训练侧同一通道）\n    from modelscope import snapshot_download\n    cfg_dir = snapshot_download(model, allow_file_pattern='config.json')\n    c = json.load(open(os.path.join(cfg_dir, 'config.json')))\n    for nested in ('text_config', 'language_config', 'llm_config'):\n        if isinstance(c.get(nested), dict):\n            c = {**c.get(nested), **{k: v for k, v in c.items() if k != nested}}\n    return c\n\n\ninfo = {'model': model}\nmod_shapes = {}\ncfg = {}\nif snap:\n    cfg = json.load(open(os.path.join(snap, 'config.json')))\n    # 多模态外层：文本主干参数嵌套在 text_config；拍平后统一取键\n    for nested in ('text_config', 'language_config', 'llm_config'):\n        if isinstance(cfg.get(nested), dict):\n            cfg = {**cfg.get(nested), **{k: v for k, v in cfg.items() if k != nested}}\n    total = 0\n    st_files = sorted(glob.glob(os.path.join(snap, '*.safetensors')))\n    for f in st_files:\n        with open(f, 'rb') as fp:\n            n = struct.unpack('<Q', fp.read(8))[0]\n            meta = json.loads(fp.read(n))\n        for k, v in meta.items():\n            if k == '__metadata__': continue\n            numel = 1\n            for d in v.get('shape', []): numel *= d\n            total += numel\n            mod_shapes[k] = v.get('shape')\n    if st_files and total > 0:\n        info['paramsSource'] = 'safetensors'\n        info['params'] = total\n    else:\n        # 缓存里只有 config（snapshot_download 只拉过 config.json）：走估算分支\n        snap = None\nif not snap:\n    if not cfg:\n        cfg = _fetch_cfg_from_hub(model)\n    info['paramsSource'] = 'config-estimate'\n    h = cfg.get('hidden_size', 0) or 0\n    l = cfg.get('num_hidden_layers', 0) or 0\n    v = cfg.get('vocab_size', 0) or 0\n    inter = cfg.get('intermediate_size', 0) or 0\n    experts = cfg.get('num_experts') or cfg.get('moe_num_experts') or 1\n    per_layer = 12 * h * h + 3 * h * inter * experts\n    info['params'] = int(v * h + l * per_layer)\nfor k, key in [('modelType', 'model_type'), ('layers', 'num_hidden_layers'), ('hidden', 'hidden_size'),\n               ('heads', 'num_attention_heads'), ('kvHeads', 'num_key_value_heads'),\n               ('vocab', 'vocab_size'), ('intermediate', 'intermediate_size')]:\n    if cfg.get(key) is not None: info[k] = cfg.get(key)\nexperts = cfg.get('num_experts') or cfg.get('moe_num_experts') or (cfg.get('decoder_config') or {}).get('moe_num_experts')\nif experts: info['moeExperts'] = experts\nlora = {}\nfor name, shape in mod_shapes.items():\n    m = re.search(r'\\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj|in_proj_qkv|in_proj_a|in_proj_b|in_proj_z|out_proj)\\.weight$', name)\n    if m: lora.setdefault(m.group(1), []).append(shape)\ninfo['loraModules'] = {k: len(v) for k, v in lora.items()}\ninfo['loraShapes'] = {k: v[0] for k, v in lora.items()}\nprint(json.dumps(info))\n";
/** model-structure 探测结果缓存：模型结构不随重启变化，避免每次打开弹窗都起探针 */
const modelStructureCache = new Map<string, Record<string, unknown>>();
/* 奖励规则名注册表探针：判别 orm/prm 条目是规则名（不占组）还是模型 id（占独立组） */
const ORM_RULES_PROBE = "import json\nout = {}\ntry:\n    from swift.dev.rewards.orm import orms\n    out['orm'] = sorted(orms)\nexcept Exception:\n    out['orm'] = []\ntry:\n    import swift.dev.rewards as _rw\n    out['prm'] = sorted(getattr(getattr(_rw, 'prm', None) or object(), 'prm_scorers', {}))\nexcept Exception:\n    out['prm'] = []\nprint(json.dumps(out))\n";
let ormRulesCache: Record<string, unknown> | null = null;

function listCatalog(): Promise<{ models: CatalogEntry[]; datasets: CatalogEntry[] }> {
  if (catalogCache) return Promise.resolve(catalogCache);
  return new Promise((resolvePromise) => {
    const proc = spawn(resolvePython(), ['-c', CATALOG_PROBE], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    const fail = () => resolvePromise({ models: [], datasets: [] });
    proc.on('error', fail);
    proc.on('close', (code) => {
      if (code !== 0) {
        /* 注册表探测失败：空清单兜底，SearchSelect/TagInput 仍接受自由输入 */
        fail();
        return;
      }
      try {
        const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
          models: CatalogEntry[];
          datasets: CatalogEntry[];
        };
        /*
         * 本机缓存标记 + 缓存独有模型：注册表里已有、且已下载到本机的条目
         * 也打 cached=true（agent 与下拉都靠它判断「哪些模型不用下载」）；
         * 注册表没有的（外部/自定义模型）作为额外条目并入。
         */
        const cachedSet = new Set(cachedHubModels());
        const known = new Set(parsed.models.map((m) => m.id));
        const models = parsed.models.map((m) => (cachedSet.has(m.id) ? { ...m, cached: true } : m));
        const extra = [...cachedSet]
          .filter((id) => !known.has(id))
          .map((id) => ({ id, tags: [] as string[], cached: true }));
        catalogCache = {
          models: [...models, ...extra],
          datasets: parsed.datasets,
        };
        resolvePromise(catalogCache);
      } catch {
        fail();
      }
    });
  });
}

/*
 * 本机 modelscope 缓存里已下载的模型（org/name 形态）。MODELSCOPE_CACHE 有
 * 两种指法——指到 .../modelscope（标准，hub 内容在 hub/models）或直接指到
 * .../modelscope/hub（本机形态，内容在 models/）——两种布局都试。
 */
function cachedHubModels(): string[] {
  const root = modelCacheRoot();
  for (const hub of [join(root, 'hub', 'models'), join(root, 'models')]) {
    try {
      return readdirSync(hub)
        /* 以 -- 开头的是老式「绝对路径当目录名」的缓存条目（路径分隔符被折成
         * --，replace 后是 /mnt--workspace--… 畸形串），跳过 */
        .filter((d) => d.includes('--') && !d.startsWith('--'))
        .map((d) => d.replace('--', '/'));
    } catch {
      /* 这个布局不存在：试下一种 */
    }
  }
  return [];
}

/** 列表返回时把 key 打成掩码——前端永远拿不到明文 */
function mask(model: StoredModel): StoredModel {
  return { ...model, apiKey: model.apiKey ? MASK : '' };
}

/** 联网搜索配置。只有一个搜索工具（Tavily），不做成列表 */
interface StoredSearch {
  tavilyKey?: string;
}

function searchFile(): string {
  return join(swiftHome(), 'search.json');
}

function loadSearch(): StoredSearch {
  const file = searchFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as StoredSearch;
  } catch {
    return {};
  }
}

function saveSearch(search: StoredSearch): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(searchFile(), JSON.stringify(search, null, 2));
}

/**
 * agent 工具的工作空间：文件读写只允许落在这一棵子树里（SWIFT_HOME 可改根）。
 * shell 的工作目录也钉在这里——「当前空间」之外一概无权限。
 */
function workspaceRoot(): string {
  return join(swiftHome(), 'workspace');
}

/*
 * 任务子进程（训练/评测/导出/部署）的工作目录：与 agent 工具的工作空间同根。
 * 必须显式钉住——不设 cwd 会继承 dev server 的 webui 根目录，swift.dev 会在
 * cwd 周期性落临时文件（如 swift.dev.model.loader.base），被 vite watch 当成
 * 源码变更触发整页 reload，表现为页面随日志输出节奏白屏闪烁。
 */
function taskCwd(): string {
  const root = workspaceRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

/** 把入参里的相对/绝对路径收进指定根；越界返回 null */
function confineTo(root: string, p: string): string | null {
  const base = resolve(root);
  const abs = resolve(base, p || '.');
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

/*
 * 物理路径求取：confineTo 是纯词法规范化（path.resolve 不解析 symlink），
 * 根内一个指向外部的 symlink 就能词法过关、物理越界。这里把最终物理路径
 * 求出来——目标存在直接 realpath；不存在（write 新文件）则找最近的已存在
 * 祖先 realpath 后拼回剩余段（剩余段尚不存在，不可能再藏 symlink；若祖先
 * 本身是 symlink，realpath 后拼接的结果已经在外部，守卫会拦下）。
 */
function physicalPath(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    let probe = dirname(abs);
    for (;;) {
      try {
        return join(realpathSync(probe), relative(probe, abs));
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return abs; /* 走到文件系统根都不存在：只能按词法算 */
        probe = parent;
      }
    }
  }
}

/** 物理守卫：abs 的真实落点必须仍在某个允许根的物理路径之下（含根本身） */
function withinRealRoots(abs: string, roots: string[]): boolean {
  const real = physicalPath(abs);
  return roots.some((r) => {
    const realRoot = physicalPath(r);
    return real === realRoot || real.startsWith(realRoot + sep);
  });
}

/** 工作空间形态的 confineTo（agent 文件工具的默认根） */
function confineWorkspace(p: string): string | null {
  return confineTo(workspaceRoot(), p);
}

/**
 * shell 危险命令判定：只读命令白名单直接放行，其余（写操作、包管理、网络、
 * 任意解释器等）一律需要用户在前端审批卡片上点头后才执行。判定偏保守——
 * 漏放比漏拦的代价小；`ls 2>/dev/null` 这类丢弃输出的重定向不算写。
 */
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'pwd', 'echo', 'du', 'df',
  'stat', 'file', 'tree', 'which', 'type', 'env', 'printenv', 'sort', 'uniq',
  'diff', 'whoami', 'date', 'id', 'uname', 'hostname', 'basename', 'dirname',
  'realpath', 'ps', 'true', 'false',
  /* 文本/数据只读分析件（越界参数与真实文件重定向由下方守卫另行拦截） */
  'jq', 'awk', 'sed', 'cut', 'column', 'nl', 'rev', 'md5sum', 'sha256sum',
  'nproc', 'free', 'uptime',
  /* GPU 状态查询：训练/部署规划前的常规只读探测 */
  'nvidia-smi',
  /* shell 流程件：cd 无副作用（spawn 的 cwd 已钉死）、timeout 只包一层
   * （真实主命令由 effectiveCommand 剥出来另判）、管道 tee 输出不算写文件 */
  'cd', 'timeout',
  /* 低危工作空间写：mkdir 建目录、touch 建空文件——删除/覆盖类（rm/mv/cp）
   * 仍走审批 */
  'mkdir', 'touch',
  /* 包/仓库管理的只读面（install/push 等改动面子命令由 unsafeArgs 拦下） */
  'pip', 'pip3', 'git',
  /* python -V / python3 --version 这类版本探测不执行任意代码；跑脚本
   * （python3 x.py / python3 -c）不在白名单，由用户勾选或开关放行 */
  'python', 'python3',
]);

/** 输出重定向里真正写文件的形态：/dev/null（丢弃输出）与 fd 复制（2>&1）不算写 */
function redirectsToRealFile(cmd: string): boolean {
  /*
   * target 不吃 ;/&/| 等 shell 段分隔符（\S+ 贪婪会把「2>/dev/null; echo」的
   * target 连分号一起吞成 /dev/null;，豁免判定随之失效）；& 在排除类里，
   * 2>&1 形态天然不匹配。只豁免 /dev/null。
   */
  for (const m of cmd.matchAll(/(\d*)>>?\s*([^;\s&|]+)/g)) {
    if (m[2] !== '/dev/null') return true;
  }
  return false;
}

/**
 * 白名单命令的参数级写/执行排除：命令本身只读，但个别参数会让它越界
 * （sed -i 就地改写、find -exec 执行任意命令、awk 的 system()、sort -o 写文件、
 * pip/git 的非只读子命令）。
 */
function unsafeArgs(first: string, rest: string[]): string | null {
  if (first === 'sed' && rest.some((a) => /^-i/.test(a))) return 'sed 带 -i 会就地改写文件';
  if (first === 'find' && rest.some((a) => /^-(exec|execdir|delete|ok|okdir|fprint0?|fprintf|fls)$/.test(a))) {
    return 'find 的 -exec/-delete 等参数会执行命令或写文件';
  }
  if (first === 'awk' && /\bsystem\s*\(/.test(rest.join(' '))) {
    return 'awk 程序里的 system() 可以执行任意命令';
  }
  if (first === 'sort' && rest.some((a) => /^-o/.test(a))) return 'sort 带 -o 会写文件';
  /* pip/git 只放行只读子命令：install/uninstall/push/reset 等改动面照常审批 */
  if (first === 'pip' || first === 'pip3') {
    const sub = rest.find((a) => !a.startsWith('-'));
    if (!['list', 'show', 'freeze'].includes(sub ?? '')) {
      return `pip ${sub ?? '(无子命令)'} 不是只读操作（list/show/freeze 直接放行）`;
    }
  }
  if (first === 'git') {
    const sub = rest.find((a) => !a.startsWith('-'));
    if (!['status', 'log', 'diff', 'show', 'branch', 'rev-parse'].includes(sub ?? '')) {
      return `git ${sub ?? '(无子命令)'} 可能改动仓库（status/log/diff/show/branch 直接放行）`;
    }
  }
  /* python 只放行版本探测：跑脚本/-c/-m 是任意代码执行，必须审批 */
  if (first === 'python' || first === 'python3') {
    const sub = rest.filter((a) => !a.startsWith('-'));
    const flags = rest.filter((a) => a.startsWith('-') && a !== '-V' && a !== '--version');
    if (sub.length || flags.length) {
      return `python 的 ${sub[0] ?? flags[0]} 会执行任意代码（仅 -V/--version 直接放行）`;
    }
  }
  return null;
}

/*
 * 一段命令的「真实主命令」起点：剥掉 timeout <时长> 前缀（timeout 30 python3
 * x.py 的风险在 python3 不在 timeout）。返回主命令的 token 下标。
 */
function effectiveCommandIndex(toks: string[]): number {
  let i = 0;
  if (toks[i] === 'timeout') {
    i += 1;
    while (i < toks.length && /^[\d.]+[a-z]?$/i.test(toks[i])) i += 1;
  }
  return i;
}

function classifyShell(cmd: string): { safe: boolean; reason?: string; command?: string } {
  if (/`|\$\(/.test(cmd)) return { safe: false, reason: '包含命令替换（反引号或 $()），实际执行内容不可静态判定' };
  if (redirectsToRealFile(cmd)) return { safe: false, reason: '包含输出重定向，会写文件' };
  const segments = cmd.split(/&&|\|\||;|\||\n/);
  for (let i = 0; i < segments.length; i++) {
    const toks = segments[i].trim().split(/\s+/).filter((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!toks.length) continue;
    /* 剥掉 timeout 前缀后的 [主命令, 真实参数…]：参数级守卫按真实参数判 */
    const cut = effectiveCommandIndex(toks);
    const first = (toks[cut] ?? '').replace(/^["']|["']$/g, '');
    if (!first) continue;
    if (!SAFE_COMMANDS.has(first)) {
      return {
        /* command = 触发审批段的命令名：前端「会话内总是允许」按它记账，且
         * 放行判定会复查整条命令的每一段（见 builtin 的 shell 执行器） */
        command: first,
        reason: `第 ${i + 1} 段的「${first}」不在只读白名单（ls/cat/grep/jq/awk 等直接放行；rm/chmod/python3 等改动或执行类需批准）`,
      };
    }
    const bad = unsafeArgs(first, toks.slice(cut + 1));
    if (bad) return { safe: false, command: first, reason: `第 ${i + 1} 段：${bad}` };
  }
  /* command 仅在有唯一主命令时带回（供前端直通判定），多段组合回退首段 */
  const heads = segments
    .map((s) => {
      const toks = s.trim().split(/\s+/).filter(Boolean);
      return (toks[effectiveCommandIndex(toks)] ?? '').replace(/^["']|["']$/g, '');
    })
    .filter(Boolean);
  return { safe: true, command: heads[0] };
}

/** 用 /bin/bash 跑一条命令：cwd 钉在工作空间，限时 30s，输出各截 256KB */
function execShell(cmd: string): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }> {
  const root = workspaceRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return new Promise((resolvePromise) => {
    const proc = spawn('/bin/bash', ['-c', cmd], { cwd: root, env: spawnEnv() });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, 30_000);
    proc.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < 262_144) stdout += b.toString('utf-8');
    });
    proc.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < 262_144) stderr += b.toString('utf-8');
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${e}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

/*
 * agent 定位原语之一——行范围读：流式逐行取 [offset, offset+limit)，大文件
 * （外部数据根里的 GB 级 CSV）不必整读进内存。单行截 8KB（超长数据行不是
 * 精读对象）；reachedEnd 标记是否读到文件尾（提前停=后面还有内容）。
 */
function readLines(abs: string, offset: number, limit: number): Promise<{ lines: string[]; reachedEnd: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const collected: string[] = [];
    let lineno = 0;
    let reachedEnd = false;
    let earlyStop = false;
    const rl = createInterface({ input: createReadStream(abs, { encoding: 'utf-8' }), crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      /* close() 后 node 的 line 事件仍可能继续触发（流缓冲），必须显式中断收集，
       * 否则 resolve 拿到的数组引用会被继续填充——返回行数超 limit 的竞态 */
      if (earlyStop) return;
      lineno += 1;
      if (lineno >= offset) collected.push(line.length > 8192 ? `${line.slice(0, 8192)}…（单行超 8KB 已截断）` : line);
      if (collected.length >= limit) {
        earlyStop = true;
        rl.close();
      }
    });
    rl.on('close', () => {
      reachedEnd = !earlyStop;
      resolvePromise({ lines: collected, reachedEnd });
    });
    rl.on('error', rejectPromise);
  });
}

/*
 * agent 定位原语之三——数据文件画像：一次扫描给出行数/字节/列名/抽样/可选
 * 字段值分布。吃掉「wc -l + head + 手写单行统计」这类数据探查微操作（实测
 * 一次研究里 shell 探查 200+ 次里近半是这类）。csv/tsv 按分隔符切列、jsonl
 * 每行一个 JSON 对象（解析失败计 badRows 跳过）；GB 级文件流式统计，时间
 * 预算 8s（超时停止计数并标记 truncated——行数是下界，不冒充完整）。
 */
interface ProfileStats {
  distinct: number;
  /** distinct 超过收集上限（5000）时为 true：分布只列 top 20 */
  truncated: boolean;
  top: [string, number][];
}

interface ProfileResult {
  sizeBytes: number;
  rows: number;
  badRows: number;
  columns: string[];
  /** 抽样记录（每条截 500 字）：头部前几条，不是随机抽样 */
  samples: string[];
  fieldStats?: ProfileStats;
  truncated: boolean;
}

/** 单行 CSV 解析（RFC4180 引号/成对双引号转义）；返回 null = 行尾引号未闭合（跨行字段，需缓冲拼接） */
function parseCsvLine(line: string, delimiter: string): string[] | null {
  const values: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      values.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (inQuotes) return null;
  values.push(cur);
  return values;
}

const PROFILE_COLUMN_SAMPLE = 500;
const PROFILE_SAMPLE_COUNT = 3;
const PROFILE_STATS_CAP = 5000;
const PROFILE_TOP_N = 20;

function profileFile(abs: string, field?: string): Promise<ProfileResult> {
  const ext = extname(abs).toLowerCase();
  return new Promise((resolvePromise, rejectPromise) => {
    const delimiter = ext === '.tsv' ? '\t' : ',';
    const result: ProfileResult = {
      sizeBytes: statSync(abs).size,
      rows: 0,
      badRows: 0,
      columns: [],
      samples: [],
      truncated: false,
    };
    let csvBuffer: string | null = null;
    const counts = new Map<string, number>();
    const deadline = Date.now() + 8000;
    const rl = createInterface({ input: createReadStream(abs, { encoding: 'utf-8' }), crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      if (Date.now() > deadline) {
        result.truncated = true;
        rl.close();
        return;
      }
      let record: Record<string, unknown> | null = null;
      if (ext === '.jsonl') {
        try {
          const parsed = JSON.parse(line);
          record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
          if (!record) result.badRows += 1;
        } catch {
          result.badRows += 1;
        }
      } else {
        /*
         * csv：RFC4180 引号状态机——引号内的分隔符/换行/成对双引号都是字段
         * 内容，跨行字段靠缓冲拼接（parseCsvLine 返回 null 表示引号未闭合）。
         * tsv 没有引号转义语义，直接按分隔符切。
         */
        csvBuffer = csvBuffer === null ? line : `${csvBuffer}\n${line}`;
        const values = ext === '.csv' ? parseCsvLine(csvBuffer, delimiter) : csvBuffer.split(delimiter);
        if (values === null) return; /* 跨行字段：继续缓冲下一物理行 */
        csvBuffer = null;
        /* csv/tsv：第一行当表头，之后每行按列位置映射成记录 */
        if (result.columns.length === 0) {
          if (line.trim()) result.columns = values.map((c) => c.trim());
          return;
        }
        record = Object.fromEntries(result.columns.map((c, i) => [c, values[i] ?? '']));
      }
      if (!record) return;
      result.rows += 1;
      if (result.rows <= PROFILE_COLUMN_SAMPLE) {
        for (const k of Object.keys(record)) if (!result.columns.includes(k)) result.columns.push(k);
        if (result.rows <= PROFILE_SAMPLE_COUNT) {
          const s = JSON.stringify(record);
          result.samples.push(s.length > 500 ? `${s.slice(0, 500)}…` : s);
        }
      }
      if (field !== undefined && field !== '' && field in record) {
        const v = String(record[field]);
        if (counts.size < PROFILE_STATS_CAP || counts.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    });
    rl.on('close', () => {
      if (field !== undefined && field !== '') {
        result.fieldStats = {
          distinct: counts.size,
          truncated: counts.size >= PROFILE_STATS_CAP,
          top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, PROFILE_TOP_N),
        };
      }
      resolvePromise(result);
    });
    rl.on('error', rejectPromise);
  });
}

/*
 * agent 定位原语之二——递归正则搜索。返回「相对路径:行号:该行内容（截
 * 300 字）」。跳过 .git/node_modules 等目录与二进制文件（前 4KB 含 NUL）；
 * 单文件流式逐行 match，GB 级数据文件也能搜。时间预算 8s + 文件数上限
 * 3000 + 命中数上限 maxResults，任一触顶即停并标记 truncated（提示缩小
 * path 收紧 pattern，而不是静默给一份「看似完整」的结果）。
 */
const GREP_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.locks', '.vite', '.ruff_cache', '.pytest_cache']);

function looksBinary(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function grepFiles(
  re: RegExp,
  baseRoot: string,
  relPath: string,
  maxResults: number,
  state: { matches: string[]; scanned: number; truncated: boolean; deadline: number },
): Promise<void> {
  if (state.matches.length >= maxResults || state.truncated) return;
  const abs = join(baseRoot, relPath);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    if (GREP_SKIP_DIRS.has(relPath.split(sep).pop() ?? '')) return;
    for (const name of readdirSync(abs)) {
      if (state.scanned >= 3000 || Date.now() > state.deadline) {
        state.truncated = true;
        return;
      }
      await grepFiles(re, baseRoot, join(relPath, name), maxResults, state);
      if (state.matches.length >= maxResults) {
        state.truncated = true;
        return;
      }
    }
    return;
  }
  state.scanned += 1;
  if (Date.now() > state.deadline || looksBinary(abs)) {
    if (Date.now() > state.deadline) state.truncated = true;
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const rl = createInterface({ input: createReadStream(abs, { encoding: 'utf-8' }), crlfDelay: Infinity });
    let lineno = 0;
    let stop = false;
    rl.on('line', (line: string) => {
      if (stop) return;
      lineno += 1;
      if (re.test(line)) {
        state.matches.push(`${relPath.split(sep).join('/')}:${lineno}:${line.length > 300 ? `${line.slice(0, 300)}…` : line}`);
        if (state.matches.length >= maxResults) {
          stop = true;
          state.truncated = true;
          rl.close();
        }
      }
    });
    rl.on('close', () => resolvePromise());
    rl.on('error', () => resolvePromise());
  });
}

async function readJsonBody(req: { on?: any; }): Promise<any> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve());
    req.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

/*
 * 特殊 token 字面量消毒（仅请求侧、模型无关）：训练数据/轨迹里常内嵌
 * 各家模型的协议保留串——Qwen/ChatML 的 <|im_end|>（ASCII 竖线）、
 * DeepSeek 的 <｜end▁of▁sentence｜> 与 <｜DSML｜invoke ...>（全角竖线、
 * 含无右闭合的开标签形态）。一旦被读进对话历史，上游 tokenizer 的安全
 * 检查会拒绝编码整个请求（报 "Disallowed special token found"），该会话
 * 从此每次发送都失败，且报错只指上游、不指哪条消息带毒。
 *
 * 通用做法不是枚举各家 token 表，而是破坏「竖线前缀」这一共同形态：
 * tokenizer 对 special token 做完整串匹配，凡 <| / <｜ 开头的串在 '<'
 * 后插一个零宽空格即不可能再命中——与后续内容、长度、闭合与否无关。
 * 正常文本里 <| 序列不存在于任何主流语法（markdown 表格的 | 不带 <，
 * shell 重定向是 << 与 <(），误伤面可忽略；Gemma 系 <start_of_turn> 的
 * 下划线形态与 HTML 标签无法区分，刻意不碰。消毒发生时打一行日志，
 * 事后在 dev 日志可查是哪个请求带毒。
 */
const SPECIAL_TOKEN_RE = /<[|｜]/g;
function sanitizeSpecialTokens(body: { messages?: unknown[] }): number {
  let count = 0;
  const scrub = (s: string) =>
    s.replace(SPECIAL_TOKEN_RE, (m) => {
      count += 1;
      return `<\u200b${m.slice(1)}`;
    });
  for (const msg of body.messages ?? []) {
    const m = msg as { content?: unknown; tool_calls?: Array<{ function?: { arguments?: unknown } }> };
    /* content 两种形态：纯文本串，或多模态 parts 数组里的 text 项 */
    if (typeof m.content === 'string') m.content = scrub(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        const p = part as { text?: unknown };
        if (p && typeof p.text === 'string') p.text = scrub(p.text);
      }
    }
    /*
     * assistant 工具调用的参数是 JSON 字符串，上游同样会经 chat template
     * 拼进 prompt 编码——模型把带毒数据片段写进工具参数时会从这里漏出去
     * （症状：换任何模型都报 Disallowed special token）。
     */
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const fn = call?.function;
        if (fn && typeof fn.arguments === 'string') fn.arguments = scrub(fn.arguments);
      }
    }
  }
  return count;
}

/**
 * 部署任务执行器（webui 侧）。
 *
 * 每个部署 = 一个 `python -m swift.dev.cli.deploy` 子进程（ATTACHED 模式，刻意 不用
 * --detach）：进程由本服务持有，停止=SIGTERM（driver 收到信号优雅关停 Serve 与 进程内
 * Ray 集群）。多部署各是独立进程内集群，天然各占一个端口、路径都是标准 /v1。
 * 任务表在内存里——attached 部署的生命周期与本服务一致，无需落盘状态机。
 * 就绪后自动把 endpoint 登记进 ~/.swift/models.json（对话页/模型页立即可用），
 * 停止或失败时摘除。
 */
interface DeployTask {
  id: string;
  /** 对外模型名（--served_model_name，也是 models.json 里的登记名） */
  servedName: string;
  /** 用户改的显示名（重命名）；不设时列表用 servedName */
  name?: string;
  model: string;
  engine: string;
  port: number;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  pid?: number;
  startedAt: string;
  /** 环形日志（截尾保留最近 500 行） */
  log: string[];
  registered: boolean;
  /** 指定使用的 GPU 卡号（本机模式，CUDA_VISIBLE_DEVICES）；undefined = 不限制 */
  gpus?: number[];
  /** 集群模式的卡数（远端资源只声明数量，与 gpus 互斥） */
  gpuCount?: number;
  /** 插件来源（--external_plugins），登记于 plugins.json */
  plugins?: string[];
  /** LoRA adapter（--adapters）：训练产出的 checkpoint 目录，支持 name=path 形态 */
  adapters?: string[];
  /** 「将要执行」直写的附加参数原文（spawn 时 tokenize 追加） */
  extraArgs?: string;
}

const deployTasks = new Map<string, DeployTask & { proc?: ChildProcess }>();

function pushLog(task: DeployTask & { proc?: ChildProcess }, line: string): void {
  pushTaskLog(task, line);
}

function pickFreePort(from: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number): void => {
      const srv = createServer();
      srv.once('error', () => srv.close(() => tryPort(p + 1)));
      srv.listen(p, '0.0.0.0', () => srv.close(() => resolve(p)));
    };
    tryPort(from);
    setTimeout(() => reject(new Error('no free port')), 8000);
  });
}

/*
 * 就绪探测用一次最小 chat 而非 /v1/models：Ray Serve 网关先于 sampler 就绪，
 * /v1/models 在引擎仍在初始化（甚至初始化失败重试中）时就会 200——用它会把
 * 不可用的部署标成 running。真实发一条 max_tokens=1 的请求是唯一能穿透
 * sampler 的判据（网关的 deep healthz 端点对 sampler 部署恒 503，不可用）。
 * 未就绪时 Serve 拒绝该请求（503/超时），就绪后 200——一条 1-token 生成的
 * 开销可以忽略，失败也无副作用（下一轮重试）。
 */
async function waitUntilReady(task: DeployTask & { proc?: ChildProcess }): Promise<void> {
  const url = `http://127.0.0.1:${task.port}/v1/chat/completions`;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline && task.status === 'starting') {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: task.servedName,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        /* fetch 在飞时进程可能已退出并判了终态（failed/stopped）——不再覆盖 */
        if (task.status !== 'starting') return;
        task.status = 'running';
        registerDeployedModel(task);
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** 把部署登记进 models.json：对话页下拉与模型管理页立即可见 */
function registerDeployedModel(task: DeployTask): void {
  try {
    const models = loadModels().filter((m) => m.id !== task.servedName);
    models.push({
      id: task.servedName,
      baseUrl: `http://127.0.0.1:${task.port}/v1`,
      apiKey: '',
      model: task.servedName,
      note: 'swift 部署',
    });
    saveModels(models);
    task.registered = true;
  } catch (e) {
    pushLog(task, `[webui] failed to register model: ${e}`);
  }
}

function unregisterDeployedModel(task: DeployTask): void {
  if (!task.registered) return;
  try {
    saveModels(loadModels().filter((m) => m.id !== task.servedName));
    task.registered = false;
  } catch {
    /* best effort */
  }
}

function publicTask(t: DeployTask & { proc?: ChildProcess }) {
  return publicOf(t);
}

/*
 * 评测任务执行器：一个任务 = 被测模型（models.json 条目）× 若干评测集，
 * 逐集串行跑 `swift eval --eval_url <端点> --eval_dataset <集>` 子进程。
 * 每集独立子进程的原因：EvalScope 的 limit 是 TaskConfig 级全局值，
 * 「每个评测集各评一部分」只能拆成独立调用各带 --eval_limit。
 * 报告逐集 append 进 resultJsonl，任务完成后读回交给前端展示。
 */
interface EvalItem {
  dataset: string;
  /** 只评前 N 条；undefined = 全量 */
  limit?: number;
  /** 逐集 dataset_args（subset_list 版本透传等）：JSON 序列化进 --eval_dataset_args */
  datasetArgs?: Record<string, unknown>;
}

interface EvalTask {
  id: string;
  /** models.json 条目 id（被测模型名） */
  modelId: string;
  /** 用户改的显示名（重命名）；不设时列表用「模型 · 评测集摘要」拼接 */
  name?: string;
  /** 服务端真实模型名（请求体 model 字段） */
  model: string;
  baseUrl: string;
  items: EvalItem[];
  /** 正在跑第几个（0 起；进度 = current+1 / items.length） */
  current: number;
  status: 'starting' | 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  /** 环形日志（截尾保留最近 500 行） */
  log: string[];
  outputDir: string;
  resultJsonl: string;
  /** 完成后从 resultJsonl 读回的逐集报告行 */
  report?: { dataset: string; rows: unknown[] }[];
  /*
   * 本地直评模式（autoresearch watcher / agent 用）：--model 底座 +
   * --adapters checkpoint 直接评，不起服务不占端口。设了它就不走
   * eval_url/api key 路径。
   */
  local?: { model: string; adapters?: string[]; gpus?: number[] };
  /** 插件来源（--external_plugins），登记于 plugins.json */
  plugins?: string[];
  /** 「将要执行」直写的附加参数原文（逐集 spawn 时 tokenize 追加） */
  extraArgs?: string;
  proc?: ChildProcess;
}

const evalTasks = new Map<string, EvalTask>();

function pushEvalLog(task: EvalTask, line: string): void {
  pushTaskLog(task, line);
}

/**
 * 读回 resultJsonl 的逐集报告：每行一个 {Native: [row], ...} 记录（每个评测集
 * 一行追加）。集名取行内 Native[0].dataset_name——顶层没有 dataset 字段，按
 * items 下标配对会在失败集缺行时错位。
 */
function readEvalReport(file: string): { dataset: string; rows: unknown[] }[] {
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const rec = JSON.parse(l) as { Native?: Array<{ dataset_name?: string }> };
        const rows = rec.Native ?? [];
        return { dataset: rows[0]?.dataset_name ?? '', rows };
      })
      .filter((r) => r.dataset);
  } catch {
    return [];
  }
}

function publicEvalTask(t: EvalTask) {
  return publicOf(t);
}

/**
 * EvalScope 的数据集注册表（207 个基准）：spawn 一次 python 导出 JSON，
 * 结果缓存在模块变量里——注册表随安装版本固定，不需要每请求重探。
 */
let evalDatasetsCache: { name: string; prettyName: string; tags: string[]; metrics: string[] }[] | null = null;

function listEvalDatasets(): Promise<{ name: string; prettyName: string; tags: string[]; metrics: string[] }[]> {
  if (evalDatasetsCache) return Promise.resolve(evalDatasetsCache);
  return new Promise((resolvePromise, rejectPromise) => {
    const script =
      'import json\n' +
      'from evalscope.api.registry import BENCHMARK_REGISTRY\n' +
      'out = []\n' +
      'for name, meta in sorted(BENCHMARK_REGISTRY.items()):\n' +
      "    out.append({'name': name, 'prettyName': getattr(meta, 'pretty_name', None) or name," +
      " 'tags': list(getattr(meta, 'tags', None) or []), 'metrics': [m.get('name', '') if isinstance(m, dict) else str(m)" +
      ' for m in (getattr(meta, "metric_list", None) or [])]})\n' +
      'print(json.dumps(out))';
    const proc = spawn(resolvePython(), ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    proc.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf-8');
    });
    proc.on('error', (e) => rejectPromise(e));
    proc.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`evalscope registry 探测失败 (exit ${code}): ${err.slice(0, 300)}`));
        return;
      }
      try {
        evalDatasetsCache = JSON.parse(out.trim().split('\n').pop() ?? '[]');
        resolvePromise(evalDatasetsCache);
      } catch (e) {
        rejectPromise(e);
      }
    });
  });
}

/**
 * 评测链：逐集串行 spawn。失败即停（后续集不再跑，已完成集的报告仍在）；
 * 停止（DELETE）杀当前子进程并中止链条。所有集跑完读回报告。
 */
async function runEvalChain(task: EvalTask): Promise<void> {
  task.status = 'running';
  /* 本地直评模式不走 models.json（无 key、无 url）；api 模式照旧 */
  const apiKey = task.local ? undefined : loadModels().find((m) => m.id === task.modelId)?.apiKey;
  for (let i = 0; i < task.items.length; i++) {
    if (task.status !== 'running') return;
    const item = task.items[i];
    task.current = i;
    const model = task.local ? task.local.model : task.model;
    const args = [
      '-m', 'swift.dev.cli.eval',
      '--model', model,
      ...(task.local?.adapters?.length ? ['--adapters', ...task.local.adapters] : []),
      ...(task.local ? [] : ['--eval_url', task.baseUrl]),
      '--eval_dataset', item.dataset,
      ...(item.datasetArgs ? ['--eval_dataset_args', JSON.stringify(item.datasetArgs)] : []),
      '--eval_output_dir', task.outputDir,
      '--result_jsonl', task.resultJsonl,
      ...(task.plugins?.length ? ['--external_plugins', ...task.plugins] : []),
      ...(item.limit ? ['--eval_limit', String(item.limit)] : []),
      ...(task.local || !apiKey ? [] : ['--eval_api_key', apiKey]),
      ...splitExtraArgs(task.extraArgs ?? ''),
    ];
    pushEvalLog(
      task,
      `$ [${item.dataset}] ${resolvePython()} -m swift.dev.cli.eval --model ${model}` +
        `${task.local?.adapters?.length ? ` --adapters ${task.local.adapters.join(' ')}` : ''}` +
        `${task.local ? '' : ` --eval_url ${task.baseUrl}`} --eval_dataset ${item.dataset}${item.limit ? ` --eval_limit ${item.limit}` : ''}${item.datasetArgs ? ` --eval_dataset_args ${JSON.stringify(item.datasetArgs)}` : ''}`,
    );
    const code = await new Promise<number>((resolvePromise) => {
      const proc = spawn(resolvePython(), args, {
        env: {
          ...spawnEnv(),
          USE_SWIFT_V5: '1',
          ...(task.local?.gpus?.length ? { CUDA_VISIBLE_DEVICES: task.local.gpus.join(',') } : {}),
        },
        cwd: taskCwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      task.proc = proc;
      const onChunk = (buf: Buffer) =>
        buf.toString('utf-8').split('\n').filter(Boolean).forEach((l) => pushEvalLog(task, l));
      proc.stdout?.on('data', onChunk);
      proc.stderr?.on('data', onChunk);
      proc.on('error', (e) => {
        pushEvalLog(task, `[webui] eval spawn 失败: ${e}`);
        resolvePromise(-1);
      });
      proc.on('exit', (c) => resolvePromise(c ?? -1));
    });
    task.proc = undefined;
    if (task.status !== 'running') break; /* 被停止：exit 来自 kill，不再推进 */
    if (code !== 0) {
      pushEvalLog(task, `[webui] ${item.dataset} 评测失败 (exit ${code})，后续评测集不再执行`);
      task.status = 'failed';
      break;
    }
    pushEvalLog(task, `[webui] ${item.dataset} 完成`);
  }
  /* 停止可能发生在最后一集退出与这里之间——不覆盖已判定的终态 */
  if (task.status === 'running') task.status = 'done';
  /* 已产出集的报告对任何终态都读回（含失败/停止前完成的部分） */
  task.report = readEvalReport(task.resultJsonl);
  const { proc: _proc, log: _log, ...evalSnapshot } = task;
  recordHistory('eval', evalSnapshot as Record<string, unknown>);
}

/*
 * 导出任务：一次 swift export 子进程（LoRA 合并 / 量化 / 推送 Hub 的组合）。
 * 与部署/评测同构的 attached 生命周期：webui 持有子进程，停止 = SIGTERM；
 * 导出是有限作业，exit 0 即 done，产物目录浅层扫描进 artifacts 供详情页展示。
 */
interface ExportTask {
  id: string;
  /** 用户改的显示名（重命名）；不设时列表用「源 → 操作摘要」拼接 */
  name?: string;
  /** 底座模型（hub id 或本地路径） */
  model: string;
  /** LoRA adapter（训练 checkpoint 目录）；mergeLora 时必填 */
  adapters?: string;
  mergeLora: boolean;
  /** awq / gptq / bnb；位宽跟着方法走（awq|gptq=int4, bnb=int8） */
  quantMethod?: 'awq' | 'gptq' | 'bnb';
  /** awq / gptq 的校准数据集（CLI 校验必填） */
  calibDataset?: string;
  pushToHub: boolean;
  hubModelId?: string;
  outputDir: string;
  /** 指定使用的 GPU 卡号（CUDA_VISIBLE_DEVICES）；undefined = 不限制（默认卡 0） */
  gpus?: number[];
  /** 插件来源（--external_plugins），登记于 plugins.json */
  plugins?: string[];
  /** 「将要执行」直写的附加参数原文（spawn 时 tokenize 追加） */
  extraArgs?: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  /** 环形日志（截尾保留最近 500 行） */
  log: string[];
  /** 完成后对 outputDir 的浅层扫描（文件名 + 字节数） */
  artifacts?: { name: string; size: number }[];
  proc?: ChildProcess;
}

const exportTasks = new Map<string, ExportTask>();

function pushExportLog(task: ExportTask, line: string): void {
  pushTaskLog(task, line);
}

function publicExportTask(t: ExportTask) {
  return publicOf(t);
}

/** 与任务执行器 spawn 的参数一致——详情页「创建命令」按同一逻辑拼装 */
function exportArgs(task: ExportTask): string[] {
  const bits = task.quantMethod === 'bnb' ? 8 : 4;
  return [
    '-m', 'swift.dev.cli.export',
    '--model', task.model,
    ...(task.adapters ? ['--adapters', task.adapters] : []),
    ...(task.mergeLora ? ['--merge_lora', 'true'] : []),
    ...(task.quantMethod
      ? ['--quant_method', task.quantMethod, '--quant_bits', String(bits)]
      : []),
    ...(task.quantMethod === 'awq' || task.quantMethod === 'gptq'
      ? ['--dataset', task.calibDataset ?? '']
      : []),
    ...(task.pushToHub ? ['--push_to_hub', 'true'] : []),
    ...(task.pushToHub && task.hubModelId ? ['--hub_model_id', task.hubModelId] : []),
    ...(task.plugins?.length ? ['--external_plugins', ...task.plugins] : []),
    ...splitExtraArgs(task.extraArgs ?? ''),
    '--output_dir', task.outputDir,
  ];
}

function runExportTask(task: ExportTask): void {
  task.status = 'running';
  const args = exportArgs(task);
  pushExportLog(task, `$ ${resolvePython()} ${args.join(' ')}`);
  const proc = spawn(resolvePython(), args, {
    cwd: taskCwd(),
    env: {
      ...spawnEnv(),
      USE_SWIFT_V5: '1',
      /* 量化/合并是 GPU 作业：选了卡就限住，避免落在被占的默认卡 0 上 */
      ...(task.gpus?.length ? { CUDA_VISIBLE_DEVICES: task.gpus.join(',') } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  task.proc = proc;
  const onChunk = (buf: Buffer) =>
    buf.toString('utf-8').split('\n').filter(Boolean).forEach((l) => pushExportLog(task, l));
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);
  proc.on('error', (e) => pushExportLog(task, `[webui] export spawn 失败: ${e}`));
  proc.on('exit', (code) => {
    task.proc = undefined;
    /* 停止（SIGTERM）触发的退出不算失败 */
    if (task.status !== 'running') {
      const { proc: _p, log: _l, ...earlySnapshot } = task;
      recordHistory('export', earlySnapshot as Record<string, unknown>);
      return;
    }
    if (code === 0) {
      task.status = 'done';
      pushExportLog(task, '[webui] 导出完成');
      try {
        task.artifacts = readdirSync(task.outputDir)
          .filter((f) => f !== 'output.log')
          .map((f) => {
            const st = statSync(join(task.outputDir, f));
            return { name: f, size: st.isFile() ? st.size : 0 };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        /* 输出目录不存在或不可读：产物列表留空，日志已有错误详情 */
      }
    } else {
      task.status = 'failed';
      pushExportLog(task, `[webui] 导出失败 (exit ${code ?? -1})`);
    }
    const { proc: _proc, log: _log, ...exportSnapshot } = task;
    recordHistory('export', exportSnapshot as Record<string, unknown>);
  });
}

/*
 * 训练任务：一次 `swift sft` 子进程（USE_SWIFT_V5 路由到 dev 侧）。
 * 表单的核心字段结构化（model/datasets/tuner/plugins/选卡），其余训练旋钮
 * 以 params KV 自由携带（key 即 CLI flag 名）——后端不需要为每个超参建字段，
 * 「重要参数」与「附加参数」的取舍由前端表单决定。完整 spawn 参数在创建时
 * 拼好存进 args：spawn 与详情页创建命令永远同源。
 */
interface TrainMetric {
  step: number;
  loss?: number;
  lr?: number;
  gradNorm?: number;
  epoch?: number;
  /* 算法专有指标（reward、rewards/margins 等）：key 与日志行里的指标名同文 */
  extra?: Record<string, number>;
}

interface TrainTask {
  id: string;
  /** 用户改的显示名（重命名）；不设时列表用「模型 · tuner · 数据集摘要」拼接 */
  name?: string;
  /* 收编任务没有子进程句柄，只有记下的 pid */
  pid?: number;
  /*
   * v5 训练命令面只有三个命令：sft / pt / rl。dpo、grpo、gkd、opsd 等
   * 全部是 `swift rl --rl_type <t>` 的算法变体（RLConfig.rl_type 的 12 值
   * Literal），不是独立命令——模块名由它拼出 swift.dev.cli.<taskType>。
   * 'code' 是第四种形态：用户直接写 Python（swift.dev 原生 API），整份
   * 代码落盘 workspace/train-code/<id>.py 后由解释器执行（POST mode='code'）。
   */
  taskType: 'sft' | 'pt' | 'rl' | 'code';
  model: string;
  datasets: string[];
  valDatasets?: string[];
  tuner: 'full' | 'lora' | 'trainable_tokens';
  /** 插件来源（external_plugins），登记于 plugins.json */
  plugins: string[];
  /** 本机选卡（CUDA_VISIBLE_DEVICES） */
  gpus?: number[];
  /** 集群卡数（--nproc_per_node） */
  gpuCount?: number;
  /** 表单训练旋钮（key = CLI flag 名，value 为标量） */
  params: Record<string, string | number | boolean>;
  /*
   * 关注指标（创建页按任务类型预选、可增删）：详情/对比页按它决定画哪几张
   * 曲线。不进 params——params 的 key 是 CLI flag 名，会拼进 spawn 命令行。
   */
  watchMetrics?: string[];
  /** 「将要执行」里用户直写的附加参数，原样 tokenize 后追加 */
  extraArgs?: string;
  outputDir: string;
  /** 创建时拼好的完整 spawn 参数——spawn 与 createCommand 同源 */
  args: string[];
  /** 续跑血缘：从哪个任务的 checkpoint 恢复（一键续跑/研究迭代传入） */
  parentTaskId?: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  /** 环形日志（截尾保留最近 500 行） */
  log: string[];
  /** 从训练日志解析的进度（tqdm 帧）与指标（loss 行） */
  step?: number;
  totalSteps?: number;
  metrics: TrainMetric[];
  proc?: ChildProcess;
}

const trainTasks = new Map<string, TrainTask>();

/*
 * 结构化指标源（<output_dir>/metrics.jsonl，训练侧 StepState 逐 logging 步
 * 追加）：webui 优先读它，日志解析作回落——旧任务/未升训练侧时曲线照常。
 * mtime 缓存避免每次轮询全量读文件；收编任务重启后曲线也由此恢复。
 */
const metricsFileMtime = new Map<string, number>();

function syncTrainMetricsFile(task: TrainTask): void {
  const file = join(task.outputDir, 'metrics.jsonl');
  try {
    const st = statSync(file);
    if (metricsFileMtime.get(task.id) === st.mtimeMs) return;
    metricsFileMtime.set(task.id, st.mtimeMs);
    const metrics: TrainMetric[] = [];
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const step = Number(r.step);
        const loss = Number(r.loss);
        if (!Number.isInteger(step) || !Number.isFinite(loss)) continue;
        /* lr 形态两种：CLI 侧 'learning rate'（含多 param group 变体）与 runtime 侧 lr */
        let lr: number | undefined;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'lr' || k.startsWith('learning rate')) {
            const n = Number(v);
            if (Number.isFinite(n)) {
              lr = n;
              break;
            }
          }
        }
        const gradNorm = Number(r.grad_norm);
        const totalSteps = Number(r.total_steps);
        /* 其余数值键全收进 extra（reward、rewards/margins 等，与日志解析同口径） */
        const extra: Record<string, number> = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === 'step' || k === 'loss' || k === 'grad_norm' || k === 'lr' || k === 'epoch' || k === 'total_steps' || k.startsWith('learning rate')) continue;
          const n = Number(v);
          if (Number.isFinite(n)) extra[k] = n;
        }
        metrics.push({
          step,
          loss,
          ...(Number.isFinite(gradNorm) ? { gradNorm } : {}),
          ...(lr !== undefined ? { lr } : {}),
          ...(Object.keys(extra).length ? { extra } : {}),
        });
        if (Number.isFinite(totalSteps) && totalSteps > 0) task.totalSteps = totalSteps;
      } catch {
        /* 坏行跳过，不连坐 */
      }
    }
    if (metrics.length) {
      task.metrics = metrics.slice(-500);
      task.step = metrics[metrics.length - 1].step;
    }
  } catch {
    /* 无文件：保持日志解析路径 */
  }
}

function pushTrainLog(task: TrainTask, line: string): void {
  /* 落盘日志：重启收编后 read_train_log 仍可读（与脚本任务同一约定） */
  pushTaskLog(task, line, (l) => appendFileSync(join(dirname(task.outputDir), 'output.log'), `${l}\n`));
  /*
   * 训练日志的权威进度行是 swift.dev 自己打的 logger 行：
   *   [INFO:swift.dev] step 3  loss=2.2546  lr=5.000000e-05  grad_norm=11.3125  reward=0.0312
   * （可兼容 step 3/100 带总数形态；行内还可能出现算法专有指标，如 DPO 的
   * rewards/margins=0.8541、rewards/accuracies=85.0%）。不能解析 tqdm 帧——训练
   * 日志里混着 `Loading weights: 100%|…| 290/290` 这类加载条，会被当成训练进度。
   *
   * 解析分两层：步号/loss/grad_norm/lr 走固定字段（与历史前端契约兼容），
   * 其余 key=value 全量收进 extra——每算法的头部收敛信号（reward、margins 等）
   * 由训练侧日志行声明，前端不维护算法名单；以后训练行多打一个 key 即自动上图。
   */
  const m = line.match(/step (\d+)(?:\/(\d+))?/);
  if (m && line.includes('swift.dev')) {
    task.step = Number(m[1]);
    if (m[2]) task.totalSteps = Number(m[2]);
    /* max_steps 显式设定时总步数就是它（epoch 模式下日志无总数，进度条不显示百 分比） */
    if (!task.totalSteps && typeof task.params.max_steps === 'number' && task.params.max_steps > 0) {
      task.totalSteps = task.params.max_steps;
    }
    /* 行内任意 key=value：key 容忍斜杠/下划线/字母数字；值容忍科学计数、百分比（85.0%）。 */
    const extra: Record<string, number> = {};
    const kv = /([A-Za-z_][\w/.\-]*)=([\d.]+(?:[eE][+-]?\d+)?)%?/g;
    let loss: number | undefined;
    let gradNorm: number | undefined;
    let lr: number | undefined;
    for (const pair of line.matchAll(kv)) {
      const key = pair[1];
      const value = Number(pair[2]);
      if (!Number.isFinite(value)) continue; /* NaN/Infinity 不上图 */
      if (key === 'loss') loss = value;
      else if (key === 'grad_norm') gradNorm = value;
      else if (key === 'lr') lr = value;
      else extra[key] = value;
    }
    if (loss !== undefined) {
      task.metrics.push({
        step: Number(m[1]),
        loss,
        ...(gradNorm !== undefined ? { gradNorm } : {}),
        ...(lr !== undefined ? { lr } : {}),
        ...(Object.keys(extra).length ? { extra } : {}),
      });
      if (task.metrics.length > 500) task.metrics.splice(0, task.metrics.length - 500);
    }
  }
}

function publicTrainTask(t: TrainTask) {
  return publicOf(t);
}

/*
 * ckpt 血缘（~/.swift/train/<id>/lineage.json，webui 独占写）：创建时记来源
 * （底座/数据集/旋钮/父任务），终态时补产出 checkpoint 清单。agent 经
 * list_checkpoints 读它——「这个 ckpt 从哪来、能不能续」不靠翻目录猜。
 */
function trainLineageFile(outputDir: string): string {
  return join(dirname(outputDir), 'lineage.json');
}

/*
 * 数据集指纹：hub id 只记名字；本地文件（绝对/相对路径）补字节数与 mtime——
 * 弱指纹但廉价（全量 hash 对大数据集太贵），足够回答「数据后来有没有被改过」。
 */
function datasetEntry(name: string): { name: string; bytes?: number; mtimeMs?: number } {
  const entry: { name: string; bytes?: number; mtimeMs?: number } = { name };
  try {
    const p = name.startsWith('/') ? name : join(taskCwd(), name);
    const st = statSync(p);
    if (st.isFile()) {
      entry.bytes = st.size;
      entry.mtimeMs = st.mtimeMs;
    }
  } catch {
    /* hub id 或不存在的路径：只记名字 */
  }
  return entry;
}

function writeTrainLineage(task: TrainTask): void {
  const remote = task.params.mode === 'remote';
  const checkpoints = listTrainCheckpoints(task.outputDir).map((c) => ({
    name: c.name,
    path: join(task.outputDir, c.name),
    mtimeMs: c.mtimeMs,
    ...(remote ? { remote: true } : {}),
  }));
  const versions = probeStackVersions();
  const lineage = {
    taskId: task.id,
    taskType: task.taskType,
    model: task.model,
    datasets: task.datasets.map(datasetEntry),
    ...(task.valDatasets?.length ? { valDatasets: task.valDatasets.map(datasetEntry) } : {}),
    tuner: task.tuner,
    params: task.params,
    status: task.status,
    startedAt: task.startedAt,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(versions.swift ? { swiftVersion: versions.swift } : {}),
    ...(versions.twinkle ? { twinkleVersion: versions.twinkle } : {}),
    ...(remote ? { remote: { serverBaseUrl: String(task.params.server_base_url ?? '') } } : {}),
    checkpoints,
    updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  try {
    const dir = dirname(trainLineageFile(task.outputDir));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${trainLineageFile(task.outputDir)}.tmp`;
    writeFileSync(tmp, JSON.stringify(lineage, null, 2));
    renameSync(tmp, trainLineageFile(task.outputDir));
  } catch {
    /* 血缘写失败不影响任务本体 */
  }
  /* 终态同时进历史索引（log/metrics 不带：重启后从 output.log/metrics.jsonl 恢复） */
  if (task.status !== 'running') {
    const { log: _log, metrics: _metrics, proc: _proc, ...snapshot } = task;
    recordHistory('train', snapshot as Record<string, unknown>);
  }
}

/*
 * 训练执行器的属地 flag：buildTrainArgs 自己拼这些键（--model/--dataset/--tuner/
 * --output_dir 等），研究快照的 params 若再带同名键会拼出双份 argv，parser 以
 * 冲突 ValueError 拒收（表现为训练四连败同一根因）。trainConfig.params 只存
 * 旋钮，属地键在 PATCH 收口与快照收口处一律剥掉。
 */
const TRAIN_OWNED_KEYS = new Set([
  /* 与 src/agent/researchTools.ts 的同名集合必须同步改（前后端无法共享 import，
   * 漏一边属地键防御就静默失效）；这里覆盖 train/export 两类执行器 */
  'model', 'dataset', 'val_dataset', 'tuner', 'external_plugins', 'nproc_per_node', 'output_dir',
]);

/** 把任务字段拼成完整 spawn 参数；trainArgs 是 args 的唯一来源（创建时调用一次） */
function buildTrainArgs(task: Omit<TrainTask, 'args' | 'status' | 'startedAt' | 'log' | 'metrics'>): string[] {
  const nproc = task.gpus?.length ?? task.gpuCount ?? 0;
  return [
    '-m', `swift.dev.cli.${task.taskType}`,
    '--model', task.model,
    '--dataset', ...task.datasets,
    ...(task.valDatasets?.length ? ['--val_dataset', ...task.valDatasets] : []),
    '--tuner', task.tuner,
    ...(task.plugins.length ? ['--external_plugins', ...task.plugins] : []),
    ...(nproc > 1 ? ['--nproc_per_node', String(nproc)] : []),
    /*
     * params 的 key 就是 CLI flag 名；空串与显式 false 不产生 flag（用默认值）。
     * 值里带空格 = List[str] 型 flag 的多值（如 --teacher_model A B，前端把
     * 多个教师以空格 join 进一个 string）——拆成多个 argv 交给 HfArgumentParser
     * 的 nargs 解析；标量 flag 的值本来就不该含空格，含了也是错的。
     */
    ...Object.entries(task.params).flatMap(([k, v]) => {
      if (v === '' || v === false) return [];
      const parts = String(v).split(/\s+/).filter(Boolean);
      return ['--' + k, ...parts];
    }),
    ...splitExtraArgs(task.extraArgs ?? ''),
    '--output_dir', task.outputDir,
  ];
}

function runTrainTask(task: TrainTask): void {
  task.status = 'running';
  pushTrainLog(task, `$ ${resolvePython()} ${task.args.join(' ')}`);
  const proc = spawn(resolvePython(), task.args, {
    cwd: taskCwd(),
    env: {
      ...spawnEnv(),
      USE_SWIFT_V5: '1',
      ...(task.gpus?.length ? { CUDA_VISIBLE_DEVICES: task.gpus.join(',') } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  task.proc = proc;
  /* tqdm 的进度帧用 \r 分隔（同「行」粘多帧），先拆 \r 再拆 \n，日志取全量帧 */
  const onChunk = (buf: Buffer) =>
    buf
      .toString('utf-8')
      .split('\n')
      .flatMap((l) => l.split('\r'))
      .filter(Boolean)
      .forEach((l) => pushTrainLog(task, l));
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);
  proc.on('error', (e) => pushTrainLog(task, `[webui] train spawn 失败: ${e}`));
  proc.on('exit', (code) => {
    task.proc = undefined;
    /*
     * 退出码先落盘再翻转状态（脚本任务同一约定）：webui 若在这两步之间
     * 重启，收编/探活读 exit_code 判终态，不依赖本回调跑完。
     */
    try {
      writeFileSync(join(dirname(task.outputDir), 'exit_code'), `${code ?? -1}\n`);
    } catch {
      /* 落盘失败不影响内存态收尾 */
    }
    /* 停止（SIGTERM）触发的退出不算失败 */
    if (task.status !== 'running') {
      writeTrainLineage(task);
      return;
    }
    if (code === 0) {
      task.status = 'done';
      pushTrainLog(task, '[webui] 训练完成');
    } else {
      task.status = 'failed';
      pushTrainLog(task, `[webui] 训练失败 (exit ${code ?? -1})`);
    }
    /* 终态补产出 checkpoint 清单进血缘（续跑依据） */
    writeTrainLineage(task);
  });
}

/*
 * 脚本任务执行器：工作空间里的 python 脚本以后台任务形态执行。前处理、
 * 数据分析是长作业，shell 工具的 30 秒同步超时撑不住；这里与训练任务同一
 * 套形态（环形日志、SIGTERM 停止、退出码判终态），agent 写完脚本后用
 * run_script 工具启动、read_script_log 轮询输出。脚本路径钉死在工作空间内
 * ——外部数据根与 swift 源码根是只读面，不从那里执行任何东西。
 */
interface ScriptTask {
  id: string;
  /** 用户改的显示名（重命名）；不设时列表用脚本路径 */
  name?: string;
  /** 工作空间内的脚本路径（相对根形态） */
  script: string;
  /** 命令行参数（逐个传给 spawn，不经 shell 拼接，无注入面） */
  args: string[];
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  /** 环形日志（截尾保留最近 500 行） */
  log: string[];
  proc?: ChildProcess;
  /** 发起任务的对话（脚本唤醒归属；页面直接启动的任务不带） */
  conv?: string;
  /** 发起任务的模型列（唤醒钉回同一列） */
  modelId?: string;
  /** 收编任务没有子进程句柄，只有记下的 pid */
  pid?: number;
}

const scriptTasks = new Map<string, ScriptTask>();

/*
 * 脚本任务的落盘面（~/.swift/scripts/<id>/）：meta.json（webui 独占写）+
 * output.log（逐行追加）+ exit_code（退出回调写）。对齐训练/部署的任务目录
 * 约定，使 webui 重启后能收编：活脚本重建进列表；重启期间结束的脚本把
 * 唤醒补推给发起对话（wakeDelivered 防重复推）。
 */
function scriptTaskDir(id: string): string {
  return join(swiftHome(), 'scripts', id);
}

/** 唤醒是否已推过（落盘在 meta.wakeDelivered；内存镜像供运行期改写） */
const scriptWakeDelivered = new Map<string, boolean>();

function writeScriptMeta(task: ScriptTask): void {
  const dir = scriptTaskDir(task.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const meta = {
    id: task.id,
    ...(task.name ? { name: task.name } : {}),
    script: task.script,
    args: task.args,
    status: task.status,
    startedAt: task.startedAt,
    ...(task.conv ? { conv: task.conv } : {}),
    ...(task.modelId ? { modelId: task.modelId } : {}),
    ...(task.pid ? { pid: task.pid } : {}),
    wakeDelivered: scriptWakeDelivered.get(task.id) ?? false,
  };
  const tmp = join(dir, 'meta.json.tmp');
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, join(dir, 'meta.json'));
}

/* ===== 长程可靠性共享机制：单实例锁 / 卡位守卫 / 磁盘水位 / 任务历史 ===== */

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/*
 * 单实例锁（webui.lock 记 pid）：wakeup.json / research.json / history.json 都是
 * 单写者文件，双开 webui 会互相覆盖。占用者活着则 fail loudly；同 pid 是
 * vite 同进程内重启（configureServer 重跑），放行。
 */
function acquireWebuiLock(server: { httpServer?: { on: (ev: string, fn: () => void) => void } }): void {
  const lock = join(swiftHome(), 'webui.lock');
  try {
    const prev = Number(readFileSync(lock, 'utf-8').trim());
    if (Number.isInteger(prev) && prev !== process.pid && pidAlive(prev)) {
      throw new Error(
        `另一个 ms-webui 实例（pid ${prev}）正在运行。单写者文件（wakeup/research/history）不允许双实例——先停掉它，或换 SWIFT_WEBUI_HOME。`,
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  mkdirSync(swiftHome(), { recursive: true });
  writeFileSync(lock, String(process.pid));
  server.httpServer?.on('close', () => {
    try {
      if (Number(readFileSync(lock, 'utf-8').trim()) === process.pid) rmSync(lock);
    } catch {
      /* 锁文件已被后来者接管：不动 */
    }
  });
}

/** 卡位占用登记：running/starting 任务的选卡 → 占用者（id + 类型）。 */
function gpuOccupants(): Map<number, { id: string; kind: string }> {
  const occ = new Map<number, { id: string; kind: string }>();
  const add = (gpus: number[] | undefined, id: string, kind: string, busy: boolean) => {
    if (!busy || !gpus?.length) return;
    for (const g of gpus) if (!occ.has(g)) occ.set(g, { id, kind });
  };
  for (const t of trainTasks.values()) add(t.gpus, t.id, '训练', t.status === 'running');
  for (const t of deployTasks.values()) add(t.gpus, t.id, '部署', t.status === 'starting' || t.status === 'running');
  for (const t of evalTasks.values()) add(t.local?.gpus, t.id, '评测', t.status === 'starting' || t.status === 'running');
  for (const t of exportTasks.values()) add(t.gpus, t.id, '导出', t.status === 'running');
  return occ;
}

/*
 * 卡位冲突守卫：冲突返回可行动的错误文案（创建路由以 409 拒绝），无冲突返回
 * null。训练/评测/导出/部署/编排会话共用——资源撞车的自愈是模型最贵的负担，
 * 在提交时挡下（换卡 / 等待 / 停占用任务三个出口都写进文案）。
 */
function gpuConflictError(gpus: number[] | undefined): string | null {
  if (!gpus?.length) return null;
  const occ = gpuOccupants();
  const hits = gpus
    .map((g) => {
      const o = occ.get(g);
      return o ? `卡 ${g}（${o.kind}任务 ${o.id} 占用中）` : null;
    })
    .filter((x): x is string => Boolean(x));
  return hits.length ? `所选显卡已被占用：${hits.join('、')}。换卡、等它结束，或先停止占用任务再提交。` : null;
}

/** swiftHome 所在文件系统的可用空间（GB）；不可探测返回 null（守卫跳过不挡路）。 */
function diskFreeGB(): number | null {
  try {
    const st = statfsSync(swiftHome());
    return (st.bavail * st.bsize) / 1e9;
  } catch {
    return null;
  }
}

/** 磁盘水位守卫：训练/导出/编排这类会写大量 checkpoint 的作业在提交时挡下。 */
function diskGuardError(minGB = 2): string | null {
  const free = diskFreeGB();
  return free !== null && free < minGB ? `磁盘可用空间仅 ${free.toFixed(1)}GB（要求 ≥ ${minGB}GB）——先清理旧 checkpoint（prune_checkpoints）再提交。` : null;
}

/*
 * 任务历史索引（history.json）：五类任务表都是内存 Map，收编只救活任务；
 * 终态快照进此索引，重启后历史列表不空、eval/export 任务也可追溯。单写者
 * = webui，截尾 300 条。快照不带 log/metrics（train 的从 output.log 尾部与
 * metrics.jsonl 恢复，script 同理），其余字段保留（eval 的 report、export 的
 * artifacts、deploy 的 endpoint）。
 */
interface HistoryEntry {
  kind: 'train' | 'eval' | 'export' | 'deploy' | 'script';
  endedAt: string;
  snapshot: Record<string, unknown>;
}

const HISTORY_CAP = 300;

function historyFile(): string {
  return join(swiftHome(), 'history.json');
}

function recordHistory(kind: HistoryEntry['kind'], snapshot: Record<string, unknown>): void {
  try {
    const entries: HistoryEntry[] = (() => {
      try {
        const raw = JSON.parse(readFileSync(historyFile(), 'utf-8')) as HistoryEntry[];
        return Array.isArray(raw) ? raw : [];
      } catch {
        return [];
      }
    })();
    /* 同任务同类型的旧条目先移除：停止路径（DELETE）与退出回调都会各记一次 */
    const deduped = entries.filter((e) => !(e.kind === kind && e.snapshot.id === snapshot.id));
    deduped.unshift({ kind, endedAt: new Date().toISOString().slice(0, 19).replace('T', ' '), snapshot });
    const capped = deduped.slice(0, HISTORY_CAP);
    const tmp = `${historyFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify(capped));
    renameSync(tmp, historyFile());
  } catch {
    /* 历史写失败不影响任务本体 */
  }
}

/** 任务目录里 output.log 的尾部（重启恢复日志缓冲用；无文件返回空） */
function readTaskLogTail(dir: string, cap = 500): string[] {
  try {
    const lines = readFileSync(join(dir, 'output.log'), 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-cap);
  } catch {
    return [];
  }
}

function loadHistory(): void {
  let entries: HistoryEntry[];
  try {
    const raw = JSON.parse(readFileSync(historyFile(), 'utf-8')) as HistoryEntry[];
    entries = Array.isArray(raw) ? raw : [];
  } catch {
    return;
  }
  for (const { kind, snapshot } of entries) {
    const id = typeof snapshot.id === 'string' ? snapshot.id : '';
    if (!id) continue;
    const withLog = { ...snapshot, log: [] as string[] };
    if (kind === 'train') {
      if (trainTasks.has(id)) continue;
      const dir = typeof snapshot.outputDir === 'string' ? dirname(snapshot.outputDir) : '';
      if (dir) withLog.log = readTaskLogTail(dir);
      trainTasks.set(id, { ...(withLog as unknown as TrainTask), metrics: (withLog as unknown as TrainTask).metrics ?? [] });
    } else if (kind === 'eval') {
      if (evalTasks.has(id)) continue;
      evalTasks.set(id, withLog as unknown as EvalTask);
    } else if (kind === 'export') {
      if (exportTasks.has(id)) continue;
      exportTasks.set(id, withLog as unknown as ExportTask);
    } else if (kind === 'deploy') {
      if (deployTasks.has(id)) continue;
      deployTasks.set(id, withLog as unknown as DeployTask);
    } else if (kind === 'script') {
      if (scriptTasks.has(id)) continue;
      withLog.log = readTaskLogTail(scriptTaskDir(id));
      scriptTasks.set(id, withLog as unknown as ScriptTask);
    }
  }
}

/*
 * swift/twinkle 版本探测（进 lineage）：一次 spawnSync 探测后进程内缓存。
 * 远端任务在别的机器上跑，版本只记本机 driver 侧——诚实记录「谁在驱动」。
 */
let stackVersionCache: { swift?: string; twinkle?: string } | undefined;

function probeStackVersions(): { swift?: string; twinkle?: string } {
  if (stackVersionCache) return stackVersionCache;
  const out: { swift?: string; twinkle?: string } = {};
  try {
    const r = spawnSync(
      resolvePython(),
      ['-c', "import importlib.metadata as m\nfor pkg, key in (('ms-swift', 'swift'), ('twinkle-kit', 'twinkle')):\n    try:\n        print(key, m.version(pkg))\n    except Exception:\n        pass"],
      { encoding: 'utf-8', timeout: 20000 },
    );
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = line.match(/^(swift|twinkle)\s+(\S+)$/);
      if (m) out[m[1] as 'swift' | 'twinkle'] = m[2];
    }
  } catch {
    /* 探测失败：lineage 不带版本，不影响任务 */
  }
  stackVersionCache = out;
  return out;
}

/* ===== 对话历史服务端落盘（/api/convs；展览模式机器侧共享面，禁用） ===== */

function convsFile(): string {
  return join(swiftHome(), 'convs.json');
}

/**
 * 读失败返回 null（区别于「空库」）：坏文件下当空库跑 appendTurn/PUT 会把
 * 整库替换成单回合的桶——调用方必须显式处理 null（放弃回合 / 拒写 PUT）。
 */
function readConvs(): { chats: unknown[]; turns: Record<string, Record<string, unknown>> } | null {
  try {
    const raw = JSON.parse(readFileSync(convsFile(), 'utf-8'));
    return {
      chats: Array.isArray((raw as { chats?: unknown }).chats) ? (raw as { chats: unknown[] }).chats : [],
      turns: (raw as { turns?: Record<string, Record<string, unknown>> }).turns ?? {},
    };
  } catch {
    return null;
  }
}

function writeConvs(chats: unknown, turns: unknown): void {
  const tmp = `${convsFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ chats, turns }));
  renameSync(tmp, convsFile());
}

/*
 * 会话唤醒队列：脚本终态事件推给发起它的对话（run_script 登记 conv），
 * 对话页 2s 一拍取走（take=1 消费即删）。与研究 events 队列同语义——消费
 * 即删、无需展示历史（事件文本本身进对话消息流，可审计）。
 *
 * 队列落盘（wakeup.json）：webui 重启（含部署重启）不清空待消费事件，否则
 * 每次部署都在斩断在飞的研究接力。单写者=webui，tmp+rename 原子写。
 */
const convEvents = new Map<string, { text: string; modelId?: string }[]>();

function wakeupFile(): string {
  return join(swiftHome(), 'wakeup.json');
}

function saveWakeup(): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const tmp = `${wakeupFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify([...convEvents.entries()]));
  renameSync(tmp, wakeupFile());
}

(function loadWakeup(): void {
  try {
    const raw = JSON.parse(readFileSync(wakeupFile(), 'utf-8')) as [string, { text: string; modelId?: string }[]][];
    for (const [conv, queue] of Array.isArray(raw) ? raw : []) convEvents.set(conv, queue);
  } catch {
    /* 无文件或坏文件：空队列起步 */
  }
})();

function pushConvEvent(conv: string, ev: { text: string; modelId?: string }): void {
  const queue = convEvents.get(conv) ?? [];
  queue.push(ev);
  if (queue.length > 20) queue.splice(0, queue.length - 20);
  convEvents.set(conv, queue);
  saveWakeup();
}

/* 脚本到达终态：向发起对话推一条带日志尾部的事件（详情由模型自己 read_script_log） */
function notifyScriptWake(task: ScriptTask, status: 'done' | 'failed' | 'lost'): void {
  if (!task.conv) return;
  const tail = task.log.slice(-5).join('\n');
  const outcome =
    status === 'done' ? '已完成' : status === 'failed' ? '失败（exit 非零）' : '在 webui 重启期间结束（退出码未知）';
  pushConvEvent(task.conv, {
    text: `后台脚本 ${task.script}（${task.id}）${outcome}。日志尾 5 行：\n${tail}\n需要完整日志用 read_script_log。`,
    ...(task.modelId ? { modelId: task.modelId } : {}),
  });
  scriptWakeDelivered.set(task.id, true);
}

function pushScriptLog(task: ScriptTask, line: string): void {
  /* 落盘日志：重启收编后 read_script_log 仍可读 */
  pushTaskLog(task, line, (l) => appendFileSync(join(scriptTaskDir(task.id), 'output.log'), `${l}\n`));
}

function runScriptTask(task: ScriptTask, abs: string): void {
  task.status = 'running';
  pushScriptLog(task, `$ ${resolvePython()} ${task.script}${task.args.length ? ` ${task.args.join(' ')}` : ''}`);
  const proc = spawn(resolvePython(), [abs, ...task.args], {
    cwd: taskCwd(),
    env: spawnEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  task.proc = proc;
  task.pid = proc.pid;
  writeScriptMeta(task);
  /* 脚本也可能打 tqdm 进度帧（\r 分隔），与训练日志同款拆法 */
  const onChunk = (buf: Buffer) =>
    buf
      .toString('utf-8')
      .split('\n')
      .flatMap((l) => l.split('\r'))
      .filter(Boolean)
      .forEach((l) => pushScriptLog(task, l));
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);
  proc.on('error', (e) => pushScriptLog(task, `[webui] script spawn 失败: ${e}`));
  proc.on('exit', (code) => {
    task.proc = undefined;
    /* 停止（SIGTERM）触发的退出不算失败 */
    if (task.status !== 'running') {
      writeScriptMeta(task);
      const { proc: _p, ...earlySnapshot } = task;
      recordHistory('script', earlySnapshot as Record<string, unknown>);
      return;
    }
    if (code === 0) {
      task.status = 'done';
      pushScriptLog(task, '[webui] 脚本执行完成');
    } else {
      task.status = 'failed';
      pushScriptLog(task, `[webui] 脚本失败 (exit ${code ?? -1})`);
    }
    /* 退出码先落盘再推唤醒：两步之间宕机由收编补推（wakeDelivered 仍 false） */
    try {
      writeFileSync(join(scriptTaskDir(task.id), 'exit_code'), String(code ?? -1));
    } catch {
      /* 不可写时唤醒照推，重启后只能以 lost 形态归因 */
    }
    notifyScriptWake(task, code === 0 ? 'done' : 'failed');
    writeScriptMeta(task);
    const { proc: _proc, ...scriptSnapshot } = task;
    recordHistory('script', scriptSnapshot as Record<string, unknown>);
  });
}

function publicScriptTask(t: ScriptTask) {
  return publicOf(t);
}

/*
 * 脚本孤儿收编（对齐训练/部署收编）：活脚本按 meta 里的 pid 重建进列表
 * （日志从 output.log 尾部恢复）；重启期间结束的脚本按 exit_code（有则
 * done/failed、无则 failed-lost）收尾，未送达的唤醒补推给发起对话。
 * 已送达终态的任务不重建——留在盘上作历史，列表不无限膨胀。
 */
function readScriptLogTail(id: string): string[] {
  try {
    const lines = readFileSync(join(scriptTaskDir(id), 'output.log'), 'utf-8').split('\n').filter(Boolean);
    return lines.slice(-500);
  } catch {
    return [];
  }
}

function adoptOrphanScriptTasks(): void {
  const root = join(swiftHome(), 'scripts');
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(readFileSync(join(root, entry.name, 'meta.json'), 'utf-8')) as Record<string, unknown>;
    } catch {
      continue; /* 坏 meta：认不出归属，跳过 */
    }
    const id = typeof meta.id === 'string' ? meta.id : entry.name;
    if (scriptTasks.has(id)) continue;
    const status = typeof meta.status === 'string' ? meta.status : 'running';
    const wakeDelivered = meta.wakeDelivered === true;
    scriptWakeDelivered.set(id, wakeDelivered);
    const alive =
      typeof meta.pid === 'number' &&
      (() => {
        try {
          process.kill(meta.pid as number, 0);
          return true;
        } catch {
          return false;
        }
      })();
    let exitCode: number | undefined;
    try {
      exitCode = Number(readFileSync(join(root, entry.name, 'exit_code'), 'utf-8').trim());
      if (!Number.isFinite(exitCode)) exitCode = undefined;
    } catch {
      /* 无 exit_code 文件 */
    }
    const task: ScriptTask = {
      id,
      ...(typeof meta.name === 'string' ? { name: meta.name } : {}),
      script: typeof meta.script === 'string' ? meta.script : '(未知)',
      args: Array.isArray(meta.args) ? meta.args.map((a) => String(a)) : [],
      status: 'running',
      startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : 'webui 重启前',
      log: readScriptLogTail(id),
      ...(typeof meta.conv === 'string' && meta.conv ? { conv: meta.conv } : {}),
      ...(typeof meta.modelId === 'string' && meta.modelId ? { modelId: meta.modelId } : {}),
      ...(typeof meta.pid === 'number' ? { pid: meta.pid } : {}),
    };
    if (status === 'running' && alive) {
      task.log.unshift('[webui] 脚本在 webui 重启后仍在运行，已重新纳入管理');
      scriptTasks.set(id, task);
      continue;
    }
    /* running 但进程不在：webui 停机期间结束。有 exit_code 用它，无则 lost。 */
    const finalStatus =
      status === 'running' ? (exitCode === 0 ? 'done' : 'failed') : (['done', 'failed', 'stopped'].includes(status) ? (status as ScriptTask['status']) : 'failed');
    task.status = finalStatus;
    const needWake = Boolean(task.conv) && !wakeDelivered && status === 'running';
    if (needWake) {
      notifyScriptWake(task, exitCode !== undefined ? (exitCode === 0 ? 'done' : 'failed') : 'lost');
    }
    if (status === 'running' || needWake) {
      writeScriptMeta(task);
      scriptTasks.set(id, task);
      const { proc: _p, ...adoptedSnapshot } = task;
      recordHistory('script', adoptedSnapshot as Record<string, unknown>);
    }
    /* 终态且已送达：不重建（历史留在盘上） */
  }
}

/*
 * ============ autoresearch：研究会话与看护 ============
 *
 * 一个研究会话 = 主模型经访谈收敛出「量化达标标准」后的一段自动迭代循环：
 * 训练期间会话挂起，watcher 盯任务状态跃迁（训练完成→自动对 checkpoint
 * 本地直评、失败→附日志尾部唤醒、失联→提示 resume），评测完成把分数记
 * 进迭代账本并与阈值比较，全部结论以事件队列形态等待对话页消费（取走
 * 即删）——主模型被事件唤醒后决定 Challenger 下一轮数据或收工上报。
 */

interface ResearchIteration {
  index: number;
  /** 本轮训练用的数据版本（工作空间内路径或标识） */
  dataVersion?: string;
  trainTaskId?: string;
  evalTaskId?: string;
  /** parallel 模式已评过的 checkpoint 名（防重复评） */
  evaluatedCkpt?: string;
  /** during 模式已记录的最新评测 step（防重复事件） */
  lastEvalStep?: number;
  score?: number;
  /** 模型给这轮的注记：改了什么、为什么 */
  note?: string;
}

/** start_train 复用的训练配置快照（首轮挂接训练时从任务对象自动抄一份） */
interface ResearchTrainConfig {
  taskType: 'sft' | 'pt' | 'rl';
  tuner: 'full' | 'lora' | 'trainable_tokens';
  params: Record<string, string | number | boolean>;
  gpus?: number[];
  gpuCount?: number;
  plugins?: string[];
}

interface ResearchSession {
  id: string;
  /** 唤醒事件回到哪个对话（对话页轮询 events 的依据） */
  convId: string;
  /** 主模型（chat 侧配置 id） */
  modelId: string;
  goal: string;
  baseModel: string;
  /** 工作空间内的数据版本根（相对路径形态，如 research/<id>/data） */
  dataDir: string;
  evalPlan: {
    mode: 'during' | 'checkpoint' | 'parallel';
    metric: {
      kind: 'evalscope' | 'custom';
      dataset: string;
      metricName: string;
      limit?: number;
      judge?: string;
    };
    threshold: number;
    direction: 'higher' | 'lower';
  };
  budget: { maxIterations: number };
  trainConfig?: ResearchTrainConfig;
  status: 'preparing' | 'training' | 'evaluating' | 'deciding' | 'done' | 'escalated' | 'stopped';
  iterations: ResearchIteration[];
  /** 唤醒事件队列（取走即删；截尾保留 200 条防无限膨胀） */
  events: Array<{ at: string; kind: string; text: string }>;
  /** 事件历史（只增不删，研究页事件流的展示源；同截尾 200） */
  eventLog: Array<{ at: string; kind: string; text: string }>;
  /*
   * 停摆哨兵的记账：stallSince = 连续无在飞任务的起点（ms 时间戳，有在飞即清
   * 零）；lastStallAt = 上次发 stall 事件的时刻（1 小时冷却，防事件轰炸）。旧
   * 会话文件无这两个字段——读取方全部 ?? 0 兜底。
   */
  stallSince?: number;
  lastStallAt?: number;
  createdAt: string;
}

function researchFile(): string {
  return join(swiftHome(), 'research.json');
}

function loadResearch(): ResearchSession[] {
  const file = researchFile();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    return (Array.isArray(raw) ? raw : [])
      .filter((s): s is ResearchSession => Boolean(s) && typeof (s as ResearchSession).id === 'string')
      /* 旧文件没有 eventLog（后加字段）：补空数组，读取方不判空 */
      .map((s) => ({ eventLog: [] as ResearchSession['eventLog'], ...s }));
  } catch {
    /* 坏文件降级为空列表：研究账本丢了不崩 webui */
    return [];
  }
}

function saveResearch(sessions: ResearchSession[]): void {
  const home = swiftHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(researchFile(), JSON.stringify(sessions, null, 2));
}

/*
 * 串行化读改写：watcher（2s 一拍）与 PATCH 两个写入方共享同一条 promise
 * 链，避免交错覆盖；每一步都重读文件再写回。
 */
let researchWriteChain: Promise<unknown> = Promise.resolve();

function mutateResearch(
  id: string,
  fn: (s: ResearchSession) => void,
): Promise<ResearchSession | null> {
  const run = async (): Promise<ResearchSession | null> => {
    const sessions = loadResearch();
    const s = sessions.find((x) => x.id === id);
    if (!s) return null;
    fn(s);
    saveResearch(sessions);
    return s;
  };
  const next = researchWriteChain.then(run, run);
  researchWriteChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function researchNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function pushResearchEvent(id: string, kind: string, text: string): Promise<void> {
  return mutateResearch(id, (s) => {
    const e = { at: researchNow(), kind, text };
    s.events.push(e);
    if (s.events.length > 200) s.events.splice(0, s.events.length - 200);
    s.eventLog.push(e);
    if (s.eventLog.length > 200) s.eventLog.splice(0, s.eventLog.length - 200);
  }).then(() => undefined);
}

/** 取走研究会话积压事件（消费即删）：唯一消费方是 turnTimer（起引擎唤醒回合） */
async function takeResearchEvents(id: string): Promise<ResearchSession['events']> {
  let taken: ResearchSession['events'] = [];
  await mutateResearch(id, (x) => {
    taken = x.events;
    x.events = [];
  });
  return taken;
}

/** 取走该对话积压的脚本事件（消费即删 + 落盘同步）：唯一消费方是 turnTimer */
function takeConvEvents(conv: string): { text: string; modelId?: string }[] {
  const events = convEvents.get(conv) ?? [];
  convEvents.delete(conv);
  saveWakeup();
  return events;
}

/*
 * 回合引擎句柄（configureServer 里创建）：模块级变量让中间件（回合提交、
 * SSE 订阅、审批 API）与 watcher（stall 在飞判定）能引用。
 */
let engine: TurnEngineHandle | null = null;

/** 列表不带 events / eventLog（事件单独取，负载体积） */
function publicResearchSession(s: ResearchSession) {
  const { events: _events, eventLog: _log, ...rest } = s;
  return rest;
}

/** 与阈值比较：direction 决定高低分孰优 */
function researchScorePasses(score: number, plan: ResearchSession['evalPlan']): boolean {
  return plan.direction === 'higher' ? score >= plan.threshold : score <= plan.threshold;
}

/**
 * 训练产物目录下的 checkpoint（v5 形态 v<N>-<时间戳>；容 checkpoint- 前缀
 * 兼容）。按 mtime 降序，首即最新。
 */
function listTrainCheckpoints(outputDir: string): Array<{ name: string; mtimeMs: number }> {
  try {
    return readdirSync(outputDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (/^v\d+(-|$)/.test(d.name) || d.name.startsWith('checkpoint')))
      .map((d) => ({ name: d.name, mtimeMs: statSync(join(outputDir, d.name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/** 访谈自由文本的评测身份归一化：「live_code_bench (release_v6)」→ 注册名 + subset */
function parseEvalDataset(raw: string): { name: string; subset?: string } {
  const m = raw.trim().match(/^(.+?)\s*[(（]([^()（）]+)[)）]\s*$/);
  if (m && m[1].trim()) return { name: m[1].trim(), subset: m[2].trim() };
  return { name: raw.trim() };
}

/** 评测报告里取分：dataset 行内先按 metric 名找，兜底行级 score */
function extractEvalScore(
  report: { dataset: string; rows: unknown[] }[] | undefined,
  dataset: string,
  metricName: string,
): number | null {
  for (const r of report ?? []) {
    if (r.dataset !== dataset) continue;
    for (const row of r.rows) {
      const rec = row as { name?: unknown; score?: unknown; metrics?: Array<{ name?: unknown; score?: unknown }> };
      for (const m of rec.metrics ?? []) {
        if (String(m.name ?? '') === metricName && Number.isFinite(Number(m.score))) return Number(m.score);
      }
      if (
        (metricName === 'score' || String(rec.name ?? '') === metricName) &&
        Number.isFinite(Number(rec.score))
      ) {
        return Number(rec.score);
      }
    }
  }
  return null;
}

/** during 模式：训练日志里 `step N  eval: {'metric': v, ...}` 行的解析 */
function parseDuringEvalScores(log: string[], metricName: string): Array<{ step: number; score: number }> {
  const key = metricName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`['"]${key}['"]\\s*:\\s*([\\d.eE+-]+)`);
  const out: Array<{ step: number; score: number }> = [];
  for (const line of log) {
    if (!line.includes('eval:')) continue;
    const m = line.match(/step (\d+)\s+eval: \{(.+)\}/);
    const kv = m && m[2].match(re);
    if (m && kv) out.push({ step: Number(m[1]), score: Number(kv[1]) });
  }
  return out;
}

/** 研究用本地直评：底座 + adapter 直接 spawn swift eval，不起服务不占端口 */
function startResearchEval(session: ResearchSession, adapters: string, gpus?: number[]): string {
  const id = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(swiftHome(), 'eval', id);
  mkdirSync(dir, { recursive: true });
  /*
   * dataset 身份结构化：访谈自由文本里的「name (subset)」注记拆成注册名 +
   * subset_list 透传（--eval_dataset_args）——剥注记会丢语义（live_code_bench
   * 剥掉 release_v6 就评成固化 lite 默认版），取分也对不回原名。启动与取分
   * 共用 parseEvalDataset，同一份归一化。
   */
  const parsed = parseEvalDataset(session.evalPlan.metric.dataset);
  const datasetArgs = parsed.subset ? { [parsed.name]: { subset_list: [parsed.subset] } } : undefined;
  const task: EvalTask = {
    id,
    modelId: `research:${session.id}`,
    name: `研究 ${session.id.slice(-6)} · ${parsed.name}${parsed.subset ? ` (${parsed.subset})` : ''}`,
    model: session.baseModel,
    baseUrl: '',
    items: [
      {
        dataset: parsed.name,
        ...(session.evalPlan.metric.limit ? { limit: session.evalPlan.metric.limit } : {}),
        ...(datasetArgs ? { datasetArgs } : {}),
      },
    ],
    current: 0,
    status: 'starting',
    startedAt: researchNow(),
    log: [],
    outputDir: join(dir, 'output'),
    resultJsonl: join(dir, 'results.jsonl'),
    local: { model: session.baseModel, adapters: [adapters], ...(gpus?.length ? { gpus } : {}) },
  };
  evalTasks.set(id, task);
  void runEvalChain(task);
  return id;
}

/*
 * watcher：2s 一拍，只碰 training / evaluating 态的会话。所有写都走
 * mutateResearch（串行链）与 PATCH 不会交错覆盖；状态跃迁后条件不再
 * 成立，天然防重复推事件。
 */
async function researchTick(): Promise<void> {
  for (const session of loadResearch()) {
    try {
      if (session.status === 'training') await watchResearchTrain(session);
      else if (session.status === 'evaluating') await watchResearchEval(session);
      /* 停摆哨兵对全部非终态生效：preparing/deciding 没有专属 watcher，最易停摆 */
      if (session.status !== 'done' && session.status !== 'escalated' && session.status !== 'stopped') {
        await watchResearchStall(session);
      }
    } catch {
      /* 单会话异常不拖垮整拍 */
    }
  }
}

/*
 * 停摆哨兵：非终态会话连续 30 分钟无在飞任务（训练/评测/脚本全无、也无审批
 * 在等）时补发一次 stall 唤醒。事件驱动只覆盖「任务终态」这一个复活出口——
 * 续轮流中断、页面关闭吞掉唤醒、模型回合话说一半断掉，都会把会话留在
 * 「无任务、无审批、非终态」的三不管地带且无人再叫醒它。哨兵是这条纪律的
 * 机制化兜底：1 小时冷却防轰炸；有任务回到在飞即清零计时。
 */
async function watchResearchStall(session: ResearchSession): Promise<void> {
  const busy =
    /* 账本最新的训练/评测任务仍在跑 */
    [...session.iterations].reverse().some((it) => {
      const t = it.trainTaskId ? trainTasks.get(it.trainTaskId) : undefined;
      const e = it.evalTaskId ? evalTasks.get(it.evalTaskId) : undefined;
      return (t && t.status === 'running') || (e && (e.status === 'running' || e.status === 'starting'));
    }) ||
    /* 该会话的对话还有后台脚本在跑 */
    [...scriptTasks.values()].some((s) => s.conv === session.convId && s.status === 'running') ||
    /* 引擎回合在飞（含审批挂起）：事件已消费、模型正在决策或等人 */
    (session.convId ? engine?.busyConv(session.convId) : false) === true;
  if (busy) {
    if (session.stallSince) await mutateResearch(session.id, (s) => { s.stallSince = undefined; });
    return;
  }
  const now = Date.now();
  const since = session.stallSince ?? now;
  if (!session.stallSince) {
    await mutateResearch(session.id, (s) => { s.stallSince = since; });
  }
  const STALL_AFTER_MS = 30 * 60_000;
  const STALL_COOLDOWN_MS = 60 * 60_000;
  if (now - since < STALL_AFTER_MS) return;
  if (now - (session.lastStallAt ?? 0) < STALL_COOLDOWN_MS) return;
  await pushResearchEvent(
    session.id,
    'stall',
    `研究会话已 30 分钟无在飞任务（无训练/评测/脚本在跑、无审批等待），停在 ${session.status}。上一动作可能中断（失败的脚本、断掉的回合）：先读最新事件与账本定位断点，修复后继续推进（数据就绪就 start_train）；无法推进就总结现状并上报用户，不要停在原地。`,
  );
  await mutateResearch(session.id, (s) => {
    s.lastStallAt = now;
  });
}

async function watchResearchTrain(session: ResearchSession): Promise<void> {
  const it = [...session.iterations].reverse().find((x) => x.trainTaskId);
  if (!it?.trainTaskId) return;
  const task = trainTasks.get(it.trainTaskId);
  if (!task) {
    await pushResearchEvent(
      session.id,
      'train-lost',
      `训练任务 ${it.trainTaskId} 失联（webui 可能重启过）。先用 list_checkpoints 看已产出的 checkpoint，倾向 --resume_from_checkpoint 续跑；确认进程已死且无断点再考虑重跑或上报用户。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  /* 首次挂接：把训练配置快照进会话，供后续迭代 start_train 复用 */
  if (!session.trainConfig) {
    await mutateResearch(session.id, (s) => {
      if (s.trainConfig) return;
      s.trainConfig = {
        taskType: task.taskType,
        tuner: task.tuner,
        /* 属地键（output_dir 等）不进快照——start_train 复用时执行器自拼 */
        params: Object.fromEntries(Object.entries(task.params).filter(([k]) => !TRAIN_OWNED_KEYS.has(k))),
        ...(task.gpus?.length ? { gpus: task.gpus } : {}),
        ...(task.gpuCount ? { gpuCount: task.gpuCount } : {}),
        ...(task.plugins.length ? { plugins: task.plugins } : {}),
      };
    });
  }
  if (task.status === 'failed') {
    const tail = task.log.slice(-8).join('\n');
    /* 远端形态的失败优先怀疑 server 侧（ckpt 回收/资源），与本地归因分开提示 */
    const remoteHint =
      task.params.mode === 'remote'
        ? '\n远端形态：先考虑 server 侧因素（旧 checkpoint 被回收、服务资源），list_checkpoints 的返回里带远端提示。'
        : '';
    await pushResearchEvent(
      session.id,
      'train-failed',
      `迭代 ${it.index} 训练失败：\n${tail}\n\n嵌的是日志尾 8 行，不够用 read_task_log 深读；先 list_checkpoints 查断点，倾向 --resume_from_checkpoint 续跑；连续失败或无断点时停止并上报用户。${remoteHint}`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  if (task.status === 'stopped') {
    await pushResearchEvent(
      session.id,
      'train-stopped',
      `迭代 ${it.index} 的训练被停止。确认是否预期，再决定 resume / 重跑 / 上报用户。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  if (task.status === 'running' && session.evalPlan.mode === 'during') {
    /* during：解析新出现的评测行，每个新 step 记一次分 + 一条趋势事件 */
    const scores = parseDuringEvalScores(task.log, session.evalPlan.metric.metricName);
    const fresh = scores.filter((x) => x.step > (it.lastEvalStep ?? 0));
    if (fresh.length) {
      const last = fresh[fresh.length - 1];
      await mutateResearch(session.id, (s) => {
        const target = s.iterations.find((x) => x.index === it.index);
        if (target) {
          target.lastEvalStep = last.step;
          target.score = last.score;
        }
      });
      await pushResearchEvent(
        session.id,
        'during-eval',
        `训练中评测（step ${last.step}）：${session.evalPlan.metric.metricName} = ${last.score}。训练仍在进行，无需行动，仅供掌握趋势。`,
      );
    }
    return;
  }
  if (task.status === 'running' && session.evalPlan.mode === 'parallel') {
    /* parallel：有新 checkpoint 且有空闲卡时并行起评（中期信息，决策仍在最终评） */
    const ckpts = listTrainCheckpoints(task.outputDir);
    const latest = ckpts[0];
    if (latest && latest.name !== it.evaluatedCkpt) {
      const gpus = await queryGpus();
      const busy = new Set(task.gpus ?? []);
      const free = gpus.find((g) => !busy.has(g.index) && g.used < 1000);
      if (free) {
        const evalId = startResearchEval(session, join(task.outputDir, latest.name), [free.index]);
        await mutateResearch(session.id, (s) => {
          const target = s.iterations.find((x) => x.index === it.index);
          if (target) {
            target.evaluatedCkpt = latest.name;
            target.evalTaskId = evalId;
          }
        });
        await pushResearchEvent(
          session.id,
          'parallel-eval',
          `检测到新 checkpoint ${latest.name}，已并行启动中期评测（卡 ${free.index}）。训练继续，评测结果会另行事件通知。`,
        );
      }
    }
    return;
  }
  if (task.status !== 'done') return;
  /*
   * custom metric：判分在模型侧（自建 judge 脚本 / run_script），swift eval
   * 无从执行（dataset 是自建标识，不是基准名）。训练完成改推 train-done 事件
   * 把评测交还模型：它对最新 checkpoint 跑自己的判分脚本（脚本完成另有
   * conv 唤醒），分数经 update_research 记账，达标与否由它对照阈值判断。
   * 置 evaluating（无 evalTaskId 时 watchResearchEval 安静跳过）防本拍重复推。
   */
  if (session.evalPlan.metric.kind === 'custom') {
    await pushResearchEvent(
      session.id,
      'train-done',
      `迭代 ${it.index} 训练完成。metric 是自定义判分（${session.evalPlan.metric.metricName}，阈值 ${session.evalPlan.threshold}${session.evalPlan.direction === 'lower' ? ' 以下' : ' 以上'}）：用自己的评测脚本对最新 checkpoint 打分（run_script 后台跑，完成后会自动通知），分数经 update_research 写进该迭代的 score；达标→总结成果并置 done，未达标且预算内→调整方案后 start_train 下一迭代。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'evaluating';
    });
    return;
  }
  /* 训练完成：during 直接用训练中最后分数收口；checkpoint/parallel 对最新 ckpt 起评 */
  if (session.evalPlan.mode === 'during') {
    const scores = parseDuringEvalScores(task.log, session.evalPlan.metric.metricName);
    const score = scores.length ? scores[scores.length - 1].score : null;
    await finalizeResearchIteration(session, it.index, score, '训练完成（训练中评测口径）');
    return;
  }
  const ckpts = listTrainCheckpoints(task.outputDir);
  const latest = ckpts[0];
  if (!latest) {
    await pushResearchEvent(
      session.id,
      'no-checkpoint',
      `训练完成但 output 下没有 checkpoint 目录（${task.outputDir}），无法自动评测。检查 save 配置后决定重跑或上报用户。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  const evalId = startResearchEval(session, join(task.outputDir, latest.name));
  await mutateResearch(session.id, (s) => {
    const target = s.iterations.find((x) => x.index === it.index);
    if (target) target.evalTaskId = evalId;
    s.status = 'evaluating';
  });
  await pushResearchEvent(
    session.id,
    'eval-started',
    `迭代 ${it.index} 训练完成，已对 checkpoint ${latest.name} 自动启动评测（${session.evalPlan.metric.dataset} · ${session.evalPlan.metric.metricName}）。评测完成会另行事件通知。`,
  );
}

async function watchResearchEval(session: ResearchSession): Promise<void> {
  const it = [...session.iterations].reverse().find((x) => x.evalTaskId);
  if (!it?.evalTaskId) return;
  const task = evalTasks.get(it.evalTaskId);
  if (!task) {
    await pushResearchEvent(
      session.id,
      'eval-lost',
      `评测任务 ${it.evalTaskId} 失联（webui 可能重启过）。重跑评测或上报用户。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  if (task.status === 'failed') {
    const tail = task.log.slice(-8).join('\n');
    await pushResearchEvent(
      session.id,
      'eval-failed',
      `迭代 ${it.index} 评测失败：\n${tail}\n\n嵌的是日志尾 8 行，不够用 read_task_log 深读；分析失败原因（样本量？数据格式？）后决定重评或调整方案。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  if (task.status !== 'done') return;
  const score = extractEvalScore(task.report, parseEvalDataset(session.evalPlan.metric.dataset).name, session.evalPlan.metric.metricName);
  await finalizeResearchIteration(session, it.index, score, '评测完成');
}

/** 一次迭代的收口：记分、比阈值、定去向（达标收工 / 未达标迭代 / 预算耗尽上报） */
async function finalizeResearchIteration(
  session: ResearchSession,
  index: number,
  score: number | null,
  label: string,
): Promise<void> {
  if (score === null || !Number.isFinite(score)) {
    await pushResearchEvent(
      session.id,
      'score-miss',
      `${label}，但报告里解析不到 ${session.evalPlan.metric.metricName}（数据集 ${session.evalPlan.metric.dataset}）。核对 metric 名（可读评测任务日志与报告），修正后重评或换指标。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'deciding';
    });
    return;
  }
  const prev = [...session.iterations].reverse().slice(1).find((x) => x.score !== undefined)?.score;
  const delta =
    prev !== undefined ? `（较上一有分迭代 ${Number((score - prev).toPrecision(4)) >= 0 ? '+' : ''}${Number((score - prev).toPrecision(4))}）` : '';
  await mutateResearch(session.id, (s) => {
    const target = s.iterations.find((x) => x.index === index);
    if (target) target.score = score;
  });
  if (researchScorePasses(score, session.evalPlan)) {
    await pushResearchEvent(
      session.id,
      'pass',
      `${label}：${session.evalPlan.metric.metricName} = ${score}${delta}，达到阈值 ${session.evalPlan.threshold}。研究达标——总结成果（最终 checkpoint 路径、各轮分数、数据版本谱系）给用户；可用 deploy_checkpoint 把最佳 checkpoint 直接部署成可对话服务（LoRA 免合并）或 export_checkpoint 固化/推 Hub，并用 update_research 置 done。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'done';
    });
    return;
  }
  const usedIter = session.iterations.length;
  if (usedIter >= session.budget.maxIterations) {
    await pushResearchEvent(
      session.id,
      'budget',
      `${label}：${session.evalPlan.metric.metricName} = ${score}${delta}，未达阈值 ${session.evalPlan.threshold}，且预算（${usedIter}/${session.budget.maxIterations} 轮）已用尽。停止迭代，向用户汇报各轮分数与判断（是数据问题还是方案上限），并用 update_research 置 escalated。`,
    );
    await mutateResearch(session.id, (s) => {
      s.status = 'escalated';
    });
    return;
  }
  await pushResearchEvent(
    session.id,
    'fail',
    `${label}：${session.evalPlan.metric.metricName} = ${score}${delta}，未达阈值 ${session.evalPlan.threshold}（预算 ${usedIter}/${session.budget.maxIterations}）。分析失败案例、用 Challenger 组件生成下一版数据（评测集不可读），然后 start_train 下一轮，并用 update_research 记录迭代 note。`,
  );
  await mutateResearch(session.id, (s) => {
    s.status = 'deciding';
  });
}

/*
 * 训练任务孤儿收编（对齐部署收编）：任务表随 vite 重启清零，训练子进程是
 * 独立进程继续在跑。pgrep 还原活任务（torchrun 各 rank 同命令行，按
 * --output_dir 去重；只收编 webui 启动的 ~/.swift/train 下的任务）；死任务
 * 不重建——研究 watcher 会以「失联」事件交给模型决策 resume。
 */
function pgrepTrainLines(pattern: string): Promise<Array<{ pid: number; cmdline: string }>> {
  return new Promise((resolvePromise) => {
    const proc = spawn('pgrep', ['-af', pattern], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    proc.on('error', () => resolvePromise([]));
    proc.on('close', () => {
      resolvePromise(
        out
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const sp = l.indexOf(' ');
            return { pid: Number(l.slice(0, sp)), cmdline: l.slice(sp + 1) };
          })
          .filter((x) => Number.isInteger(x.pid)),
      );
    });
  });
}

async function adoptOrphanTrainTasks(): Promise<void> {
  const lines = await pgrepTrainLines('swift\\.dev\\.cli\\.(sft|pt|rl)');
  const trainRoot = join(swiftHome(), 'train') + sep;
  const byOutput = new Map<string, { pid: number; argv: string[] }>();
  for (const { pid, cmdline } of lines) {
    const argv = cmdline.split(/\s+/);
    const outIdx = argv.indexOf('--output_dir');
    const outputDir = outIdx >= 0 ? argv[outIdx + 1] : '';
    /* 只收编 webui 启动的任务：用户手动跑的 swift 训练不接管 */
    if (!outputDir || !outputDir.startsWith(trainRoot)) continue;
    if (!byOutput.has(outputDir)) byOutput.set(outputDir, { pid, argv });
  }
  for (const [outputDir, { pid, argv }] of byOutput) {
    const segs = outputDir.split(sep).filter(Boolean);
    const id = segs.length >= 2 && segs[segs.length - 1] === 'output' ? segs[segs.length - 2] : `adopted-${pid}`;
    if (trainTasks.has(id)) continue;
    const joined = argv.join(' ');
    const taskType = (joined.match(/swift\.dev\.cli\.(sft|pt|rl)/)?.[1] ?? 'sft') as TrainTask['taskType'];
    const pick = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const dsIdx = argv.indexOf('--dataset');
    const datasets: string[] = [];
    if (dsIdx >= 0) {
      for (let i = dsIdx + 1; i < argv.length && !argv[i].startsWith('--'); i++) datasets.push(argv[i]);
    }
    const task: TrainTask = {
      id,
      taskType,
      model: pick('--model') ?? '',
      datasets: datasets.length ? datasets : ['(未知)'],
      tuner: (pick('--tuner') as TrainTask['tuner']) ?? 'lora',
      plugins: [],
      params: {},
      outputDir,
      /* 展示用：收编任务按真实命令行重建（与 spawn 时 argv 同构，去掉解释器） */
      args: argv.slice(1),
      status: 'running',
      startedAt: 'webui 重启前',
      /* 日志从落盘的 output.log 尾部恢复（指标由 metrics.jsonl 同步恢复） */
      log: [
        ...readTaskLogTail(dirname(outputDir)),
        '[webui] 训练进程在 webui 重启后仍在运行，已重新纳入管理（参数从其命令行还原）',
      ],
      metrics: [],
      pid,
    };
    trainTasks.set(id, task);
  }
}

/*
 * 收编任务的运行期探活：孤儿没有子进程句柄，自然退出没有 exit 回调——
 * 不探活的话 status 永远停在 running，研究 watcher 看不到终态、停摆哨兵
 * 的「在飞」判定也被它骗过，研究会话卡死到下一次 webui 重启才能自愈。
 * 5s 一拍：活着顺带同步指标（曲线更新不再依赖有人开着训练页），死了按
 * exit_code（exit 回调先落盘的约定）判终态、补写血缘——研究侧随后的
 * 常规 watcher 2s 内看到跃迁即推事件。spawn 的任务带 proc 句柄，exit
 * 回调自己翻转状态，这里只碰「running 且无句柄且记了 pid」的收编形态。
 */
function adoptTrainTick(): void {
  for (const task of trainTasks.values()) {
    if (task.status !== 'running' || task.proc || !task.pid) continue;
    let alive: boolean;
    try {
      process.kill(task.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      syncTrainMetricsFile(task);
      continue;
    }
    let exitCode: number | undefined;
    try {
      exitCode = Number(readFileSync(join(dirname(task.outputDir), 'exit_code'), 'utf-8').trim());
      if (!Number.isFinite(exitCode)) exitCode = undefined;
    } catch {
      /* 无 exit_code 文件：webui 停机窗口内退出，回调没来得及跑 */
    }
    task.pid = undefined;
    if (exitCode === 0) {
      task.status = 'done';
      pushTrainLog(task, '[webui] 训练完成');
    } else {
      task.status = 'failed';
      pushTrainLog(task, `[webui] 训练失败 (exit ${exitCode !== undefined ? exitCode : '未知（webui 重启期间退出）'})`);
    }
    writeTrainLineage(task);
  }
}

/*
 * Challenger 组件模板库（webui 根 challenger-templates/，随 npm 包发布）：
 * 模板是只读真相源；install 拷进 workspace/challenger/ 后模型可读可改可
 * 继承。每个模板首段 docstring 以 name/desc/usage/guards 四行自描述。
 */
function challengerDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'challenger-templates');
}

function listChallengerTemplates(): Array<{ name: string; desc: string; usage: string; guards: string }> {
  let files: string[];
  try {
    files = readdirSync(challengerDir()).filter((f) => f.endsWith('.py'));
  } catch {
    return [];
  }
  const out: Array<{ name: string; desc: string; usage: string; guards: string }> = [];
  for (const f of files) {
    try {
      const src = readFileSync(join(challengerDir(), f), 'utf-8');
      const doc = src.match(/^"""([\s\S]*?)"""/)?.[1] ?? '';
      const field = (k: string): string => doc.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
      out.push({ name: f.replace(/\.py$/, ''), desc: field('desc') || field('name'), usage: field('usage'), guards: field('guards') });
    } catch {
      /* 单文件坏不影响整体 */
    }
  }
  return out;
}

/**
 * nvidia-smi 探测 GPU 清单：新建部署页选卡的数据源。
 * 输出失败（没装驱动/无卡）返回空数组——页面对空列表降级成「手动填卡号」。
 */
function queryGpus(): Promise<Array<{ index: number; name: string; used: number; total: number }>> {
  return new Promise((resolvePromise) => {
    const proc = spawn(
      'nvidia-smi',
      ['--query-gpu=index,name,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    proc.on('error', () => resolvePromise([]));
    proc.on('close', () => {
      const gpus = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [index, name, used, total] = l.split(',').map((s) => s.trim());
          return { index: Number(index), name: name ?? '', used: Number(used), total: Number(total) };
        })
        .filter((g) => Number.isInteger(g.index) && Number.isFinite(g.total));
      resolvePromise(gpus);
    });
  });
}

/*
 * swift 环境探测（agent 的 env_info 工具后端）：版本 + 安装路径 + 解释器。
 * import swift 首次要十几秒，进程内缓存 Promise 只探一次；探测失败返回
 * null（环境没装 swift 等），不阻塞 GPU 部分。
 */
let swiftEnvCache: Promise<{ version: string; path: string } | null> | null = null;
function probeSwiftEnv(): Promise<{ version: string; path: string } | null> {
  if (!swiftEnvCache) {
    swiftEnvCache = new Promise((resolvePromise) => {
      const py = resolvePython();
      const proc = spawn(
        py,
        ['-c', 'import swift, importlib.metadata as m; print(m.version("ms-swift")); print(swift.__file__)'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), 90_000);
      proc.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf-8');
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolvePromise(null);
      });
      proc.on('close', () => {
        clearTimeout(timer);
        const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
        resolvePromise(lines.length >= 2 ? { version: lines[0], path: lines[1] } : null);
      });
    });
  }
  return swiftEnvCache;
}

/*
 * evalscope 可用性探测：模型搭评测链前常被环境分裂坑（registry 模块找不到、
 * 版本不符），与其让它连环写 probe 脚本，不如 env_info 一次报清。失败返回
 * null（未安装），同样进程内缓存只探一次。
 */
let evalscopeCache: Promise<{ version: string } | null> | null = null;
function probeEvalscope(): Promise<{ version: string } | null> {
  if (!evalscopeCache) {
    evalscopeCache = new Promise((resolvePromise) => {
      const proc = spawn(
        resolvePython(),
        ['-c', 'import importlib.metadata as m; print(m.version("evalscope"))'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
      proc.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf-8');
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolvePromise(null);
      });
      proc.on('close', () => {
        clearTimeout(timer);
        const v = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
        resolvePromise(v ? { version: v } : null);
      });
    });
  }
  return evalscopeCache;
}

/*
 * evalscope 基准注册表（名 → subset 值域）：--eval_dataset 只认精确名、版本
 * 注记走 --eval_dataset_args 的 subset_list 透传（live_code_bench (release_v6)
 * 事故）。import evalscope 首次要几秒；成功结果按解释器缓存（切 python 重探），
 * 失败不缓存——返回 null 只表示此刻不可达，不把一次抖动固化成永久失败。
 */
let benchmarksCache: Record<string, string[]> | null = null;
let benchmarksCachePython: string | null = null;
let benchmarksInflight: Promise<Record<string, string[]> | null> | null = null;
function probeBenchmarks(): Promise<Record<string, string[]> | null> {
  if (benchmarksCache !== null && benchmarksCachePython === resolvePython()) return Promise.resolve(benchmarksCache);
  if (benchmarksInflight) return benchmarksInflight;
  let resolveInflight: (v: Record<string, string[]> | null) => void = () => undefined;
  const finish = (v: Record<string, string[]> | null): void => {
    benchmarksInflight = null;
    if (v !== null) {
      benchmarksCache = v;
      benchmarksCachePython = resolvePython();
    }
    resolveInflight(v);
  };
  benchmarksInflight = new Promise((r) => {
    resolveInflight = r;
    const proc = spawn(
      resolvePython(),
      [
        '-c',
        'import json\nfrom evalscope.api.registry import BENCHMARK_REGISTRY\nprint(json.dumps({k: sorted(getattr(m, "subset_list", None) or []) for k, m in BENCHMARK_REGISTRY.items()}))',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 90_000);
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    proc.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(out.trim()) as Record<string, string[]>;
        finish(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        finish(null);
      }
    });
  });
  return benchmarksInflight;
}

/*
 * 模型缓存根：swift/评测链用 hub id 时权重落这里（MODELSCOPE_CACHE 可改默认
 * 位置），自建评测起 vllm 需要磁盘路径——报给模型省去逐层 find 探测。
 */
function modelCacheRoot(): string {
  return process.env.MODELSCOPE_CACHE || join(homedir(), '.cache', 'modelscope');
}

/** 找到监听某端口的部署 driver 进程（pid + 完整命令行）；找不到返回 null */
function findDeployCmdline(port: number): Promise<{ pid: number; cmdline: string } | null> {
  return new Promise((resolvePromise) => {
    const proc = spawn('pgrep', ['-af', `swift.dev.cli.deploy.*--port ${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf-8');
    });
    proc.on('error', () => resolvePromise(null));
    proc.on('close', () => {
      const line = out.split('\n').map((l) => l.trim()).find(Boolean);
      if (!line) {
        resolvePromise(null);
        return;
      }
      const pid = Number(line.split(/\s+/)[0]);
      resolvePromise(Number.isInteger(pid) && pid > 0 ? { pid, cmdline: line } : null);
    });
  });
}

/**
 * 重启收编：任务表只在内存，webui 重启后清单空了，但 attached 部署子进程
 * 不随 vite 死（pkill 只杀 node），会失联成孤儿——还占着卡、models.json 里
 * 还有登记，部署页却看不到它。启动时按登记探活把孤儿重新纳入管理：创建
 * 参数从 driver 的真实命令行还原，停止靠记下的 pid；探不活的登记是残留，
 * 直接摘除。
 */
async function adoptOrphanDeploys(): Promise<void> {
  const registered = loadModels().filter((m) => m.note === 'swift 部署');
  for (const m of registered) {
    const portMatch = m.baseUrl.match(/:(\d+)\/v1/);
    const port = portMatch ? Number(portMatch[1]) : NaN;
    if (!Number.isInteger(port) || port <= 0) continue;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error('endpoint not ready');
    } catch {
      /* 探不活 = 进程已死但登记还在（异常退出的孤儿），摘掉 */
      saveModels(loadModels().filter((x) => x.id !== m.id));
      continue;
    }
    const found = await findDeployCmdline(port);
    const argv = found?.cmdline ?? '';
    const pick = (flag: string): string | undefined => argv.match(new RegExp(`${flag} (\\S+)`))?.[1];
    /* adapters 是多值 flag：取到下一个 flag 前的全部 token（收编任务只求展示与停止，不必逐个精确还原） */
    const adapters = (argv.match(/--adapters ((?:\S+\s*)*\S+)(?=\s+--|$)/)?.[1] ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const task: DeployTask = {
      id: `adopted-${port}`,
      servedName: m.id,
      model: pick('--model') ?? m.model,
      engine: pick('--infer_backend') === 'sglang' ? 'sglang' : 'vllm',
      port,
      status: 'running',
      startedAt: 'webui 重启前',
      log: ['[webui] 部署进程在 webui 重启后仍在运行，已重新纳入管理（参数从其命令行还原）'],
      registered: true,
      ...(adapters.length ? { adapters } : {}),
      ...(found ? { pid: found.pid } : {}),
    };
    deployTasks.set(task.id, task);
  }
}

function startDeployTask(body: {
  model: string;
  servedName?: string;
  engine?: string;
  port?: number;
  adapters?: unknown;
}) {
  const model = String(body.model ?? '').trim();
  if (!model) throw new Error('model is required');
  const engine = body.engine === 'sglang' ? 'sglang' : 'vllm';
  const servedName =
    String(body.servedName ?? '').trim() || model.split('/').pop() || model;
  /* 前端传数组，避免空格拆分歧义（路径含空格不炸） */
  const adapters = (Array.isArray(body.adapters) ? body.adapters : [])
    .map((a: unknown) => String(a ?? '').trim())
    .filter(Boolean);
  const id = `deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return { id, model, engine, servedName, adapters };
}

/** 一份可注入的技能：SKILL.md 全文 + 同目录其余 markdown 的相对路径清单 */
interface SkillEntry {
  group: 'swift' | 'modelscope';
  name: string;
  content: string;
  files: string[];
}

/*
 * 首页注入模型上下文的技能来源。swift 组：本仓 skills/ 优先（在 swift repo 内
 * 开发时编辑即时生效），否则读 fetch-skills 拷进 public/ 的副本（发布产物形态）；
 * modelscope 组只读 public/ 副本（`npm run fetch:skills` 拷入，未跑则空）。
 */
function scanSkills(root: string, group: SkillEntry['group']): SkillEntry[] {
  if (!existsSync(root)) return [];
  const entries: SkillEntry[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    const skillMd = join(dir, 'SKILL.md');
    if (!isFile(skillMd)) continue;
    const files: string[] = [];
    const walk = (sub: string) => {
      for (const f of readdirSync(sub, { withFileTypes: true })) {
        const p = join(sub, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.md') && f.name !== 'SKILL.md') files.push(relative(dir, p));
      }
    };
    walk(dir);
    entries.push({ group, name: d.name, content: readFileSync(skillMd, 'utf-8'), files: files.sort() });
  }
  return entries;
}

/** isFileSync 的窄化包装（readdirSync withFileTypes 之外这里的文件判存在用） */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function listSkills(): SkillEntry[] {
  const root = dirname(fileURLToPath(import.meta.url));
  return [
    ...scanSkills(swiftSkillsRoot(), 'swift'),
    ...scanSkills(join(root, 'public', 'skills', 'modelscope'), 'modelscope'),
  ];
}

/** swift 组技能根：本仓 skills/ 优先（编辑即时生效），否则读 public/ 副本 */
function swiftSkillsRoot(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const localSwift = resolve(root, '../../skills');
  return isFile(join(localSwift, 'swift-usage', 'SKILL.md'))
    ? localSwift
    : join(root, 'public', 'skills', 'swift');
}

/**
 * 读一份技能的附属文档（agent 的 read_skill 工具后端）。按技能名在两组根里
 * 找（模型只看到技能名，不感知组）；路径钉死在技能目录内、只放行 .md——
 * 注入清单里的相对路径是唯一合法输入形态。
 */
function readSkillDocFile(skill: string, file: string): string | null {
  if (!skill || !file || !file.endsWith('.md')) return null;
  const root = dirname(fileURLToPath(import.meta.url));
  const bases = [swiftSkillsRoot(), join(root, 'public', 'skills', 'modelscope')];
  for (const base of bases) {
    const dir = join(base, skill);
    if (!isFile(join(dir, 'SKILL.md'))) continue;
    const abs = resolve(dir, file);
    if (abs !== dir && !abs.startsWith(dir + sep)) return null;
    if (!isFile(abs)) continue;
    return readFileSync(abs, 'utf-8');
  }
  return null;
}

function swiftApiPlugin(): Plugin {
  return {
    name: 'swift-api',
    configureServer(server) {
      /* 单实例锁先于一切：单写者文件面不允许双 webui 互踩 */
      acquireWebuiLock(server);
      /*
       * 回合引擎（单写者）：对话回合的执行体——页面提交与事件唤醒都由它跑，
       * convs.json 的 turns 桶只有它写。工具执行体经 apiBase() 自调用本机
       * HTTP（端口注入 globalThis），与浏览器同一执行面。
       */
      const port = server.config.server.port;
      (globalThis as { __WEBUI_PORT__?: number }).__WEBUI_PORT__ = typeof port === 'number' ? port : 5180;
      engine = createTurnEngine({
        readTurns: (conv, model) => {
          const c = readConvs();
          if (c === null) return null;
          return (c.turns[conv]?.[model] as ChatMessage[] | undefined) ?? [];
        },
        appendTurn: (conv, model, msg) => {
          const c = readConvs();
          /* 坏文件时抛错（回合失败、不落盘），禁止当空库把整库换成单回合桶 */
          if (c === null) throw new Error('convs.json unreadable');
          const buckets = { ...(c.turns[conv] ?? {}) } as Record<string, unknown[]>;
          buckets[model] = [...(buckets[model] ?? []), msg as unknown];
          writeConvs(c.chats, { ...c.turns, [conv]: buckets });
        },
        upsertChat: (conv, title) => {
          const c = readConvs();
          if (c === null) return; /* 坏文件不建档：回合照跑，元数据下次补 */
          const chats = [...c.chats] as Array<{ id?: unknown; title?: unknown; updatedAt?: unknown }>;
          const hit = chats.find((x) => x?.id === conv);
          if (hit) {
            hit.updatedAt = Date.now();
            if (title) hit.title = title;
          } else {
            chats.push({ id: conv, ...(title ? { title } : {}), updatedAt: Date.now() });
          }
          writeConvs(chats, c.turns);
        },
        loadModel: (modelId) => loadModels().find((m) => m.id === modelId),
        chatDefaults: () => (loadWebuiSettings() as { chatDefaults?: { temperature?: number; topP?: number; maxTokens?: number } }).chatDefaults ?? {},
        readExperimentsHead: () => {
          try {
            return readFileSync(join(workspaceRoot(), 'EXPERIMENTS.md'), 'utf-8').split('\n').slice(0, 60).join('\n');
          } catch {
            return '';
          }
        },
        summariesFile: () => join(swiftHome(), 'summaries.json'),
        dataDir: () => swiftHome(),
      });
      /*
       * 重启恢复两步，顺序即真相优先级：收编（活进程，最新真相）先，历史
       * 索引（终态快照，旧真相）后——同 id 活任务覆盖历史里的陈旧终态。
       */
      void (async () => {
        await adoptOrphanDeploys();
        await adoptOrphanTrainTasks();
        adoptOrphanScriptTasks();
        loadHistory();
      })();
      /*
       * autoresearch watcher：2s 一拍盯训练/评测状态跃迁，结论进事件队列。
       * server 关停时清掉定时器——vite 改配置重启会在同进程内重跑
       * configureServer，不清会叠出多个 watcher。
       */
      const researchTimer = setInterval(() => void researchTick(), 2000);
      server.httpServer?.on('close', () => clearInterval(researchTimer));
      /* 收编训练的运行期探活：5s 一拍（终态翻转不需要 2s 级敏捷），同上防叠加 */
      const trainAdoptTimer = setInterval(() => adoptTrainTick(), 5000);
      server.httpServer?.on('close', () => clearInterval(trainAdoptTimer));
      /*
       * 事件唤醒 tick：5s 一拍消费积压事件（研究事件 + 脚本事件）并交给回合
       * 引擎续轮。回合执行全在 server，不再有「浏览器在场让位」的分支——
       * 浏览器关闭/刷新只影响观看（SSE），不影响执行。MS 登录 token 模型
       * 例外：models.json 无 key 无法无头跑，事件留队等浏览器提交回合。
       */
      const turnTimer = setInterval(() => {
        void (async () => {
          if (!engine) return;
          const handledConvs = new Set<string>();
          for (const session of loadResearch()) {
            if (!session.convId || !session.modelId) continue;
            if (!session.events?.length && !convEvents.get(session.convId)?.length) continue;
            if (engine.busyConv(session.convId)) continue;
            const m = loadModels().find((x) => x.id === session.modelId);
            if (!m?.baseUrl || !m?.apiKey) continue; /* MS token 模型：事件留队 */
            /*
             * 事件取走挪进引擎占锁之后的 prepare：tick 与页面提交的竞态窗口
             * 里事件不会被「取走后丢弃」（runWakeupTurn 返回 false = 未取未跑，
             * 事件留队下一拍重试）。
             */
            const accepted = engine.runWakeupTurn(session.convId, session.modelId, async () => {
              const researchEvents = session.events?.length ? await takeResearchEvents(session.id) : [];
              const scriptEvents = takeConvEvents(session.convId);
              if (!researchEvents.length && !scriptEvents.length) return '';
              console.log(`[turn] 唤醒 ${session.id}（${researchEvents.length} 研究事件 + ${scriptEvents.length} 脚本事件）`);
              return [
                ...(researchEvents.length ? [composeWakeupMessage(session, researchEvents)] : []),
                ...(scriptEvents.length ? [composeScriptWakeupMessage(scriptEvents)] : []),
              ].join('\n\n');
            });
            if (accepted) handledConvs.add(session.convId);
          }
          /*
           * 非研究会话的积压脚本事件（普通对话里模型自己跑的后台脚本完成）：
           * 事件带 modelId 才能定位唤醒哪一列；无 modelId 的旧事件留队。
           */
          for (const conv of [...convEvents.keys()]) {
            if (handledConvs.has(conv)) continue; /* 研究循环已合并消费 */
            const queue = convEvents.get(conv) ?? [];
            const model = queue.find((e) => e.modelId)?.modelId;
            if (!model) continue;
            if (engine.busy(conv, model)) continue;
            const m = loadModels().find((x) => x.id === model);
            if (!m?.baseUrl || !m?.apiKey) continue;
            /* 事件取走放进引擎锁内（同上：占锁失败 = 事件未取，零丢失） */
            engine.runWakeupTurn(conv, model, () => {
              const scriptEvents = takeConvEvents(conv);
              console.log(`[turn] 唤醒 ${conv}（${scriptEvents.length} 脚本事件）`);
              return Promise.resolve(composeScriptWakeupMessage(scriptEvents));
            });
          }
        })();
      }, 5000);
      server.httpServer?.on('close', () => clearInterval(turnTimer));
      /*
       * 排障判别器（最前置）：所有进入的 /api 请求都留一行——请求只要到达
       * 容器必然被记录，用于裁决「报错发生但服务端无痕迹」类故障属于
       * 浏览器/网关层（没到达）还是中间件路由层（到达但被别处处理）。
       */
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith('/api/')) {
          console.log(`[api-req] ${req.method} ${req.url}`);
        }
        next();
      });
      server.middlewares.use('/api/models', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          if (req.method === 'GET') {
            /*
             * 本地部署类条目逐条探活（GET baseUrl/models，1.5s 超时、并发）：
             * 部署停止/死亡后登记不会立刻消失，让「登记还在、服务已死」变成
             * 页面上的可见状态。用户手动配置的远端 API 不探——那是用户自己
             * 保证的服务，探活反而会被网络抖动误报。探活失败也不删配置：
             * 删除权留在模型页的删除按钮；死部署另有启动收编负责清登记。
             */
            const raw = loadModels();
            const models = await Promise.all(
              raw.map(async (m) => {
                if (m.note !== 'swift 部署') return mask(m);
                let alive = false;
                try {
                  const probe = await fetch(`${m.baseUrl.replace(/\/+$/, '')}/models`, {
                    signal: AbortSignal.timeout(1500),
                  });
                  alive = probe.ok;
                } catch {
                  /* 超时 / 拒连 = 不可达 */
                }
                return { ...mask(m), alive };
              }),
            );
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ models }));
            return;
          }
          /*
           * 展览模式禁写：多用户共用运行机器，机器侧 models.json 是共享面，
           * 任何写入都会串到别人的会话里。列表照读（只读展示），增删一律 403。
           */
          if (launchMode() === 'expo' && (req.method === 'POST' || req.method === 'DELETE')) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: '展览模式不保存配置到运行机器' }));
            return;
          }
          if (req.method === 'POST') {
            const body = (await readJsonBody(req)) as StoredModel;
            if (!body.id || !body.baseUrl || !body.model) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'id / baseUrl / model 必填' }));
              return;
            }
            const models = loadModels();
            const prev = models.find((m) => m.id === body.id);
            // key 传空或掩码 = 沿用已存值（编辑时不重输 key）
            const apiKey =
              body.apiKey && body.apiKey !== MASK ? body.apiKey : prev?.apiKey ?? '';
            const next: StoredModel = { ...body, apiKey };
            const idx = models.findIndex((m) => m.id === body.id);
            if (idx >= 0) models[idx] = next;
            else models.push(next);
            saveModels(models);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE') {
            const id = url.searchParams.get('id');
            saveModels(loadModels().filter((m) => m.id !== id));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /** GPU 清单：GET /api/gpus（nvidia-smi 探测；无驱动/无卡返回空数组） */
      server.middlewares.use('/api/gpus', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const gpus = await queryGpus();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ gpus }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 运行环境：GET /api/env（agent 的 env_info 工具）。GPU 清单 + swift
       * 版本/安装路径 + python 解释器——规划训练/部署的用卡与分片前一次拿全，
       * 免得模型拿 nvidia-smi / python -c 一条条试探（每条都要审批）。
       */
      server.middlewares.use('/api/env', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.end();
          return;
        }
        try {
          const [gpus, swift, evalscope, benchmarks] = await Promise.all([
            queryGpus(),
            probeSwiftEnv(),
            probeEvalscope(),
            probeBenchmarks(),
          ]);
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              gpus,
              python: resolvePython(),
              swift,
              evalscope,
              /* evalscope 基准注册表：名 → subset 值域（--eval_dataset 合法名 + subset_list 可选值；null=探测不可达） */
              benchmarks,
              /* 模型缓存根 + 已缓存清单：自建评测/部署要磁盘权重路径，别再逐层 find */
              modelCache: modelCacheRoot(),
              cachedModels: cachedHubModels(),
            }),
          );
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 外部数据目录登记：GET 列表 / POST 添加（body: { path }）/ DELETE ?path=。
       * 登记的是运行机器上的目录，agent 文件工具对它们只读放行（探查原始数据
       * 写前处理脚本用）。展览模式下机器侧文件是共享面：读空、写 403。
       */
      server.middlewares.use('/api/data-roots', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ roots: launchMode() === 'expo' ? [] : loadDataRoots() }));
            return;
          }
          if (req.method === 'POST') {
            if (launchMode() === 'expo') {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '展览模式不保存配置到运行机器' }));
              return;
            }
            const body = (await readJsonBody(req)) as { path?: string };
            const raw = String(body.path ?? '').trim();
            if (!raw) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'path 必填' }));
              return;
            }
            const abs = resolve(raw);
            if (abs === sep) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '不能登记文件系统根目录' }));
              return;
            }
            if (!existsSync(abs) || !statSync(abs).isDirectory()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `目录不存在: ${abs}` }));
              return;
            }
            const roots = loadDataRoots();
            if (!roots.includes(abs)) saveDataRoots([...roots, abs]);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ roots: loadDataRoots() }));
            return;
          }
          if (req.method === 'DELETE') {
            const target = url.searchParams.get('path') ?? '';
            saveDataRoots(loadDataRoots().filter((r) => r !== target));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /** 部署任务：GET 列表 / POST 新建 / :id/log 日志 / DELETE 停止 */
      server.middlewares.use('/api/deploy', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const taskId = segs[0];

          if (req.method === 'GET' && !taskId) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ tasks: [...deployTasks.values()].map(publicTask) }));
            return;
          }
          if (req.method === 'GET' && taskId && segs[1] === 'log') {
            const task = deployTasks.get(taskId);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown deploy task' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ lines: task.log }));
            return;
          }
          if (req.method === 'POST' && !taskId) {
            const body = await readJsonBody(req);
            const { id, model, engine, servedName, adapters } = startDeployTask(body);
            const port = Number(body.port) > 0 ? Number(body.port) : await pickFreePort(8100);
            /*
             * 显卡分配两模式：本机选卡的卡号列表进 CUDA_VISIBLE_DEVICES；
             * 集群模式只声明卡数（远端资源由集群调度，本机不设 CUDA 限制）。
             * 卡数的权威入口是 --nproc_per_node（sampler DeviceGroup 的 ranks）：
             * Ray 据此把 N 张卡分给 sampler actor，vLLM 引擎从 actor 可见卡
             * 自动推出张量并行数。不能只传 --vllm_tensor_parallel_size——它只是
             * 引擎层声明，不会让 Ray 多分卡，actor 仍只拿到一张卡时 TP>1 必然
             * 断言失败（visible devices 1 < local_world_size N）。
             */
            const gpus = Array.isArray(body.gpus)
              ? [...new Set(body.gpus.map(Number).filter((n) => Number.isInteger(n) && n >= 0))].sort(
                  (a, b) => a - b,
                )
              : undefined;
            const gpuCount =
              !gpus?.length && Number.isInteger(body.gpuCount) && body.gpuCount > 0
                ? body.gpuCount
                : undefined;
            const nproc = gpus?.length ?? gpuCount ?? 0;
            /* 卡位与磁盘守卫：冲突/水位不足在提交时挡下（409），不留给 OOM 事后排障 */
            const gpuConflict = gpuConflictError(gpus);
            if (gpuConflict) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: gpuConflict }));
              return;
            }
            const diskShort = diskGuardError();
            if (diskShort) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: diskShort }));
              return;
            }
            /* 「将要执行」直写的附加参数（引号包着的带空格值支持） */
            const extraArgs = splitExtraArgs(String(body.extraArgs ?? ''));
            const plugins = (Array.isArray(body.plugins) ? body.plugins : [])
              .map((p: unknown) => String(p ?? '').trim())
              .filter(Boolean);
            const task: DeployTask & { proc?: ChildProcess } = {
              id,
              servedName,
              model,
              engine,
              port,
              status: 'starting',
              startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
              log: [],
              registered: false,
              ...(gpus?.length ? { gpus } : {}),
              ...(gpuCount ? { gpuCount } : {}),
              ...(plugins.length ? { plugins } : {}),
              ...(adapters.length ? { adapters } : {}),
              ...(extraArgs.length ? { extraArgs: String(body.extraArgs).trim() } : {}),
            };
            deployTasks.set(id, task);
            const spawnArgs = [
              '-m', 'swift.dev.cli.deploy',
              '--model', model,
              '--infer_backend', engine,
              '--served_model_name', servedName,
              /* 多 adapter 直出多个值（HfArgumentParser nargs），name=path 语法由 config 层统一解析 */
              ...(adapters.length ? ['--adapters', ...adapters] : []),
              '--port', String(port),
              ...(nproc > 1 ? ['--nproc_per_node', String(nproc)] : []),
              ...(plugins.length ? ['--external_plugins', ...plugins] : []),
              ...extraArgs,
            ];
            const proc = spawn(resolvePython(), spawnArgs, {
              cwd: taskCwd(),
              env: {
                ...spawnEnv(),
                USE_SWIFT_V5: '1',
                ...(gpus?.length ? { CUDA_VISIBLE_DEVICES: gpus.join(',') } : {}),
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            task.proc = proc;
            task.pid = proc.pid;
            pushLog(
              task,
              `$ ${gpus?.length ? `CUDA_VISIBLE_DEVICES=${gpus.join(',')} ` : ''}${resolvePython()} ${spawnArgs.join(' ')}`,
            );
            const onChunk = (buf: Buffer) => buf.toString('utf-8').split('\n').filter(Boolean).forEach((l) => pushLog(task, l));
            proc.stdout?.on('data', onChunk);
            proc.stderr?.on('data', onChunk);
            /*
             * spawn 失败（如解释器路径失效）只发 error + close，不发 exit——
             * 其余四类执行器都有这段，deploy 漏了会让 error 变 uncaught
             * exception 直接崩掉 dev server，连带杀死全部在跑任务的监管。
             */
            proc.on('error', (e) => {
              pushLog(task, `[webui] deploy spawn 失败: ${e}`);
              task.status = 'failed';
              const { proc: _p, log: _l, ...snap } = task;
              recordHistory('deploy', snap as Record<string, unknown>);
            });
            proc.on('exit', (code) => {
              if (task.status === 'starting' || task.status === 'running') {
                /* 成败只看退出码：曾就绪过的部署失败退出同样是失败，不是「已停止」；
                   用户主动停止走 DELETE，那里先把状态置成 stopped，不会进这个分支 */
                task.status = code === 0 ? 'stopped' : 'failed';
                if (code !== 0) pushLog(task, `[webui] deploy process exited with code ${code}`);
              }
              unregisterDeployedModel(task);
              const { proc: _proc, log: _log, ...deploySnapshot } = task;
              recordHistory('deploy', deploySnapshot as Record<string, unknown>);
            });
            void waitUntilReady(task);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id }));
            return;
          }
          /* 重命名：只改 webui 里的显示名，不触碰任务本体与登记 */
          if (req.method === 'PATCH' && taskId) {
            const task = deployTasks.get(taskId);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown deploy task' }));
              return;
            }
            const body = (await readJsonBody(req)) as { name?: string };
            const name = String(body.name ?? '').trim();
            if (!name) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'name is required' }));
              return;
            }
            task.name = name;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE' && taskId) {
            const task = deployTasks.get(taskId);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown deploy task' }));
              return;
            }
            if (task.status === 'starting' || task.status === 'running') {
              /*
               * 正常任务有子进程句柄，kill 后 exit 回调会置 stopped 并摘除登记；
               * 重启收编的孤儿没有句柄，只有记下的 pid——kill 后主动收尾。
               */
              if (task.proc) {
                task.proc.kill('SIGTERM');
              } else if (task.pid) {
                try {
                  process.kill(task.pid, 'SIGTERM');
                } catch {
                  /* 进程已不在：直接收尾 */
                }
                task.status = 'stopped';
                unregisterDeployedModel(task);
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 评测任务：GET 列表 / GET datasets 数据集注册表 / :id/log 日志 /
       * POST 新建（body: { modelId, items: [{dataset, limit?}] }）/ DELETE :id 停止。
       * 'datasets' 走 segs[0]，与任务 id（eval-* 前缀）不冲突。
       */
      server.middlewares.use('/api/eval', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          if (req.method === 'GET' && seg0 === 'datasets') {
            const datasets = await listEvalDatasets();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ datasets }));
            return;
          }
          if (req.method === 'GET' && !seg0) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ tasks: [...evalTasks.values()].map(publicEvalTask) }));
            return;
          }
          if (req.method === 'GET' && seg0 && segs[1] === 'log') {
            const task = evalTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown eval task' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ lines: task.log }));
            return;
          }
          if (req.method === 'POST' && !seg0) {
            const body = await readJsonBody(req);
            /*
             * 两形态互斥：api 模式（models.json 的 modelId）或本地直评
             * （local: { model, adapters?, gpus? }——底座 + checkpoint 直接评）。
             * 本地模式给 autoresearch watcher 与 agent 用，也允许评测页手填。
             */
            const localBody =
              body.local && typeof body.local === 'object' && !Array.isArray(body.local) ? body.local : null;
            const local = localBody
              ? {
                  model: String(localBody.model ?? '').trim(),
                  adapters: (Array.isArray(localBody.adapters) ? localBody.adapters : [])
                    .map((a: unknown) => String(a ?? '').trim())
                    .filter(Boolean),
                  gpus: (Array.isArray(localBody.gpus) ? localBody.gpus : [])
                    .map((g: unknown) => Number(g))
                    .filter((g: number) => Number.isInteger(g) && g >= 0),
                }
              : undefined;
            if (local && !local.model) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '本地直评需要 local.model（底座模型）' }));
              return;
            }
            const config = local ? undefined : loadModels().find((m) => m.id === body.modelId);
            if (!local && !config) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `未配置的模型: ${body.modelId}` }));
              return;
            }
            const items = (Array.isArray(body.items) ? body.items : [])
              .map((it: { dataset?: unknown; limit?: unknown }) => ({
                dataset: String(it?.dataset ?? ''),
                limit: Number.isInteger(it?.limit) && (it?.limit as number) > 0 ? (it?.limit as number) : undefined,
              }))
              .filter((it: EvalItem) => it.dataset);
            const extraArgs = String(body.extraArgs ?? '').trim() || undefined;
            const plugins = (Array.isArray(body.plugins) ? body.plugins : [])
              .map((p: unknown) => String(p ?? '').trim())
              .filter(Boolean);
            if (!items.length) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '至少选择一个评测集' }));
              return;
            }
            /*
             * 本地直评是占卡作业（api 模式打的是远端端点）：与训练/导出/部署
             * 同一道卡位/磁盘守卫——此前评测「卫人而不被人卫」，手动提交可与
             * 在跑训练撞卡（watcher 的自动路径自己挑了空闲卡，不受此影响）。
             */
            const evalGuardErr = gpuConflictError(local?.gpus) ?? diskGuardError();
            if (evalGuardErr) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: evalGuardErr }));
              return;
            }
            const id = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const dir = join(swiftHome(), 'eval', id);
            mkdirSync(dir, { recursive: true });
            const task: EvalTask = {
              id,
              modelId: local ? `local:${local.model}` : config!.id,
              model: local ? local.model : config!.model,
              baseUrl: local ? '' : config!.baseUrl.replace(/\/+$/, ''),
              items,
              current: 0,
              status: 'starting',
              startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
              log: [],
              outputDir: join(dir, 'output'),
              resultJsonl: join(dir, 'results.jsonl'),
              ...(local ? { local } : {}),
              ...(plugins.length ? { plugins } : {}),
              ...(extraArgs ? { extraArgs } : {}),
            };
            evalTasks.set(id, task);
            void runEvalChain(task);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id }));
            return;
          }
          /* 重命名：只改 webui 里的显示名，不触碰任务本体与结果文件 */
          if (req.method === 'PATCH' && seg0) {
            const task = evalTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown eval task' }));
              return;
            }
            const body = (await readJsonBody(req)) as { name?: string };
            const name = String(body.name ?? '').trim();
            if (!name) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'name is required' }));
              return;
            }
            task.name = name;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE' && seg0) {
            const task = evalTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown eval task' }));
              return;
            }
            /* 已终态的任务没有可停的进程，不改写终态（否则 done 会被改成 stopped） */
            if (task.status === 'starting' || task.status === 'running') {
              task.status = 'stopped';
              task.proc?.kill('SIGTERM');
              pushEvalLog(task, '[webui] 用户停止评测');
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 导出任务：GET 列表 / :id/log 日志 / POST 新建（body 见 startExport 入参）/
       * PATCH :id 重命名 / DELETE :id 停止。导出是有限作业，没有 starting 态。
       */
      server.middlewares.use('/api/export', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          if (req.method === 'GET' && !seg0) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ tasks: [...exportTasks.values()].map(publicExportTask) }));
            return;
          }
          if (req.method === 'GET' && seg0 && segs[1] === 'log') {
            const task = exportTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown export task' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ lines: task.log }));
            return;
          }
          if (req.method === 'POST' && !seg0) {
            const body = await readJsonBody(req);
            const model = String(body.model ?? '').trim();
            const adapters = String(body.adapters ?? '').trim() || undefined;
            const mergeLora = Boolean(body.mergeLora);
            const quantMethod =
              body.quantMethod === 'awq' || body.quantMethod === 'gptq' || body.quantMethod === 'bnb'
                ? body.quantMethod
                : undefined;
            const calibDataset = String(body.calibDataset ?? '').trim() || undefined;
            const pushToHub = Boolean(body.pushToHub);
            const hubModelId = String(body.hubModelId ?? '').trim() || undefined;
            const gpus = (Array.isArray(body.gpus) ? body.gpus : [])
              .map((g: unknown) => Number(g))
              .filter((g: number) => Number.isInteger(g) && g >= 0);
            const plugins = (Array.isArray(body.plugins) ? body.plugins : [])
              .map((p: unknown) => String(p ?? '').trim())
              .filter(Boolean);
            const extraArgs = String(body.extraArgs ?? '').trim() || undefined;
            /* 卡位与磁盘守卫：导出要加载模型，与训练同属重作业 */
            const guardErr = gpuConflictError(gpus) ?? diskGuardError();
            if (guardErr) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: guardErr }));
              return;
            }
            /* 与 CLI 的 _validate_export 同一套早失败，把报错留在提交时刻 */
            if (!model) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '底座模型必填' }));
              return;
            }
            if (!mergeLora && !quantMethod && !pushToHub) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '至少选择一个导出操作（合并 / 量化 / 推送）' }));
              return;
            }
            if (mergeLora && !adapters) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '合并 LoRA 需要填 adapter（训练 checkpoint）路径' }));
              return;
            }
            if ((quantMethod === 'awq' || quantMethod === 'gptq') && !calibDataset) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `${quantMethod} 量化需要校准数据集` }));
              return;
            }
            if (pushToHub && !hubModelId) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '推送 Hub 需要填 hub_model_id' }));
              return;
            }
            const id = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const task: ExportTask = {
              id,
              model,
              ...(adapters ? { adapters } : {}),
              mergeLora,
              ...(quantMethod ? { quantMethod, ...(calibDataset ? { calibDataset } : {}) } : {}),
              pushToHub,
              ...(hubModelId ? { hubModelId } : {}),
              ...(gpus.length ? { gpus } : {}),
              ...(plugins.length ? { plugins } : {}),
              ...(extraArgs ? { extraArgs } : {}),
              outputDir: join(swiftHome(), 'export', id, 'output'),
              status: 'running',
              startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
              log: [],
            };
            exportTasks.set(id, task);
            runExportTask(task);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id }));
            return;
          }
          /* 重命名：只改 webui 里的显示名，不触碰任务本体与产物 */
          if (req.method === 'PATCH' && seg0) {
            const task = exportTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown export task' }));
              return;
            }
            const body = (await readJsonBody(req)) as { name?: string };
            const name = String(body.name ?? '').trim();
            if (!name) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'name is required' }));
              return;
            }
            task.name = name;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE' && seg0) {
            const task = exportTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown export task' }));
              return;
            }
            if (task.status === 'running') {
              task.status = 'stopped';
              task.proc?.kill('SIGTERM');
              pushExportLog(task, '[webui] 用户停止导出');
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 候选清单：新建页可搜索下拉的数据源。真相源是 swift 的模型/数据集注册
       * 表（MODEL_MAPPING / DATASET_MAPPING），探测一次后缓存——swift 新增
       * 模型后重启 webui 即自动出现，无需改前端。
       */
      server.middlewares.use('/api/catalog', async (_req, res) => {
        try {
          const catalog = await listCatalog();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(catalog));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /*
       * 技能清单：GET /api/skills 列表 / GET /api/skills/doc?skill=&file= 附属
       * 文档正文。首页把每份 skill 的 SKILL.md 注入 system 上下文（附属文件
       * 只报清单，不进上下文——skill 本身就是渐进展开结构）；模型按需用
       * read_skill 工具取深度文档，不然清单挂在那里却物理不可达，会被模型
       * 拿 read_file/shell 乱翻工作空间。路径无前缀撞车，注册位置不构成安全边界。
       */
      server.middlewares.use('/api/skills', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          if (req.method === 'GET' && segs[0] === 'doc') {
            const content = readSkillDocFile(
              url.searchParams.get('skill') ?? '',
              url.searchParams.get('file') ?? '',
            );
            if (content === null) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '没有这份技能文档（只放行清单里列出的 .md 附属文件）' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ content }));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ skills: listSkills() }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /*
       * 启动模式：GET /api/mode → { mode }。前端 boot 时读一次决定展览形态。
       * 注意挂载路径是 /api/models 的字符串前缀（'mode' + 'ls'），必须注册在
       * /api/models 之后——那边所有分支都终结响应，这里的顺序才不构成拦截。
       */
      server.middlewares.use('/api/mode', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ mode: launchMode() }));
      });

      /*
       * 首页默认模型：GET /api/ms-models → { models, default, source }。
       * 两种模式都可调用（normal 模式前端不消费），dolphin 不可达时走兜底。
       */
      server.middlewares.use('/api/ms-models', async (_req, res) => {
        try {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(await listMsDefaultModels()));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });


      /*
       * 全局偏好：GET 全量读 / POST 全量写（~/.swift/webui-settings.json）。
       * 全量语义最简单——前端持整份状态，改一个字段也 POST 整份；无并发写方，
       * 无需局部更新。路径无前缀撞车（没有其它 /api/settings* 端点）。
       */
      server.middlewares.use('/api/settings', async (req, res) => {
        try {
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            /*
             * 展览模式返回空对象（= 前端全默认）：webui-settings.json 是机器侧
             * 共享文件，读它会把他人/历史配置带进展览会话；写它更会互相覆盖。
             * 前端在展览模式下把改动全部留在浏览器会话内存。
             */
            res.end(JSON.stringify(launchMode() === 'expo' ? {} : loadWebuiSettings()));
            return;
          }
          if (req.method === 'POST') {
            if (launchMode() === 'expo') {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '展览模式不保存配置到运行机器' }));
              return;
            }
            const body = await readJsonBody(req);
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'settings body must be an object' }));
              return;
            }
            saveWebuiSettings(body as Record<string, unknown>);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 插件登记：GET 列表 / POST upsert（body: { id?, source, tags?, note? }）/
       * DELETE :id。单中间件内部按剩余段分发（对齐 eval/export，避开前缀撞车）。
       */
      server.middlewares.use('/api/plugins', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          if (req.method === 'GET' && !seg0) {
            res.setHeader('Content-Type', 'application/json');
            /* 登记条目 + 工作空间 plugins/ 扫描（agent 产出），同名不覆盖 */
            res.end(JSON.stringify({ plugins: [...loadPlugins(), ...workspacePlugins()] }));
            return;
          }
          if (req.method === 'POST' && !seg0) {
            const body = await readJsonBody(req);
            const source = String(body.source ?? '').trim();
            if (!source) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'source is required' }));
              return;
            }
            const id = String(body.id ?? '').trim() || source;
            const tags = (Array.isArray(body.tags) ? body.tags : []).map((t: unknown) => String(t).trim()).filter(Boolean);
            const note = String(body.note ?? '').trim() || undefined;
            savePlugins([...loadPlugins().filter((p) => p.id !== id), { id, source, tags, ...(note ? { note } : {}) }]);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE' && seg0) {
            savePlugins(loadPlugins().filter((p) => p.id !== seg0));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /*
       * 编排页常驻会话：一 workflow key 一个常驻 python -m swift.dev.webui.session
       * 子进程（stdin JSONL 命令 / stdout [workflow] {json} 事件）。模型、数据集、
       * 采样器、iterator 全部留在会话进程里；再次点击只发 run 命令，不再 spawn、
       * 不再重建资源。DELETE 只停止本次图调用（会话与常驻资源保留）；POST
       * release 才终止 source 并关闭资源。浏览器断连不释放。
       */
      interface WorkflowSession {
        id: string;
        /** 画布工作流 key（草稿 id）：同 key 复用同一常驻会话 */
        key: string;
        /** 会话目录（workspaceRoot 下）：graph.json 副本 + log.txt */
        dir: string;
        /** 会话进程上报的状态机（session.py 的 STATES） */
        state: string;
        startedAt: string;
        /** stdout 原始行（事件 + 命令回执），环形有界 */
        log: string[];
        /** 解析出的 [workflow] JSON 事件，环形有界 */
        events: any[];
        /** node 事件推进的节点状态（真实调用前后驱动，非日志猜测） */
        nodesDone: string[];
        nodesRunning: string[];
        nodesFailed: string[];
        activeNodes: string[];
        activeEdges: string[];
        usedEdges: string[];
        requestId?: string;
        /** 本次终态独立保存，不能被日志事件环淘汰 */
        runEnd?: any;
        proc?: ChildProcess;
        /** 命令序号：request_id 去重的来源 */
        seq: number;
        lastRun?: { target?: string; mode: string };
        /** 最近一次提交生效的资源声明（本机选卡 / 集群地址+卡数）：页面回到实验时回填资源页 */
        resource?: any;
      }

      const workflowSessions = new Map<string, WorkflowSession>(); // id -> session
      const workflowKeys = new Map<string, string>(); // key -> session id

      const WORKFLOW_EVENT_LIMIT = 500;

      /* stdout 一行：[workflow] {json} 是事件/回执，其余为噪声只进日志环 */
      function handleSessionLine(session: WorkflowSession, line: string): void {
        session.log.push(line);
        if (session.log.length > 500) session.log.splice(0, session.log.length - 500);
        try {
          appendFileSync(join(session.dir, 'log.txt'), `${line}\n`, 'utf-8');
        } catch {
          /* 盘上副本尽力而为；内存环形仍是主路径 */
        }
        if (!line.startsWith('[workflow] ')) return;
        let ev: any;
        try {
          ev = JSON.parse(line.slice('[workflow] '.length));
        } catch {
          return;
        }
        session.events.push(ev);
        if (session.events.length > WORKFLOW_EVENT_LIMIT) {
          session.events.splice(0, session.events.length - WORKFLOW_EVENT_LIMIT);
        }
        const runEvent = ['run_begin', 'run_plan', 'node', 'edge', 'run_end'].includes(ev.event);
        if (runEvent && ev.request_id !== session.requestId) return;
        if (ev.event === 'run_begin') {
          session.nodesDone = [];
          session.nodesRunning = [];
          session.nodesFailed = [];
          session.activeNodes = [];
          session.activeEdges = [];
          session.usedEdges = [];
        } else if (ev.event === 'run_plan') {
          session.activeNodes = Array.isArray(ev.nodes) ? ev.nodes : [];
          session.activeEdges = Array.isArray(ev.edges) ? ev.edges : [];
        } else if (ev.event === 'edge' && ev.state === 'used' && ev.edge_id) {
          if (!session.usedEdges.includes(ev.edge_id)) session.usedEdges.push(ev.edge_id);
        } else if (ev.event === 'node' && ev.node_id) {
          const id = String(ev.node_id);
          session.nodesRunning = session.nodesRunning.filter((x) => x !== id);
          session.nodesDone = session.nodesDone.filter((x) => x !== id);
          session.nodesFailed = session.nodesFailed.filter((x) => x !== id);
          if (ev.state === 'running') session.nodesRunning.push(id);
          else if (ev.state === 'completed' || ev.state === 'cached') session.nodesDone.push(id);
          else if (ev.state === 'failed') session.nodesFailed.push(id);
        }
        if (ev.event === 'run_end') {
          session.runEnd = ev;
          session.nodesRunning = [];
        } else if (ev.event === 'reply' && ev.op === 'run'
                   && ev.request_id === session.requestId && !ev.ok && !session.runEnd) {
          // 被拒绝的 run 没有 run_begin/run_end，也必须有可观察的终态。
          session.runEnd = { ...ev, event: 'run_end', state: 'failed' };
          session.nodesRunning = [];
          session.state = 'failed';
        }
        // 节点/边的状态不是会话状态；冷启动 idle 也不能结束已排队的请求。
        if (['run_begin', 'run_end', 'stop', 'release_begin', 'release_end', 'session_exit',
             'pause', 'resume', 'paused', 'resumed'].includes(ev.event)
            || (ev.event === 'session' && session.state !== 'queued' && !session.requestId)) {
          if (typeof ev.state === 'string') session.state = ev.state;
        }
      }

      /* 发一条 stdin 命令；request_id 由序号生成，session 侧去重 */
      function sendSessionCommand(session: WorkflowSession, cmd: Record<string, unknown>): string | null {
        const proc = session.proc;
        if (!proc || !proc.stdin || proc.exitCode !== null || proc.killed) return null;
        session.seq += 1;
        const requestId = `${session.id}-${session.seq}`;
        const payload = { ...cmd, request_id: requestId };
        if (cmd.op === 'run') session.requestId = requestId;
        try {
          proc.stdin.write(JSON.stringify(payload) + '\n');
        } catch {
          return null;
        }
        return requestId;
      }

      /* 仅启动/复用进程；调用入口取得 busy 锁后才发送 update/run。GPU 分配是
       * 声明 resource 段的一部分：session 自己从 graph.json 读取（本机选卡时
       * 子进程内设 CUDA_VISIBLE_DEVICES，集群模式 ray.init(address)），中间件
       * 不再另设一条选卡通道。 */
      function ensureSession(key: string, graph: { nodes: any[]; edges: any[]; resource?: any }): WorkflowSession {
        const existing = workflowKeys.get(key);
        const live = existing ? workflowSessions.get(existing) : undefined;
        if (live && live.proc && live.proc.exitCode === null && !live.proc.killed
            && !['released', 'lost'].includes(live.state)) {
          return live;
        }
        /*
         * 编排会话复用任务守卫：graph 的 resource 段声明本机选卡（resource.gpus
         * 数字数组）时查卡位冲突；新建会话要跑训练/导出节点，水位同样要查。
         * 抛错由外层路由的 catch 统一回给提交方（fail loudly，带可行动文案）。
         */
        const declaredGpus = Array.isArray(graph?.resource?.gpus)
          ? (graph.resource.gpus as unknown[]).map((g) => Number(g)).filter((g) => Number.isInteger(g) && g >= 0)
          : undefined;
        const guardErr = gpuConflictError(declaredGpus) ?? diskGuardError();
        if (guardErr) throw new Error(guardErr);
        const id = `wf-s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const dir = join(workspaceRoot(), 'workflow-sessions', key || id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf-8');
        const session: WorkflowSession = {
          id, key, dir, state: 'idle',
          startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          log: [], events: [], nodesDone: [], nodesRunning: [], nodesFailed: [],
          activeNodes: [], activeEdges: [], usedEdges: [], seq: 0,
          resource: graph.resource,
        };
        const proc = spawn(resolvePython(), ['-m', 'swift.dev.webui.session', join(dir, 'graph.json')], {
          cwd: dir,
          env: {
            /* 与其余执行器同一环境源：解释器选谁，PATH 就优先谁的 bin（spawnEnv） */
            ...spawnEnv(),
            USE_SWIFT_V5: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        session.proc = proc;
        workflowSessions.set(id, session);
        if (key) workflowKeys.set(key, id);
        /* 解码器保留跨 chunk 的 UTF-8 字节；两条流分别缓存未完成行。 */
        for (const stream of [proc.stdout, proc.stderr]) {
          const decoder = new StringDecoder('utf8');
          let pending = '';
          const consume = (text: string) => {
            pending += text;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            lines.forEach((line) => line && handleSessionLine(session, line));
          };
          stream?.on('data', (buf: Buffer) => consume(decoder.write(buf)));
          stream?.on('end', () => {
            consume(decoder.end());
            if (pending) handleSessionLine(session, pending);
            pending = '';
          });
        }
        proc.stdin?.on('error', (error) => {
          session.state = 'lost';
          handleSessionLine(session, `[webui] 会话命令管道异常：${error.message}`);
        });
        proc.on('error', (error) => {
          session.state = 'lost';
          handleSessionLine(session, `[webui] 会话进程异常：${error.message}`);
        });
        // close 在 stdout/stderr 排空后触发，末尾的 run_end 不会被退出事件覆盖。
        proc.on('close', (code) => {
          handleSessionLine(session, `[workflow] ${JSON.stringify({
            event: 'session_exit', state: code === 0 ? 'released' : 'lost', exit: code,
          })}`);
        });
        return session;
      }

      /* 查会话：内存命中；进程已死且状态非 released → lost（进程丢失明确显示，
       * 不能按退出码自动重发训练）。 */
      function resolveWorkflowSession(id: string): WorkflowSession | null {
        const session = workflowSessions.get(id);
        if (!session) return null;
        if ((!session.proc || session.proc.exitCode !== null)
            && !['released', 'lost'].includes(session.state)) {
          session.state = 'lost';
        }
        return session;
      }

      /* 会话的公开形态（GET 回给前端的字段镜像） */
      function publicSession(session: WorkflowSession): Record<string, any> {
        return {
          id: session.id, key: session.key, state: session.state,
          startedAt: session.startedAt, nodesDone: [...session.nodesDone],
          nodesRunning: [...session.nodesRunning], nodesFailed: [...session.nodesFailed],
          activeNodes: [...session.activeNodes], activeEdges: [...session.activeEdges],
          usedEdges: [...session.usedEdges], request_id: session.requestId,
          runEnd: session.runEnd, command_seq: session.seq,
          lastRun: session.lastRun, eventCount: session.events.length,
          resource: session.resource,
        };
      }

      /*
       * 从会话日志提取真实的失败原因：bootstrap / 运行期崩溃的 Traceback 走
       * stderr 进日志环，HTTP 层若只回笼统文案，用户就看不到「选卡不足」这类
       * 自己就能解决的问题。取最后一个 Traceback 块的异常行；环形缓冲把头
       * 裁掉了就退化为扫尾部最近一条异常形态的行。
       */
      function lastSessionError(session: WorkflowSession): string | null {
        const lines = session.log;
        const tb = lines.lastIndexOf('Traceback (most recent call last):');
        if (tb >= 0) {
          for (let i = lines.length - 1; i > tb; i--) {
            const line = lines[i];
            if (!/^\s/.test(line) && /\w+(Error|Exception)\b/.test(line)) {
              return line.trim();
            }
          }
        }
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60) && i >= 0; i--) {
          const line = lines[i];
          if (/\S*(Error|Exception)\S*:/.test(line)) return line.trim();
        }
        return null;
      }

      /* 画布声明的双形态归一：params 数组（label/value）或 dict；边字段 from/to 双兼容。
       * dict 形态的参数值保持原类型（不统一 String）；frames/edge id/slot 原样透传；
       * resource 段（本机选卡 / 集群地址+卡数）属于会话的放置规划输入，中间件无权
       * 丢弃也无权改写——session 靠它规划 DeviceGroup，丢了就是「没有 GPU 分配」。 */
      function normalizeGraph(graph: any): {
        version: number; workflow_id: string; nodes: any[]; edges: any[]; frames?: any[];
        resource?: any;
      } {
        const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : [])
          .map((n: any) => {
            const params: Record<string, unknown> = {};
            const raw = n?.params;
            if (Array.isArray(raw)) {
              raw.forEach((p: any) => {
                if (p?.label != null) params[String(p.label)] = String(p.value ?? '');
              });
            } else if (raw && typeof raw === 'object') {
              Object.entries(raw).forEach(([k, v]) => {
                params[k] = v ?? '';
              });
            }
            const node: Record<string, unknown> = {
              id: String(n?.id ?? ''), type: String(n?.type ?? ''), params,
            };
            if (n?.code) node.code = String(n.code);
            return node;
          })
          .filter((n: any) => n.id && n.type);
        const edges = (Array.isArray(graph?.edges) ? graph.edges : [])
          .map((e: any) => {
            const edge: Record<string, unknown> = {
              id: String(e?.id ?? `${e?.source}:${e?.source_port ?? ''}->${e?.target}:${e?.target_port ?? ''}`),
              source: String(e?.source ?? e?.from ?? ''),
              source_port: String(e?.source_port ?? e?.fromPort ?? ''),
              target: String(e?.target ?? e?.to ?? ''),
              target_port: String(e?.target_port ?? e?.toPort ?? ''),
            };
            if (e?.slot) edge.slot = String(e.slot);
            return edge;
          })
          .filter((e: any) => e.source && e.target);
        const frames = Array.isArray(graph?.frames) ? graph.frames : undefined;
        /* version/workflow_id 透传：session 只认声明版本且要求非空身份，剥掉它们
         * 等于把每张合法图变成「旧图必须显式升级」的拒绝——中间件无权改写声明。 */
        const version = Number.isInteger(graph?.version) ? graph.version : 3;
        const workflowId = String(graph?.workflow_id ?? '').trim();
        const resource = graph?.resource && typeof graph.resource === 'object'
          ? graph.resource : undefined;
        return {
          version, workflow_id: workflowId,
          ...(frames ? { frames } : {}), ...(resource ? { resource } : {}),
          nodes, edges,
        };
      }

      /* 等一条命令回执：session 的 stdout 会把带 request_id/op 的 reply 写回事件流 */
      async function waitForReply(session: WorkflowSession, requestId: string,
                                  timeoutMs: number): Promise<any> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          for (let i = session.events.length - 1; i >= 0; i--) {
            const ev = session.events[i];
            if (ev && ev.event === 'reply' && ev.request_id === requestId) return ev;
          }
          if (['lost', 'released'].includes(session.state)) return null;
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      }

      /* 编排实验 CRUD：脚手架是初始状态，实验本体持久在 ~/.swift/flows.json */
      server.middlewares.use('/api/flows', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];
          const flows = loadFlows();
          if (req.method === 'GET' && !seg0) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              /* 每个实验附它的常驻会话状态（仅进程活着的）：列表页据此显示
               * 「资源占用中/运行中」并给出释放入口——释放是归还显存的唯一
               * 通道，只藏在编辑页里用户找不到。 */
              flows: flows.map((f) => {
                const sessionId = workflowKeys.get(f.id);
                const session = sessionId ? workflowSessions.get(sessionId) : undefined;
                const alive = session && session.proc && session.proc.exitCode === null
                  && !['released', 'lost'].includes(session.state);
                return {
                  id: f.id, name: f.name, preset: f.preset, updatedAt: f.updatedAt,
                  ...(alive ? { session: { id: session!.id, state: session!.state } } : {}),
                };
              }),
            }));
            return;
          }
          if (req.method === 'POST' && !seg0) {
            const body = await readJsonBody(req);
            const graph = body?.graph;
            if (!graph || !Array.isArray(graph.nodes)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '创建编排需要画布声明（nodes 数组，可为空=空白画布）' }));
              return;
            }
            const now = new Date().toISOString();
            const flow: StoredFlow = {
              id: `flow-${randomUUID().slice(0, 8)}`,
              name: String(body?.name ?? '').trim() || '未命名编排',
              preset: String(body?.preset ?? ''),
              graph,
              createdAt: now,
              updatedAt: now,
            };
            flows.unshift(flow);
            saveFlows(flows);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id: flow.id, name: flow.name }));
            return;
          }
          const flow = flows.find((f) => f.id === seg0);
          if (!flow) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'unknown flow' }));
            return;
          }
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ flow }));
            return;
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req);
            if (typeof body?.name === 'string' && body.name.trim()) flow.name = body.name.trim();
            if (body?.graph && Array.isArray(body.graph.nodes)) flow.graph = body.graph;
            flow.updatedAt = new Date().toISOString();
            saveFlows(flows);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, updatedAt: flow.updatedAt }));
            return;
          }
          if (req.method === 'DELETE') {
            saveFlows(flows.filter((f) => f.id !== seg0));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'method not allowed' }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(error) }));
        }
      });

      server.middlewares.use('/api/workflow', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          /* 会话日志：stdout 环形镜像 */
          if (req.method === 'GET' && seg0 && segs[1] === 'log') {
            const session = workflowSessions.get(seg0);
            if (!session) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ lines: session.log }));
            return;
          }
          /* 按业务 key 查会话：编辑页回到实验时恢复运行态（在途运行/节点灯/停止入口）。
           * 页面切走只丢前端引用，会话本体常驻在这里——key 是接回引用的把手。 */
          if (req.method === 'GET' && !seg0) {
            const key = (url.searchParams.get('key') ?? '').trim();
            const id = key ? workflowKeys.get(key) : '';
            const session = id ? workflowSessions.get(id) : undefined;
            if (!session) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              session: publicSession(session),
              events: session.events.slice(-200),
            }));
            return;
          }
          /* 会话状态 + 事件流（真实调用事件驱动节点灯，非日志猜测） */
          if (req.method === 'GET' && seg0) {
            const session = resolveWorkflowSession(seg0);
            if (!session) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              session: publicSession(session),
              events: session.events.slice(-200),
            }));
            return;
          }
          /* 发起/复用常驻会话并发 run 命令：同 key 不 spawn、资源常驻 */
          if (req.method === 'POST' && !seg0) {
            const body = await readJsonBody(req);
            const key = String(body?.workflowKey ?? body?.key ?? '').trim();
            const graph = normalizeGraph(body?.graph);
            /* 声明身份兜底：图没写 workflow_id 时用会话 key（同一个常驻身份），空身份会被 session 拒。 */
            if (key && !graph.workflow_id) graph.workflow_id = key;
            if (!graph.nodes.length) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '画布声明不完整：需要至少一个节点' }));
              return;
            }
            const target = String(body?.target ?? '').trim() || undefined;
            /* session 的 run 契约是 component|full：带目标跑一段/一环，不带目标
             * 跑整图。旧词表（to_target/debug/train）在 session 重写时已废。 */
            const rawMode = String(body?.mode ?? '').trim();
            const mode = rawMode === 'component' || rawMode === 'full'
              ? rawMode : (target ? 'component' : 'full');
            const steps = Number.isInteger(body?.steps) ? body.steps : undefined;
            const session = ensureSession(key, graph);
            if (['queued', 'running', 'stopping', 'releasing'].includes(session.state)) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'busy: 会话正在处理一次图调用', id: session.id }));
              return;
            }
            // 在第一个 await 前占用提交窗口；update 失败时绝不能运行上一份图。
            session.state = 'queued';
            session.requestId = undefined;
            session.runEnd = undefined;
            session.nodesDone = [];
            session.nodesRunning = [];
            session.nodesFailed = [];
            session.activeNodes = [];
            session.activeEdges = [];
            session.usedEdges = [];
            const updateId = sendSessionCommand(session, { op: 'update', declaration: graph });
            const updated = updateId ? await waitForReply(session, updateId, 30_000) : null;
            if (!updated?.ok || updated.state === 'reset_required' || session.state !== 'queued') {
              if (session.state === 'queued') session.state = updated?.state ?? 'failed';
              res.statusCode = updated ? 409 : 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({
                /* 优先级：会话明确拒绝的报错 > 进程崩溃日志里的真实 Traceback
                 * （bootstrap 失败即退出，没有回执）> reset 提示 > 笼统兜底。 */
                error: updated?.error
                  ?? lastSessionError(session)
                  ?? (updated?.state === 'reset_required'
                    ? 'reset_required: 构造配置变化，需要明确重置或释放资源'
                    : '会话未确认图更新，未提交运行（会话无回执，详情见运行日志）'),
                id: session.id,
              }));
              return;
            }
            session.lastRun = { ...(target ? { target } : {}), mode };
            /* 本次生效的资源声明留档：页面回到实验时资源页按它回填 */
            session.resource = graph.resource;
            const requestId = sendSessionCommand(session, { op: 'run', target, mode, steps });
            if (!requestId) {
              session.state = 'lost';
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '会话进程不可写（已退出）', id: session.id }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              id: session.id, session_id: session.id, request_id: requestId, command_seq: session.seq,
            }));
            return;
          }
          /* 暂停/继续：运行中随时入队，回执立即返回（暂停在下一个节点边界生效） */
          if (req.method === 'POST' && seg0 && (segs[1] === 'pause' || segs[1] === 'resume')) {
            const session = resolveWorkflowSession(seg0);
            if (!session) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            const requestId = sendSessionCommand(session, { op: segs[1] });
            if (!requestId) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: '会话进程不可写（已退出）' }));
              return;
            }
            const reply = await waitForReply(session, requestId, 10_000);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(reply ?? { ok: false, error: `${segs[1]} 超时` }));
            return;
          }
          /* 停止本次图调用：会话与常驻资源保留（后台可能有有界预取） */
          if (req.method === 'DELETE' && seg0) {
            const session = resolveWorkflowSession(seg0);
            if (!session) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            sendSessionCommand(session, { op: 'stop' });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, state: session.state }));
            return;
          }
          /* 释放：终止 source、关闭模型/采样器/工具；幂等 */
          if (req.method === 'POST' && seg0 && segs[1] === 'release') {
            const session = resolveWorkflowSession(seg0);
            if (!session) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            sendSessionCommand(session, { op: 'release' });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, state: 'releasing' }));
            return;
          }
          /* 有界输出预览：分页参数原样透传，回执落在事件流（preview 回执）里。
           * 超时放宽到 30s：lane 页是会话里唯一 deref 重载荷引用的地方，大张量
           * 的物化可能远超普通命令。 */
          if (req.method === 'POST' && seg0 && segs[1] === 'preview') {
            const session = resolveWorkflowSession(seg0);
            if (!session) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown workflow session' }));
              return;
            }
            const body = await readJsonBody(req).catch(() => ({}));
            const requestId = sendSessionCommand(session, {
              op: 'preview', node_id: String(body?.node_id ?? ''),
              ...(body?.lane != null ? { lane: String(body.lane) } : {}),
              ...(Number.isInteger(body?.offset) ? { offset: body.offset } : {}),
              ...(Number.isInteger(body?.limit) ? { limit: body.limit } : {}),
            });
            if (!requestId) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: '会话进程不可写（已退出）' }));
              return;
            }
            const reply = await waitForReply(session, requestId, 30_000);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(reply ?? { ok: false, error: 'preview 超时' }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 训练任务：GET 列表 / :id/log / POST 新建（body 见 startTrain 入参）/
       * PATCH :id 重命名 / DELETE :id 停止。训练是长作业，进度与指标从日志解析 。
       */
      server.middlewares.use('/api/train', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          if (req.method === 'GET' && !seg0) {
            for (const task of trainTasks.values()) syncTrainMetricsFile(task);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ tasks: [...trainTasks.values()].map(publicTrainTask) }));
            return;
          }
          if (req.method === 'GET' && seg0 && segs[1] === 'checkpoints') {
            const task = trainTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown train task' }));
              return;
            }
            const ckpts = listTrainCheckpoints(task.outputDir).map((c) => ({ ...c, path: join(task.outputDir, c.name) }));
            const latest = ckpts[0];
            /* 远端形态：ckpt 在 server 侧，本机 output 下通常为空且不可枚举 */
            const remote = task.params.mode === 'remote';
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                checkpoints: ckpts,
                /* 最新断点 + 续跑模板：agent 与一键续跑共用同一事实源 */
                ...(latest ? { resumeFrom: latest.path } : {}),
                ...(remote
                  ? {
                      remote: true,
                      warning:
                        '远端形态训练：checkpoint 存在 server 侧（本机不可枚举），服务端可能回收旧 checkpoint——续跑前先确认目标仍存在，失败时优先怀疑回收。',
                    }
                  : {}),
              }),
            );
            return;
          }
          if (req.method === 'GET' && seg0 && segs[1] === 'log') {
            const task = trainTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown train task' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ lines: task.log }));
            return;
          }
          /*
           * 断点清理（POST :id/prune {keep:N}）：只删本任务 output 下的旧
           * checkpoint 目录，保留最新 N 个；lineage 同步重写。磁盘水位的
           * 出口——agent（prune_checkpoints 工具）与人（curl）共用。
           */
          if (req.method === 'POST' && seg0 && segs[1] === 'prune') {
            const task = trainTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown train task' }));
              return;
            }
            const body = (await readJsonBody(req)) as { keep?: unknown };
            const keep = Number.isInteger(body.keep) && (body.keep as number) > 0 ? (body.keep as number) : 1;
            const ckpts = listTrainCheckpoints(task.outputDir);
            const victims = ckpts.slice(keep);
            if (!victims.length) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ pruned: [], kept: ckpts.map((c) => c.name) }));
              return;
            }
            try {
              for (const v of victims) rmSync(join(task.outputDir, v.name), { recursive: true, force: true });
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: `清理失败: ${String(e)}` }));
              return;
            }
            writeTrainLineage(task);
            pushTrainLog(task, `[webui] 清理旧 checkpoint：保留最新 ${keep} 个，删除 ${victims.map((v) => v.name).join('、')}`);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ pruned: victims.map((v) => v.name), kept: ckpts.slice(0, keep).map((c) => c.name) }));
            return;
          }
                    /* 并行规划器的规则名清单（orm/prm 注册表；判别奖励条目是否占独立组）。缓存，失败降级空清单 */
          if (req.method === 'GET' && seg0 === 'orm-rules') {
            if (ormRulesCache) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(ormRulesCache));
              return;
            }
            let out = '';
            const proc = spawn(resolvePython(), ['-c', ORM_RULES_PROBE], { stdio: ['ignore', 'pipe', 'pipe'] });
            proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
            /* spawn 失败只发 error + close 不发 exit；close 兜底分支会以 500 收口，这里只防 uncaught */
            proc.on('error', () => {});
            const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
            proc.on('close', () => {
              clearTimeout(timer);
              const lastLine = out.trimEnd().split('\n').pop() ?? '';
              try {
                const parsed = JSON.parse(lastLine);
                ormRulesCache = parsed;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(parsed));
              } catch {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ orm: [], prm: [] }));
              }
            });
            return;
          }
          /* 训练创建页预检：数据集前 N 条预览。loader 的 stderr 里混着大量
             [INFO:swift] 等噪声，成功判定以 stdout 尾行 JSON 为准。 */
          if (req.method === 'POST' && seg0 === 'dataset-preview') {
            const body = await readJsonBody(req);
            const dataset = String(body.dataset ?? '').trim();
            const n = Math.min(50, Math.max(1, Number(body.n) || 5));
            if (!dataset) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'dataset is required' }));
              return;
            }
            /* 本地绝对路径不存在时，loader 会把它当 hub id 联网探测并走满超时；先快失败 */
            if (dataset.startsWith('/') && !existsSync(dataset)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: `路径不存在: ${dataset}` }));
              return;
            }
            let stdout = '';
            let stderr = '';
            const proc = spawn(resolvePython(), ['-c', DATASET_PREVIEW_PROBE, dataset, String(n)], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            /* spawn 失败只发 error + close 不发 exit；close 兜底分支会以 500 收口，这里只防 uncaught */
            proc.on('error', () => {});
            const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
            proc.on('close', () => {
              clearTimeout(timer);
              const lastLine = stdout.trimEnd().split('\n').pop() ?? '';
              try {
                const parsed = JSON.parse(lastLine);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(parsed));
              } catch {
                res.statusCode = 500;
                const lines = stderr
                  .trimEnd()
                  .split('\n')
                  .filter((l: string) => !/^\[INFO:swift/.test(l) && !/^(Map|Generating|Downloading|Resolving)/.test(l));
                const detail = lines.slice(-4).join(' | ').slice(0, 500);
                res.end(JSON.stringify({ error: detail ? `数据集加载失败: ${detail}` : '数据集加载超时（120s）' }));
              }
            });
            return;
          }
          /* 训练创建页预检：模型可训练结构探测（参数量 + LoRA 模块统计）。
             结果按 model 缓存；非缓存模型由探针走 modelscope 拉 config。 */
          if (req.method === 'POST' && seg0 === 'model-structure') {
            const body = await readJsonBody(req);
            const model = String(body.model ?? '').trim();
            if (!model) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'model is required' }));
              return;
            }
            const cached = modelStructureCache.get(model);
            if (cached) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(cached));
              return;
            }
            let stdout = '';
            let stderr = '';
            const proc = spawn(resolvePython(), ['-c', MODEL_STRUCTURE_PROBE, model], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
            proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
            /* spawn 失败只发 error + close 不发 exit；close 兜底分支会以 500 收口，这里只防 uncaught */
            proc.on('error', () => {});
            const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
            proc.on('close', () => {
              clearTimeout(timer);
              const lastLine = stdout.trimEnd().split('\n').pop() ?? '';
              try {
                const parsed = JSON.parse(lastLine);
                modelStructureCache.set(model, parsed);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(parsed));
              } catch {
                res.statusCode = 500;
                const detail = stderr.trimEnd().split('\n').slice(-3).join(' | ').slice(0, 500);
                res.end(
                  JSON.stringify({
                    error: detail
                      ? `结构探测失败: ${detail}`
                      : '结构探测超时（30s）——hub 模型拉取 config 失败或网络不通',
                  }),
                );
              }
            });
            return;
          }
if (req.method === 'POST' && !seg0) {
            const body = await readJsonBody(req);
            /*
             * 代码形态：整份 Python 落盘 workspace/train-code/<id>.py 后直接
             * spawn 解释器执行。校验只有「代码非空」——内容对错由解释器与
             * swift.dev 报错（与命令行同级信任）。模型/数据集等结构化字段
             * 留空（对比页只做代码 diff，不消费这些字段）。
             */
            if (body.mode === 'code') {
              const code = String(body.code ?? '');
              if (!code.trim()) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '代码不能为空' }));
                return;
              }
              const gpus = (Array.isArray(body.gpus) ? body.gpus : [])
                .map((g: unknown) => Number(g))
                .filter((g: number) => Number.isInteger(g) && g >= 0);
              /* 卡位与磁盘守卫（与 CLI 形态同一条） */
              const guardErr = gpuConflictError(gpus) ?? diskGuardError();
              if (guardErr) {
                res.statusCode = 409;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: guardErr }));
                return;
              }
              const id = `train-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
              const name = String(body.name ?? '').trim() || undefined;
              const codeDir = join(workspaceRoot(), 'train-code');
              mkdirSync(codeDir, { recursive: true });
              const codeFile = join(codeDir, `${id}.py`);
              writeFileSync(codeFile, code);
              const task: TrainTask = {
                id,
                ...(name ? { name } : {}),
                taskType: 'code',
                model: '',
                datasets: [],
                tuner: 'lora',
                plugins: [],
                ...(gpus.length ? { gpus } : {}),
                params: {},
                outputDir: join(swiftHome(), 'train', id, 'output'),
                /* args 即落盘文件本身——日志首行回显 python <file>，与展示同源 */
                args: [codeFile],
                status: 'running',
                startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
                log: [],
                metrics: [],
              };
              trainTasks.set(id, task);
              writeTrainLineage(task);
              runTrainTask(task);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ id }));
              return;
            }
            const model = String(body.model ?? '').trim();
            const datasets = (Array.isArray(body.datasets) ? body.datasets : [])
              .map((d: unknown) => String(d ?? '').trim())
              .filter(Boolean);
            const valDatasets = (Array.isArray(body.valDatasets) ? body.valDatasets : [])
              .map((d: unknown) => String(d ?? '').trim())
              .filter(Boolean);
            const tuner =
              body.tuner === 'full' || body.tuner === 'trainable_tokens' ? body.tuner : 'lora';
            const taskType = body.taskType === 'pt' || body.taskType === 'rl' ? body.taskType : 'sft';
            const plugins = (Array.isArray(body.plugins) ? body.plugins : [])
              .map((p: unknown) => String(p ?? '').trim())
              .filter(Boolean);
            const gpus = (Array.isArray(body.gpus) ? body.gpus : [])
              .map((g: unknown) => Number(g))
              .filter((g: number) => Number.isInteger(g) && g >= 0);
            const gpuCount = Number.isInteger(body.gpuCount) && body.gpuCount > 0 ? body.gpuCount : undefined;
            /* 卡位与磁盘守卫：本机选卡才查冲突（集群卡数是远端资源）；水位两类都查 */
            const guardErr = gpuConflictError(gpus) ?? diskGuardError();
            if (guardErr) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: guardErr }));
              return;
            }
            /* params 只收标量 KV（key = CLI flag 名），非标量值丢弃 */
            const params: Record<string, string | number | boolean> = {};
            for (const [k, v] of Object.entries(body.params ?? {})) {
              if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
            }
            /*
             * rl 的算法选择是 --rl_type（RLConfig.rl_type 的 12 值 Literal）。
             * 不传时兜底 dpo（与 CLI 默认一致）；传了但不在 Literal 里则拒绝，
             * 否则要到 python 解析期才炸，webui 里只看到一个 failed 任务。
             */
            const RL_TYPES = new Set([
              'dpo', 'orpo', 'simpo', 'kto', 'cpo', 'rm', 'ppo', 'grpo', 'gkd', 'opsd', 'mopd', 'rft',
            ]);
            if (taskType === 'rl') {
              const rlType = params.rl_type === undefined ? 'dpo' : String(params.rl_type);
              if (!RL_TYPES.has(rlType)) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `不支持的 rl_type: ${rlType}（dpo/kto/orpo/cpo/simpo/rm/grpo/ppo/rft/gkd/opsd/mopd）` }));
                return;
              }
              params.rl_type = rlType;
            }
            const extraArgs = String(body.extraArgs ?? '').trim() || undefined;
            /* 续跑血缘：一键续跑/研究迭代可带 parentTaskId（原任务 id） */
            const parentTaskId = String(body.parentTaskId ?? '').trim() || undefined;
            /* 关注指标：字符串数组清洗（创建页预选，展示页消费） */
            const watchMetrics = (Array.isArray(body.watchMetrics) ? body.watchMetrics : [])
              .map((w: unknown) => String(w ?? '').trim())
              .filter(Boolean);
            if (!model) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '模型必填' }));
              return;
            }
            if (!datasets.length) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '至少选择一个训练数据集' }));
              return;
            }
            const id = `train-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            /*
             * 创建时可直接带显示名（消融实验批量启动用「组名-实验名」区分任务；
             * PATCH 重命名是另一个入口，两者写同一个字段）。
             */
            const name = String(body.name ?? '').trim() || undefined;
            const base = {
              id,
              ...(name ? { name } : {}),
              taskType,
              model,
              datasets,
              ...(valDatasets.length ? { valDatasets } : {}),
              tuner,
              plugins,
              ...(gpus.length ? { gpus } : {}),
              ...(gpuCount ? { gpuCount } : {}),
              params,
              ...(watchMetrics.length ? { watchMetrics } : {}),
              ...(extraArgs ? { extraArgs } : {}),
              ...(parentTaskId ? { parentTaskId } : {}),
              outputDir: join(swiftHome(), 'train', id, 'output'),
            };
            const task: TrainTask = {
              ...base,
              args: buildTrainArgs(base),
              status: 'running',
              startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
              log: [],
              metrics: [],
            };
            trainTasks.set(id, task);
            writeTrainLineage(task);
            runTrainTask(task);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id }));
            return;
          }
          /* 重命名：只改 webui 里的显示名 */
          if (req.method === 'PATCH' && seg0) {
            const task = trainTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown train task' }));
              return;
            }
            const body = (await readJsonBody(req)) as { name?: string };
            const name = String(body.name ?? '').trim();
            if (!name) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'name is required' }));
              return;
            }
            task.name = name;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE' && seg0) {
            const task = trainTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown train task' }));
              return;
            }
            if (task.status === 'running') {
              task.status = 'stopped';
              /* 正常任务有句柄；收编的孤儿只有记下的 pid */
              if (task.proc) {
                task.proc.kill('SIGTERM');
              } else if (task.pid) {
                try {
                  process.kill(task.pid, 'SIGTERM');
                } catch {
                  /* 进程已不在：直接收尾 */
                }
              }
              pushTrainLog(task, '[webui] 用户停止训练');
              writeTrainLineage(task);
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 脚本任务：GET 列表 / :id/log 日志 / POST 新建（body: { script, args? }）/
       * PATCH :id 重命名 / DELETE :id 停止（幂等：终态任务不改状态）。
       * 脚本必须在工作空间内——外部数据根与 swift 源码根是只读面。
       */
      server.middlewares.use('/api/scripts', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          if (req.method === 'GET' && !seg0) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ tasks: [...scriptTasks.values()].map(publicScriptTask) }));
            return;
          }
          if (req.method === 'GET' && seg0 && segs[1] === 'log') {
            const task = scriptTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown script task' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ lines: task.log }));
            return;
          }
          if (req.method === 'POST' && !seg0) {
            const body = (await readJsonBody(req)) as { script?: string; args?: unknown; conv?: unknown; modelId?: unknown };
            const script = String(body.script ?? '').trim();
            if (!script) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'script 必填' }));
              return;
            }
            /* args 数组逐个传给 spawn，不经 shell 拼接——无注入面 */
            const args = (Array.isArray(body.args) ? body.args : [])
              .map((a: unknown) => String(a ?? ''))
              .filter(Boolean);
            const abs = confineWorkspace(script);
            if (!abs || !withinRealRoots(abs, [workspaceRoot()])) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '脚本路径超出工作空间（只能在 ~/.swift/workspace 内执行）' }));
              return;
            }
            if (!existsSync(abs)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `工作空间里没有这个文件: ${script}` }));
              return;
            }
            /*
             * 脚本可以是一个多文件目录：按约定找入口（main.py / run.py /
             * __main__.py），找不到报错指出可填完整文件路径。script 改写成
             * 「目录/入口」形态——列表、日志命令行、详情 createCommand 显示的
             * 就是实际执行的那个文件，不再误导。
             */
            let target = abs;
            let displayScript = script;
            if (statSync(abs).isDirectory()) {
              const entry = ['main.py', 'run.py', '__main__.py'].find((n) => existsSync(join(abs, n)));
              if (!entry) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(
                  JSON.stringify({
                    error: `目录 ${script} 里没有入口文件（main.py / run.py / __main__.py）；或改填脚本文件的完整路径`,
                  }),
                );
                return;
              }
              target = join(abs, entry);
              displayScript = join(script, entry);
            }
            const id = `script-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            /* 唤醒归属（对话发起的 run_script 才带）：终态事件推回这个对话的这一列 */
            const conv = String(body.conv ?? '').trim();
            const modelId = String(body.modelId ?? '').trim();
            const task: ScriptTask = {
              id,
              script: displayScript,
              args,
              status: 'running',
              startedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
              log: [],
              ...(conv ? { conv } : {}),
              ...(modelId ? { modelId } : {}),
            };
            scriptTasks.set(id, task);
            runScriptTask(task, target);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id }));
            return;
          }
          /* 重命名：只改 webui 里的显示名 */
          if (req.method === 'PATCH' && seg0) {
            const task = scriptTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown script task' }));
              return;
            }
            const body = (await readJsonBody(req)) as { name?: string };
            const name = String(body.name ?? '').trim();
            if (!name) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'name is required' }));
              return;
            }
            task.name = name;
            writeScriptMeta(task);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE' && seg0) {
            const task = scriptTasks.get(seg0);
            if (!task) {
              res.statusCode = 404;
              res.end(JSON.stringify({ error: 'unknown script task' }));
              return;
            }
            /* 终态任务不改状态（幂等）；running 的先置 stopped 再杀，exit 回调不再改写 */
            if (task.status === 'running') {
              task.status = 'stopped';
              task.proc?.kill('SIGTERM');
              pushScriptLog(task, '[webui] 用户停止脚本');
              writeScriptMeta(task);
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 研究会话：GET 列表（不带 events）/ GET :id 全量 / GET :id/events
       * （?consume=1 取走即删）/ POST 创建 / PATCH 更新 / DELETE 停止
       * （只断 watcher 关联，不杀训练——停训练走训练页）。状态机由 watcher
       * 与主模型（update_research 工具）共同推进。
       */
      server.middlewares.use('/api/research', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];

          if (req.method === 'GET' && !seg0) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ sessions: loadResearch().map(publicResearchSession) }));
            return;
          }
          if (req.method === 'GET' && seg0 && segs[1] === 'events') {
            const s = loadResearch().find((x) => x.id === seg0);
            if (!s) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'unknown research session' }));
              return;
            }
            if (url.searchParams.get('consume') !== '1') {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ events: s.events }));
              return;
            }
            /*
             * 取走即删：drain 在串行链里重读文件，push 进来的新事件要么
             * 已在本批、要么留在队列给下一轮——不会静默丢。
             */
            const taken = await takeResearchEvents(seg0);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ events: taken }));
            return;
          }
          if (req.method === 'GET' && seg0) {
            const s = loadResearch().find((x) => x.id === seg0);
            if (!s) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'unknown research session' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ session: s }));
            return;
          }
          if (req.method === 'POST' && !seg0) {
            if (launchMode() === 'expo') {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '展览模式不保存配置到运行机器' }));
              return;
            }
            const body = (await readJsonBody(req)) as Record<string, unknown>;
            const str = (k: string): string => String(body?.[k] ?? '').trim();
            const plan = (body?.evalPlan ?? {}) as Record<string, unknown>;
            const metric = (plan.metric ?? {}) as Record<string, unknown>;
            const budget = (body?.budget ?? {}) as Record<string, unknown>;
            const mode = plan.mode === 'during' || plan.mode === 'parallel' ? plan.mode : 'checkpoint';
            const direction = plan.direction === 'lower' ? 'lower' : 'higher';
            const threshold = Number(plan.threshold);
            const maxIterations = Number(budget.maxIterations);
            const id = `research-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            const session: ResearchSession = {
              id,
              convId: str('convId'),
              modelId: str('modelId'),
              goal: str('goal'),
              baseModel: str('baseModel'),
              dataDir: str('dataDir') || join('research', id, 'data'),
              evalPlan: {
                mode,
                metric: {
                  kind: metric.kind === 'custom' ? 'custom' : 'evalscope',
                  dataset: String(metric.dataset ?? '').trim(),
                  metricName: String(metric.metricName ?? '').trim(),
                  ...(Number.isInteger(metric.limit) && Number(metric.limit) > 0
                    ? { limit: Number(metric.limit) }
                    : {}),
                  ...(String(metric.judge ?? '').trim() ? { judge: String(metric.judge).trim() } : {}),
                },
                threshold,
                direction,
              },
              budget: { maxIterations: Number.isInteger(maxIterations) && maxIterations > 0 ? maxIterations : 3 },
              status: 'preparing',
              iterations: [],
              events: [],
              eventLog: [],
              createdAt: researchNow(),
            };
            const missing: string[] = [];
            if (!session.goal) missing.push('goal');
            if (!session.baseModel) missing.push('baseModel');
            if (!session.evalPlan.metric.dataset) missing.push('evalPlan.metric.dataset');
            if (!session.evalPlan.metric.metricName) missing.push('evalPlan.metric.metricName');
            if (!Number.isFinite(threshold)) missing.push('evalPlan.threshold');
            if (!session.convId) missing.push('convId');
            if (!session.modelId) missing.push('modelId');
            if (missing.length) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `缺少必填字段: ${missing.join(', ')}` }));
              return;
            }
            saveResearch([...loadResearch(), session]);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ session }));
            return;
          }
          if (req.method === 'PATCH' && seg0) {
            if (launchMode() === 'expo') {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '展览模式不保存配置到运行机器' }));
              return;
            }
            const body = (await readJsonBody(req)) as Record<string, unknown>;
            const STATUSES = new Set(['preparing', 'training', 'evaluating', 'deciding', 'done', 'escalated', 'stopped']);
            const updated = await mutateResearch(seg0, (s) => {
              /* 唤醒绑定改绑：研究常被换会话/换列续跑，绑定点跟随最近一次维护动作
               * （update_research 工具自动附带当前 conv/model），事件才不会投到
               * 已被弃置的旧会话——那正是「研究停摆、只能手动发继续」的形态 */
              if (typeof body.convId === 'string' && body.convId.trim()) s.convId = body.convId.trim();
              if (typeof body.modelId === 'string' && body.modelId.trim()) s.modelId = body.modelId.trim();
              if (typeof body.goal === 'string' && body.goal.trim()) s.goal = body.goal.trim();
              if (typeof body.baseModel === 'string' && body.baseModel.trim()) s.baseModel = body.baseModel.trim();
              if (typeof body.dataDir === 'string' && body.dataDir.trim()) s.dataDir = body.dataDir.trim();
              if (typeof body.status === 'string' && STATUSES.has(body.status)) s.status = body.status as ResearchSession['status'];
              if (body.budget && typeof body.budget === 'object') {
                const n = Number((body.budget as Record<string, unknown>).maxIterations);
                if (Number.isInteger(n) && n > 0) s.budget.maxIterations = n;
              }
              if (Array.isArray(body.iterations)) {
                s.iterations = body.iterations
                  .filter(
                    (x): x is Record<string, unknown> =>
                      Boolean(x) && typeof x === 'object' && Number.isInteger((x as Record<string, unknown>).index),
                  )
                  .map((x) => ({
                    index: Number(x.index),
                    ...(typeof x.dataVersion === 'string' && x.dataVersion ? { dataVersion: x.dataVersion } : {}),
                    ...(typeof x.trainTaskId === 'string' && x.trainTaskId ? { trainTaskId: x.trainTaskId } : {}),
                    ...(typeof x.evalTaskId === 'string' && x.evalTaskId ? { evalTaskId: x.evalTaskId } : {}),
                    ...(typeof x.note === 'string' && x.note ? { note: x.note } : {}),
                    ...(Number.isFinite(Number(x.score)) ? { score: Number(x.score) } : {}),
                    /*
                     * watcher 的防重字段（parallel: 评过哪个 ckpt；during: 记到哪个
                     * step）：整组回传的 PATCH 若把它们剥掉，watcher 会对同一
                     * checkpoint/同一 step 重复起评——必须原样透传。
                     */
                    ...(typeof x.evaluatedCkpt === 'string' && x.evaluatedCkpt ? { evaluatedCkpt: x.evaluatedCkpt } : {}),
                    ...(Number.isFinite(Number(x.lastEvalStep)) ? { lastEvalStep: Number(x.lastEvalStep) } : {}),
                  }));
              }
              if (body.trainConfig && typeof body.trainConfig === 'object') {
                const tc = body.trainConfig as Record<string, unknown>;
                const params: Record<string, string | number | boolean> = {};
                for (const [k, v] of Object.entries(tc.params ?? {})) {
                  if (TRAIN_OWNED_KEYS.has(k)) continue;
                  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[k] = v;
                }
                s.trainConfig = {
                  taskType: tc.taskType === 'pt' || tc.taskType === 'rl' ? tc.taskType : 'sft',
                  tuner:
                    tc.tuner === 'full' || tc.tuner === 'trainable_tokens' ? tc.tuner : 'lora',
                  params,
                  ...(Array.isArray(tc.gpus)
                    ? { gpus: tc.gpus.map(Number).filter((g: number) => Number.isInteger(g) && g >= 0) }
                    : {}),
                  ...(Number.isInteger(tc.gpuCount) && Number(tc.gpuCount) > 0 ? { gpuCount: Number(tc.gpuCount) } : {}),
                  ...(Array.isArray(tc.plugins) ? { plugins: tc.plugins.map(String).filter(Boolean) } : {}),
                };
              }
            });
            if (!updated) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'unknown research session' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ session: updated }));
            return;
          }
          if (req.method === 'DELETE' && seg0) {
            await mutateResearch(seg0, (s) => {
              if (['preparing', 'training', 'evaluating', 'deciding'].includes(s.status)) {
                s.status = 'stopped';
                /* 只断 watcher 关联，不停训练/评测——停止它们走各自任务页 */
                s.events.push({
                  at: researchNow(),
                  kind: 'stopped',
                  text: '用户停止了研究会话（训练/评测任务不受影响，可在各自页面停止）。',
                });
              }
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * Challenger 组件模板库：GET 列表（名字/说明/用法/护栏）/ POST { name }
       * 安装进 workspace/challenger/（已存在则 409——可能是模型改过的继承版）。
       */
      server.middlewares.use('/api/challenger', async (req, res) => {
        try {
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ challengers: listChallengerTemplates() }));
            return;
          }
          if (req.method === 'POST') {
            const body = (await readJsonBody(req)) as { name?: string };
            const name = String(body.name ?? '').trim();
            const valid = listChallengerTemplates().find((c) => c.name === name);
            if (!valid) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `没有这个组件模板: ${name || '(空)'}` }));
              return;
            }
            const dest = join(workspaceRoot(), 'challenger', `${name}.py`);
            if (existsSync(dest)) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  error: `workspace/challenger/${name}.py 已存在（可能是改过的继承版）；要重装先删掉它`,
                }),
              );
              return;
            }
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, readFileSync(join(challengerDir(), `${name}.py`), 'utf-8'));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: `challenger/${name}.py` }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /*
       * 会话事件队列：GET ?conv=X&take=1 取走该对话的全部待发事件（消费即删）。
       * 只服务于脚本唤醒——研究事件走 /api/research/:id/events 的 peek+consume
       * 两步式；这里取走后由前端 pending 兑住发不出去的竞态，事件不丢。
       */
      /*
       * 对话历史（convs.json）：server 是唯一真相源（回合引擎是唯一写者），
       * 浏览器只读——GET 拉全量做首屏渲染与重连对账。展览模式禁用：机器侧
       * 文件是共享面，多用户的对话不允许混进同一份 convs.json。
       */
      server.middlewares.use('/api/convs', (req, res) => {
        try {
          if (launchMode() === 'expo') {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: '展览模式不保存对话到运行机器' }));
            return;
          }
          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            /* 坏文件按空库应答：页面本地缓存照常，拉回面拿不到东西不会误覆盖 */
            res.end(JSON.stringify(readConvs() ?? { chats: [], turns: {} }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      
      /*
       * 回合提交与观看（单写者架构的页面侧入口）：
       * - POST /api/conv/:id/turn：提交回合（单列或多列并发），system 块与
       *   工具名清单由页面按胶囊状态组装好随请求带上；引擎是唯一执行体，
       *   页面关闭/刷新不影响回合跑完。
       * - GET /api/conv/:id/live：SSE 订阅该会话的回合增量（打字机、工具
       *   结果、回合完成）。SSE 断开只是不看了；重连后 GET /api/convs 对账。
       * - DELETE /api/conv/:id：删除会话（chats + 全部 turns 桶）。
       * - POST /api/conv/:id/abort：停止按钮——中止该列页面提交的在跑回合。
       * - POST /api/conv/:id/move：切模型续聊时把桶搬到新模型（旧语义保留）。
       * - GET /api/conv/:id：单会话桶对账（回合完成后轻量拉回，防 SSE 丢事件）。
       */
      server.middlewares.use('/api/conv', async (req, res) => {
        try {
          const segs = (req.url ?? '').split('?')[0].split('/').filter(Boolean);
          const conv = segs[0] ?? '';
          if (!conv) {
            res.statusCode = 404;
            res.end();
            return;
          }
          if (req.method === 'POST' && segs[1] === 'turn') {
            const body = (await readJsonBody(req)) as {
              text?: unknown;
              models?: unknown;
              images?: unknown;
              system?: unknown;
              tools?: unknown;
              title?: unknown;
              sampling?: unknown;
              noApproval?: unknown;
            };
            const text = typeof body.text === 'string' ? body.text : '';
            const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string') : [];
            const system = Array.isArray(body.system) ? body.system.filter((s): s is string => typeof s === 'string') : [];
            const tools = Array.isArray(body.tools) ? body.tools.filter((t): t is string => typeof t === 'string') : [];
            const images = Array.isArray(body.images) ? body.images.filter((i): i is string => typeof i === 'string') : undefined;
            const sampling =
              body.sampling && typeof body.sampling === 'object'
                ? (body.sampling as { temperature?: number; topP?: number; maxTokens?: number })
                : undefined;
            if (!text || !models.length || !engine) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'text 与 models 必填' }));
              return;
            }
            /* 页面免审总闸：引擎侧同语义放行该回合的一切审批 */
            const noApproval = body.noApproval === true;
            /* 展览模式的会话 token 随头走（与 /api/chat 代理同一取法） */
            const headerKey = req.headers['x-swift-api-key'];
            const apiKey = typeof headerKey === 'string' && headerKey ? headerKey : undefined;
            const r = engine.submitTurn(conv, {
              text,
              models,
              ...(images?.length ? { images } : {}),
              system,
              tools,
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(sampling ? { sampling } : {}),
              ...(apiKey ? { apiKey } : {}),
              ...(noApproval ? { noApproval: true } : {}),
            });
            if ('error' in r) {
              res.statusCode = 409;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: r.error }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(r));
            return;
          }
          if (req.method === 'GET' && !segs[1]) {
            /* 单会话桶对账（回合完成/重连时轻量拉回） */
            const current = readConvs();
            const buckets = current?.turns[conv] ?? {};
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ buckets }));
            return;
          }
          if (req.method === 'GET' && segs[1] === 'live') {
            /*
             * SSE：回合增量原样推给浏览器。网关兼容头（防代理缓冲）+ 心跳注释
             * 行（30s 一拍，半开连接早死早发现）。订阅即刻回放「当前在跑」，
             * 页面刷新重连时能补上按钮态。
             */
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Accel-Buffering': 'no',
              Connection: 'keep-alive',
            });
            res.write(':ok\n\n');
            /* 首连同步：正在跑的列名一次告知（页面刷新重连后恢复按钮态） */
            res.write(`data: ${JSON.stringify({ type: 'sync', conv, models: engine?.busyModels(conv) ?? [] })}\n\n`);
            const unsub = engine?.subscribe(conv, (ev) => {
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }) ?? (() => undefined);
            const beat = setInterval(() => {
              try {
                res.write(':beat\n\n');
              } catch {
                /* 连接已死：close 回调里清 */
              }
            }, 30_000);
            res.on('close', () => {
              clearInterval(beat);
              unsub();
            });
            return;
          }
          if (req.method === 'POST' && segs[1] === 'abort') {
            const body = (await readJsonBody(req)) as { model?: unknown };
            const model = typeof body.model === 'string' ? body.model : '';
            if (!model) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'model 必填' }));
              return;
            }
            engine?.abortTurn(conv, model);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'POST' && segs[1] === 'move') {
            /* 切模型搬桶：目标桶已有消息不动（那是该列的既有流），搬空旧桶 */
            const body = (await readJsonBody(req)) as { from?: unknown; to?: unknown };
            const from = typeof body.from === 'string' ? body.from : '';
            const to = typeof body.to === 'string' ? body.to : '';
            if (!from || !to) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'from/to 必填' }));
              return;
            }
            const current = readConvs();
            if (current === null) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'convs.json unreadable' }));
              return;
            }
            const buckets = { ...(current.turns[conv] ?? {}) } as Record<string, unknown[]>;
            if (buckets[from]?.length && !buckets[to]?.length) {
              buckets[to] = buckets[from];
              delete buckets[from];
              writeConvs(current.chats, { ...current.turns, [conv]: buckets });
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE') {
            /*
             * 会话删除传播：先 retire（中止该会话在跑回合 + 屏蔽后续落盘，
             * 防 abort 的异步尾部把已删桶重建出来），再清 chats 与 turns。
             */
            engine?.retire(conv);
            const current = readConvs();
            if (current === null) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'convs.json unreadable' }));
              return;
            }
            const chats = [...current.chats].filter((c) => (c as { id?: unknown })?.id !== conv);
            const turns = { ...current.turns };
            delete turns[conv];
            writeConvs(chats, turns);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 404;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /*
       * 引擎审批面（端点名沿用 headless 时代，前端零改动）：GET ?conv= 列
       * 该对话的在途审批 + 共用白名单（浏览器打开时渲染成审批卡、把白名单灌
       * 进本地允许集）；POST /:id { approve, alwaysAllow? } 用户决定（勾了总是
       * 允许就把命令收进白名单），挂起的 server 回合 1s 内恢复；POST /allow
       * { command } 浏览器侧「总是允许」同步（引擎与页面共用一份落盘白名单）。
       */
      server.middlewares.use('/api/headless/approvals', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://local');
          const segs = url.pathname.split('/').filter(Boolean);
          const seg0 = segs[0];
          if (req.method === 'GET' && !seg0) {
            const conv = url.searchParams.get('conv') ?? '';
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                approvals: conv ? engine?.listPendingApprovals(conv) ?? [] : [],
                allowed: engine?.listAllowedCommands() ?? [],
              }),
            );
            return;
          }
          if (req.method === 'POST' && seg0 === 'allow') {
            const body = (await readJsonBody(req)) as { command?: string };
            const command = String(body.command ?? '').trim();
            if (!command) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'command 必填' }));
              return;
            }
            engine?.addAllowedCommand(command);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'POST' && seg0) {
            const body = (await readJsonBody(req)) as { approve?: boolean; alwaysAllow?: boolean };
            const ok = engine?.resolveApproval(seg0, body.approve === true, body.alwaysAllow === true) ?? false;
            if (!ok) {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'unknown approval' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /*
       * 聊天代理：POST /api/chat/completions
       * body: { model: <配置 id>, ...openai 请求体 }，流式响应原样透传。
       */
      server.middlewares.use('/api/chat/completions', async (req, res) => {
        try {
          const body = await readJsonBody(req);
          /* 排障判别器：每个经过此中间件的请求都留一行（消毒命中与否都打），
           * 用于区分「请求到达但无毒」与「请求根本没到这个实例」两种故障面 */
          const sanitized = sanitizeSpecialTokens(body);
          console.log(`[chat-req] model=${String(body.model)} msgs=${body.messages?.length ?? 0} sanitized=${sanitized}`);
          /*
           * key 来源分两路：models.json 条目用机器侧存的 key（现状不变）；
           * 带 x-swift-api-key 头的请求（展览模式把会话 token 放在这里）优先，
           * 且此时若 model 不在 models.json，再查 ms 默认清单——展览模式的
           * 首页默认模型走 api-inference，token 只在浏览器内存，服务端无处可查。
           * 无头且未配置 = 原行为（404 或裸连），normal 模式逐位不变。
           */
          const headerKey = req.headers['x-swift-api-key'];
          const sessionKey = typeof headerKey === 'string' ? headerKey : '';
          let config = loadModels().find((m) => m.id === body.model);
          if (!config && sessionKey) {
            const ms = (await listMsDefaultModels()).models.find((m) => m.model === body.model);
            if (ms) {
              config = { id: ms.model, baseUrl: MS_INFERENCE_BASE, apiKey: '', model: ms.model };
            }
          }
          if (!config) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `未配置的模型: ${body.model}` }));
            return;
          }
          const apiKey = sessionKey || config.apiKey;
          const { model: _id, ...openaiBody } = body;
          const upstreamAbort = new AbortController();
          /*
           * 客户端断开跟随中止：上游黑洞（连接建立却不消费请求体、不回响应）时
           * 浏览器侧迟早放弃/刷新/关页，若不跟随，中间件会一直持有挂死的上游
           * fetch 与滞留在发送缓冲的请求体（连接泄漏）。挂 res 的 close（响应
           * 完成与连接断开都触发，writableEnded 区分二者；req 的 close 在新版
           * node 上只表示请求流消费完毕，连接中断不触发——实测不 fire）。回
           * 合执行体在引擎侧，浏览器断开不影响回合跑完，这里只需管连接卫生。
           */
          res.on('close', () => {
            upstreamAbort.abort();
          });
          /*
           * 服务端自己的响应头超时：预览链路的本地代理会保活与 vite 的连接，
           * 浏览器刷新/断开时代理不跟着断，req close 收不到信号——上游黑洞
           * 只能靠这里兜底中止。取到响应头即解除（流式正文可合法跑几分钟，
           * 中途停滞由浏览器侧看门狗负责）。中止后走 catch 回 502，浏览器
           * 侧 streamChat 对 5xx 自带一次重试，用户无感。
           */
          const UPSTREAM_HEADERS_STALL_MS = 180_000;
          const headersTimer = setTimeout(() => upstreamAbort.abort(), UPSTREAM_HEADERS_STALL_MS);
          const upstream = await fetch(
            `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              },
              body: JSON.stringify({ ...openaiBody, model: config.model }),
              signal: upstreamAbort.signal,
            },
          );
          clearTimeout(headersTimer);
          /*
           * 上游拒绝时把完整请求体落盘（/tmp/chat-reject.jsonl，每行一条）：
           * 报错只指上游不指具体字段，历史在浏览器 localStorage 服务端读不到，
           * 不落盘就无法定位毒串/异常结构藏在哪个字段。调试面，仅失败触发。
           */
          if (!upstream.ok) {
            try {
              const upstreamText = await upstream.clone().text().catch(() => '');
              appendFileSync(
                '/tmp/chat-reject.jsonl',
                JSON.stringify({
                  ts: new Date().toISOString(),
                  model: String(body.model),
                  status: upstream.status,
                  response: upstreamText.slice(0, 1000),
                  sanitized,
                  requestBody: body,
                }) + '\n',
                'utf-8',
              );
            } catch {
              /* 落盘失败不影响转发 */
            }
          }
          res.statusCode = upstream.status;
          upstream.headers.forEach((v, k) => {
            if (k !== 'content-encoding' && k !== 'transfer-encoding') res.setHeader(k, v);
          });
          if (upstream.body) {
            /* 上游流中途出错（含跟随客户端断开的 abort）须有 error 处理，
             * 否则是未处理的 'error' 事件；目标 res 已死时 destroy 而非继续写 */
            const upstreamStream = Readable.fromWeb(upstream.body as any);
            upstreamStream.on('error', () => {
              try {
                res.destroy();
              } catch {
                /* 目标已销毁，无需处理 */
              }
            });
            upstreamStream.pipe(res);
          } else {
            res.end();
          }
        } catch (e) {
          /* 浏览器已断开时 res 不可再写（跟随中止会走到这里）：静默放弃 */
          try {
            if (!res.destroyed) {
              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: String(e) }));
            }
          } catch {
            /* 写已销毁的响应流：客户端已断开，无需处理 */
          }
        }
      });

      /**
       * 搜索工具配置：GET /api/search-config（掩码）/ POST（保存 key，
       * 空串或掩码 = 沿用已存值，与模型配置同一约定）/ DELETE（清掉 key，
       * 退回免 key 通道）。
       */
      server.middlewares.use('/api/search-config', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const { tavilyKey } = loadSearch();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ tavilyKey: tavilyKey ? MASK : '' }));
            return;
          }
          /* 展览模式禁写：search.json 与 models.json 同为机器侧共享落盘面 */
          if (launchMode() === 'expo') {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: '展览模式不保存配置到运行机器' }));
            return;
          }
          if (req.method === 'POST') {
            const body = (await readJsonBody(req)) as { tavilyKey?: string };
            // 与模型配置同一约定：编辑时不重输 key 就传空/掩码沿用旧值
            const prev = loadSearch();
            const tavilyKey =
              body.tavilyKey && body.tavilyKey !== MASK ? body.tavilyKey : prev.tavilyKey ?? '';
            saveSearch({ tavilyKey });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (req.method === 'DELETE') {
            saveSearch({});
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 405;
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * 联网搜索代理：POST /api/search，body { query }。
       * 配了 key 走账号额度，没配走 keyless 免费通道（速率受限）。
       * 返回裁剪成 { title, url, content }——raw_content 对注入上下文太长。
       */
      server.middlewares.use('/api/search', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const body = (await readJsonBody(req)) as { query?: string };
          if (!body.query) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'query 必填' }));
            return;
          }
          const { tavilyKey } = loadSearch();
          const upstream = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(tavilyKey
                ? { Authorization: `Bearer ${tavilyKey}` }
                : { 'X-Tavily-Access-Mode': 'keyless' }),
            },
            body: JSON.stringify({ query: body.query, max_results: 5 }),
          });
          if (!upstream.ok) {
            // Tavily 的报错体自带自然语言说明（撞限额时教你怎么续），原样带给前端
            const text = await upstream.text().catch(() => '');
            let detail = text;
            try {
              detail = JSON.parse(text).detail ?? text;
            } catch {
              /* 非 JSON 报错体就用原文 */
            }
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Tavily 搜索失败: ${detail || upstream.status}` }));
            return;
          }
          const data = (await upstream.json()) as {
            results?: { title?: string; url?: string; content?: string }[];
          };
          const results = (data.results ?? []).map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            content: r.content ?? '',
          }));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ results }));
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * agent 工具——文件读写：POST /api/tools/fs，body { op, path, content?, root? }。
       * op ∈ list / read / write / edit。默认路径收进 ~/.swift/workspace；root='swift'
       * 时收进当前 python 环境安装的 swift 包根（只读——文档查不到时回源码
       * 核实的仲裁通道）；root='external' 时收进用户登记的外部数据根（只读
       * ——原始数据探查）。三种根都越界 403，两个只读根的 write/edit 恒 403。
       */
      server.middlewares.use('/api/tools/fs', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const body = (await readJsonBody(req)) as {
            op?: string;
            path?: string;
            content?: string;
            oldString?: string;
            newString?: string;
            replaceAll?: boolean;
            root?: 'workspace' | 'swift' | 'external';
            /* read 的行范围（1-based offset + 行数；不带则整读，edit 锚点流程用整读） */
            offset?: number;
            limit?: number;
            /* grep：正则 + 命中数上限 */
            pattern?: string;
            maxResults?: number;
            /* profile：统计哪个字段的值分布（可选） */
            field?: string;
          };
          let abs: string | null;
          let baseRoot: string;
          if (body.root === 'external') {
            abs = confineExternal(body.path ?? '');
            if (!abs) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '路径不在任何已登记的外部数据目录 内（偏好设置 → 外部数据目录）' }));
              return;
            }
            baseRoot = externalRootOf(abs) ?? abs;
          } else {
            if (body.root === 'swift') {
              const swiftEnv = await probeSwiftEnv();
              if (!swiftEnv) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: '当前 python 环境未装 swift，无源码可读' }));
                return;
              }
              /* swift.__file__ 是包内 __init__.py，包根是它的上一层目录 */
              baseRoot = dirname(swiftEnv.path);
            } else {
              baseRoot = workspaceRoot();
              if (!existsSync(baseRoot)) mkdirSync(baseRoot, { recursive: true });
            }
            abs = confineTo(baseRoot, body.path ?? '');
            if (!abs || !withinRealRoots(abs, [baseRoot])) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '路径超出允许的根目录' }));
              return;
            }
          }
          /* swift 源码根与外部数据根都是只读面：只放行 list / read */
          if (
            (body.root === 'swift' || body.root === 'external') &&
            (body.op === 'write' || body.op === 'edit')
          ) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: body.root === 'swift' ? 'swift 安装源码是只读的' : '外部数据目录是只读的',
              }),
            );
            return;
          }
          if (body.op === 'list') {
            if (!existsSync(abs) || !statSync(abs).isDirectory()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `不是目录: ${body.path}` }));
              return;
            }
            const entries = readdirSync(abs).map((name) => ({
              name,
              dir: statSync(join(abs, name)).isDirectory(),
            }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ entries }));
            return;
          }
          if (body.op === 'read') {
            if (!existsSync(abs) || statSync(abs).isDirectory()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `不是文件: ${body.path}` }));
              return;
            }
            /* 行范围读：大文件（GB 级数据）流式取片段，不受 512KB 整读上限约束 */
            const wantRange = Number.isInteger(body.offset) || Number.isInteger(body.limit);
            if (wantRange) {
              const offset = Number.isInteger(body.offset) && Number(body.offset) > 0 ? Number(body.offset) : 1;
              const limit =
                Number.isInteger(body.limit) && Number(body.limit) > 0 ? Math.min(Number(body.limit), 2000) : 200;
              const r = await readLines(abs, offset, limit);
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({
                  content: r.lines.join('\n'),
                  lines: r.lines.length,
                  offset,
                  reachedEnd: r.reachedEnd,
                }),
              );
              return;
            }
            if (statSync(abs).size > 512 * 1024) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: '文件超过 512KB，超出工具单次读取上限' }));
              return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ content: readFileSync(abs, 'utf-8') }));
            return;
          }
          if (body.op === 'grep') {
            const pattern = String(body.pattern ?? '');
            if (!pattern) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'grep 需要 pattern（正则）' }));
              return;
            }
            let re: RegExp;
            try {
              re = new RegExp(pattern);
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `正则无效: ${e}` }));
              return;
            }
            if (!existsSync(abs)) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `路径不存在: ${body.path}` }));
              return;
            }
            const maxResults =
              Number.isInteger(body.maxResults) && Number(body.maxResults) > 0
                ? Math.min(Number(body.maxResults), 200)
                : 50;
            const state = { matches: [] as string[], scanned: 0, truncated: false, deadline: Date.now() + 8000 };
            /* 命中条目的相对路径以根起算——模型可直接回填给 read_file 的 path */
            await grepFiles(re, baseRoot, body.path ?? '.', maxResults, state).catch(() => {
              state.truncated = true;
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                matches: state.matches.slice(0, maxResults),
                truncated: state.truncated,
                scanned: state.scanned,
              }),
            );
            return;
          }
          if (body.op === 'profile') {
            if (!existsSync(abs) || statSync(abs).isDirectory()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `不是文件: ${body.path}` }));
              return;
            }
            const ext = extname(abs).toLowerCase();
            const field = body.field !== undefined ? String(body.field) : undefined;
            if (ext === '.csv' || ext === '.tsv' || ext === '.jsonl') {
              const r = await profileFile(abs, field);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(r));
              return;
            }
            if (ext === '.json') {
              /* 小 JSON（对象数组）整读画像；大 JSON 结构不定型，指路行范围读 */
              if (statSync(abs).size > 512 * 1024) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'JSON 超过 512KB，结构不定型无法画像——用 read_file 的行范围读片段' }));
                return;
              }
              let data: unknown;
              try {
                data = JSON.parse(readFileSync(abs, 'utf-8'));
              } catch (e) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: `JSON 解析失败: ${e}` }));
                return;
              }
              const records = Array.isArray(data) ? data.filter((x) => x && typeof x === 'object') : [data];
              const columns: string[] = [];
              for (const rec of records.slice(0, 500))
                for (const k of Object.keys(rec as Record<string, unknown>)) if (!columns.includes(k)) columns.push(k);
              const r: ProfileResult = {
                sizeBytes: statSync(abs).size,
                rows: records.length,
                badRows: Array.isArray(data) ? data.length - records.length : 0,
                columns,
                samples: records.slice(0, PROFILE_SAMPLE_COUNT).map((rec) => {
                  const s = JSON.stringify(rec);
                  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
                }),
                truncated: false,
              };
              if (field !== undefined && field !== '') {
                const counts = new Map<string, number>();
                for (const rec of records) {
                  const v = String((rec as Record<string, unknown>)[field]);
                  counts.set(v, (counts.get(v) ?? 0) + 1);
                }
                r.fieldStats = {
                  distinct: counts.size,
                  truncated: counts.size >= PROFILE_STATS_CAP,
                  top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, PROFILE_TOP_N),
                };
              }
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(r));
              return;
            }
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: '只支持 .csv / .tsv / .jsonl / .json 文件的画像' }));
            return;
          }
          if (body.op === 'edit') {
            const oldString = String(body.oldString ?? '');
            const newString = String(body.newString ?? '');
            if (!oldString) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'oldString 不能为空' }));
              return;
            }
            if (oldString === newString) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'oldString 与 newString 相同，没有可执行的替换' }));
              return;
            }
            if (!existsSync(abs) || statSync(abs).isDirectory()) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: `不是文件: ${body.path}` }));
              return;
            }
            const content = readFileSync(abs, 'utf-8');
            const count = content.split(oldString).length - 1;
            if (count === 0) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({ error: 'oldString 在文件里找不到；内容可能已被改过，先 read_file 看当前内容再定锚点' }),
              );
              return;
            }
            /* 唯一性守卫：两处相同锚点静默改第一处是错改，报次数让模型扩大锚点 */
            if (!body.replaceAll && count !== 1) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(
                JSON.stringify({ error: `oldString 出现了 ${count} 次，不唯一；扩大锚点上下文使它唯一，或显式 replace_all` }),
              );
              return;
            }
            const next = body.replaceAll
              ? content.split(oldString).join(newString)
              : content.replace(oldString, newString);
            writeFileSync(abs, next, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({ bytes: Buffer.byteLength(next, 'utf-8'), replaced: body.replaceAll ? count : 1 }),
            );
            return;
          }
          if (body.op === 'write') {
            const content = String(body.content ?? '');
            mkdirSync(resolve(abs, '..'), { recursive: true });
            writeFileSync(abs, content, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ bytes: Buffer.byteLength(content, 'utf-8') }));
            return;
          }
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'op 必须是 list / read / grep / profile / write / edit' }));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });

      /**
       * agent 工具——shell：POST /api/tools/shell，body { cmd, ack? }。
       * 只读白名单命令直接执行；其余先返回 needApproval 让前端弹审批卡片，
       * 用户点允许后带 ack 重发才真正执行（cwd 钉在工作空间）。
       */
      server.middlewares.use('/api/tools/shell', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.end();
            return;
          }
          const body = (await readJsonBody(req)) as { cmd?: string; ack?: boolean };
          if (!body.cmd || typeof body.cmd !== 'string') {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'cmd 必填' }));
            return;
          }
          const verdict = classifyShell(body.cmd);
          if (!verdict.safe && !body.ack) {
            res.setHeader('Content-Type', 'application/json');
            /* command = 命令名（首 token），前端审批卡的「会话内总是允许」以它为粒度 */
            res.end(JSON.stringify({ needApproval: true, reason: verdict.reason, command: verdict.command }));
            return;
          }
          const r = await execShell(body.cmd);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(r));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), swiftApiPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5180,
    strictPort: false,
    /*
     * 经 DSW 网关代理访问时 Host 头是网关域名（如 <id>-proxy-<port>.dsw-gateway-*.aliyuncs.com），
     * 不在 Vite 默认放行名单里会被 403 拒掉。放开该网关后缀而非写死完整 host：
     * 域名里的 proxy-<port> 跟着端口走，端口让位后完整 host 会再次被拦。
     */
    allowedHosts: ['.dsw-gateway-cn-beijing.data.aliyuncs.com'],
    // 所在机器 fs.inotify.max_user_watches 只有 8192，且已被大仓库的索引进程占满，
    // 用 inotify 会直接 ENOSPC 崩掉。webui 自身文件很少，改用轮询更稳。
    watch: {
      usePolling: true,
      interval: 400,
      /*
       * swift.dev 在 cwd 落的临时产物（两种形态：swift.dev.model.loader.base
       * 与被 mmap 持有的 .efc_..._swift.dev.model.loader.base 随机前缀变体）：
       * 根因已修在任务 spawn 的 cwd 上，但改 cwd 前启动的存量任务与收编的
       * 孤儿部署仍以 webui 根为 cwd 周期性写这类文件，轮询 watch 会把它当
       * 源码变更触发整页 reload（页面周期性白屏闪烁）。用正则而不是 glob：
       * 变体文件以点开头，glob 的 * 默认不匹配点开头文件。源码都在 src/ 下，
       * 路径含 'swift.dev.' 的只可能是这类产物，不会误伤。
       */
      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**', /swift\.dev\./],
    },
  },
});
