import { addDays, type DayKey, isWorkingDay } from '@knoqra/core';
import { Avatar, Reveal } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import {
  Ban,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock,
  FileUp,
  type LucideIcon,
  MessageCircle,
  NotebookPen,
  Phone,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { gradientFor } from '../../lib/contacts';
import { failureMessage } from '../../lib/failure-copy';
import { CONTACTS_IMPORT_PATH, CONTACTS_PATH } from '../../lib/nav-items';
import { useEffectiveTimeZone } from '../../lib/time-zone';
import { type ActivityEntry, type TodayWeekRow, useWeek } from '../../lib/today';
import { chipText, dayHeader, weekRangeLabel } from '../../lib/today-format';
import { focusRing, textPill } from '../../lib/ui-classes';
import { useOnline } from '../../lib/use-online';
import { WeekRowsSkeleton } from '../skeletons/today-skeleton';
import { PanelError } from './widget-frame';

const TITLE_ID = 'week-grid-title';
const COLUMNS = 'grid grid-cols-[168px_minmax(0,1fr)] gap-x-3 xl:grid-cols-[206px_minmax(0,1fr)]';
const DAYS = 'grid grid-cols-7 gap-2';

const KIND_LOOK: Record<ActivityEntry['kind'], { icon: LucideIcon; fill: string | null }> = {
  call: { icon: Phone, fill: 'var(--grad-mint)' },
  message: { icon: MessageCircle, fill: 'var(--grad-peri)' },
  note: { icon: NotebookPen, fill: 'var(--grad-apr)' },
  task_done: { icon: CircleCheck, fill: 'var(--grad-cit)' },
  task_due: { icon: Clock, fill: null },
  consent: { icon: ShieldCheck, fill: 'var(--grad-grey)' },
};

const navButton = `flex size-[38px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)] ${focusRing}`;

function DayHeaders({ days, today }: { days: DayKey[]; today: DayKey }) {
  return (
    <div className={COLUMNS} aria-hidden="true">
      <span className="self-center pl-1 font-medium text-[13px] text-[color:var(--muted)]">
        People
      </span>
      <div className={DAYS}>
        {days.map((day) => {
          const { weekday, date } = dayHeader(day);
          const isToday = day === today;
          const look = isToday
            ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)] [box-shadow:var(--shadow-accent)]'
            : isWorkingDay(day)
              ? 'border border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--muted)]'
              : 'bg-[image:var(--hatch)] text-[color:var(--muted)]';
          return (
            <span
              key={day}
              className={`flex h-10 min-w-0 flex-col items-center justify-center gap-[3px] rounded-[13px] font-medium text-[11px] leading-none ${look}`}
            >
              <span className="truncate">{isToday ? `${weekday} · today` : weekday}</span>
              <span
                className={`font-semibold text-[14px] ${isToday ? '' : 'text-[color:var(--text)]'}`}
              >
                {date}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface EntryChipProps {
  day: DayKey;
  entries: ActivityEntry[];
  timeZone: string;
}

/** The latest entry of a day, visibly short; screen readers hear the day and every entry. */
function EntryChip({ day, entries, timeZone }: EntryChipProps) {
  const latest = entries.at(-1);
  if (!latest) return null;
  const { icon: Icon, fill } = KIND_LOOK[latest.kind];
  const more = entries.length - 1;
  const look = fill
    ? 'text-[color:var(--on-accent)] [box-shadow:var(--shadow-tile)]'
    : 'border-[1.5px] border-[color:var(--muted)] border-dashed bg-[color:var(--pill)] text-[color:var(--text)]';
  const details = entries.map((entry) => entry.label).join(', ');
  const { weekday, date } = dayHeader(day);
  return (
    <span
      title={details}
      className={`relative z-[2] flex h-[38px] min-w-0 items-center gap-[6px] rounded-[13px] px-[9px] font-semibold text-[12px] leading-none ${look}`}
      style={{ gridRow: 1, gridColumn: 1, ...(fill ? { background: fill } : {}) }}
    >
      <Icon size={14} strokeWidth={1.9} aria-hidden="true" className="shrink-0" />
      <span aria-hidden="true" className="min-w-0 truncate">
        {chipText(latest, timeZone)}
      </span>
      <span className="sr-only">{`${weekday} ${date} · ${details}`}</span>
      {more > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -top-[6px] -right-[5px] rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[5px] py-[2px] font-semibold text-[10px] text-[color:var(--text)] leading-none"
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}

interface PersonRowProps {
  row: TodayWeekRow;
  days: DayKey[];
  today: DayKey;
  timeZone: string;
}

function PersonRow({ row, days, today, timeZone }: PersonRowProps) {
  const { contact, blocked } = row;
  const href: string = `/contacts/${contact.id}`;
  return (
    <li className={`${COLUMNS} items-center`}>
      <Link
        to={href}
        className={`flex h-[38px] min-w-0 items-center gap-[10px] rounded-[14px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[10px] ${blocked ? 'opacity-70' : ''} ${focusRing}`}
      >
        <Avatar
          name={contact.displayName}
          gradient={blocked ? 'grey' : gradientFor(contact.id)}
          size={28}
        />
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate font-semibold text-[13px] leading-none">
            {contact.displayName}
          </span>
          <span className="truncate text-[12px] text-[color:var(--muted)] leading-none">
            {contact.company ?? 'No company'}
          </span>
        </span>
      </Link>
      {blocked ? (
        <div className="flex h-[38px] min-w-0 items-center gap-[10px] rounded-[13px] border border-[color:var(--blocked-border)] bg-[image:var(--blocked-stripe)] px-[14px] font-medium text-[13px] leading-none">
          <Ban
            size={15}
            strokeWidth={1.9}
            aria-hidden="true"
            className="shrink-0 text-[color:var(--dot-bad)]"
          />
          <span className="truncate">Do not contact · suppressed on every channel</span>
          <span className="flex-1" />
          <span className="shrink-0 font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)]">
            POLICY · NOT A TASK
          </span>
        </div>
      ) : (
        <div className={DAYS}>
          {days.map((day, index) => {
            const entries = row.entries.filter((entry) => entry.day === day);
            return (
              <div
                key={day}
                data-day={day}
                data-today={day === today ? 'true' : undefined}
                className="grid min-w-0"
                style={{ gridRow: 1, gridColumn: index + 1 }}
              >
                <span
                  aria-hidden="true"
                  className={`h-[38px] rounded-[12px] ${
                    isWorkingDay(day)
                      ? 'bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]'
                      : 'bg-[image:var(--hatch)]'
                  }`}
                  style={{ gridRow: 1, gridColumn: 1 }}
                />
                {entries.length > 0 ? (
                  <EntryChip day={day} entries={entries} timeZone={timeZone} />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

/** The dashed line that runs down today's column, under the chips. */
function TodayLine({ days, today }: { days: DayKey[]; today: DayKey }) {
  const index = days.indexOf(today);
  if (index === -1) return null;
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 ${COLUMNS}`}>
      <span />
      <div className={DAYS}>
        <span
          className="z-[1] mx-auto -mt-2 h-[calc(100%+8px)] w-0 border-[color:var(--line)] border-l-2 border-dashed opacity-60"
          style={{ gridColumn: index + 1 }}
        />
      </div>
    </div>
  );
}

function EmptyWeek({ current }: { current: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[18px] border-[1.5px] border-[color:var(--pillBorder)] border-dashed px-5 py-5">
      <p className="font-semibold text-[15px]">
        {current ? 'No conversations this week yet.' : 'Nothing was logged this week.'}
      </p>
      <p className="max-w-[56ch] text-[13px] text-[color:var(--muted)] leading-[1.45]">
        Notes, calls and messages with your contacts land here, one row per person.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to={CONTACTS_PATH} className={textPill}>
          <UserPlus size={15} strokeWidth={1.75} aria-hidden="true" />
          Add contact
        </Link>
        <Link to={CONTACTS_IMPORT_PATH} className={textPill}>
          <FileUp size={15} strokeWidth={1.75} aria-hidden="true" />
          Import
        </Link>
      </div>
    </div>
  );
}

export interface WeekGridProps {
  /** Monday of the week shown. */
  start: DayKey;
  /** Monday of the current week, to know when "This week" is shown. */
  currentStart: DayKey;
  today: DayKey;
  onStartChange: (start: DayKey) => void;
}

/** Monday to Sunday, one row per person the user talked to, every channel in one place. */
export function WeekGrid({ start, currentStart, today, onStartChange }: WeekGridProps) {
  const week = useWeek(start);
  const online = useOnline();
  const timeZone = useEffectiveTimeZone();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const rows = week.data?.rows ?? [];

  return (
    <section
      aria-labelledby={TITLE_ID}
      className="flex min-w-0 flex-col gap-3 rounded-[30px] border border-[color:var(--panelBorder)] bg-[image:var(--panel)] px-4 py-4 [box-shadow:var(--panelShadow)] sm:px-[22px]"
    >
      <div className="flex flex-wrap items-center gap-x-[10px] gap-y-2">
        <h2
          id={TITLE_ID}
          className="font-[family-name:var(--font-display)] font-normal text-[clamp(22px,2.4vw,30px)] leading-none tracking-[-0.025em]"
        >
          This week's conversations
        </h2>
        <span className="font-[family-name:var(--font-mono)] font-medium text-[12px] text-[color:var(--muted)] leading-none sm:ml-2">
          EVERY CHANNEL, ONE ROW PER PERSON
        </span>
        <span className="flex-1" />
        <div className="flex items-center gap-[6px]">
          {start !== currentStart ? (
            <button type="button" className={textPill} onClick={() => onStartChange(currentStart)}>
              This week
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Previous week"
            className={navButton}
            onClick={() => onStartChange(addDays(start, -7))}
          >
            <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="flex h-[38px] items-center gap-2 whitespace-nowrap rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[14px] font-medium text-[13px] leading-none [box-shadow:var(--pillShadow)]">
            <CalendarDays size={15} strokeWidth={1.75} aria-hidden="true" />
            <span aria-live="polite">{weekRangeLabel(start)}</span>
          </span>
          <button
            type="button"
            aria-label="Next week"
            className={navButton}
            onClick={() => onStartChange(addDays(start, 7))}
          >
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="flex min-w-[740px] flex-col gap-2">
          <DayHeaders days={days} today={today} />
          {week.isError && !week.data ? (
            <PanelError
              message={failureMessage(week.error, online, 'this week')}
              onRetry={() => void week.refetch()}
            />
          ) : (
            <Reveal loading={week.isPending}>
              {week.isPending ? (
                <WeekRowsSkeleton label="Loading this week" />
              ) : rows.length === 0 ? (
                <EmptyWeek current={start === currentStart} />
              ) : (
                <div
                  className={`relative transition-opacity ${week.isPlaceholderData ? 'opacity-50' : ''}`}
                >
                  <TodayLine days={days} today={today} />
                  <ul aria-label="People this week" className="flex flex-col gap-2">
                    {rows.map((row) => (
                      <PersonRow
                        key={row.contact.id}
                        row={row}
                        days={days}
                        today={today}
                        timeZone={timeZone}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </Reveal>
          )}
        </div>
      </div>
    </section>
  );
}
