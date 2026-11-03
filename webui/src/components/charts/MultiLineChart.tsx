import { useId } from 'react';
import { neutral } from '@/theme/theme';

/**
 * 多序列折线图（对比页用）：与单序列 LineChart 同一套极简 SVG 路线，
 * 差异是 y 域取全部序列的并集（消融实验的 loss 量级接近，共用一个
 * 刻度才能看出谁收敛得快）、每条线一个颜色并在图例里点任务名。
 *
 * 每个序列独立取点：step 不对齐的实验（不同 max_steps / logging_steps）
 * 各画各的曲线，不做插值对齐——对齐会制造不存在的数据。
 */
export interface ChartSeries {
  /** 图例名（任务显示名） */
  label: string;
  points: Array<{ x: number; y: number }>;
  color: string;
}

export function MultiLineChart({
  series,
  height = 280,
  yLabel,
  xLabel = 'step',
}: {
  series: ChartSeries[];
  height?: number;
  yLabel?: string;
  xLabel?: string;
}) {
  const W = 760;
  const H = height;
  const pad = { top: 16, right: 16, bottom: 28, left: 52 };

  /* 全序列点数并集（含仅 1 个点的序列：画不出线但画得出点） */
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return null;

  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yPad = (yMax - yMin) * 0.12 || 0.1;
  const yLo = yMin - yPad;
  const yHi = yMax + yPad;

  const sx = (x: number) => pad.left + ((x - xMin) / (xMax - xMin || 1)) * (W - pad.left - pad.right);
  const sy = (y: number) => H - pad.bottom - ((y - yLo) / (yHi - yLo || 1)) * (H - pad.top - pad.bottom);

  const yTicks = Array.from({ length: 5 }, (_, i) => yLo + ((yHi - yLo) / 4) * i);
  const xTicks = Array.from({ length: 5 }, (_, i) => xMin + ((xMax - xMin) / 4) * i);

  const legendId = `multi-chart-${useId().replace(/:/g, '')}`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={pad.left}
              y1={sy(t)}
              x2={W - pad.right}
              y2={sy(t)}
              stroke={neutral.borderLight}
              strokeWidth={1}
            />
            <text x={pad.left - 8} y={sy(t) + 4} textAnchor="end" fontSize={11} fill={neutral.textTertiary}>
              {t.toFixed(2)}
            </text>
          </g>
        ))}

        {xTicks.map((t, i) => (
          <text
            key={i}
            x={sx(t)}
            y={H - pad.bottom + 18}
            textAnchor="middle"
            fontSize={11}
            fill={neutral.textTertiary}
          >
            {Math.round(t)}
          </text>
        ))}

        {series.map((s) => {
          /* 单点序列只画点不画线（两点才有路径） */
          if (s.points.length === 1) {
            return (
              <circle key={s.label} cx={sx(s.points[0].x)} cy={sy(s.points[0].y)} r={3.5} style={{ fill: s.color }} />
            );
          }
          if (s.points.length === 0) return null;
          const path = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)}`).join(' ');
          const lastP = s.points[s.points.length - 1];
          return (
            <g key={s.label}>
              <path d={path} fill="none" style={{ stroke: s.color }} strokeWidth={1.8} strokeLinejoin="round" />
              <circle cx={sx(lastP.x)} cy={sy(lastP.y)} r={3.5} style={{ fill: s.color }} />
            </g>
          );
        })}

        {yLabel && (
          <text x={pad.left} y={12} fontSize={11} fill={neutral.textSecondary}>
            {yLabel}
          </text>
        )}
        <text x={W - pad.right} y={H - 4} textAnchor="end" fontSize={11} fill={neutral.textTertiary}>
          {xLabel}
        </text>
      </svg>

      {/* 图例：图下方一行排开，色点 + 任务名（消融实验一般 2-5 个，够放） */}
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={`${legendId}-${s.label}`} className="flex items-center gap-1.5 text-[12px]">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            <span className="text-muted-foreground max-w-64 truncate">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
