import { useRef, useState } from 'react';

/**
 * 审批状态机（hook 形态）：立即执行类工具共用。
 *
 * resolver 存 ref 而非 state——Promise 的 settle 句柄不是渲染数据。
 * 多列（多模型）同时撞审批时，前一个未决的自动按拒绝结算：卡片只有一张，
 * 排队会让人误以为卡死。approval 本体是 {title, reason, command?}，由调用方渲染。
 *
 * command 只在 shell 审批时携带（服务端判出的命令名）：审批卡为它多渲染一个
 * 「会话内总是允许此类命令」勾选框，同意且勾选时经 onAlwaysAllow 把命令名
 * 记进调用方的允许集——之后同名命令不再弹卡。任务停止/表单提交类审批没有
 * command，不提供该勾选（每次都该由人点头）。
 */
export interface ApprovalRequest {
  title: string;
  reason: string;
  command?: string;
}

export function useApproval(opts?: { onAlwaysAllow?: (command: string) => void }) {
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const approvalResolver = useRef<((ok: boolean) => void) | null>(null);

  const requestApproval = (title: string, reason: string, command?: string) =>
    new Promise<boolean>((resolve) => {
      approvalResolver.current?.(false);
      approvalResolver.current = resolve;
      setAlwaysAllow(false);
      setApproval({ title, reason, ...(command ? { command } : {}) });
    });

  const settleApproval = (ok: boolean) => {
    if (ok && alwaysAllow && approval?.command && opts?.onAlwaysAllow) {
      opts.onAlwaysAllow(approval.command);
    }
    approvalResolver.current?.(ok);
    approvalResolver.current = null;
    setApproval(null);
  };

  return { approval, alwaysAllow, setAlwaysAllow, requestApproval, settleApproval };
}
