import { Button } from '@knoqra/ui';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ExportTooLargeError, exportLedger, type LedgerFilters } from '../../lib/ledger-csv';
import { fetchLedgerPage } from '../../lib/usage';

export interface ExportButtonProps {
  filters: LedgerFilters;
  disabled: boolean;
  /** Shows a toast: called once with the outcome. */
  onDone: (message: string) => void;
}

/** Downloads every row that matches the filters as a CSV, built in the browser. */
export function ExportButton({ filters, disabled, onDone }: ExportButtonProps) {
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  // Leaving the page stops the paging, so no file is saved after the user has gone.
  useEffect(() => () => controller.current?.abort(), []);
  const run = async () => {
    const abort = new AbortController();
    controller.current = abort;
    setPending(true);
    try {
      const count = await exportLedger(filters, fetchLedgerPage, undefined, abort.signal);
      onDone(count === 1 ? 'Exported 1 ledger row.' : `Exported ${count} ledger rows.`);
    } catch (error) {
      if (abort.signal.aborted) return;
      onDone(
        error instanceof ExportTooLargeError
          ? 'Narrow the date range to export.'
          : 'Could not export the ledger. Try again.',
      );
    } finally {
      if (!abort.signal.aborted) setPending(false);
    }
  };
  return (
    <Button
      variant="ghost"
      disabled={disabled}
      onClick={pending ? undefined : () => void run()}
      aria-busy={pending}
    >
      <Download size={15} strokeWidth={1.75} aria-hidden="true" />
      {pending ? 'Exporting…' : 'Export CSV'}
    </Button>
  );
}
