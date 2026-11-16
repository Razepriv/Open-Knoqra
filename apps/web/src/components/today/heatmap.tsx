import type { CSSProperties } from 'react';
import type { TodaySummary } from '../../lib/today';
import { heatCellLabel, heatmapMonths } from '../../lib/today-format';

type HeatWeek = TodaySummary['heatmap'][number];
type HeatDay = HeatWeek['days'][number];

const LEVELS = [0, 1, 2, 3, 4] as const;
const DAY_LETTERS = ['M', '', 'W', '', 'F', '', ''] as const;
const mono =
  'font-[family-name:var(--font-mono)] font-medium text-[10px] text-[color:var(--streak-muted)] uppercase leading-none';

function cellStyle(cell: HeatDay): CSSProperties {
  const level = `var(--heat-${Math.min(4, Math.max(0, cell.level))})`;
  if (cell.state === 'upcoming') {
    return { background: 'transparent', border: '1px solid var(--heat-upcoming)' };
  }
  if (cell.state === 'today') {
    return cell.count > 0
      ? { background: level, border: '1px solid var(--accent)' }
      : { background: 'transparent', border: '1.5px dashed var(--accent)' };
  }
  return { background: level };
}

export interface HeatmapProps {
  weeks: HeatWeek[];
  best: number;
}

/** Sixteen weeks of logged outcomes, Monday at the top, the current week on the right. */
export function Heatmap({ weeks, best }: HeatmapProps) {
  const months = heatmapMonths(weeks);
  const columns: CSSProperties = {
    gridTemplateColumns: `repeat(${Math.max(1, weeks.length)}, minmax(0, 1fr))`,
  };

  return (
    <div className="flex w-full max-w-[340px] flex-col gap-[6px]">
      <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-[4px]">
        <span />
        <div className="grid gap-[3px]" style={columns} aria-hidden="true">
          {months.map((month) => (
            <span
              key={`${month.label}-${month.start}`}
              className={mono}
              style={{ gridColumn: `${month.start + 1} / span ${month.span}` }}
            >
              {month.label}
            </span>
          ))}
        </div>
        <div className="grid grid-rows-[repeat(7,minmax(0,1fr))] gap-[3px]" aria-hidden="true">
          {DAY_LETTERS.map((letter, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed seven weekday rows
              key={index}
              className={`${mono} flex items-center text-[9px]`}
            >
              {letter}
            </span>
          ))}
        </div>
        <ol
          aria-label="Logged outcomes, last 16 weeks"
          className="grid grid-flow-col grid-rows-[repeat(7,minmax(0,1fr))] gap-[3px]"
          style={columns}
        >
          {weeks.flatMap((week) =>
            week.days.map((cell) => {
              const label = heatCellLabel(cell);
              return (
                <li key={cell.day} className="flex">
                  <span
                    role="img"
                    aria-label={label}
                    title={label}
                    className="block aspect-square w-full rounded-[3px] transition-[background] duration-500"
                    style={cellStyle(cell)}
                  />
                </li>
              );
            }),
          )}
        </ol>
      </div>
      <div className={`${mono} mt-[2px] flex items-center gap-1`}>
        <span className="mr-1">LESS</span>
        {LEVELS.map((level) => (
          <span
            key={level}
            aria-hidden="true"
            className="size-[10px] rounded-[3px]"
            style={{ background: `var(--heat-${level})` }}
          />
        ))}
        <span className="ml-1">MORE</span>
        <span className="flex-1" />
        <span>BEST RUN {best}</span>
      </div>
    </div>
  );
}
