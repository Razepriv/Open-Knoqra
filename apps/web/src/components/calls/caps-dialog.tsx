import { Button } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';
import { formatMicros } from '../../lib/money';
import { useAddCredit, useUpdateCaps, type WalletSummary } from '../../lib/wallet';
import { validateCaps, validateCredit } from '../../lib/wallet-form';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { Field } from '../field';
import { FormAlert } from '../form-alert';

const NOTE_MAX = 200;
const MONEY_HINT = 'In dollars, like 10 or 2.50. Leave blank for no cap.';

/** A cap as the text a person would type: `16.00`, `0.05`, or blank for off. */
const capText = (micros: number | null): string =>
  micros === null ? '' : formatMicros(micros).replace('$', '');

function saveError(error: unknown, forbidden: string): string {
  if (error instanceof ApiError && error.status === 403) return forbidden;
  if (error instanceof ApiError && error.code === 'validation_error') {
    return 'Those amounts were not accepted. Check them and try again.';
  }
  return 'We could not save that. Try again in a moment.';
}

/** Changing money changes what the dialer may do: ask the pre-call check again. */
function useRefreshPreflight(): () => void {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['calls', 'preflight'] });
}

/** Edits this month's WARN and STOP caps, in dollars; a blank field turns that cap off. */
export function CapsDialog({ summary, onClose }: { summary: WalletSummary; onClose: () => void }) {
  const update = useUpdateCaps();
  const refreshPreflight = useRefreshPreflight();
  const [warn, setWarn] = useState(() => capText(summary.warnCapMicros));
  const [stop, setStop] = useState(() => capText(summary.stopCapMicros));
  const [errors, setErrors] = useState<{ warn?: string; stop?: string }>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const check = validateCaps(warn, stop);
    if (!check.ok) {
      setErrors({ warn: check.warnError, stop: check.stopError });
      return;
    }
    setErrors({});
    update.mutate(check.value, {
      onSuccess: () => {
        refreshPreflight();
        onClose();
      },
    });
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Spend caps"
      description="Limits on this workspace's call spend for the calendar month (UTC). At WARN the dialer warns; at STOP new calls are paused."
      initialFocusId="caps-warn"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field
          id="caps-warn"
          label="WARN at"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Off"
          value={warn}
          onChange={(event) => setWarn(event.target.value)}
          hint={MONEY_HINT}
          error={errors.warn}
        />
        <Field
          id="caps-stop"
          label="STOP at"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Off"
          value={stop}
          onChange={(event) => setStop(event.target.value)}
          hint={MONEY_HINT}
          error={errors.stop}
        />
        <FormAlert
          message={
            update.isError
              ? saveError(update.error, 'Only owners and admins can change the caps.')
              : null
          }
        />
        <div className="flex justify-end gap-2">
          <DialogCancel />
          <Button
            type="submit"
            variant="primary"
            disabled={update.isPending}
            aria-busy={update.isPending}
          >
            Save caps
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Records credit added to the workspace's calling balance, with a note for the ledger. */
export function CreditDialog({ onClose }: { onClose: () => void }) {
  const add = useAddCredit();
  const refreshPreflight = useRefreshPreflight();
  // One key per dialog: a retry after a dropped response cannot add the credit twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; note?: string }>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const check = validateCredit(amount, note);
    if (!check.ok) {
      setErrors({ amount: check.amountError, note: check.noteError });
      return;
    }
    setErrors({});
    add.mutate(
      { ...check.value, idempotencyKey },
      {
        onSuccess: () => {
          refreshPreflight();
          onClose();
        },
      },
    );
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add credit"
      description="Adds to the balance calls hold against. It is recorded in the ledger with your note."
      initialFocusId="credit-amount"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field
          id="credit-amount"
          label="Amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="5.00"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint="In dollars, up to $1,000 at a time."
          error={errors.amount}
        />
        <Field
          id="credit-note"
          label="Note"
          autoComplete="off"
          maxLength={NOTE_MAX}
          placeholder="Where this credit came from"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          error={errors.note}
        />
        <FormAlert
          message={
            add.isError ? saveError(add.error, 'Only owners and admins can add credit.') : null
          }
        />
        <div className="flex justify-end gap-2">
          <DialogCancel />
          <Button
            type="submit"
            variant="primary"
            disabled={add.isPending}
            aria-busy={add.isPending}
          >
            Add credit
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
