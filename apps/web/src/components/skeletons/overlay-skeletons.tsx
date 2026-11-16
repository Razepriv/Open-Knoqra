import { SkeletonStatus, SkeletonText } from '@knoqra/ui';

// Loading rows for the shell's popovers. Kept apart from the page outlines, so the bell and the
// palette do not pull every outline in with them.

/** Notification rows while the bell's popover loads: dot, title and time, as each Row draws them. */
export function BellListSkeleton() {
  return (
    <div data-skeleton="bell-list" className="flex flex-col">
      <SkeletonStatus label="Loading notifications" />
      {[64, 82, 52].map((w, i) => (
        <span key={w} aria-hidden="true" className="flex items-start gap-3 px-3 py-2.5">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[color:var(--pillBorder)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <SkeletonText widths={[`${w}%`]} seed={i} />
            <SkeletonText widths={['5rem']} lineHeight={18} seed={i + 3} />
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Contact results while the palette searches: the group heading and item-shaped rows. It sits in
 * cmdk's listbox, so it is hidden from assistive tech; the palette announces the search itself.
 */
export function PaletteResultsSkeleton() {
  return (
    <div data-skeleton="palette-results" aria-hidden="true" className="px-1 pb-1">
      <span className="flex flex-col">
        <SkeletonText size="mono" widths={['4.5rem']} lineHeight={16.5} className="px-3 py-1.5" />
        {[46, 60].map((w, i) => (
          <span key={w} className="flex h-[41px] items-center gap-2 rounded-[14px] px-3">
            <SkeletonText widths={[`${w}%`]} seed={i} className="flex-1" />
          </span>
        ))}
      </span>
    </div>
  );
}
