import { Panel, Skeleton } from '@knoqra/ui';
import type { ReactNode } from 'react';
import { USAGE_CHANNELS } from '../../lib/usage-channels';

/**
 * The Usage page's layout constants and loading shapes, shared by its real panels and the page
 * outline. A leaf module: the outline is in the initial bundle, so nothing here loads data.
 */

export const sectionHeading =
  'font-[family-name:var(--font-display)] text-[22px] leading-none tracking-[-0.02em]';
export const eyebrow =
  'font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]';
export const cellSurface =
  'rounded-[20px] bg-[color:var(--cell)] [box-shadow:var(--cellShadow)] px-4 py-3';

const headCell =
  'font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]';

/** A skeleton of a fixed size, so the placeholder takes exactly the room the content will. */
export function Slot({
  height,
  width = '100%',
  label = 'Loading',
}: {
  height: number;
  width?: number | string;
  label?: string;
}) {
  return (
    <div className="overflow-hidden" style={{ height, width }}>
      <Skeleton height="100%" width="100%" label={label} />
    </div>
  );
}

// --- Ledger ---------------------------------------------------------------------------------

export const LEDGER_GRID =
  'grid grid-cols-[minmax(120px,1.1fr)_90px_minmax(140px,2fr)_90px_110px_90px] items-center gap-4';
/** A ledger row: two lines of date and time set its height. */
export const LEDGER_ROW = `${LEDGER_GRID} min-h-[60px] rounded-[16px] bg-[color:var(--cell)] px-3 py-2.5 text-[14px]`;

export function LedgerHeaderRow() {
  return (
    <div aria-hidden="true" className={`${LEDGER_GRID} px-3 pb-2 ${headCell}`}>
      <span>Date</span>
      <span>Kind</span>
      <span>Description</span>
      <span className="text-right">Amount</span>
      <span className="text-right">Balance after</span>
      <span className="text-right">Held after</span>
    </div>
  );
}

/** The table's header row and rows, with the real columns and row height. */
export function LedgerRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="min-w-[720px]" aria-busy="true">
      <LedgerHeaderRow />
      <div className="flex flex-col gap-[6px]">
        {Array.from({ length: rows }, (_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            key={index}
            aria-hidden={index > 0 ? true : undefined}
            className={LEDGER_ROW}
          >
            <Slot height={36} width="80%" label="Loading ledger" />
            <Slot height={24} width={72} />
            <Slot height={18} width={`${60 + ((index * 13) % 35)}%`} />
            <Slot height={18} width="70%" />
            <Slot height={18} width="80%" />
            <Slot height={18} width="70%" />
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Reconciliation -------------------------------------------------------------------------

export const RECON_GRID =
  'grid grid-cols-[110px_150px_minmax(160px,2fr)_90px_90px] items-center gap-4';
export const RECON_ROW = `${RECON_GRID} min-h-[44px] rounded-[16px] bg-[color:var(--cell)] px-3 py-2.5 text-[14px]`;

export function ReconciliationHeaderRow() {
  return (
    <div aria-hidden="true" className={`${RECON_GRID} px-3 pb-2 ${headCell}`}>
      <span>Day</span>
      <span>Status</span>
      <span>Provider and ledger</span>
      <span className="text-right">Drift</span>
      <span className="text-right">Run</span>
    </div>
  );
}

/** The reconciliation table's header and its own five-column rows. */
export function ReconciliationRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="min-w-[640px]" aria-busy="true">
      <ReconciliationHeaderRow />
      <div className="flex flex-col gap-[6px]">
        {Array.from({ length: rows }, (_, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            key={index}
            aria-hidden={index > 0 ? true : undefined}
            className={RECON_ROW}
          >
            <Slot height={18} width="80%" label="Loading reconciliations" />
            <Slot height={24} width={90} />
            <Slot height={18} width="75%" />
            <Slot height={18} width="70%" />
            <Slot height={18} width="70%" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The date field and button of "Run reconciliation", shown while the list loads. */
export function RunReconciliationSkeleton() {
  return (
    <div className="flex flex-wrap items-end gap-3" aria-hidden="true">
      <div className="flex flex-col">
        <span className="mb-2 font-medium text-[13px]">Day to reconcile</span>
        <Slot height={48} width={180} />
      </div>
      <div className="mb-1">
        <Slot height={40} width={170} />
      </div>
    </div>
  );
}

// --- Panel scaffolding shared with the page skeleton -----------------------------------------

export function PanelHeading({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className={sectionHeading}>{title}</h2>
      {aside}
    </div>
  );
}

// --- Row skeletons of the real panels ---------------------------------------------------------

/** The same grid, cell sizes and gaps as the loaded cards, so nothing shifts when they arrive. */
export function BalanceCardsSkeleton() {
  const figure = (extra?: boolean) => (
    <div className={`${cellSurface} flex min-w-0 flex-col ${extra ? 'gap-3' : 'gap-2'}`}>
      <Slot height={11} width="50%" label="Loading balance" />
      <Slot height={28} width="60%" />
      {extra ? <Slot height={34} width="100%" /> : null}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]" aria-busy="true">
      <Panel className="flex flex-col gap-4 p-5 sm:p-6">
        <Slot height={22} width={120} label="Loading wallet" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {figure()}
          {figure()}
          {figure()}
        </div>
      </Panel>
      <Panel className="flex flex-col gap-4 p-5 sm:p-6">
        <Slot height={22} width={160} label="Loading Telnyx balance" />
        {figure(true)}
      </Panel>
    </div>
  );
}

export function ReconciliationHeading() {
  return (
    <div className="flex flex-col gap-1">
      <h2 className={sectionHeading}>Reconciliation</h2>
      <p className={eyebrow}>Our ledger against the provider's report, one UTC day at a time</p>
    </div>
  );
}

/** The spend chart's hover read-out line, above the plot. */
export const CHART_HOVER_LINE = 'min-h-[18px]';
/**
 * The spend chart's plot box: its 640 by 220 viewBox at full width. Loading, empty and loaded all
 * keep it, so the panels below never move when the summary arrives.
 */
export const CHART_PLOT_BOX = 'aspect-[640/220] w-full';

/** The chart body as a placeholder: the hover line, a plot with the chart's aspect, the legend row. */
export function SpendChartSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="flex flex-col gap-2">
        <div className={CHART_HOVER_LINE} />
        <div className={`${CHART_PLOT_BOX} overflow-hidden`}>
          <Skeleton height="100%" width="100%" label="Loading spend chart" />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2" aria-hidden="true">
        {USAGE_CHANNELS.map((channel) => (
          <div key={channel} className="flex h-5 items-center gap-2">
            <span className="inline-block size-2.5" />
            <Slot height={14} width={110} />
          </div>
        ))}
      </div>
    </div>
  );
}
