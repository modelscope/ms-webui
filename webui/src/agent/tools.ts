import type { ToolCall } from '@/api/models';

/**
 * agent 工具的统一范式：一条工具 = OpenAI function schema + 执行器。
 *
 * 首页的文件/shell/联网搜索、批二的任务创建/删除、批三的表单填写，全部
 * 以这个形态注册——模型对页面的任何操作都走同一条 tool-calling 管线，
 * 没有旁路。执行器把结果整成回喂模型的文本；错误也作为结果回喂（模型可自救）。
 */

export interface ToolContext {
  /**
   * 立即执行类操作的审批入口：弹卡片等用户点头，返回 true = 同意。
   * 填参类工具（跳转+预填）不需要它——提交动作由人在目标页面上完成。
   * 第三个参数是命令名（shell 审批卡「会话内总是允许」的粒度），非 shell
   * 审批不传。
   */
  requestApproval: (title: string, reason: string, command?: string) => Promise<boolean>;
  /**
   * 会话级 shell 允许集：用户在某次审批卡勾过「总是允许」的命令名集合，
   * 后续同名命令直接执行不再弹卡。由使用方创建并维护，不传则每次都审批。
   */
  allowedCommands?: Set<string>;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentTool {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export function defineTool(schema: ToolSchema, execute: AgentTool['execute']): AgentTool {
  return { schema, execute };
}

/** 发请求时带给模型的 tools 数组 */
export function toolSchemas(tools: AgentTool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}

/** 执行一次工具调用：JSON 解析、分发、错误回喂，三个页面共用 */
export async function executeToolCall(
  tools: AgentTool[],
  call: ToolCall,
  ctx: ToolContext,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
  } catch {
    /*
     * 最常见成因是回复长度（max_tokens）不足：长内容写一半被截断，JSON 自然
     * 不完整。把成因与出路写进回喂，模型不用猜——分次写短内容或提示用户调大
     * 回复长度；附参数尾巴而非全文（全文回喂只会再烧一遍 token）。
     */
    const tail = (call.arguments ?? '').slice(-120);
    return [
      '参数不是合法 JSON（常见成因：回复长度（max_tokens）不够，参数写一半被截断）。',
      '对策：把内容拆短分次写入（先写前半，再用 edit_file 或追加方式续写），或提示用户在输入框配置里调大「回复长度」。',
      `收到的参数尾部: …${tail}`,
    ].join('\n');
  }
  const tool = tools.find((t) => t.schema.function.name === call.name);
  /* 点名成因：工具集随胶囊开关变化，历史里用过不代表本轮挂了一模型看到回喂就知道引导用户开胶囊，而不是猜「工具 flaky」 */
  if (!tool)
    return `未知工具: ${call.name}（本轮没有挂载它——文件/shell/脚本类工具需要输入框上方的「代码」胶囊开着；若已开着则确认这个工具名是否存在）`;
  try {
    return await tool.execute(args, ctx);
  } catch (e) {
    return `工具执行失败: ${String(e)}`;
  }
}
