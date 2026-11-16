import { SkeletonPanel, SkeletonStatus, SkeletonText } from '@knoqra/ui';

/**
 * The drop zone while a chosen file is read: the same dashed 26px-radius box, padding and lines as
 * the "Choose a CSV file" target, so the step keeps its height.
 */
export function ReadingFileSkeleton({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[26px] border border-[color:var(--muted)] border-dashed px-6 py-14">
      {label ? <SkeletonStatus label={label} /> : null}
      <span
        aria-hidden="true"
        className="size-7 rounded-[8px] border border-[color:var(--muted)] opacity-40"
      />
      <SkeletonText widths={['9rem']} lineHeight={24} align="center" className="w-full" />
      <SkeletonText widths={['22rem']} lineHeight={21} align="center" className="w-full" />
    </div>
  );
}

const stepPills = [92, 76, 92, 84, 92] as const;

/** Step 1 of the import wizard: the step list, then the upload panel. */
export function ImportSkeleton() {
  return (
    <section data-skeleton="contacts-import" className="flex flex-1 flex-col gap-4">
      <SkeletonStatus label="Loading the import" />
      <span aria-hidden="true" className="flex flex-col gap-3 px-1">
        <SkeletonText widths={['5.5rem']} />
        <SkeletonText size="mono" widths={['9rem']} />
      </span>
      <div className="flex flex-col gap-4">
        <span aria-hidden="true" data-skeleton-part="step-list" className="flex flex-wrap gap-2">
          {stepPills.map((w, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the wizard's five steps
              key={i}
              className={`flex h-[27px] items-center rounded-full border px-3 ${
                i === 0
                  ? 'border-[color:var(--pillBorder)] bg-[color:var(--pressed)]'
                  : 'border-transparent'
              }`}
              style={{ width: w }}
            >
              <SkeletonText size="mono" widths={[100]} className="flex-1" />
            </span>
          ))}
        </span>
        <SkeletonPanel data-skeleton-part="upload-panel" className="flex flex-col gap-6 p-6 sm:p-9">
          <span className="flex flex-col gap-3">
            <SkeletonText size="mono" widths={['10rem']} />
            <SkeletonText widths={['16rem']} lineHeight="clamp(28px, 3.6vw, 44px)" />
            <SkeletonText
              lines={3}
              widths={['36rem', 'min(96%, 34rem)', 'min(60%, 18rem)']}
              lineHeight={24.375}
            />
          </span>
          <ReadingFileSkeleton />
          <SkeletonText lines={2} widths={['34rem', 'min(50%, 14rem)']} lineHeight={21.125} />
        </SkeletonPanel>
      </div>
    </section>
  );
}
