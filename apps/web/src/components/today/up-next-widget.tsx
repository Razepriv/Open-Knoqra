import { TODAY_WIDGET_LABELS } from '@knoqra/core';
import { Avatar, Reveal } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Check } from 'lucide-react';
import { useState } from 'react';
import { gradientFor } from '../../lib/contacts';
import { dueGroup, dueLabel } from '../../lib/due';
import { failureMessage } from '../../lib/failure-copy';
import { type Task, useTasks, useUpdateTask } from '../../lib/tasks';
import { useEffectiveTimeZone } from '../../lib/time-zone';
import { focusRing } from '../../lib/ui-classes';
import { useNow } from '../../lib/use-now';
import { useOnline } from '../../lib/use-online';
import { UpNextBodySkeleton } from '../skeletons/today-skeleton';
import { PanelError, WidgetFrame, type WidgetSlotProps } from './widget-frame';

const LABEL = TODAY_WIDGET_LABELS.next;
/** How many open tasks Up next shows. Otto's default contact comes from these. */
export const UP_NEXT_SHOWN = 3;
const CLOCK_REFRESH_MS = 60_000;

interface CardLook {
  card: string;
  chip: string;
  action: string;
}

const highlight: CardLook = {
  card: 'border-[color:var(--hl-chip)] bg-[image:var(--grad-hl)] text-[color:var(--on-accent)] [box-shadow:var(--shadow-accent)]',
  chip: 'bg-[color:var(--hl-chip)]',
  action: 'bg-[color:var(--ink)] text-[color:var(--on-ink)]',
};

const plain: CardLook = {
  card: 'border-[color:var(--panelBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)]',
  chip: 'bg-[color:var(--cell)]',
  action: 'bg-[color:var(--cell)] text-[color:var(--text)]',
};

interface UpNextCardProps {
  task: Task;
  look: CardLook;
  due: string;
  overdue: boolean;
  busy: boolean;
  onDone: () => void;
}

function UpNextCard({ task, look, due, overdue, busy, onDone }: UpNextCardProps) {
  const contact = task.contact;
  const contactHref: string | null = contact ? `/contacts/${contact.id}` : null;
  const pill = `inline-flex h-[32px] shrink-0 cursor-pointer items-center gap-[6px] rounded-full px-3 font-semibold text-[13px] leading-none disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`;
  return (
    <li
      className={`flex flex-col gap-[10px] rounded-[20px] border p-[14px] transition-opacity ${look.card} ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-semibold text-[15px] leading-[1.2]">{task.title}</p>
        <span
          className={`shrink-0 whitespace-nowrap rounded-full px-2 py-[5px] font-medium text-[11px] leading-none ${look.chip}`}
        >
          <span aria-hidden="true" className={overdue ? 'text-[color:var(--dot-bad)]' : ''}>
            ●{' '}
          </span>
          {due}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-[6px]">
        {contact ? (
          <span
            className={`flex h-[32px] min-w-0 items-center gap-[6px] rounded-[10px] pr-[10px] pl-1 font-medium text-[12px] ${look.chip}`}
          >
            <Avatar name={contact.displayName} gradient={gradientFor(contact.id)} size={24} />
            <span className="truncate">{contact.displayName}</span>
          </span>
        ) : (
          <span
            className={`flex h-[32px] items-center rounded-[10px] px-[10px] font-medium text-[12px] ${look.chip}`}
          >
            Task
          </span>
        )}
        <span className="flex-1" />
        {contactHref && contact ? (
          <Link
            to={contactHref}
            aria-label={`Open ${contact.displayName}`}
            className={`${pill} ${look.chip}`}
          >
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
            Open
          </Link>
        ) : null}
        <button
          type="button"
          aria-label={`Mark ${task.title} done`}
          disabled={busy}
          onClick={onDone}
          className={`${pill} ${look.action}`}
        >
          <Check size={14} strokeWidth={2} aria-hidden="true" />
          Done
        </button>
      </div>
    </li>
  );
}

/** The next three open tasks, soonest due first. The first one is highlighted. */
export function UpNextWidget({ controls, notify }: WidgetSlotProps) {
  const tasks = useTasks('open');
  const online = useOnline();
  const update = useUpdateTask();
  const timeZone = useEffectiveTimeZone();
  const now = useNow(CLOCK_REFRESH_MS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const items = (tasks.data?.pages[0]?.items ?? []).slice(0, UP_NEXT_SHOWN);

  async function complete(task: Task) {
    setBusyId(task.id);
    try {
      await update.mutateAsync({ id: task.id, body: { status: 'done' } });
    } catch {
      notify('We could not update that task. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <WidgetFrame
      widget="next"
      label={LABEL}
      controls={controls}
      aside={
        <Link
          to="/tasks"
          className={`inline-flex h-[30px] shrink-0 items-center gap-[6px] rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[11px] font-medium text-[12px] leading-none ${focusRing}`}
        >
          <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
          View all
        </Link>
      }
    >
      {tasks.isError && !tasks.data ? (
        <PanelError
          message={failureMessage(tasks.error, online, 'your tasks')}
          onRetry={() => void tasks.refetch()}
        />
      ) : (
        <Reveal loading={tasks.isPending} className="flex flex-1 flex-col">
          {tasks.isPending ? (
            <UpNextBodySkeleton label="Loading up next" />
          ) : items.length === 0 ? (
            <div className="flex flex-1 flex-col items-start justify-center gap-2 rounded-[20px] border-[1.5px] border-[color:var(--pillBorder)] border-dashed p-[14px]">
              <p className="font-semibold text-[15px]">Nothing up next.</p>
              <p className="text-[13px] text-[color:var(--muted)] leading-[1.4]">
                Tasks with a due date line up here, soonest first.
              </p>
              <Link
                to="/tasks"
                search={{ new: 1 }}
                className={`mt-1 font-medium text-[13px] underline underline-offset-4 ${focusRing}`}
              >
                Add a task
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-[10px]">
              {items.map((task, index) => (
                <UpNextCard
                  key={task.id}
                  task={task}
                  look={index === 0 ? highlight : plain}
                  due={dueLabel(task, now, timeZone)}
                  overdue={dueGroup(task, now, timeZone) === 'overdue'}
                  busy={busyId === task.id}
                  onDone={() => void complete(task)}
                />
              ))}
            </ul>
          )}
        </Reveal>
      )}
    </WidgetFrame>
  );
}
