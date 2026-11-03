import { useState } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
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

/** 正在重命名的目标；label 用作输入框初值 */
export interface RenameTarget {
  id: string;
  label: string;
}

/**
 * 重命名弹窗，TaskListPage 与 TaskDetailShell 的「重命名」共用。
 *
 * 受控形态：target 为 null 时关闭；调用方渲染时带 key={target.id}，让弹窗
 * 在换目标时重建、输入框初值回到该任务的当前名。确认按钮不依赖 Radix 的
 * 自动关闭（preventDefault），改名失败时弹窗留着、错误走 toast。
 */
export function RenameDialog({
  target,
  onConfirm,
  onClose,
}: {
  target: RenameTarget;
  onConfirm: (id: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(target.label);
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    const name = value.trim();
    if (!name) return;
    setBusy(true);
    try {
      await onConfirm(target.id, name);
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('rename.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('rename.hint')}</AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void confirm();
            }
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || !value.trim()}
            onClick={(e) => {
              /* 关闭由 confirm 的成功路径手动控制，失败时留住弹窗 */
              e.preventDefault();
              void confirm();
            }}
          >
            {t('common.save')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
