import {
  SkeletonButton,
  SkeletonField,
  SkeletonPanel,
  SkeletonStatus,
  SkeletonText,
} from '@knoqra/ui';

/** One TaskRow: checkbox, title and due line, the round actions button. 58px tall. */
function TaskRowSkeleton({ seed }: { seed: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex items-center gap-3 rounded-[18px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 py-2.5 [box-shadow:var(--pillShadow)]"
    >
      <span className="size-5 shrink-0 rounded-[5px] border border-[color:var(--pillBorder)] bg-[color:var(--cell)]" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <SkeletonText widths={[`${62 - (seed % 3) * 12}%`]} lineHeight={17.5} seed={seed} />
        <SkeletonText size="mono" widths={[`${30 + (seed % 2) * 8}%`]} lineHeight={12} />
      </span>
      <SkeletonButton size="icon" height={36} />
    </span>
  );
}

export interface TaskRowsSkeletonProps {
  label?: string;
  rows?: number;
  /** The Open tab groups rows under a due label; the Done tab is one plain list. */
  grouped?: boolean;
}

/** The task list body: rows 6px apart, under a group label on the Open tab. */
export function TaskRowsSkeleton({ label, rows = 3, grouped = true }: TaskRowsSkeletonProps) {
  return (
    <div className={grouped ? 'flex flex-col gap-2' : 'flex flex-col p-1'}>
      {label ? <SkeletonStatus label={label} /> : null}
      {grouped ? (
        <SkeletonText size="mono" widths={['4.5rem']} lineHeight={16.5} className="px-1" />
      ) : null}
      <span className="flex flex-col gap-[6px]">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          <TaskRowSkeleton key={i} seed={i} />
        ))}
      </span>
    </div>
  );
}

/** Tasks while it loads: title, the add form, the Open/Done tabs and the list. */
export function TasksSkeleton() {
  return (
    <SkeletonPanel
      data-skeleton="tasks"
      data-skeleton-part="tasks-panel"
      label="Loading your tasks"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-6 sm:p-8"
    >
      <SkeletonText widths={['6rem']} lineHeight={30} />
      <span aria-hidden="true" data-skeleton-part="task-form" className="flex flex-col gap-4">
        <SkeletonField />
        <span className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SkeletonField hint />
          <SkeletonField />
          <SkeletonField />
        </span>
        <span className="flex justify-end">
          <SkeletonButton width={98} />
        </span>
      </span>
      <span aria-hidden="true" data-skeleton-part="tabs" className="flex gap-2">
        <SkeletonButton width={66} height={34} />
        <SkeletonButton width={64} height={34} />
      </span>
      <TaskRowsSkeleton />
    </SkeletonPanel>
  );
}
