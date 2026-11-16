import {
  SkeletonButton,
  SkeletonPanel,
  SkeletonRow,
  SkeletonStatus,
  SkeletonText,
} from '@knoqra/ui';
import { contactListPanel, contactRowsList, contactSearchBox } from '../../lib/contacts-layout';

const FULL_ROWS = 8;
const COMPACT_ROWS = 7;

export interface ContactRowsSkeletonProps {
  /** The narrow list beside Contact 360: no phone column. */
  compact?: boolean;
  rows?: number;
  /** Set where the rows are the page's only loading spot. */
  label?: string;
}

/** Contact rows as ContactRow draws them: 56px pill cards, 6px apart, inside the list's padding. */
export function ContactRowsSkeleton({ compact = false, rows, label }: ContactRowsSkeletonProps) {
  const count = rows ?? (compact ? COMPACT_ROWS : FULL_ROWS);
  return (
    <div className={contactRowsList}>
      {label ? <SkeletonStatus label={label} /> : null}
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
          key={i}
          seed={i}
          trailing={compact ? 'none' : 'pill'}
        />
      ))}
    </div>
  );
}

/** The search box: a 44px sunken pill. */
function SearchSkeleton({ compact }: { compact: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-skeleton-part="search"
      className={`${contactSearchBox(compact)} shrink-0`}
    >
      <span className="size-[15px] shrink-0 rounded-full border border-[color:var(--muted)] opacity-50" />
      <SkeletonText widths={[compact ? 60 : 46]} lineHeight={21} className="flex-1" />
    </span>
  );
}

/** The whole contact list panel (ContactList), full or compact, without its own status. */
export function ContactListOutline({ compact = false }: { compact?: boolean }) {
  return (
    <SkeletonPanel data-skeleton-part="list-panel" className={contactListPanel(compact)}>
      <span className="flex flex-wrap items-center gap-3">
        <SkeletonText
          widths={[compact ? 116 : 134].map((w) => `${w}px`)}
          lineHeight={compact ? 26 : 30}
          className={compact ? 'px-2' : ''}
        />
        <span className="flex-1" />
        {compact ? (
          <SkeletonButton size="icon" height={40} />
        ) : (
          <>
            <SkeletonButton size="sm" width={113} height={34} />
            <SkeletonButton width={137} />
          </>
        )}
      </span>
      <SearchSkeleton compact={compact} />
      <ContactRowsSkeleton compact={compact} />
    </SkeletonPanel>
  );
}

/** Contacts page while it loads. */
export function ContactsSkeleton() {
  return (
    <div data-skeleton="contacts" className="flex min-h-0 flex-1 flex-col">
      <SkeletonStatus label="Loading your contacts" />
      <ContactListOutline />
    </div>
  );
}
