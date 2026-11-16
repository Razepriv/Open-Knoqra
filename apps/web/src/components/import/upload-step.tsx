import { Panel } from '@knoqra/ui';
import { FileUp } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useState } from 'react';
import { CsvError, MAX_CSV_ROWS, type ParsedCsv, parseCsv } from '../../lib/csv';
import { ReadingFileSkeleton } from '../skeletons/import-skeleton';
import { StatePanel } from '../states/state-panel';
import { formatCount, StepHeading } from './parts';

export interface UploadStepProps {
  onParsed: (fileName: string, parsed: ParsedCsv) => void;
  /** False on the page's first paint, so focus is not pulled away from the page. */
  focusHeading: boolean;
}

const FALLBACK_ERROR = 'We could not read this file. Check that it is a CSV and try again.';

export function UploadStep({ onParsed, focusHeading }: UploadStepProps) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onParsed(file.name, await parseCsv(file));
    } catch (failure) {
      setError(failure instanceof CsvError ? failure.message : FALLBACK_ERROR);
      setBusy(false);
    }
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Reset so choosing the same file again after fixing it still fires a change.
    void read(file).finally(() => {
      input.value = '';
    });
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void read(event.dataTransfer.files[0]);
  }

  return (
    <Panel data-anchor="import-upload" className="flex flex-col gap-6 p-6 sm:p-9">
      <StepHeading eyebrow="Step 1 of 5 · Upload" title="Upload a CSV" focusOnMount={focusHeading}>
        <p>
          One row per contact, with a header row. Name and phone are required; company, email, job
          title, time zone and tags are optional. Files can hold up to {formatCount(MAX_CSV_ROWS)}{' '}
          rows and 10 MB.
        </p>
      </StepHeading>

      {error ? (
        // The drop zone below stays, so choosing another file is the retry.
        <StatePanel
          kind="error"
          title="We could not read this file."
          body={error === FALLBACK_ERROR ? 'Check that it is a CSV and try again.' : error}
        />
      ) : null}

      {busy ? (
        <ReadingFileSkeleton label="Reading your file" />
      ) : (
        <label
          htmlFor="csv-file"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[26px] border border-dashed px-6 py-14 text-center transition-colors focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2 ${
            dragging
              ? 'border-[color:var(--line)] bg-[color:var(--pressed)]'
              : 'border-[color:var(--muted)] bg-[image:var(--hatch)]'
          }`}
        >
          <FileUp size={28} strokeWidth={1.5} aria-hidden="true" />
          <span className="font-medium text-[16px]">Choose a CSV file</span>
          <span className="text-[14px] text-[color:var(--muted)]">
            or drop it here. Nothing is sent until you confirm the import.
          </span>
          <input
            id="csv-file"
            type="file"
            aria-label="Choose a CSV file"
            accept=".csv,text/csv"
            onChange={onChange}
            className="sr-only"
          />
        </label>
      )}

      <p className="max-w-[62ch] text-[13px] text-[color:var(--muted)] leading-relaxed">
        Imported contacts start with unknown permission. Importing a list never records consent to
        call or message anyone.
      </p>
    </Panel>
  );
}
