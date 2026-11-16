import { Button, Reveal, Skeleton } from '@knoqra/ui';
import { useEffect, useRef } from 'react';
import { formatPhone } from '../../lib/contacts';
import { formatMicros } from '../../lib/money';
import {
  type AvailableNumber,
  type NumberQuote,
  ORDER_FAILED_COPY,
  ORDER_PENDING_COPY,
  orderUnconfirmedCopy,
  PURCHASE_DONE_COPY,
  purchaseFailure,
  purchaseOutcome,
  useCreateQuote,
  useIdempotencyKey,
  usePurchaseNumber,
} from '../../lib/number-purchase';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { FormAlert } from '../form-alert';

export interface BuyNumberDialogProps {
  /** The number to buy. Mount the dialog when one is picked; it makes its quote on mount. */
  number: AvailableNumber;
  /** Closes the dialog. `bought` is true when the purchase went through. */
  onClose: (bought: boolean) => void;
  /** Called instead of a plain close when the quote or order is gone and a new search is needed. */
  onSearchAgain: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
}

const row = 'flex items-baseline justify-between gap-4 text-[14px]';

function expiryTime(quote: NumberQuote): string {
  return new Date(quote.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function QuoteSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton lines={3} widths={[100, 100, 100]} label="Loading the price" />
      <Skeleton lines={2} widths={[90, 60]} label="Loading the charge note" />
    </div>
  );
}

function Breakdown({ quote }: { quote: NumberQuote }) {
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2 rounded-[18px] bg-[color:var(--cell)] p-4">
        <div className={row}>
          <dt className="text-[color:var(--muted)]">One-time</dt>
          <dd className="font-[family-name:var(--font-mono)]">
            {formatMicros(quote.upfrontMicros)}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-[color:var(--muted)]">First month</dt>
          <dd className="font-[family-name:var(--font-mono)]">
            {formatMicros(quote.monthlyMicros)}
          </dd>
        </div>
        <div className={`${row} border-[color:var(--panelBorder)] border-t pt-2 font-semibold`}>
          <dt>Total charged now</dt>
          <dd className="font-[family-name:var(--font-mono)]">{formatMicros(quote.totalMicros)}</dd>
        </div>
      </dl>
      <p className="text-[13px] text-[color:var(--muted)] leading-snug">
        Charged to your KNOQRA wallet now. Your phone provider bills you the same amount.
      </p>
      <p className="text-[12px] text-[color:var(--muted)]">
        {`This price is held until ${expiryTime(quote)}.`}
      </p>
    </div>
  );
}

/** Confirm and buy one number: a fresh quote, the cost breakdown, then one idempotent purchase. */
export function BuyNumberDialog({
  number,
  onClose,
  onSearchAgain,
  returnFocus,
}: BuyNumberDialogProps) {
  const quote = useCreateQuote();
  const purchase = usePurchaseNumber();
  const idempotencyKey = useIdempotencyKey();
  const started = useRef(false);
  // Two clicks in one tick both see `isPending` false; the ref makes the second one a no-op.
  const inFlight = useRef(false);
  const { mutate: createQuote } = quote;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createQuote(number.e164);
  }, [createQuote, number.e164]);

  const outcome = purchase.data ? purchaseOutcome(purchase.data) : null;
  const bought = outcome === 'done' || outcome === 'pending' || outcome === 'unconfirmed';
  const failure = quote.isError
    ? purchaseFailure(quote.error)
    : purchase.isError
      ? purchaseFailure(purchase.error)
      : null;
  const mustSearchAgain = outcome === 'failed' || failure?.searchAgain === true;

  const buy = () => {
    if (!quote.data || purchase.isPending || inFlight.current) return;
    inFlight.current = true;
    purchase.mutate(
      { quoteId: quote.data.id, idempotencyKey },
      {
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (open || purchase.isPending) return;
        onClose(bought);
      }}
      title="Buy this number"
      size="sm"
      returnFocus={returnFocus}
      description={
        <span className="font-[family-name:var(--font-mono)] font-medium text-[color:var(--text)]">
          {formatPhone(number.e164)}
        </span>
      }
    >
      <div className="flex flex-col gap-4">
        {bought ? (
          <p role="status" className="text-[14px] leading-relaxed">
            {outcome === 'done'
              ? PURCHASE_DONE_COPY
              : outcome === 'unconfirmed' && purchase.data
                ? orderUnconfirmedCopy(purchase.data.order)
                : ORDER_PENDING_COPY}
          </p>
        ) : (
          <Reveal loading={quote.isPending || quote.isIdle}>
            {quote.data ? <Breakdown quote={quote.data} /> : <QuoteSkeleton />}
          </Reveal>
        )}
        {outcome === 'failed' ? <FormAlert message={ORDER_FAILED_COPY} /> : null}
        {failure ? <FormAlert message={failure.message} /> : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {bought ? (
            <Button variant="primary" onClick={() => onClose(true)}>
              Done
            </Button>
          ) : mustSearchAgain ? (
            <>
              <DialogCancel />
              <Button variant="primary" onClick={onSearchAgain}>
                Search again
              </Button>
            </>
          ) : quote.isError ? (
            <>
              <DialogCancel />
              <Button
                variant="primary"
                onClick={() => quote.mutate(number.e164)}
                disabled={quote.isPending}
              >
                Try again
              </Button>
            </>
          ) : (
            <>
              <DialogCancel />
              <Button
                variant="primary"
                onClick={buy}
                disabled={!quote.data || purchase.isPending}
                aria-busy={purchase.isPending}
              >
                {purchase.isPending
                  ? 'Buying…'
                  : quote.data
                    ? `Buy for ${formatMicros(quote.data.totalMicros)}`
                    : 'Buy'}
              </Button>
            </>
          )}
        </div>
      </div>
    </DialogShell>
  );
}
