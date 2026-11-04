import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { TaskStatus } from '@/mock/types';
import { useT, type MessageKey } from '@/i18n';

/**
 * 状态标签。RUNNING / IDLE / DONE / FAILED / STOPPED——IDLE 仅研究会话
 * 映射（停摆待唤醒），执行器任务不产生这一档。
 *
 * 原来是无边框的软胶囊（圆角 999 + 浅底色），现在是细边框 + 极淡底色的标记。
 * 圆角走 rounded-sm 而不是不写：以前靠「不写圆角类」就能得到直角，那是因为当时
 * --radius 是 0；现在皮肤的 radius 是 0.5rem，不写的话全站都圆了只剩它是方的。
 * 这里取比默认小一档的 sm：标签只有 18px 行高，用 8px 圆角会显得胖。
 *
 * 颜色不再写死在这个文件里，而是取 index.css 的 --state-*，
 * 好处是画布里的节点边框、连线动画和这里天然同色——状态色只有一处定义。
 * 底色和边框由同一个变量 color-mix 出来，深色模式下会跟着一起变，不用写两套。
 *
 * tooltip 写清每种状态的判定来源，避免用户把 STOPPED 当成 DONE。
 */
const STATUS_META: Record<TaskStatus, { text: MessageKey; token: string; live?: boolean; hint: MessageKey }> =
  {
    RUNNING: {
      text: 'status.running',
      token: '--state-running',
      live: true,
      hint: 'status.runningHint',
    },
    IDLE: {
      text: 'status.idle',
      token: '--state-idle',
      hint: 'status.idleHint',
    },
    DONE: {
      text: 'status.done',
      token: '--state-done',
      hint: 'status.doneHint',
    },
    FAILED: {
      text: 'status.failed',
      token: '--state-failed',
      hint: 'status.failedHint',
    },
    STOPPED: {
      text: 'status.stopped',
      token: '--state-paused',
      hint: 'status.stoppedHint',
    },
  };

export function StatusTag({ status }: { status: TaskStatus }) {
  const { t } = useT();
  const s = STATUS_META[status];
  const c = `var(${s.token})`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex cursor-default items-center gap-1.5 rounded-sm border px-2 text-[11.5px] leading-[18px] font-medium whitespace-nowrap"
          style={{
            color: c,
            /* 8% / 28% 是试出来的：底色要能看出色相但不能盖过文字，边框要能勾出形状 */
            background: `color-mix(in oklab, ${c} 8%, var(--background))`,
            borderColor: `color-mix(in oklab, ${c} 28%, var(--background))`,
          }}
        >
          <span
            className={s.live ? 'status-dot-live' : undefined}
            style={{ width: 5, height: 5, borderRadius: '50%', background: c, flex: 'none' }}
          />
          {t(s.text)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t(s.hint)}</TooltipContent>
    </Tooltip>
  );
}
