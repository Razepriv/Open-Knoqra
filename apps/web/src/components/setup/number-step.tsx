import { Button } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { RefreshCw, ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { ApiError, useMe } from '../../lib/api';
import { formatPhone } from '../../lib/contacts';
import { canBuyNumbers } from '../../lib/number-purchase';
import {
  activeCapabilities,
  type PhoneNumber,
  useAssignNumber,
  useNumbers,
  useSyncNumbers,
} from '../../lib/numbers';
import { focusRing } from '../../lib/ui-classes';
import { FormAlert } from '../form-alert';
import { NumberSearch } from '../numbers/number-search';
import { NumberStepSkeleton } from './setup-skeletons';

const USE_LABELS: Record<PhoneNumber['assignedUse'], string> = {
  unassigned: 'Not in use',
  calls: 'Used for calls',
  messages: 'Used for messages',
  calls_and_messages: 'Used for calls and messages',
};

const chip =
  'inline-flex h-7 items-center whitespace-nowrap rounded-[14px] bg-[color:var(--cell)] px-[10px] font-[family-name:var(--font-mono)] font-medium text-[11px] leading-none';

function SyncError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.code === 'voice_not_configured') {
    return (
      <p role="alert" className="text-[14px] text-[color:var(--danger-text)] leading-snug">
        Connect Telnyx before syncing numbers.{' '}
        <Link
          to="/setup"
          search={{ step: 'connect' }}
          className="text-[color:var(--text)] underline underline-offset-4"
        >
          Go to Connect Telnyx
        </Link>
      </p>
    );
  }
  const message =
    error instanceof ApiError
      ? error.message
      : 'Could not sync your numbers from your phone provider.';
  return <FormAlert message={message} />;
}

/** Step 2: sync the account's numbers from Telnyx and pick the one used for calls and messages. */
export function NumberStep({ onDone }: { onDone: () => void }) {
  const numbers = useNumbers();
  const sync = useSyncNumbers();
  const assign = useAssignNumber();
  const me = useMe();
  const [picked, setPicked] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);

  if (numbers.isPending || me.isPending) return <NumberStepSkeleton />;
  // A failed refetch keeps the list; only a first load with nothing to show is an error.
  if (numbers.data === undefined) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert message="We could not load your numbers." />
        <Button variant="ghost" onClick={() => void numbers.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const items = numbers.data;
  const canBuy = canBuyNumbers(me.data?.organization.role);
  const assigned = items.find((item) => item.assignedUse === 'calls_and_messages') ?? null;
  const selected = picked ?? assigned?.id ?? null;
  const dirty = selected !== null && selected !== assigned?.id;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          onClick={() => sync.mutate()}
          aria-busy={sync.isPending}
          disabled={sync.isPending}
        >
          <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
          {sync.isPending ? 'Syncing…' : 'Sync numbers'}
        </Button>
        {canBuy ? (
          <Button
            id="get-number-button"
            variant="ghost"
            aria-expanded={buying}
            aria-controls="get-number-panel"
            onClick={() => setBuying((open) => !open)}
          >
            <ShoppingBag size={15} strokeWidth={1.75} aria-hidden="true" />
            Get a number
          </Button>
        ) : (
          <p className="text-[13px] text-[color:var(--muted)]">
            Only the workspace owner can buy numbers.
          </p>
        )}
        {sync.isSuccess ? (
          <p role="status" className="text-[13px] text-[color:var(--muted)]">
            {`Synced ${sync.data.items.length} ${sync.data.items.length === 1 ? 'number' : 'numbers'}.`}
          </p>
        ) : null}
      </div>
      {sync.isError ? <SyncError error={sync.error} /> : null}
      {canBuy && buying ? (
        <div
          id="get-number-panel"
          className="flex flex-col gap-4 rounded-[22px] border border-[color:var(--panelBorder)] p-4"
        >
          <h3 className="font-medium text-[15px]">Get a number</h3>
          <NumberSearch idPrefix="wizard-buy" onBought={onDone} />
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
          No numbers yet. Sync to load the numbers on your account, or get a new one.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium text-[13px]">Your numbers</legend>
          {items.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer flex-wrap items-center gap-3 rounded-[18px] bg-[color:var(--cell)] px-4 py-3"
            >
              <input
                type="radio"
                name="phone-number"
                value={item.id}
                checked={selected === item.id}
                onChange={() => setPicked(item.id)}
                className={`size-[18px] accent-[color:var(--accent)] ${focusRing}`}
              />
              <span className="font-[family-name:var(--font-mono)] font-medium text-[14px]">
                {formatPhone(item.e164)}
              </span>
              <span className="flex flex-wrap gap-[6px]">
                {activeCapabilities(item).map((label) => (
                  <span key={label} className={chip}>
                    {label}
                  </span>
                ))}
              </span>
              {item.assignedUse !== 'unassigned' ? (
                <span className="text-[12px] text-[color:var(--muted)]">
                  {USE_LABELS[item.assignedUse]}
                </span>
              ) : null}
            </label>
          ))}
        </fieldset>
      )}
      {assign.isError ? (
        <FormAlert
          message={
            assign.error instanceof ApiError
              ? assign.error.message
              : 'Could not assign this number.'
          }
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!dirty || assign.isPending}
          aria-busy={assign.isPending}
          onClick={() => {
            if (selected) {
              assign.mutate(
                { id: selected, assignedUse: 'calls_and_messages' },
                { onSuccess: onDone },
              );
            }
          }}
        >
          {assign.isPending ? 'Saving…' : 'Use for calls and messages'}
        </Button>
        {assigned && !dirty ? (
          <Button variant="ghost" onClick={onDone}>
            Continue
          </Button>
        ) : null}
      </div>
    </div>
  );
}
