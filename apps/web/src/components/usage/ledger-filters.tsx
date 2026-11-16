import type { LedgerFilters as Filters } from '../../lib/ledger-csv';
import { CHANNEL_LABELS, KIND_LABELS, USAGE_CHANNELS, validateRange } from '../../lib/usage';
import { Field } from '../field';
import { SelectField } from '../select-field';

export interface LedgerFiltersProps {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
}

const KINDS = ['credit', 'adjust', 'reserve', 'capture', 'release'] as const;

/** From and To dates, plus Channel and Kind. The page keeps all four in the URL search. */
export function LedgerFilters({ filters, onChange }: LedgerFiltersProps) {
  const rangeError = validateRange(filters.from, filters.to);
  return (
    <form
      aria-label="Ledger filters"
      onSubmit={(event) => event.preventDefault()}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <Field
        id="usage-from"
        label="From"
        type="date"
        value={filters.from}
        onChange={(event) => onChange({ from: event.target.value })}
        error={rangeError}
      />
      <Field
        id="usage-to"
        label="To"
        type="date"
        value={filters.to}
        onChange={(event) => onChange({ to: event.target.value })}
      />
      <SelectField
        id="usage-channel"
        label="Channel"
        value={filters.channel}
        onChange={(event) => onChange({ channel: event.target.value as Filters['channel'] })}
      >
        <option value="all">All channels</option>
        {USAGE_CHANNELS.map((channel) => (
          <option key={channel} value={channel}>
            {CHANNEL_LABELS[channel]}
          </option>
        ))}
      </SelectField>
      <SelectField
        id="usage-kind"
        label="Kind"
        value={filters.kind}
        onChange={(event) => onChange({ kind: event.target.value as Filters['kind'] })}
      >
        <option value="all">All kinds</option>
        {KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {KIND_LABELS[kind]}
          </option>
        ))}
      </SelectField>
    </form>
  );
}
