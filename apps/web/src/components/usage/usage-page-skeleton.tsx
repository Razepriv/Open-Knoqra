import { Panel } from '@knoqra/ui';
import {
  BalanceCardsSkeleton,
  LedgerRowsSkeleton,
  PanelHeading,
  ReconciliationHeading,
  ReconciliationRowsSkeleton,
  RunReconciliationSkeleton,
  Slot,
  SpendChartSkeleton,
} from './usage-layout';

const FILTER_LABELS = ['From', 'To', 'Channel', 'Kind'] as const;

/** Heading row, the four filter fields and Export, then the table: what the ledger panel is. */
function LedgerPanelSkeleton() {
  return (
    <Panel className="flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelHeading title="Ledger" />
        <Slot height={40} width={132} label="Loading export" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
        {FILTER_LABELS.map((label) => (
          <div key={label} className="flex flex-col">
            <span className="mb-2 font-medium text-[13px]">{label}</span>
            <Slot height={48} />
          </div>
        ))}
      </div>
      <div className="relative overflow-x-auto">
        <LedgerRowsSkeleton />
      </div>
    </Panel>
  );
}

/**
 * The whole Usage page as a placeholder: the same four rows, so nothing shifts on arrival. The
 * table scrollers are positioned so the rows' screen-reader labels (absolutely placed) stay
 * inside them instead of widening the page on a phone.
 */
export function UsagePageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <BalanceCardsSkeleton />
      <Panel className="flex flex-col gap-4 p-5 sm:p-6">
        <PanelHeading title="Spend by day" aside={<Slot height={11} width={200} />} />
        <SpendChartSkeleton />
      </Panel>
      <LedgerPanelSkeleton />
      <Panel className="flex flex-col gap-4 p-5 sm:p-6">
        <ReconciliationHeading />
        <RunReconciliationSkeleton />
        <div className="relative overflow-x-auto">
          <ReconciliationRowsSkeleton />
        </div>
      </Panel>
    </div>
  );
}
