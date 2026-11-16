import { SkeletonStatus, SkeletonText } from '@knoqra/ui';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { provenanceLabel } from '../../lib/contact360';
import { useMergeHistory } from '../../lib/contact360-queries';
import type { Contact } from '../../lib/contacts';
import { formatDate } from '../../lib/format';
import { focusRing } from '../../lib/ui-classes';
import { QueryStatePanel } from '../states/state-panel';

const mono =
  'font-[family-name:var(--font-mono)] font-medium text-[10.5px] leading-[1.5] text-[color:var(--muted)]';

/**
 * Where this record came from, as one mono caption at the foot of the panel (source and creation
 * date), and what was merged into it on request.
 */
export function Provenance({ contact }: { contact: Contact }) {
  const [showMerges, setShowMerges] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <p className={mono}>
        <span className="uppercase tracking-[.04em]">Provenance</span>
        {` · ${provenanceLabel(contact.source, contact.sourceDetail)} · Created ${formatDate(contact.createdAt)}`}
      </p>
      {/* Merge history costs a scan of the timeline, so it is read only when asked for. */}
      <button
        type="button"
        aria-expanded={showMerges}
        onClick={() => setShowMerges((open) => !open)}
        className={`mt-1 inline-flex items-center gap-1 self-start rounded-full py-1 font-medium text-[12px] underline ${focusRing}`}
      >
        <ChevronDown
          size={13}
          strokeWidth={1.75}
          aria-hidden="true"
          className={showMerges ? 'rotate-180' : ''}
        />
        {showMerges ? 'Hide merge history' : 'Show merge history'}
      </button>
      {showMerges ? <MergeHistory contactId={contact.id} /> : null}
    </div>
  );
}

function MergeHistory({ contactId }: { contactId: string }) {
  const history = useMergeHistory(contactId, true);
  if (history.isPending) {
    return (
      <span className="flex flex-col">
        <SkeletonStatus label="Loading merge history" />
        <SkeletonText widths={['70%']} lineHeight={18.125} />
        <SkeletonText size="mono" widths={['30%']} lineHeight={15.75} />
      </span>
    );
  }
  if (history.data === undefined) {
    return (
      <QueryStatePanel
        error={history.error}
        onRetry={() => void history.refetch()}
        retrying={history.isFetching}
        subject="the merge history"
        headingLevel={3}
      />
    );
  }
  const { merges, capped } = history.data;
  return (
    <div className="flex flex-col gap-1">
      {merges.length === 0 ? (
        <p className="text-[12.5px] text-[color:var(--muted)] leading-[1.45]">
          Nothing has been merged into this contact.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {merges.map((event) => (
            <li key={event.id} className="text-[12.5px] leading-[1.45]">
              {event.title}
              <span className={`${mono} block`}>{formatDate(event.occurredAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {capped ? <p className={mono}>Older merges may not be shown.</p> : null}
    </div>
  );
}
