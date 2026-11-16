import { DAILY_GOAL_MAX, DAILY_GOAL_MIN, TODAY_WIDGET_LABELS } from '@knoqra/core';
import { Reveal } from '@knoqra/ui';
import { Minus, Plus, Timer } from 'lucide-react';
import { useState } from 'react';
import { failureMessage } from '../../lib/failure-copy';
import { formatClock, useFocusTimer } from '../../lib/focus-timer';
import {
  type TodaySummary,
  useTodayPrefs,
  useTodaySummary,
  useUpdateTodayPrefs,
} from '../../lib/today';
import { countLabel } from '../../lib/today-format';
import { focusRing } from '../../lib/ui-classes';
import { useOnline } from '../../lib/use-online';
import { FocusBodySkeleton } from '../skeletons/today-skeleton';
import { GoalRing } from './goal-ring';
import { eyebrowClass, PanelError, WidgetFrame, type WidgetSlotProps } from './widget-frame';

const LABEL = TODAY_WIDGET_LABELS.focus;

const KINDS = [
  { key: 'calls', label: 'CALLS', fill: 'var(--grad-mint)' },
  { key: 'messages', label: 'MESSAGES', fill: 'var(--grad-peri)' },
  { key: 'notes', label: 'NOTES', fill: 'var(--grad-apr)' },
  { key: 'tasksDone', label: 'TASKS', fill: 'var(--grad-cit)' },
] as const;

const stepButton = `flex size-[22px] cursor-pointer items-center justify-center rounded-full text-[color:var(--text)] hover:bg-[color:var(--pressed)] disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;

function GoalStepper({ goal, onChange }: { goal: number; onChange: (next: number) => void }) {
  return (
    <span className={`${eyebrowClass('light')} gap-[2px] pr-[3px] pl-[3px]`}>
      <button
        type="button"
        aria-label="Lower daily goal"
        disabled={goal <= DAILY_GOAL_MIN}
        onClick={() => onChange(goal - 1)}
        className={stepButton}
      >
        <Minus size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      <span className="px-[3px] tabular-nums">GOAL {goal}</span>
      <button
        type="button"
        aria-label="Raise daily goal"
        disabled={goal >= DAILY_GOAL_MAX}
        onClick={() => onChange(goal + 1)}
        className={stepButton}
      >
        <Plus size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </span>
  );
}

function Legend({ fill, children }: { fill: string; children: string }) {
  return (
    <span className="flex items-center gap-2 font-medium text-[13px] leading-[1.25]">
      <span
        aria-hidden="true"
        className="size-[10px] shrink-0 rounded-[3px]"
        style={{ background: fill }}
      />
      {children}
    </span>
  );
}

function ActivityBar({ byKind }: { byKind: TodaySummary['todayByKind'] }) {
  const total = KINDS.reduce((sum, kind) => sum + byKind[kind.key], 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between font-medium text-[13px] leading-none">
        <span>Activity today</span>
        <span className="font-[family-name:var(--font-mono)] tabular-nums">{total}</span>
      </div>
      <div className="flex h-[10px] gap-1" aria-hidden="true">
        {total === 0 ? (
          <span className="flex-1 rounded-[5px] bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]" />
        ) : (
          KINDS.filter((kind) => byKind[kind.key] > 0).map((kind) => (
            <span
              key={kind.key}
              className="rounded-[5px] transition-[flex-grow] duration-500"
              style={{ flexGrow: byKind[kind.key], background: kind.fill }}
            />
          ))
        )}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
        {KINDS.map((kind) => (
          <li key={kind.key} className="flex items-center gap-[5px]">
            <span
              aria-hidden="true"
              className="size-[7px] rounded-full"
              style={{ background: kind.fill }}
            />
            {kind.label} {byKind[kind.key]}
          </li>
        ))}
      </ul>
    </div>
  );
}

const FOCUS_DONE = 'Focus block done. Nice work.';

/**
 * Starts and stops a 25-minute block. The clock on the button is not announced every second; a
 * separate status says when the block starts or stops, and the toast says when it is done.
 */
function FocusButton({ notify }: { notify: (message: string) => void }) {
  const [announcement, setAnnouncement] = useState('');
  const timer = useFocusTimer({
    onDone: () => {
      setAnnouncement('');
      notify(FOCUS_DONE);
    },
  });

  function toggle() {
    if (timer.running) {
      timer.stop();
      setAnnouncement('Focus block stopped');
    } else {
      timer.start();
      setAnnouncement('Focus block started, 25 minutes');
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        className={`mt-auto flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full border border-[color:var(--pillBorder)] font-semibold text-[14px] leading-none [box-shadow:var(--pillShadow)] ${
          timer.running
            ? 'bg-[color:var(--ink)] text-[color:var(--on-ink)]'
            : 'bg-[color:var(--pill)] text-[color:var(--text)]'
        } ${focusRing}`}
      >
        <Timer size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className="tabular-nums">
          {timer.running
            ? `Focus block · ${formatClock(timer.remaining)} · stop`
            : 'Start a 25-minute focus block'}
        </span>
      </button>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

/** The daily goal ring, what is due, today's activity mix and a 25-minute focus block. */
export function FocusWidget({ controls, notify }: WidgetSlotProps) {
  const summary = useTodaySummary();
  const online = useOnline();
  const prefs = useTodayPrefs();
  const updatePrefs = useUpdateTodayPrefs();
  const data = summary.data;
  const goal = prefs.data?.dailyGoal ?? data?.goal.target;

  function changeGoal(next: number) {
    updatePrefs.mutate(
      { dailyGoal: next },
      { onError: () => notify('We could not save your goal. Try again.') },
    );
  }

  return (
    <WidgetFrame
      widget="focus"
      label={LABEL}
      controls={controls}
      aside={goal === undefined ? null : <GoalStepper goal={goal} onChange={changeGoal} />}
    >
      {summary.isError && !data ? (
        <PanelError
          message={failureMessage(summary.error, online, "today's numbers")}
          onRetry={() => void summary.refetch()}
        />
      ) : (
        <Reveal loading={!data} className="flex flex-col gap-[14px]">
          {data && goal !== undefined ? (
            <>
              <div className="flex items-center gap-[18px]">
                <GoalRing done={data.goal.done} target={goal} />
                <div className="flex min-w-0 flex-col gap-[10px]">
                  <Legend fill="var(--ring-fill)">{`${countLabel(data.goal.done, 'outcome')} logged`}</Legend>
                  <Legend fill="var(--grad-peri)">{`${countLabel(data.dueToday, 'task')} due today`}</Legend>
                  <Legend fill="var(--grad-apr)">{`${data.overdue} overdue`}</Legend>
                </div>
              </div>
              <ActivityBar byKind={data.todayByKind} />
            </>
          ) : (
            <FocusBodySkeleton label="Loading today's focus" />
          )}
        </Reveal>
      )}
      <FocusButton notify={notify} />
    </WidgetFrame>
  );
}
