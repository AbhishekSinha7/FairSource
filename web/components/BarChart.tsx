import { cx } from './ui';

export interface Bar {
  key: string;
  value: number;
  /** Shown on hover and to screen readers, e.g. "17 Nov: $2.57". */
  title: string;
}

/**
 * Simple vertical bar chart: past bars in the soft brand colour, the last bar
 * (today) in full brand colour, light gridlines, and a few x-axis labels.
 */
export function BarChart({
  bars,
  ticks,
  height = 260,
  label,
}: {
  bars: Bar[];
  /** Index into bars -> label shown under the axis. */
  ticks: Array<{ index: number; label: string }>;
  height?: number;
  label: string;
}) {
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  const last = bars.length - 1;

  return (
    <figure aria-label={label}>
      <div className="relative" style={{ height }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="absolute inset-x-0 border-t border-line" style={{ top: `${(i / 4) * 100}%` }} />
        ))}
        <ol className="absolute inset-0 flex items-end gap-[3px] sm:gap-1.5">
          {bars.map((b, i) => (
            <li
              key={b.key}
              title={b.title}
              aria-label={b.title}
              className={cx('flex-1 rounded-t-[4px] transition-[height] duration-500', i === last ? 'bg-brand' : 'bg-brand-soft hover:bg-brand/70')}
              style={{ height: `${Math.max(1, (b.value / max) * 98)}%` }}
            />
          ))}
        </ol>
      </div>
      <div className="relative mt-3 h-5 text-sm text-muted">
        {ticks.map((t) => {
          const left = bars.length > 1 ? (t.index / (bars.length - 1)) * 100 : 0;
          const align = t.index === 0 ? 'translate-x-0' : t.index === last ? '-translate-x-full' : '-translate-x-1/2';
          return (
            <span key={t.index} className={cx('absolute whitespace-nowrap', align)} style={{ left: `${left}%` }}>
              {t.label}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
