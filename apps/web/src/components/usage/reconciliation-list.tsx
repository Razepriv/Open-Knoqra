import { Button, Panel, Reveal } from '@knoqra/ui';
import { useMemo, useState } from 'react';
import { useMe } from '../../lib/api';
import { formatMicros } from '../../lib/money';
import {
  type ReconciliationReport,
  reconciliationStatusLabel,
  useReconciliations,
  useRunReconciliation,
  yesterday,
} from '../../lib/usage';
import { Field } from '../field';
import { ScrollRegion } from '../scroll-region';
import { ReconciliationHeading } from './usage-layout';
import {
  BlockError,
  RECON_ROW,
  ReconciliationHeaderRow,
  ReconciliationRowsSkeleton,
  RunReconciliationSkeleton,
} from './usage-states';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const TRIGGER_LABELS: Record<ReconciliationReport['trigger'], string> = {
  cron: 'Scheduled',
  manual: 'Manual',
};

function Row({ report }: { report: ReconciliationReport }) {
  const provider =
    report.providerMicros === null ? 'Unavailable' : formatMicros(report.providerMicros);
  return (
    <li className={RECON_ROW}>
      <span className="font-[family-name:var(--font-mono)]">{report.date}</span>
      <span className="inline-flex h-6 w-fit items-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-2.5 font-medium text-[12px] leading-none">
        {reconciliationStatusLabel(report.status)}
      </span>
      <span>{`Provider ${provider} · Ledger ${formatMicros(report.ledgerMicros)}`}</span>
      <span className="text-right font-[family-name:var(--font-mono)]">{`Drift ${formatMicros(report.driftMicros)}`}</span>
      <span className="text-right text-[color:var(--muted)]">{TRIGGER_LABELS[report.trigger]}</span>
    </li>
  );
}

function RunReconciliation({ onDone }: { onDone: (message: string) => void }) {
  const [date, setDate] = useState(() => yesterday(new Date()));
  const run = useRunReconciliation();
  const submit = () =>
    run.mutate(date, {
      onSuccess: (report) =>
        onDone(`Reconciliation for ${report.date}: ${reconciliationStatusLabel(report.status)}.`),
      onError: () => onDone('Could not run the reconciliation. Try again.'),
    });
  return (
    <form
      aria-label="Run reconciliation"
      onSubmit={(event) => {
        event.preventDefault();
        if (!run.isPending) submit();
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <Field
        id="reconcile-date"
        label="Day to reconcile"
        type="date"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        required
        className="w-auto"
      />
      <Button
        type="submit"
        variant="ghost"
        className="mb-1"
        disabled={date === ''}
        aria-busy={run.isPending}
      >
        {run.isPending ? 'Running…' : 'Run reconciliation'}
      </Button>
    </form>
  );
}

/** Row 4: the daily check of our ledger against the provider's own usage report. */
export function ReconciliationList({ onDone }: { onDone: (message: string) => void }) {
  const me = useMe();
  const list = useReconciliations();
  const canRun = me.data ? MANAGER_ROLES.has(me.data.organization.role) : false;
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  return (
    <Panel aria-label="Reconciliation" className="flex flex-col gap-4 p-5 sm:p-6">
      <ReconciliationHeading />
      {me.isPending ? (
        <RunReconciliationSkeleton />
      ) : canRun ? (
        <RunReconciliation onDone={onDone} />
      ) : null}
      {list.isError && items.length === 0 ? (
        <BlockError
          what="reconciliations"
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : (
        <Reveal loading={list.isPending}>
          {list.isPending ? (
            <ReconciliationRowsSkeleton />
          ) : items.length === 0 ? (
            <p className="text-[15px] text-[color:var(--muted)]">
              No reconciliations yet. The first one runs overnight.
            </p>
          ) : (
            <ScrollRegion label="Reconciliations">
              <div className="min-w-[640px]">
                <ReconciliationHeaderRow />
                <ul aria-label="Reconciliations" className="flex flex-col gap-[6px]">
                  {items.map((report) => (
                    <Row key={report.id} report={report} />
                  ))}
                </ul>
              </div>
            </ScrollRegion>
          )}
        </Reveal>
      )}
      {list.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={list.isFetchingNextPage ? undefined : () => void list.fetchNextPage()}
            aria-busy={list.isFetchingNextPage}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
      {list.isError && items.length > 0 ? (
        <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
          We could not load more reconciliations. Try again.
        </p>
      ) : null}
    </Panel>
  );
}
