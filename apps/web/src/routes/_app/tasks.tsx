import { Panel } from '@knoqra/ui';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { TasksSkeleton } from '../../components/skeletons/tasks-skeleton';
import { TaskForm } from '../../components/tasks/task-form';
import { TaskList } from '../../components/tasks/task-list';
import type { TaskStatus } from '../../lib/tasks';
import { focusRing } from '../../lib/ui-classes';

export const Route = createFileRoute('/_app/tasks')({
  staticData: { title: 'Tasks' },
  validateSearch: (search: Record<string, unknown>): { new?: 1 } =>
    search.new === 1 || search.new === '1' ? { new: 1 } : {},
  pendingComponent: TasksSkeleton,
  component: TasksPage,
});

const TABS: { status: TaskStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'done', label: 'Done' },
];

function TasksPage() {
  const { new: focusNew } = Route.useSearch();
  const [status, setStatus] = useState<TaskStatus>('open');
  return (
    <Panel
      aria-label="Tasks"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6 sm:p-8"
    >
      <h1 className="font-[family-name:var(--font-display)] text-[30px] leading-none tracking-[-0.025em]">
        Tasks
      </h1>
      <TaskForm autoFocusTitle={focusNew === 1} />
      <div role="tablist" aria-label="Task status" className="flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            role="tab"
            aria-selected={status === tab.status}
            onClick={() => setStatus(tab.status)}
            className={`h-[34px] cursor-pointer rounded-full border border-[color:var(--pillBorder)] px-4 font-medium text-[13px] ${focusRing} ${
              status === tab.status
                ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
                : 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <TaskList key={status} status={status} />
    </Panel>
  );
}
