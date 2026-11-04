import { fsTool, shellTool, type ShellResult } from '../api/tools';
import { webSearch, type SearchHit } from '../api/search';
import { readSkillDoc } from '../api/skills';
import { listCatalog, type CatalogEntry } from '../api/catalog';
import { envInfo } from '../api/env';
import { getScriptLog, listScripts, startScript, stopScript } from '../api/scripts';
import { defineTool, type AgentTool } from './tools';

/**
 * 内置工具集：从 ChatPage 迁来的代码模式四件套与联网搜索。
 * schema 与执行器成对搬家，ChatPage 只保留选择哪些工具的页面语义。
 */

/**
 * agent 工具轮上限：防模型无限连环调用（每轮还会各自吃 max_tokens）。
 * 用户定为 100：长链探查/实验任务不设人为瓶颈，失控防护靠上限存在
 * 本身 + runAgentLoop 的耗尽显式提示，而非把值压小。
 */
export const MAX_TOOL_ROUNDS = 100;

/*
 * 「研究」模式的 system 不再是这里的常量：对话的基础/研究两个 prompt 都在
 * 偏好设置的提示词库里管理（src/store/systemPrompts.ts），send() 现读现用。
 */

/** 「联网搜索」模式的 system 注入：引导模型把检索当工具自主使用（可多轮） */
export const WEB_SEARCH_SYSTEM =
  '你可以随时调用 web_search 工具检索网络信息。时效性、版本号、最新动态这类' +
  '问题先检索再回答；检索词自行提炼，一次结果不够可以换个关键词再搜。' +
  '回答时注明来源编号，检索不到的如实说明。';

/*
 * 「研究」模式的行为引导（代码级注入，不随用户设置里的旧预设文案漂移）：
 * 优先级——bundled skills 文档（SKILL.md 全文 + read_skill 深度文档）/
 * web_search > 本地文件探查。数据集格式、CLI 参数、组件用法这类「文档里就有」
 * 的问题不该靠翻本地文件来回答，一次研究任务里十几条只读命令 + 审批点是把
 * 用户当批处理跑。
 */
export const RESEARCH_GUIDANCE =
  'Prioritize the bundled skill documents and web_search over local file inspection: dataset ' +
  'formats, CLI flags, component usage and model ids are documented there — do not read local ' +
  'dataset files just to determine a format. The SKILL.md of each skill is already in your context; ' +
  'when you need deeper details (full CLI reference, components, plugins, server-client), read the ' +
  'listed companion files with the read_skill tool instead of hunting for them with read_file or ' +
  'shell. Read local workspace files only when the answer genuinely depends on their contents ' +
  '(data you created, logs, outputs). Keep tool usage minimal: prefer one decisive command over ' +
  'exploratory ones, and reuse conclusions you already drew instead of re-checking the same file.';

/** 检索结果回喂格式：带编号的标题/链接/摘要 */
function formatSearchHits(hits: SearchHit[]): string {
  if (!hits.length) return '没有检索到相关结果。可以换个关键词再试，或如实说明无法检索到。';
  return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.content}`).join('\n\n');
}

/*
 * 工具输出回喂上限：探查类输出（shell 结果、read_file、脚本日志）超过它就只
 * 保留头尾、中段标注省略量。不截断的代价是结构性的——大输出进对话历史后，
 * agent 循环每一轮都把全部历史重发一遍，一条几万 token 的输出会跟着后续每轮
 * 重复计费；截掉中段模型仍可缩小命令范围（head/tail/grep）再取所需片段。
 */
const FEEDBACK_LIMIT = 8192;

/** 探查类输出回喂截断：头 6KB + 尾 1.5KB，中段换成省略说明 */
function clipFeedback(text: string, label: string): string {
  if (text.length <= FEEDBACK_LIMIT) return text;
  const head = text.slice(0, 6144);
  const tail = text.slice(-1536);
  const omitted = text.length - head.length - tail.length;
  return (
    `${head}\n…（${label}已截断：省略中段 ${omitted} 字符、共 ${text.length} 字符。` +
    `需要别的片段就缩小命令/读取范围再取：head/tail/grep 过滤，或指定更小的文件段落）…\n${tail}`
  );
}

/**
 * 「研究」模式的文件/shell 工具集（执行面在 vite 中间件，权限限工作空间）。
 * conv/modelId 是脚本唤醒通道的归属：run_script 把它们随任务登记，脚本到达
 * 终态时中间件把事件推回这个对话的这一列（对话页 2s 轮询取走自动续轮）。
 */
export function workspaceTools(conv?: string, modelId?: string): AgentTool[] {
  return [
    defineTool(
      {
        type: 'function',
        function: {
          name: 'read_file',
          description:
            '读取文本文件的指定行范围（offset/limit，1-based 起始行 + 行数，默认前 200 行）。' +
            '定位工作流：先 grep 拿「文件:行号」再用 offset 读命中处片段，不要整读大文件。' +
            '默认在工作空间里（相对 ~/.swift/workspace）；root="external" 读用户登记的外部数据目录' +
            '（绝对路径，只读——探查原始数据用；GB 级大文件也走行范围读）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径：workspace 根的相对路径，或 external 模式下的绝对路径' },
              root: {
                type: 'string',
                enum: ['workspace', 'external'],
                description: '默认 workspace；external = 用户在偏好设置里登记的外部数据目录',
              },
              offset: { type: 'integer', description: '起始行号（1-based，默认 1）' },
              limit: { type: 'integer', description: '读取行数（默认 200，上限 2000）' },
            },
            required: ['path'],
          },
        },
      },
      async (args) => {
        const path = String(args.path ?? '');
        const root = args.root === 'external' ? 'external' : 'workspace';
        const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : undefined;
        const limit = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
        try {
          const r = await fsTool({ op: 'read', path, root, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) });
          /* 行范围形态：带范围元信息头，模型知道后面还有多少、怎么续读 */
          if (r.lines !== undefined) {
            const start = r.offset ?? offset ?? 1;
            const end = start + r.lines - 1;
            const rangeNote = r.reachedEnd
              ? `（第 ${start}–${end} 行，已到文件尾）`
              : `（第 ${start}–${end} 行，其后还有内容——续读传 offset=${end + 1}）`;
            return clipFeedback(`${rangeNote}\n${r.content ?? ''}`, '文件内容 ');
          }
          return clipFeedback(r.content ?? '', '文件内容 ');
        } catch (e) {
          /* 报错顺手指路：技能文档不在工作空间里，模型最常犯的就是拿它查技能 */
          return `${String(e instanceof Error ? e.message : e)}\n提示：技能文档（如 swift-usage/cli-reference.md）用 read_skill 工具读取；` +
            `${root === 'external' ? '外部路径需要用户先在「偏好设置 → 外部数据目录」里登记。' : '原始数据等外部路径走 root="external"（需用户已登记）。'}`;
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'dataset_profile',
          description:
            '一次调用给出数据文件画像：行数/字节/列名/抽样 3 条/字段值分布（csv/tsv/jsonl/json，支持 GB 级流式）。' +
            '数据探查（几行、什么列、某字段取值）先用它，不要用 shell 连环 wc/head/grep 或单行 python 统计摸数据；' +
            '需要更复杂的统计才写脚本 run_script',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '文件路径：workspace 根的相对路径，或 external 模式下的绝对路径' },
              root: {
                type: 'string',
                enum: ['workspace', 'external'],
                description: '默认 workspace；external = 用户在偏好设置里登记的外部数据目录',
              },
              field: { type: 'string', description: '可选：统计该字段的值分布（top 20 + distinct 总数）' },
            },
            required: ['path'],
          },
        },
      },
      async (args) => {
        const path = String(args.path ?? '');
        const root = args.root === 'external' ? 'external' : 'workspace';
        const field = String(args.field ?? '').trim();
        try {
          const r = await fsTool({ op: 'profile', path, root, ...(field ? { field } : {}) });
          const parts = [
            `文件 ${path} · ${r.sizeBytes ?? '?'} 字节 · ${r.rows ?? '?'} 行 · 列 ${r.columns?.length ?? 0} 个` +
              `${r.truncated ? '（扫描超 8s 截断，行数是下界）' : ''}${r.badRows ? ` · ${r.badRows} 行解析失败跳过` : ''}`,
            r.columns?.length ? `列名：${r.columns.join('、')}` : '',
            r.samples?.length ? `抽样（前 ${r.samples.length} 条）：\n${r.samples.join('\n')}` : '',
            r.fieldStats
              ? `字段 ${field} 值分布（distinct ${r.fieldStats.distinct}${r.fieldStats.truncated ? '（超上限只列 top）' : ''}）：\n` +
                r.fieldStats.top.map(([v, c]) => `  ${v}: ${c}`).join('\n')
              : '',
          ].filter(Boolean);
          return clipFeedback(parts.join('\n'), '数据画像 ');
        } catch (e) {
          return String(e instanceof Error ? e.message : e);
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'grep',
          description:
            '用正则搜索文件内容，返回「相对路径:行号:该行内容」列表。定位信息的首选工具：' +
            '找到行号后用 read_file 的 offset/limit 读上下文片段。默认搜整个工作空间；' +
            'root="external" 搜用户登记的外部数据目录（path 给相对该根的路径）；root="swift" 搜安装的 swift 源码',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '正则表达式（JavaScript RegExp 语法，如 "def train|loss_fn"）' },
              path: { type: 'string', description: '搜索起点：相对根的目录或文件路径（默认 "." 搜整个根）' },
              root: {
                type: 'string',
                enum: ['workspace', 'external', 'swift'],
                description: '默认 workspace',
              },
              max_results: { type: 'integer', description: '命中条数上限（默认 50，上限 200）' },
            },
            required: ['pattern'],
          },
        },
      },
      async (args) => {
        const pattern = String(args.pattern ?? '');
        const root = args.root === 'external' ? 'external' : args.root === 'swift' ? 'swift' : 'workspace';
        const maxResults =
          Number.isInteger(args.max_results) && Number(args.max_results) > 0 ? Number(args.max_results) : undefined;
        try {
          const r = await fsTool({
            op: 'grep',
            path: String(args.path ?? '.') || '.',
            root,
            pattern,
            ...(maxResults ? { maxResults } : {}),
          });
          const matches = r.matches ?? [];
          if (!matches.length) {
            return `没有命中（扫描 ${r.scanned ?? 0} 个文件）。换更宽的 pattern 或扩大 path 范围。`;
          }
          return [
            `${matches.length} 处命中${r.truncated ? '（已截断：缩小 path 范围或收紧 pattern）' : ''}（扫描 ${r.scanned ?? 0} 个文件）：`,
            ...matches,
          ].join('\n');
        } catch (e) {
          return String(e instanceof Error ? e.message : e);
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: '把文本内容写入工作空间的文件（整体覆盖，父目录自动创建）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对工作空间根的路径' },
              content: { type: 'string', description: '要写入的全部文本内容' },
            },
            required: ['path', 'content'],
          },
        },
      },
      async (args) => {
        const r = await fsTool({
          op: 'write',
          path: String(args.path ?? ''),
          content: String(args.content ?? ''),
        });
        return `已写入 ${r.bytes ?? 0} 字节`;
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'edit_file',
          description:
            '精确替换工作空间里一个文件的一段文本。old_string 必须与文件当前内容完全一致且唯一' +
            '（不唯一就扩大上下文行）；整份文件里多处相同替换才用 replace_all。' +
            '修改已有文件优先用它，不要用 write_file 整体重写长文件，也不要用 shell sed',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对工作空间根的路径' },
              old_string: { type: 'string', description: '要替换的原文（带上下文行保证唯一）' },
              new_string: { type: 'string', description: '替换后的内容' },
              replace_all: { type: 'boolean', description: '替换全部出现处（默认 false，仅唯一匹配时替换）' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
      async (args) => {
        try {
          const r = await fsTool({
            op: 'edit',
            path: String(args.path ?? ''),
            oldString: String(args.old_string ?? ''),
            newString: String(args.new_string ?? ''),
            ...(args.replace_all === true ? { replaceAll: true } : {}),
          });
          return `已替换 ${r.replaced ?? 1} 处，文件现在 ${r.bytes ?? 0} 字节`;
        } catch (e) {
          return String(e instanceof Error ? e.message : e);
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description:
            '列出一个目录下的条目。默认在工作空间里；root="external" 列用户登记的外部数据目录（只读）',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'workspace 根的相对路径（默认根目录），或 external 模式下的目录路径',
              },
              root: { type: 'string', enum: ['workspace', 'external'], description: '默认 workspace' },
            },
          },
        },
      },
      async (args) => {
        const root = args.root === 'external' ? 'external' : 'workspace';
        const r = await fsTool({ op: 'list', path: String(args.path ?? '') || '.', root });
        return (r.entries ?? []).map((e) => `${e.name}${e.dir ? '/' : ''}`).join('\n');
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'run_script',
          description:
            '把工作空间里的一个 python 脚本作为后台任务执行（长作业专用：前处理、数据分析）。' +
            '立即返回任务 id；完成后结果会自动通知回本对话，中途输出用 read_script_log(task_id) 查看。' +
            '不要用 shell 跑长脚本（30 秒会超时）',
          parameters: {
            type: 'object',
            properties: {
              script: { type: 'string', description: '相对工作空间根的脚本路径' },
              args: { type: 'array', items: { type: 'string' }, description: '命令行参数（逐个传递）' },
            },
            required: ['script'],
          },
        },
      },
      async (args) => {
        try {
          const id = await startScript(
            String(args.script ?? ''),
            Array.isArray(args.args) ? args.args.map(String) : undefined,
            conv,
            modelId,
          );
          return `脚本任务已启动：${id}。中途输出用 read_script_log(task_id="${id}") 查看；完成后会自动通知回本对话（无需反复轮询）。`;
        } catch (e) {
          return String(e instanceof Error ? e.message : e);
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'read_script_log',
          description:
            '读取一个脚本任务的日志（run_script 返回的 task_id），回执头部带任务状态与运行时长；带 tail 只取最后 N 行。' +
            '脚本完成后会自动唤醒本对话——本工具只用于中途诊断（怀疑跑偏/失败归因），不要反复轮询进度',
          parameters: {
            type: 'object',
            properties: {
              task_id: { type: 'string', description: 'run_script 返回的任务 id' },
              tail: { type: 'integer', description: '只取最后 N 行（长日志时用）' },
            },
            required: ['task_id'],
          },
        },
      },
      async (args) => {
        try {
          const taskId = String(args.task_id ?? '');
          const lines = await getScriptLog(taskId);
          /* 回执头部带任务状态（事实+建议动作同包）：运行中明说「完成会自动唤醒」，
           * 终止模型把读日志当唯一进度手段的轮询循环（实测一次研究 83 次轮询） */
          let head = '';
          try {
            const task = (await listScripts()).find((t) => t.id === taskId);
            if (task) {
              const mins = Math.max(
                1,
                Math.round((Date.now() - new Date(`${task.startedAt.replace(' ', 'T')}Z`).getTime()) / 60_000),
              );
              head =
                task.status === 'running'
                  ? `[脚本 ${taskId} · running · 已运行 ${mins} 分钟] 完成后会自动唤醒本对话，无需反复查看。\n`
                  : `[脚本 ${taskId} · ${task.status} · 已结束]\n`;
            }
          } catch {
            /* 任务表读取失败不影响日志本体 */
          }
          const tail = Number.isInteger(args.tail) && Number(args.tail) > 0 ? Number(args.tail) : 0;
          const shown = tail ? lines.slice(-tail) : lines;
          return shown.length
            ? clipFeedback(head + shown.join('\n'), '脚本日志 ')
            : `${head}（暂无输出——脚本可能刚启动，稍后再查）`;
        } catch (e) {
          return String(e instanceof Error ? e.message : e);
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'stop_script',
          description: '停止一个还在运行的脚本任务（发现脚本跑错了方向时及时止损）',
          parameters: {
            type: 'object',
            properties: { task_id: { type: 'string', description: 'run_script 返回的任务 id' } },
            required: ['task_id'],
          },
        },
      },
      async (args) => {
        try {
          await stopScript(String(args.task_id ?? ''));
          return '已发送停止信号。';
        } catch (e) {
          return String(e instanceof Error ? e.message : e);
        }
      },
    ),
    defineTool(
      {
        type: 'function',
        function: {
          name: 'shell',
          description:
            '在工作空间目录执行一条 shell 命令并返回 stdout/stderr/退出码（限时 30 秒）。' +
            '只读命令（ls/cat/grep/jq/awk 等）直接执行，其余需要用户批准——' +
            '被拒绝时换不需要该命令的做法',
          parameters: {
            type: 'object',
            properties: { cmd: { type: 'string', description: '要执行的命令' } },
            required: ['cmd'],
          },
        },
      },
      async (args, ctx) => {
        const cmd = String(args.cmd ?? '');
        let r = await shellTool(cmd);
        if (r.needApproval) {
          /*
           * 用户勾过「会话内总是允许」的直通判定按整条命令的每一段算：
           * 只记过 ls 就放行「ls && rm -rf …」是漏洞——组合命令必须所有段
           * 的主命令名都在允许集里才 ack 直通，否则照常弹卡。
           */
          const heads = cmd
            .split(/&&|\|\||;|\||\n/)
            .map((seg) => seg.trim().split(/\s+/).filter((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)))
            .map((toks) => {
              let i = 0;
              if (toks[0] === 'timeout') {
                i += 1;
                while (i < toks.length && /^[\d.]+[a-z]?$/i.test(toks[i])) i += 1;
              }
              return (toks[i] ?? '').replace(/^["']|["']$/g, '');
            })
            .filter(Boolean);
          if (heads.length && heads.every((n) => ctx.allowedCommands?.has(n))) {
            r = await shellTool(cmd, true);
          } else {
            const ok = await ctx.requestApproval(cmd, r.reason, r.command || heads[0] || '');
            if (!ok) {
              return '用户拒绝了这条命令的执行。请换一种不需要它的做法，或向用户解释为什么需要。';
            }
            r = await shellTool(cmd, true);
          }
        }
        if (r.needApproval) {
          return '命令获批后服务端仍要求审批（异常状态），未执行。';
        }
        /* strictNullChecks 关闭时可选判别式不收窄，显式落到执行结果形态 */
        const done = r as ShellResult;
        return [
          `exit=${done.code}${done.timedOut ? '（超时被终止）' : ''}`,
          `stdout:`,
          clipFeedback(done.stdout || '(空)', 'stdout '),
          `stderr:`,
          clipFeedback(done.stderr || '(空)', 'stderr '),
        ].join('\n');
      },
    ),
  ];
}

/**
 * 工作台行动指引（常驻注入）：把「swift 怎么用、数据集哪里找、模型谁定、
 * 卡数怎么定分片」这四类高频问题的正确入口一次性交代清楚——没有这段时
 * 模型会拿 swift --help、nvidia-smi、翻源码这类命令自己找路，每条都要审批。
 * 具体任务的领域知识（如 self-cognition 怎么配）不在此列：skills 文档 +
 * list_catalog + 用户补充覆盖。
 */
export const WORKBENCH_GUIDE = [
  '## 工作台行动指引',
  '- swift 的用法以注入的 skills 文档为准：SKILL.md 全文在上下文里，CLI 全参数、组件、插件、server-client 等细节用 read_skill 读附属文档；不要用 swift --help 或翻安装源码来回答用法问题。',
  '- skills 文档查不到的细节、或怀疑文档与安装版本不符时，用 read_swift_source 读当前 python 环境安装的 swift 源码核实（相对包根路径，如 dev/config/train_config.py）——文档优先，源码是仲裁手段不是首选。',
  '- 找数据集/模型候选用 list_catalog（swift 注册表全量，数据集带标签与热度、模型带 model_type；cached 标记已在本机）：先搜再问；ModelScope 平台与 Hub 操作参考 ms-hub 技能文档。',
  '- 模型必须由用户指定（hub id 或本地路径）：缺了就把 list_catalog 的候选摆给用户挑，不要猜。',
  '- 算力规划用 env_info 查本地 GPU 清单与 swift 环境：本地训练的卡数决定 nproc_per_node（create_train 的 gpus 传卡号列表）；远端/集群资源只声明卡数（gpu_count），不传本机卡号。',
  '- 环境事实一次拿全：GPU/卡数、模型缓存根与已缓存模型、swift 与 evalscope 的版本可用性、python 解释器，全在 env_info 的返回里——不要为这些写 probe 脚本或连环 shell 探测（每条都要审批还烧轮次）；模板渲染、数据字段这类 swift 行为问题用 read_swift_source 仲裁。把精力放在数据集选择、模型选择、训练构型、实验设计、算法与指标设计上。',
  '- 需要用户的原始数据时，先问清数据格式与存放路径：路径在工作空间外就请用户在「偏好设置 → 外部数据目录」里登记（只读），然后用 dataset_profile/read_file/list_dir 的 root="external" 探查；大文件的分析用 shell 的 head/wc/jq（不受工作空间限制）。',
  '- 前处理、数据分析这类长脚本：write_file 写进工作空间后用 run_script 后台执行（shell 有 30 秒超时）。脚本完成后会自动通知回本对话——启动后回合可以自然收尾等通知，中途诊断（怀疑跑偏/失败归因）才用 read_script_log，不要反复轮询进度；修改已有文件用 edit_file  精确替换，不要 sed。',
  '- 数据探查第一步用 dataset_profile（一次拿行数/列名/抽样/字段分布，支持外部数据根）；它覆盖不了的更复杂统计（关系配对、交叉校验）才合并成一个综合脚本 run_script 跑完，输出只留汇总统计与少量样例（几十行）；不要连环小步 shell 逐步摸——每轮工具结果都进历史且逐轮重发，连环探查的 token 成本是轮数 × 上下文大小双倍放大。探查脚本的 print 自觉控制在汇总级，全量明细落文件、按需取片段。',
  '- 找信息先定位再取片段：grep（正则搜内容拿「文件:行号」）→ read_file 的 offset/limit 只读命中处几十行；不要整读文件、也不要用 shell 管道拼 head/tail/grep。大文件（原始数据、全量明细）永远走「grep 定位 + 行范围读」，整读是最后手段。',
  '- 写插件（自定义数据集、reward、tool 等 .py）落到 workspace/plugins/<名字>.py：插件页与训练等表单立即可见可选；自定义数据集的完整做法见 swift-usage 的 custom-data.md（read_skill 读取）。',
  '- 本工作台的交互形态：create_train 等工具是「跳转目标页并预填表单」，提交由用户在页面上点启动完成；跳转后页面助手会带着这段对话续聊，不必重复背景。',
].join('\n');

/**
 * 技能深度文档工具：read_skill。system 上下文里只注入各技能的 SKILL.md 全文
 * 与附属文件清单——清单里的文件（CLI 全参数、组件、插件、server-client 等）
 * 物理上不在工作空间，read_file/shell 都够不着。没有这个工具时模型被引导
 * 「优先查文档」却查不到，就退化成乱翻工作空间。
 */
export function readSkillDocTool(): AgentTool {
  return defineTool(
    {
      type: 'function',
      function: {
        name: 'read_skill',
        description:
          '读取一份附带技能文档的附属深度文档（如 swift-usage/cli-reference.md）。' +
          'SKILL.md 全文已在 system 上下文里；需要 CLI 完整参数、组件、插件、' +
          'server-client、ModelScope 平台操作等细节时用它按需展开',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '附属文档路径，形如 "swift-usage/cli-reference.md"（即上下文附属文件清单里列出的名字）',
            },
          },
          required: ['path'],
        },
      },
    },
    async (args) => {
      const path = String(args.path ?? '').replace(/^\/+/, '');
      const slash = path.indexOf('/');
      if (slash <= 0) {
        return '路径形如 "<技能名>/<文件名>"，如 swift-usage/cli-reference.md——用上下文附属文件清单里列出的名字。';
      }
      try {
        return await readSkillDoc(path.slice(0, slash), path.slice(slash + 1));
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );
}

/**
 * 注册表候选搜索工具：list_catalog。数据源与新建页下拉同源（MODEL_MAPPING /
 * DATASET_MAPPING 全量 + 本机缓存模型）——「数据集从哪里找、模型有哪些候选」
 * 的权威答案，替代模型拿 shell 翻缓存目录。
 */
export function listCatalogTool(): AgentTool {
  const format = (entries: CatalogEntry[]): string =>
    entries.length
      ? entries.map((e) => `- ${e.id}${e.tags.length ? `（${e.tags.slice(0, 3).join(' · ')}）` : ''}${e.cached ? ' [已在本机缓存]' : ''}`).join('\n')
      : '没有匹配的候选；换个关键词，或直接用用户给的 hub id / 本地路径。';
  return defineTool(
    {
      type: 'function',
      function: {
        name: 'list_catalog',
        description:
          '搜索 swift 注册表里的模型或数据集候选（新建训练/评测/部署任务时选型的捷径）。' +
          '数据集条目带标签（🔥 = 文档标记的重要数据集），模型条目带 model_type，' +
          'cached 标记已下载到本机。清单是捷径不是白名单——用户给的清单外 id 一样可用',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['dataset', 'model'], description: '查哪一类' },
            query: { type: 'string', description: '关键词（对 id 与标签做子串匹配，如 self、gsm8k、qwen）；空 = 只看高优先候选' },
            limit: { type: 'integer', description: '返回条数上限，默认 20' },
          },
          required: ['kind'],
        },
      },
    },
    async (args) => {
      const kind = args.kind === 'model' ? 'model' : 'dataset';
      const query = String(args.query ?? '').toLowerCase();
      const limit = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : 20;
      try {
        const catalog = await listCatalog();
        const all = kind === 'model' ? catalog.models : catalog.datasets;
        const matched = all.filter(
          (e) => !query || e.id.toLowerCase().includes(query) || e.tags.some((t) => t.toLowerCase().includes(query)),
        );
        /* 无关键词时优先热门（🔥 / cached / 有标签的），有关键词时保持注册表顺序 */
        const ranked = query
          ? matched
          : matched.sort((a, b) => Number(b.cached ?? false) - Number(a.cached ?? false) || b.tags.length - a.tags.length);
        return `${kind === 'model' ? '模型' : '数据集'}候选（共 ${matched.length} 个，显示前 ${Math.min(limit, ranked.length)}）：\n${format(ranked.slice(0, limit))}`;
      } catch (e) {
        return `注册表读取失败: ${String(e instanceof Error ? e.message : e)}`;
      }
    },
  );
}

/** 运行环境工具：env_info。GPU + swift 版本/路径 + python，规划分片前先查这个 */
export function envInfoTool(): AgentTool {
  return defineTool(
    {
      type: 'function',
      function: {
        name: 'env_info',
        description:
          '查询运行环境：本地 GPU 清单（卡号/型号/显存占用）、swift 版本与安装路径、python 解释器、' +
          'evalscope 可用基准全名单（--eval_dataset / evalPlan 只认其中的精确名）。' +
          '规划训练/部署的用卡与并行度、选定评测数据集前先查这个，不要用 nvidia-smi 等命令探测',
        parameters: { type: 'object', properties: {} },
      },
    },
    async () => {
      try {
        const env = await envInfo();
        const gpuLines = env.gpus.length
          ? env.gpus.map((g) => `- 卡 ${g.index}: ${g.name}，显存 ${g.used}/${g.total} MiB`).join('\n')
          : '（无可见 GPU 或驱动不可用）';
        return [
          'GPU 清单：',
          gpuLines,
          `swift: ${env.swift ? `${env.swift.version}（安装于 ${env.swift.path}）` : '当前 python 环境未装 swift'}`,
          `python: ${env.python}`,
          `evalscope: ${env.evalscope ? env.evalscope.version : '未安装（评测链需自建 harness 或先安装）'}`,
          env.benchmarks
            ? `evalscope 可用基准（${env.benchmarks.length} 个，--eval_dataset 只认这些精确名，版本/subset/limit 注记不要写进名字）：\n${env.benchmarks.join(' ')}`
            : 'evalscope 基准注册表暂不可达（需要 --eval_dataset 时先跑一条只读命令核对名字）',
          `模型缓存根: ${env.modelCache}`,
          env.cachedModels.length ? `已缓存模型: ${env.cachedModels.join('、')}` : '已缓存模型: （无）',
          '本地训练的 nproc_per_node 应等于所选卡数；远端/集群资源只声明卡数。',
          '以上即本机环境的全部权威事实——不要再写 probe 脚本探测它们（GPU/缓存路径/依赖版本均已在此），把精力放在数据、模型与实验设计上。',
        ].join('\n');
      } catch (e) {
        return `环境读取失败: ${String(e instanceof Error ? e.message : e)}`;
      }
    },
  );
}

/**
 * swift 安装源码工具：read_swift_source。skills 文档查不到、或怀疑文档与
 * 实际安装版本不符时的仲裁通道——文档优先，源码核实是兜底不是首选。
 * 服务端把路径钉死在当前 python 环境的 swift 包根内（只读），模型无须
 * 知道绝对路径、也不能借此读包外的文件。
 */
export function readSwiftSourceTool(): AgentTool {
  return defineTool(
    {
      type: 'function',
      function: {
        name: 'read_swift_source',
        description:
          '读取当前 python 环境里安装的 swift 包源码（相对包根路径，如 "dev/config/train_config.py"；' +
          'op=list 可列目录结构）。长文件先 grep(root="swift") 定位行号，再用 offset/limit 读命中处片段，不要整读。' +
          '用于 skills 文档查不到的细节、或需要核实安装版本的真实行为时；' +
          '日常用法问题先查 skills 文档，源码是仲裁手段不是首选',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对 swift 包根的路径；list 时可用 "." 或目录路径' },
            op: { type: 'string', enum: ['read', 'list'], description: '读文件（默认）还是列目录' },
            offset: { type: 'integer', description: '起始行号（1-based，与 limit 配合读片段）' },
            limit: { type: 'integer', description: '读取行数（默认前 200 行，上限 2000）' },
          },
          required: ['path'],
        },
      },
    },
    async (args) => {
      /* 模型常拿仓内相对形态 "swift/dev/..." 传进来，剥掉包名前缀 */
      let path = String(args.path ?? '').replace(/^\/+/, '');
      if (path === 'swift' || path.startsWith('swift/')) path = path.slice('swift/'.length) || '.';
      const op = args.op === 'list' ? 'list' : 'read';
      const offset = Number.isInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : undefined;
      const limit = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
      try {
        const r = await fsTool({ op, path, root: 'swift', ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) });
        if (op === 'list') return (r.entries ?? []).map((e) => `${e.name}${e.dir ? '/' : ''}`).join('\n') || '(空目录)';
        /*
         * 行范围元信息头 + 截断守卫，与 read_file 同构：源码文件动辄上千行，
         * 无范围整读一次上万字符进历史且逐轮重发（实测回执量榜首）。
         */
        if (r.lines !== undefined) {
          const start = r.offset ?? offset ?? 1;
          const end = start + r.lines - 1;
          const rangeNote = r.reachedEnd
            ? `（第 ${start}–${end} 行，已到文件尾）`
            : `（第 ${start}–${end} 行，其后还有内容——续读传 offset=${end + 1}）`;
          return clipFeedback(`${rangeNote}\n${r.content ?? ''}`, 'swift 源码 ');
        }
        return clipFeedback(r.content ?? '', 'swift 源码 ');
      } catch (e) {
        return String(e instanceof Error ? e.message : e);
      }
    },
  );
}

/** 联网搜索工具（走 Tavily，服务端转发） */
export function webSearchTool(): AgentTool {
  return defineTool(
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '检索网络信息并返回带编号的结果（标题、链接、摘要，最多 5 条）。' +
          '时效性/版本类问题先检索再回答；结果不够可换关键词再检索',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '检索关键词，自行提炼' } },
          required: ['query'],
        },
      },
    },
    async (args) => formatSearchHits(await webSearch(String(args.query ?? ''))),
  );
}
