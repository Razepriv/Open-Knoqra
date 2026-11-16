import { Panel } from '@knoqra/ui';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { BalanceCards } from '../../components/usage/balance-cards';
import { ExportButton } from '../../components/usage/export-button';
import { LedgerFilters } from '../../components/usage/ledger-filters';
import { LedgerTable } from '../../components/usage/ledger-table';
import { ReconciliationList } from '../../components/usage/reconciliation-list';
import { SpendChart } from '../../components/usage/spend-chart';
import { sectionHeading } from '../../components/usage/usage-layout';
import { UsagePageSkeleton } from '../../components/usage/usage-page-skeleton';
import { useToast } from '../../components/use-toast';
import type { LedgerFilters as Filters } from '../../lib/ledger-csv';
import {
  defaultRange,
  filtersFromSearch,
  patchUsageSearch,
  type UsageSearch,
  validateRange,
} from '../../lib/usage';
import { USAGE_CHANNELS } from '../../lib/usage-channels';

const KINDS = ['credit', 'adjust', 'reserve', 'capture', 'release'] as const;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export const Route = createFileRoute('/_app/usage')({
  staticData: { title: 'Usage' },
  validateSearch: (search: Record<string, unknown>): UsageSearch => {
    const channel = text(search.channel);
    const kind = text(search.kind);
    return {
      ...(text(search.from) ? { from: text(search.from) } : {}),
      ...(text(search.to) ? { to: text(search.to) } : {}),
      ...(channel && (USAGE_CHANNELS as readonly string[]).includes(channel) ? { channel } : {}),
      ...(kind && (KINDS as readonly string[]).includes(kind) ? { kind } : {}),
    };
  },
  pendingComponent: UsagePageSkeleton,
  component: UsagePage,
});

function UsagePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { show, toast } = useToast();
  // The default range is read once, so it does not change under the page at midnight UTC.
  const [fallback] = useState(() => defaultRange(new Date()));
  const filters = filtersFromSearch(search, fallback);
  const valid = validateRange(filters.from, filters.to) === null;

  // Built from the router's latest search: a second change made before this render caught up
  // must not bring back a filter the first one cleared.
  const change = (patch: Partial<Filters>) => {
    void navigate({ search: (latest) => patchUsageSearch(latest, patch, fallback), replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="sr-only">Usage</h1>
      <BalanceCards />
      <SpendChart from={filters.from} to={filters.to} enabled={valid} />
      <Panel aria-label="Ledger" className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={sectionHeading}>Ledger</h2>
          <ExportButton filters={filters} disabled={!valid} onDone={show} />
        </div>
        <LedgerFilters filters={filters} onChange={change} />
        <LedgerTable filters={filters} enabled={valid} />
      </Panel>
      <ReconciliationList onDone={show} />
      {toast}
    </div>
  );
}
