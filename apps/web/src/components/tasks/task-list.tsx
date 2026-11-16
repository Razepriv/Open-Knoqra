import { Button, Reveal } from '@knoqra/ui';
import { useMemo, useRef, useState } from 'react';
import { type DueGroup, dueGroup } from '../../lib/due';
import { failureMessage } from '../../lib/failure-copy';
import { type Task, type TaskStatus, useTasks, useUpdateTask } from '../../lib/tasks';
import { useEffectiveTimeZone } from '../../lib/time-zone';
import { useNow } from '../../lib/use-now';
import { useOnline } from '../../lib/use-online';
import { TaskRowsSkeleton } from '../skeletons/tasks-skeleton';
import { useToast } from '../use-toast';
import { DeleteTaskDialog, EditTaskDialog } from './edit-task-dialog';
import { TaskRow } from './task-row';

const GROUPS: { key: DueGroup; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'none', label: 'No date' },
];

const CLOCK_REFRESH_MS = 60_000;

export interface TaskListProps {
  status: TaskStatus;
}

export function TaskList({ status }: TaskListProps) {
  const tasks = useTasks(status);
  const online = useOnline();
  const update = useUpdateTask();
  const timeZone = useEffectiveTimeZone();
  const now = useNow(CLOCK_REFRESH_MS);
  const toast = useToast();
  const [editing, setEditing] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<Task | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const items = useMemo(() => tasks.data?.pages.flatMap((page) => page.items) ?? [], [tasks.data]);
  const returnFocus = () =>
    opener.current?.isConnected ? opener.current : document.getElementById('task-title');

  const rememberOpener = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  async function toggle(task: Task) {
    setBusyId(task.id);
    try {
      await update.mutateAsync({
        id: task.id,
        body: { status: task.status === 'open' ? 'done' : 'open' },
      });
    } catch {
      toast.show('We could not update that task. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      now={now}
      timeZone={timeZone}
      busy={busyId === task.id}
      onToggle={(t) => void toggle(t)}
      onEdit={(t) => {
        rememberOpener();
        setEditing(t);
      }}
      onDelete={(t) => {
        rememberOpener();
        setDeleting(t);
      }}
    />
  );

  return (
    <>
      <Reveal loading={tasks.isPending}>
        {tasks.isPending ? (
          <TaskRowsSkeleton label="Loading tasks" grouped={status === 'open'} />
        ) : tasks.isError && items.length === 0 ? (
          <div role="alert" className="flex flex-col items-start gap-3 p-2">
            <p className="font-medium text-[15px]">
              {failureMessage(tasks.error, online, 'your tasks')}
            </p>
            <p className="text-[13px] text-[color:var(--muted)]">Your tasks are safe. Try again.</p>
            <Button
              variant="primary"
              onClick={tasks.isFetching ? undefined : () => void tasks.refetch()}
              aria-busy={tasks.isFetching}
            >
              Try again
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="p-2 text-[15px] leading-relaxed">
            {status === 'open'
              ? 'Nothing due. Add a task, or enjoy the quiet.'
              : 'Nothing done yet. Finished tasks land here.'}
          </p>
        ) : status === 'done' ? (
          <ul aria-label="Done tasks" className="flex flex-col gap-[6px] p-1">
            {items.map(row)}
          </ul>
        ) : (
          <div className="flex flex-col gap-5">
            {GROUPS.map(({ key, label }) => {
              const group = items.filter((task) => dueGroup(task, now, timeZone) === key);
              if (group.length === 0) return null;
              return (
                <section key={key} aria-label={label} className="flex flex-col gap-2">
                  <h2 className="px-1 font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase tracking-[0.08em]">
                    {label}
                  </h2>
                  <ul className="flex flex-col gap-[6px]">{group.map(row)}</ul>
                </section>
              );
            })}
          </div>
        )}
      </Reveal>
      {tasks.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={tasks.isFetchingNextPage ? undefined : () => void tasks.fetchNextPage()}
            aria-busy={tasks.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
      <EditTaskDialog
        task={editing}
        timeZone={timeZone}
        onClose={() => setEditing(null)}
        returnFocus={returnFocus}
      />
      <DeleteTaskDialog
        task={deleting}
        onClose={() => setDeleting(null)}
        returnFocus={returnFocus}
      />
      {toast.toast}
    </>
  );
}
