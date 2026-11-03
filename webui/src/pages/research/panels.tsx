import { Panel } from '@/components/TaskDetailShell';
import { useT, type MessageKey } from '@/i18n';
import type { ResearchIteration, ResearchSession } from '@/api/research';

/** 评测时机的展示文案（研究页元信息与对话页研究面板共用）：i18n key，渲染处 t() */
export const EVAL_MODE_LABELS: Record<ResearchSession['evalPlan']['mode'], MessageKey> = {
  during: 'evm.during',
  checkpoint: 'evm.checkpoint',
  parallel: 'evm.parallel',
};

/** 迭代账本：轮次 / 数据版本 / 训练任务 / 评分 / Δ / 注记。Δ 相对上一个有分数的迭代 */
export function IterationsPanel({ s }: { s: ResearchSession }) {
  const { t } = useT();
  if (!s.iterations.length) {
    return (
      <div className="text-muted-foreground border-border border border-dashed py-12 text-center text-sm">
        {t('rs.noIters')}
      </div>
    );
  }
  const scored = s.iterations.filter((it) => typeof it.score === 'number');
  const rows = [...s.iterations].sort((a, b) => a.index - b.index);
  return (
    <Panel title={t('rs.iterLedger', { done: s.iterations.length, max: s.budget.maxIterations })} padded={false}>
      <div className="overflow-auto">
        <table className="border-border w-full border-collapse text-[13px] [&_td]:border-border [&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_th]:border-b [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium">
          <thead>
            <tr>
              <th className="w-12">{t('rs.colRound')}</th>
              <th>{t('rs.colDataVer')}</th>
              <th className="w-40">{t('rs.colTrainTask')}</th>
              <th className="w-24">{t('rs.colScore')}</th>
              <th className="w-20">Δ</th>
              <th>{t('rs.colNote')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it: ResearchIteration) => {
              const prev = [...scored].filter((x) => x.index < it.index).pop();
              const delta =
                typeof it.score === 'number' && prev && typeof prev.score === 'number'
                  ? it.score - prev.score
                  : undefined;
              return (
                <tr key={it.index} className="align-top">
                  <td className="tabular">{it.index}</td>
                  <td className="font-mono text-[12.5px] break-all">{it.dataVersion ?? '—'}</td>
                  <td className="font-mono text-[12.5px]">{it.trainTaskId ?? '—'}</td>
                  <td className="tabular">{typeof it.score === 'number' ? it.score.toFixed(4) : '—'}</td>
                  <td
                    className={
                      delta === undefined
                        ? 'tabular'
                        : delta >= 0
                          ? 'text-state-done tabular'
                          : 'text-state-failed tabular'
                    }
                  >
                    {delta === undefined ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`}
                  </td>
                  <td className="text-muted-foreground">{it.note ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** 事件流：只增历史（对话页消费唤醒队列不删它），最新在上 */
export function EventLogPanel({ s }: { s: ResearchSession }) {
  const { t } = useT();
  if (!s.eventLog.length) {
    return (
      <div className="text-muted-foreground border-border border border-dashed py-12 text-center text-sm">
        {t('rs.noEvents')}
      </div>
    );
  }
  return (
    <Panel title={t('rs.eventLog', { n: s.eventLog.length })}>
      <div className="flex flex-col">
        {[...s.eventLog].reverse().map((e, i) => (
          <div key={`${e.at}-${i}`} className="border-border/60 flex items-start gap-3 border-b py-2 last:border-b-0">
            <span className="text-muted-foreground tabular flex-none font-mono text-[12px]">{e.at}</span>
            <span className="text-muted-foreground flex-none font-mono text-[12px]">[{e.kind}]</span>
            <span className="text-foreground min-w-0 flex-1 text-[13px] leading-5 break-all">{e.text}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
