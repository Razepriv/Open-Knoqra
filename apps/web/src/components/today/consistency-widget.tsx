import { TODAY_WIDGET_LABELS } from '@knoqra/core';
import { Reveal } from '@knoqra/ui';
import { failureMessage } from '../../lib/failure-copy';
import { useTodaySummary } from '../../lib/today';
import { streakLine } from '../../lib/today-format';
import { useOnline } from '../../lib/use-online';
import { StreakBodySkeleton } from '../skeletons/today-skeleton';
import { Heatmap } from './heatmap';
import { eyebrowClass, PanelError, WidgetFrame, type WidgetSlotProps } from './widget-frame';

const LABEL = TODAY_WIDGET_LABELS.streak;

/** The working-day streak and sixteen weeks of logged outcomes, on a dark panel. */
export function ConsistencyWidget({ controls }: WidgetSlotProps) {
  const summary = useTodaySummary();
  const online = useOnline();
  const data = summary.data;

  return (
    <WidgetFrame
      widget="streak"
      label={LABEL}
      controls={controls}
      tone="dark"
      aside={<span className={eyebrowClass('dark')}>16 WEEKS</span>}
    >
      {summary.isError && !data ? (
        <PanelError
          tone="dark"
          message={failureMessage(summary.error, online, 'your streak')}
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <Reveal loading={!data} className="flex flex-1 flex-col gap-[14px]">
          {data ? (
            <>
              <div className="flex items-end gap-3">
                <span className="font-[family-name:var(--font-display)] font-medium text-[68px] text-[color:var(--accent)] tabular-nums leading-[0.82] tracking-[-0.04em]">
                  {data.streak.current}
                </span>
                <div className="flex min-w-0 flex-col gap-[5px] pb-[2px]">
                  <span className="font-semibold text-[15px] leading-[1.1]">
                    working-day streak
                  </span>
                  <span className="text-[13px] text-[color:var(--streak-soft)] leading-[1.35]">
                    {streakLine(data.today, data.streak)}
                  </span>
                </div>
              </div>
              <Heatmap weeks={data.heatmap} best={data.streak.best} />
              <p className="mt-auto font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--streak-muted)] leading-[1.5]">
                COUNTS LOGGED OUTCOMES. WEEKENDS NEVER BREAK IT.
              </p>
            </>
          ) : (
            <StreakBodySkeleton label="Loading your streak" />
          )}
        </Reveal>
      )}
    </WidgetFrame>
  );
}
