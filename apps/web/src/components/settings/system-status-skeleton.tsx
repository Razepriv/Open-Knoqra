import { Skeleton } from '@knoqra/ui';

/**
 * The System status section's loading shape and the constants it shares with the section. A leaf
 * module: the Settings outline (in the initial bundle) draws it without loading the section.
 */

/** The section's own heading, shared with the place Settings holds for it while the role loads. */
export const SYSTEM_STATUS_SECTION = {
  id: 'system-status',
  title: 'System status',
  description: 'Health of this KNOQRA server. Visible to workspace owners and admins.',
} as const;

const SERVER_CHECK_ROWS = 9;
const BROWSER_CHECK_ROWS = 2;

/** One check row, loaded or loading. */
export const SYSTEM_STATUS_ROW_CLASS =
  'flex flex-col gap-2 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-3 [box-shadow:var(--cellShadow)]';
const ROW_CLASS = SYSTEM_STATUS_ROW_CLASS;

/** Mirrors the loaded section: headline, nine server rows, two browser rows and Refresh. */
export function SystemStatusSkeleton() {
  return (
    <div role="status" aria-label="Checking system status" className="flex flex-col gap-6">
      <span className="sr-only">Checking system status</span>
      {/* One announcement for the whole placeholder: the parts below are visual only. */}
      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Skeleton circle width={12} height={12} />
            <Skeleton lines={1} widths={[55]} className="flex-1" />
          </div>
          <Skeleton lines={1} widths={[45]} />
        </div>
        <SkeletonList rows={SERVER_CHECK_ROWS} />
        <SkeletonList rows={BROWSER_CHECK_ROWS} />
        <Skeleton width={96} height={40} />
      </div>
    </div>
  );
}

function SkeletonList({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton lines={1} widths={[24]} />
      <ul className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows never reorder
          <li key={index} className={ROW_CLASS}>
            <div className="flex items-center justify-between gap-3">
              <Skeleton lines={1} widths={[40]} className="flex-1" />
              <Skeleton width={64} height={22} />
            </div>
            <Skeleton lines={1} widths={[65]} />
          </li>
        ))}
      </ul>
    </div>
  );
}
