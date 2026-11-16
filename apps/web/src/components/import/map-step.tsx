import { Button, Panel } from '@knoqra/ui';
import type { ChangeEvent } from 'react';
import {
  type ColumnMapping,
  MAPPING_FIELDS,
  type MappingField,
  mappingConflicts,
} from '../../lib/csv';
import { SelectField } from '../select-field';
import { formatCount, Notice, StepHeading } from './parts';

interface FieldSpec {
  label: string;
  required: boolean;
  hint?: string;
}

export const FIELD_SPECS: Record<MappingField, FieldSpec> = {
  displayName: { label: 'Name', required: true },
  lastName: { label: 'Last name', required: false, hint: 'Joined to Name with a space' },
  phone: { label: 'Phone', required: true },
  company: { label: 'Company', required: false },
  email: { label: 'Email', required: false },
  jobTitle: { label: 'Job title', required: false },
  timezone: { label: 'Time zone', required: false },
  tags: { label: 'Tags', required: false },
};

export function canContinue(mapping: ColumnMapping): boolean {
  return mapping.displayName !== undefined && mapping.phone !== undefined;
}

export interface MapStepProps {
  fileName: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  warnings: readonly string[];
  mapping: ColumnMapping;
  onMappingChange: (mapping: ColumnMapping) => void;
  onBack: () => void;
  onContinue: () => void;
}

function columnLabel(header: string, index: number): string {
  return header === '' ? `Column ${index + 1}` : header;
}

function sampleFor(
  field: MappingField,
  mapping: ColumnMapping,
  row: readonly string[] | undefined,
): string {
  const at = (index: number | undefined) =>
    index === undefined ? '' : (row?.[index] ?? '').trim();
  if (field === 'displayName') {
    return [at(mapping.displayName), at(mapping.lastName)].filter(Boolean).join(' ');
  }
  return at(mapping[field]);
}

export function MapStep({
  fileName,
  headers,
  rows,
  warnings,
  mapping,
  onMappingChange,
  onBack,
  onContinue,
}: MapStepProps) {
  function change(field: MappingField, event: ChangeEvent<HTMLSelectElement>) {
    const { [field]: _removed, ...rest } = mapping;
    const value = event.currentTarget.value;
    onMappingChange(value === '' ? rest : { ...rest, [field]: Number(value) });
  }

  const conflicts = mappingConflicts(mapping);

  return (
    <Panel className="flex flex-col gap-6 p-6 sm:p-9">
      <StepHeading eyebrow="Step 2 of 5 · Map" title="Match your columns">
        <p>
          {fileName} has {formatCount(rows.length)} {rows.length === 1 ? 'row' : 'rows'}. Pick the
          column that holds each field. Name and phone are required.
        </p>
      </StepHeading>

      {warnings.map((warning) => (
        <Notice key={warning}>{warning}</Notice>
      ))}

      <ul className="flex flex-col gap-3">
        {MAPPING_FIELDS.map((field) => {
          const spec = FIELD_SPECS[field];
          const column = mapping[field];
          const sample = sampleFor(field, mapping, rows[0]);
          const selectId = `map-${field}`;
          return (
            <li
              key={field}
              className="grid items-end gap-2 sm:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] sm:gap-4"
            >
              <SelectField
                id={selectId}
                label={spec.label}
                hint={spec.required ? 'Required' : spec.hint}
                value={column === undefined ? '' : String(column)}
                onChange={(event) => change(field, event)}
                aria-required={spec.required || undefined}
              >
                <option value="">Don't import</option>
                {headers.map((header, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are identified by position
                  <option key={index} value={String(index)}>
                    {columnLabel(header, index)}
                  </option>
                ))}
              </SelectField>
              <p className="truncate pb-2 font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]">
                {sample ? `e.g. ${sample}` : ''}
              </p>
            </li>
          );
        })}
      </ul>

      {conflicts.map((conflict) => (
        <Notice key={conflict.column}>
          The column “{columnLabel(headers[conflict.column] ?? '', conflict.column)}” is used for{' '}
          {conflict.fields.map((field) => FIELD_SPECS[field].label).join(' and ')}. Check that is
          what you want.
        </Notice>
      ))}

      {canContinue(mapping) ? null : (
        <p className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]">
          Map Name and Phone to continue.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Choose another file
        </Button>
        <Button variant="primary" onClick={onContinue} disabled={!canContinue(mapping)}>
          Continue
        </Button>
      </div>
    </Panel>
  );
}
