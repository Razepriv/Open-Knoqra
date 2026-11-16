import { Button, Panel } from '@knoqra/ui';
import {
  CONTACT_FIELDS,
  type ColumnMapping,
  type ContactField,
  type ImportRow,
} from '../../lib/csv';
import type { DuplicateMode } from '../../lib/import-runner';
import { FIELD_SPECS } from './map-step';
import { formatCount, StepHeading, tableClasses } from './parts';

export const PREVIEW_ROWS = 10;

export interface ReviewStepProps {
  rows: readonly ImportRow[];
  /** Each row's number in the file, parallel to `rows`. */
  rowNumbers: readonly number[];
  mapping: ColumnMapping;
  onDuplicate: DuplicateMode;
  onDuplicateChange: (mode: DuplicateMode) => void;
  onBack: () => void;
  onImport: () => void;
}

const MODES: readonly { value: DuplicateMode; title: string; hint: string }[] = [
  {
    value: 'skip',
    title: 'Skip existing',
    hint: 'Contacts whose phone number is already in KNOQRA are left as they are.',
  },
  {
    value: 'update',
    title: 'Update existing',
    hint: 'Filled-in cells replace the fields on the matching contact, and tags are added. Blank cells change nothing.',
  },
];

function cellText(row: ImportRow, field: ContactField): string {
  const value = row[field];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

export function ReviewStep({
  rows,
  rowNumbers,
  mapping,
  onDuplicate,
  onDuplicateChange,
  onBack,
  onImport,
}: ReviewStepProps) {
  const fields = CONTACT_FIELDS.filter((field) => mapping[field] !== undefined);
  const preview = rows.slice(0, PREVIEW_ROWS);
  const label = `Import ${formatCount(rows.length)} ${rows.length === 1 ? 'contact' : 'contacts'}`;

  return (
    <Panel className="flex flex-col gap-6 p-6 sm:p-9">
      <StepHeading eyebrow="Step 3 of 5 · Review" title="Review before importing">
        <p>
          Here are the first {Math.min(PREVIEW_ROWS, rows.length)} of {formatCount(rows.length)}{' '}
          rows as KNOQRA will read them. Each row is checked when it is imported, and rows that fail
          are listed afterwards.
        </p>
      </StepHeading>

      <div className={tableClasses.wrap}>
        <table className={tableClasses.table} aria-label="Preview of the first rows">
          <thead>
            <tr>
              <th scope="col" className={tableClasses.th}>
                Row
              </th>
              {fields.map((field) => (
                <th key={field} scope="col" className={tableClasses.th}>
                  {FIELD_SPECS[field].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.map((row, index) => {
              const rowNumber = rowNumbers[index] ?? index + 1;
              return (
                <tr key={rowNumber}>
                  <td className={tableClasses.td}>{rowNumber}</td>
                  {fields.map((field) => (
                    <td key={field} className={tableClasses.td}>
                      {cellText(row, field)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className="mb-3 font-medium text-[14px]">If a contact already exists</legend>
        {MODES.map((mode) => (
          <label
            key={mode.value}
            className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] p-4 [box-shadow:var(--cellShadow)] has-[:checked]:border-[color:var(--line)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--line)] has-[:focus-visible]:outline-offset-2"
          >
            <input
              type="radio"
              name="on-duplicate"
              value={mode.value}
              checked={onDuplicate === mode.value}
              onChange={() => onDuplicateChange(mode.value)}
              className="mt-1 accent-[color:var(--line)]"
            />
            <span className="flex flex-col gap-1">
              <span className="font-medium text-[14px]">{mode.title}</span>
              <span className="text-[13px] text-[color:var(--muted)] leading-snug">
                {mode.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="max-w-[62ch] text-[13px] text-[color:var(--muted)] leading-relaxed">
        Imported contacts start with unknown permission. Importing a list never records consent to
        call or message anyone.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onImport}>
          {label}
        </Button>
      </div>
    </Panel>
  );
}
