import { Button, Reveal } from '@knoqra/ui';
import { useMemo } from 'react';
import { formatDate, formatTime } from '../../lib/format';
import type { LedgerFilters } from '../../lib/ledger-csv';
import { formatMicros } from '../../lib/money';
import { KIND_LABELS, type UsageLedgerRow, useUsageLedger } from '../../lib/usage';
import { ScrollRegion } from '../scroll-region';
import { BlockError, LEDGER_ROW, LedgerHeaderRow, LedgerRowsSkeleton } from './usage-states';

function LedgerRow({ row }: { row: UsageLedgerRow }) {
  return (
    <li className={LEDGER_ROW}>
      <span className="flex flex-col">
        <span>{formatDate(row.createdAt)}</span>
        <span className="text-[12px] text-[color:var(--muted)]">{formatTime(row.createdAt)}</span>
      </span>
      <span className="inline-flex h-6 w-fit items-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-2.5 font-medium text-[12px] leading-none">
        {KIND_LABELS[row.kind]}
      </span>
      <span className="min-w-0 break-words">{row.description}</span>
      <span className="text-right font-[family-name:var(--font-mono)]">
        {formatMicros(row.balanceDeltaMicros)}
      </span>
      <span className="text-right font-[family-name:var(--font-mono)]">
        {formatMicros(row.balanceAfterMicros)}
      </span>
      <span className="text-right font-[family-name:var(--font-mono)] text-[color:var(--muted)]">
        {formatMicros(row.heldAfterMicros)}
      </span>
    </li>
  );
}

export interface LedgerTableProps {
  filters: LedgerFilters;
  /** False while the range is invalid, so no request is made for it. */
  enabled: boolean;
}

/** The filtered ledger, newest first, with the running balances the API computes. */
export function LedgerTable({ filters, enabled }: LedgerTableProps) {
  const ledger = useUsageLedger(filters, enabled);
  const rows = useMemo(() => ledger.data?.pages.flatMap((page) => page.items) ?? [], [ledger.data]);

  if (!enabled) {
    return (
      <p className="text-[15px] text-[color:var(--muted)]">
        Fix the dates above to see the ledger.
      </p>
    );
  }
  if (ledger.isError && rows.length === 0) {
    return (
      <BlockError
        what="the ledger"
        error={ledger.error}
        onRetry={() => void ledger.refetch()}
        retrying={ledger.isFetching}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Reveal loading={ledger.isPending}>
        {ledger.isPending ? (
          <LedgerRowsSkeleton />
        ) : rows.length === 0 ? (
          <p className="p-1 text-[15px] text-[color:var(--muted)]">
            No ledger entries match these filters.
          </p>
        ) : (
          <ScrollRegion label="Ledger entries">
            <div className="min-w-[720px]">
              <LedgerHeaderRow />
              <ul aria-label="Ledger" className="flex flex-col gap-[6px]">
                {rows.map((row) => (
                  <LedgerRow key={row.id} row={row} />
                ))}
              </ul>
            </div>
          </ScrollRegion>
        )}
      </Reveal>
      {ledger.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={ledger.isFetchingNextPage ? undefined : () => void ledger.fetchNextPage()}
            aria-busy={ledger.isFetchingNextPage}
          >
            {ledger.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
      {ledger.isError && rows.length > 0 ? (
        <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
          We could not load more entries. Try again.
        </p>
      ) : null}
    </div>
  );
}
