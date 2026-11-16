import { Button, Reveal, Skeleton } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { formatPhone } from '../../lib/contacts';
import { formatMicros } from '../../lib/money';
import {
  type AvailableNumber,
  DEFAULT_SEARCH,
  type NumberFeature,
  type NumberSearchInput,
  US_STATES,
  useAvailableNumbers,
} from '../../lib/number-purchase';
import { loadFailed } from '../../lib/query-state';
import { CheckboxField } from '../checkbox-field';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { SelectField } from '../select-field';
import { BuyNumberDialog } from './buy-number-dialog';

const chip =
  'inline-flex h-7 items-center whitespace-nowrap rounded-[14px] bg-[color:var(--pill)] px-[10px] font-[family-name:var(--font-mono)] font-medium text-[11px] leading-none';

const FEATURES: { key: NumberFeature; label: string }[] = [
  { key: 'voice', label: 'Voice' },
  { key: 'sms', label: 'SMS' },
  { key: 'mms', label: 'MMS' },
];

function capabilityLabels(item: AvailableNumber): string[] {
  return FEATURES.filter((feature) => item.capabilities[feature.key]).map(
    (feature) => feature.label,
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {['one', 'two', 'three', 'four'].map((id) => (
        <div
          key={id}
          className="flex h-[64px] items-center justify-between gap-3 rounded-[18px] bg-[color:var(--cell)] px-4"
        >
          <Skeleton lines={1} widths={[60]} label="Loading number" className="w-40" />
          <Skeleton height={28} width={130} label="Loading capabilities" />
          <Skeleton lines={1} widths={[70]} label="Loading price" className="w-40" />
          <Skeleton height={40} width={72} label="Loading buy button" />
        </div>
      ))}
    </div>
  );
}

function SearchError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'voice_not_configured') {
    return (
      <p role="alert" className="text-[14px] text-[color:var(--danger-text)] leading-snug">
        Connect your phone provider before buying a number.{' '}
        <Link
          to="/setup"
          search={{ step: 'connect' }}
          className="text-[color:var(--text)] underline underline-offset-4"
        >
          Go to setup
        </Link>
      </p>
    );
  }
  if (error instanceof ApiError && error.code === 'forbidden') {
    return <FormAlert message="Only the workspace owner can buy numbers." />;
  }
  if (error instanceof ApiError && error.code === 'provider_unavailable') {
    return <FormAlert message="Your phone provider did not answer. Try again in a minute." />;
  }
  return <FormAlert message="Could not search for numbers. Try again in a moment." />;
}

/** What the polite live region reads out; errors have their own alert. */
function resultsAnnouncement(state: {
  ready: boolean;
  loading: boolean;
  failed: boolean;
  items: readonly AvailableNumber[];
}): string {
  if (!state.ready || state.failed) return '';
  if (state.loading) return 'Searching…';
  if (state.items.length === 0) return 'No numbers match';
  return state.items.length === 1 ? '1 number found' : `${state.items.length} numbers found`;
}

interface Picked {
  number: AvailableNumber;
  trigger: HTMLElement | null;
}

export interface NumberSearchProps {
  /** Called once after a number was bought and the confirm dialog was closed. */
  onBought: () => void;
  /** Prefix for the field ids, so two searches on one page never share them. */
  idPrefix?: string;
  /** Where focus goes when the confirm dialog closes and the Buy button that opened it is gone. */
  fallbackFocusId?: string;
}

/** Search the numbers for sale (area code, state, capabilities) and open the buy dialog on one. */
export function NumberSearch({ onBought, idPrefix = 'buy', fallbackFocusId }: NumberSearchProps) {
  const [search, setSearch] = useState<NumberSearchInput>(DEFAULT_SEARCH);
  const [picked, setPicked] = useState<Picked | null>(null);
  const areaCodeRef = useRef<HTMLDivElement>(null);
  const searchAgain = useRef(false);
  // True from "Search again" until its refetch settles, so the old results don't look current.
  const [refetching, setRefetching] = useState(false);
  const { query, ready, settling } = useAvailableNumbers(search);
  const areaCodeInvalid = /^\d{3}$/.test(search.areaCode) && !/^[2-9]/.test(search.areaCode);
  const loading = ready && (settling || query.isFetching) && (!query.data || refetching);
  const items = query.data ?? [];
  // A failed refetch keeps the results it has; only a search that returned nothing shows the error.
  const failed = loadFailed(query);
  const announcement = resultsAnnouncement({ ready, loading, failed, items });

  const toggle = (key: NumberFeature) =>
    setSearch((current) => ({
      ...current,
      features: { ...current.features, [key]: !current.features[key] },
    }));

  /** After the dialog closes: a new search starts in the area code, else back to the Buy button. */
  const returnFocus = (trigger: HTMLElement | null) => {
    if (searchAgain.current) {
      searchAgain.current = false;
      return areaCodeRef.current?.querySelector('input');
    }
    if (trigger?.isConnected) return trigger;
    return fallbackFocusId ? document.getElementById(fallbackFocusId) : null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div ref={areaCodeRef}>
          <Field
            id={`${idPrefix}-area-code`}
            label="Area code"
            inputMode="numeric"
            autoComplete="off"
            maxLength={3}
            placeholder="202"
            value={search.areaCode}
            error={areaCodeInvalid ? 'Area codes start with 2 to 9.' : null}
            onChange={(event) =>
              setSearch((current) => ({
                ...current,
                areaCode: event.target.value.replace(/\D/g, '').slice(0, 3),
              }))
            }
          />
        </div>
        <SelectField
          id={`${idPrefix}-state`}
          label="State"
          value={search.region}
          onChange={(event) => setSearch((current) => ({ ...current, region: event.target.value }))}
        >
          <option value="">Any state</option>
          {US_STATES.map((state) => (
            <option key={state.code} value={state.code}>
              {state.name}
            </option>
          ))}
        </SelectField>
      </div>
      <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
        <legend className="mb-2 font-medium text-[13px]">Capabilities</legend>
        {FEATURES.map((feature) => (
          <CheckboxField
            key={feature.key}
            id={`${idPrefix}-feature-${feature.key}`}
            label={feature.label}
            checked={search.features[feature.key]}
            onChange={() => toggle(feature.key)}
          />
        ))}
      </fieldset>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {failed ? <SearchError error={query.error} /> : null}
      {!ready ? (
        <p className="text-[14px] text-[color:var(--muted)] leading-relaxed">
          Enter a 3-digit area code or choose a state to see numbers for sale.
        </p>
      ) : (
        <Reveal loading={loading}>
          {loading ? (
            <ResultsSkeleton />
          ) : failed ? null : items.length === 0 ? (
            <p className="text-[14px] text-[color:var(--muted)] leading-relaxed">
              No numbers match. Try another area code.
            </p>
          ) : (
            <ul aria-label="Available numbers" className="flex flex-col gap-2">
              {items.map((item) => (
                <li
                  key={item.e164}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[18px] bg-[color:var(--cell)] px-4 py-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-[family-name:var(--font-mono)] font-medium text-[14px]">
                      {formatPhone(item.e164)}
                    </span>
                    <span className="text-[12px] text-[color:var(--muted)]">
                      {[item.locality, item.region].filter(Boolean).join(', ') || 'United States'}
                    </span>
                  </div>
                  <span className="flex flex-wrap gap-[6px]">
                    {capabilityLabels(item).map((label) => (
                      <span key={label} className={chip}>
                        {label}
                      </span>
                    ))}
                  </span>
                  <span className="text-[13px] text-[color:var(--muted)]">
                    {`${formatMicros(item.upfrontMicros)} one-time · ${formatMicros(item.monthlyMicros)}/month`}
                  </span>
                  <Button
                    variant="primary"
                    aria-label={`Buy ${formatPhone(item.e164)}`}
                    onClick={(event) => setPicked({ number: item, trigger: event.currentTarget })}
                  >
                    Buy
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Reveal>
      )}
      {picked ? (
        <BuyNumberDialog
          key={picked.number.e164}
          number={picked.number}
          returnFocus={() => returnFocus(picked.trigger)}
          onClose={(bought) => {
            setPicked(null);
            if (bought) onBought();
          }}
          onSearchAgain={() => {
            searchAgain.current = true;
            setPicked(null);
            setRefetching(true);
            void query.refetch().finally(() => setRefetching(false));
          }}
        />
      ) : null}
    </div>
  );
}
