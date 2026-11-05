import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useT } from '@/i18n';

/**
 * 引擎回合挂起的审批卡（approvals.json 的 pending 面）：server 侧工具
 * （submit_form / flow_control / stop_task 等）等的决定入口——用户点头/
 * 拒绝后 POST 决定，引擎 1s 内恢复回合。拒绝文案会作为工具结果回喂，
 * 模型可以换路走。command 存在 = shell 审批，多给「会话内总是允许此类
 * 命令」勾选。页面助手面板（配置/任务页）与编排页 AI 面板共用。
 */
export function EngineApprovalCard({
  approval,
  onResolve,
  checked,
  onCheck,
}: {
  approval: { id: string; title: string; reason: string; command?: string };
  /** 决定回调（approve 且勾了总是允许时把命令收进引擎白名单） */
  onResolve: (id: string, approve: boolean, allowCommand: boolean) => void;
  /** 「总是允许」勾选受控值（无 command 时不渲染勾选） */
  checked?: boolean;
  onCheck?: (v: boolean) => void;
}) {
  const { t } = useT();
  return (
    <div className="border-state-failed/50 bg-card m-3 mt-0 rounded-xl border p-3.5">
      <div className="text-foreground flex items-center gap-1.5 text-[13px] font-medium">
        <ShieldAlert size={14} className="text-state-failed flex-none" />
        {t('approval.title')}
      </div>
      <pre className="bg-muted mt-2 max-h-32 overflow-auto rounded-lg p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
        {approval.title}
      </pre>
      <div className="text-muted-foreground mt-1.5 text-xs whitespace-pre-line">{approval.reason}</div>
      {approval.command && (
        <label className="text-muted-foreground mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-xs">
          <Checkbox checked={checked === true} onCheckedChange={(v) => onCheck?.(v === true)} />
          {t('approval.alwaysAllow', { command: approval.command })}
        </label>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onResolve(approval.id, false, false)}>
          {t('approval.deny')}
        </Button>
        <Button size="sm" onClick={() => onResolve(approval.id, true, approval.command ? checked === true : false)}>
          {t('approval.allow')}
        </Button>
      </div>
    </div>
  );
}
