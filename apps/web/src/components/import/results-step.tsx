import { Button, ButtonLink, Panel } from '@knoqra/ui';
import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ImportRow } from '../../lib/csv';
import { downloadTextFile } from '../../lib/download';
import { describeImportError, type ImportSummary, type RowOutcome } from '../../lib/import-runner';
import { rejectedCsvFileName, rejectedRowsCsv } from '../../lib/rejected-csv';
import { formatCount, MonoLabel, StepHeading, tableClasses } from './parts';

/** Rows shown per table. The download holds every rejected row. */
export const TABLE_LIMIT = 100;

export interface ResultsStepProps {
  summary: ImportSummary;
  fileName: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  importRows: readonly ImportRow[];
  onStartOver: () => void;
  /** Where "View contacts" goes. */
  contactsHref: string;
}

const TITLES: Record<ImportSummary['status'], string> = {
  completed: 'Import finished',
  cancelled: 'Import cancelled',
  failed: 'Import stopped',
};

const FINISH_SAFELY =
  "Run the file again with 'Skip existing' to finish safely; contacts already imported will be skipped.";

/** What happened to the rows that were not confirmed, and what to do about it. */
export function stopMessage(summary: ImportSummary): string {
  const from =
    summary.stoppedAtRow === null ? 'The remaining rows' : `Rows ${summary.stoppedAtRow} onward`;
  if (summary.status === 'cancelled') {
    return `${from} were not sent; everything before them stays imported. ${FINISH_SAFELY}`;
  }
  return `${from} may or may not have been imported. ${FINISH_SAFELY}`;
}

export function ResultsStep({
  summary,
  fileName,
  headers,
  rows,
  importRows,
  onStartOver,
  contactsHref,
}: ResultsStepProps) {
  const { counts, outcomes, status, processed, total } = summary;
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');

  return (
    <Panel className="flex flex-col gap-6 p-6 sm:p-9">
      <StepHeading eyebrow="Step 5 of 5 · Results" title={TITLES[status]}>
        {status === 'completed' ? (
          <p>
            {formatCount(total)} {total === 1 ? 'row' : 'rows'} from {fileName} were checked.
          </p>
        ) : (
          <p>
            {formatCount(processed)} of {formatCount(total)} rows were confirmed before the import
            stopped. {stopMessage(summary)}
          </p>
        )}
      </StepHeading>

      {status === 'failed' ? (
        <div
          role="alert"
          className="rounded-2xl border border-[color:var(--danger-text)] bg-[image:var(--hatch)] px-4 py-3 text-[14px] text-[color:var(--danger-text)] leading-snug"
        >
          {describeImportError(summary.error)}
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Count id="created" label="Created" value={counts.created} />
        <Count id="updated" label="Updated" value={counts.updated} />
        <Count id="skipped" label="Skipped" value={counts.skipped} />
        <Count id="rejected" label="Rejected" value={counts.rejected} />
      </dl>

      {rejected.length > 0 ? (
        <OutcomeTable
          caption="Rejected rows"
          outcomes={rejected}
          importRows={importRows}
          hatched
          extra={
            <Button
              variant="ghost"
              onClick={() =>
                downloadTextFile(
                  rejectedCsvFileName(fileName),
                  rejectedRowsCsv(headers, rows, rejected),
                  { mimeType: 'text/csv', bom: true },
                )
              }
            >
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              Download rejected rows (CSV)
            </Button>
          }
        />
      ) : null}

      {skipped.length > 0 ? (
        <OutcomeTable caption="Skipped rows" outcomes={skipped} importRows={importRows} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onStartOver}>
          Import another file
        </Button>
        <ButtonLink variant="primary" href={contactsHref}>
          View contacts
        </ButtonLink>
      </div>
    </Panel>
  );
}

function Count({ id, label, value }: { id: string; label: string; value: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] p-4 [box-shadow:var(--cellShadow)]">
      <dt>
        <MonoLabel>{label}</MonoLabel>
      </dt>
      <dd
        data-testid={`count-${id}`}
        className="m-0 font-[family-name:var(--font-display)] text-[36px] leading-none tracking-[-0.03em]"
      >
        {formatCount(value)}
      </dd>
    </div>
  );
}

interface OutcomeTableProps {
  caption: string;
  outcomes: readonly RowOutcome[];
  importRows: readonly ImportRow[];
  hatched?: boolean;
  extra?: ReactNode;
}

function OutcomeTable({
  caption,
  outcomes,
  importRows,
  hatched = false,
  extra,
}: OutcomeTableProps) {
  const shown = outcomes.slice(0, TABLE_LIMIT);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium text-[16px]">
          {caption}{' '}
          <span className="text-[color:var(--muted)]">({formatCount(outcomes.length)})</span>
        </h2>
        {extra}
      </div>
      <div className={tableClasses.wrap}>
        <table className={tableClasses.table} aria-label={caption}>
          <thead className={hatched ? 'bg-[image:var(--hatch)]' : undefined}>
            <tr>
              <th scope="col" className={tableClasses.th}>
                Row
              </th>
              <th scope="col" className={tableClasses.th}>
                Name
              </th>
              <th scope="col" className={tableClasses.th}>
                Phone
              </th>
              <th scope="col" className={tableClasses.th}>
                Reason
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((outcome) => {
              const row = importRows[outcome.index];
              return (
                <tr key={outcome.index}>
                  <td className={tableClasses.td}>{outcome.rowNumber}</td>
                  <td className={tableClasses.td}>{row?.displayName ?? ''}</td>
                  <td className={tableClasses.td}>{row?.phone ?? ''}</td>
                  <td className="border-[color:var(--panelBorder)] border-b px-3 py-2 align-top">
                    {outcome.message ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {outcomes.length > TABLE_LIMIT ? (
        <p className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]">
          Showing the first {TABLE_LIMIT} of {formatCount(outcomes.length)}.
          {hatched ? ' The download has every rejected row.' : ''}
        </p>
      ) : null}
    </section>
  );
}
