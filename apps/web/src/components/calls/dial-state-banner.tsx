import { Button } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { Ban, CircleGauge, PhoneOff, Receipt, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { CSSProperties } from 'react';
import { deskSlot } from '../../extensions';
import { type CallPreflight, spendNoteCopy } from '../../lib/calls';
import { blockedReasonCopy } from '../../lib/dial';
import { formatMicros } from '../../lib/money';
import { textPill } from '../../lib/ui-classes';
import { CheckboxField } from '../checkbox-field';
import { DialCheckSkeleton } from './call-skeletons';

/** Where the dialer's pre-call check stands for what is in the number field. */
export type DialCheck =
  | { kind: 'setup' }
  | { kind: 'empty' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string; retry: () => void }
  | { kind: 'ready'; preflight: CallPreflight };

export interface DialStateBannerProps {
  check: DialCheck;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  /** Clears the dialer, for "Choose another number". */
  onReset: () => void;
}

const card = 'flex flex-col gap-2 rounded-[20px] px-4 py-[14px]';
const title = 'flex items-center gap-2 font-semibold text-[15px] leading-[1.3]';
const body = 'text-[13px] leading-[1.45]';
const chip =
  'inline-flex h-7 items-center gap-[5px] whitespace-nowrap rounded-[14px] bg-[color:var(--cell)] px-[10px] font-[family-name:var(--font-mono)] font-medium text-[11px] leading-none';

/** The amber stripe of the design's review state, mixed from the warn dot token. */
const reviewStyle: CSSProperties = {
  background:
    'repeating-linear-gradient(135deg, color-mix(in srgb, var(--dot-warn) 16%, transparent) 0 8px, color-mix(in srgb, var(--dot-warn) 7%, transparent) 8px 16px)',
  border: '1px solid color-mix(in srgb, var(--dot-warn) 45%, transparent)',
};

/**
 * When the workspace has no voice provider, a setup prompt that links to Settings › Voice.
 * Otherwise, what the server says about calling this number now: plain (allowed, with the hold it takes),
 * blocked (red stripe, Call disabled), or needs review (a required checkbox). Spend warnings sit
 * under it. Nothing here decides anything; the dialer reads the same preflight to enable Call.
 */
export function DialStateBanner({
  check,
  confirmed,
  onConfirmedChange,
  onReset,
}: DialStateBannerProps) {
  if (check.kind === 'setup') {
    return (
      <div className={`${card} bg-[color:var(--cell)]`}>
        <p className={`${body} flex items-start gap-2`}>
          <PhoneOff size={16} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
          <span>Calling is not set up. Connect a provider in Settings to place calls.</span>
        </p>
        <Link to="/settings" hash="connectors" className={`${textPill} self-start`}>
          Open connectors
        </Link>
      </div>
    );
  }
  if (check.kind === 'empty') {
    return (
      <p className="text-center text-[13px] text-[color:var(--muted)] leading-snug">
        Type a number or a name, or use the keypad.
      </p>
    );
  }
  if (check.kind === 'checking') {
    return <DialCheckSkeleton />;
  }
  if (check.kind === 'error') {
    return (
      <div role="alert" className={`${card} bg-[color:var(--cell)]`}>
        <span className={body}>{check.message}</span>
        <Button variant="ghost" className="self-start" onClick={check.retry}>
          Try again
        </Button>
      </div>
    );
  }
  const { decision, spend, reserveMicros, contact, rate } = check.preflight;
  // A per-destination price, when the edition prices calls that way (extensions.ts).
  const DialRateNote = deskSlot('DialRateNote');
  return (
    <div className="flex flex-col gap-2">
      {decision?.outcome === 'blocked' ? (
        <div
          role="alert"
          className={`${card} border border-[color:var(--blocked-border)] [background:var(--blocked-stripe)]`}
        >
          <span className={title}>
            <Ban size={17} strokeWidth={1.75} aria-hidden="true" />
            This call is blocked.
          </span>
          <span className={body}>
            {blockedReasonCopy(decision.reason)} Nothing was dialed or charged.
          </span>
          <div className="flex flex-wrap gap-2">
            {contact ? (
              <Link
                to="/contacts/$contactId"
                params={{ contactId: contact.id }}
                className={textPill}
              >
                View permissions
              </Link>
            ) : null}
            <button type="button" onClick={onReset} className={textPill}>
              Choose another number
            </button>
          </div>
        </div>
      ) : null}
      {decision?.outcome === 'needs_review' ? (
        <div className={card} style={reviewStyle}>
          <span className={title}>
            <ShieldAlert size={17} strokeWidth={1.75} aria-hidden="true" />
            Confirm you're authorized before calling.
          </span>
          <span className={body}>
            {contact
              ? 'There is no call consent on file for this contact.'
              : "It isn't in your contacts and has no consent history."}{' '}
            Call only numbers you own or are authorized to call.
          </span>
          <CheckboxField
            id="dial-review"
            label="I'm authorized to call this number"
            required
            checked={confirmed}
            onChange={(event) => onConfirmedChange(event.target.checked)}
          />
        </div>
      ) : null}
      {decision?.outcome === 'allowed' ? (
        <div className="flex flex-wrap justify-center gap-[6px]">
          <span className={chip}>
            <ShieldCheck size={12} strokeWidth={1.75} aria-hidden="true" />
            Consent on file
          </span>
          <span className={chip}>
            <Receipt size={12} strokeWidth={1.75} aria-hidden="true" />
            {`Holds ${formatMicros(reserveMicros)} while the call runs`}
          </span>
        </div>
      ) : null}
      {rate && DialRateNote && decision?.outcome !== 'blocked' ? (
        <DialRateNote rate={rate} />
      ) : null}
      <SpendNote outcome={spend.outcome} reason={spend.reason} />
    </div>
  );
}

function SpendNote({ outcome, reason }: CallPreflight['spend']) {
  const message = spendNoteCopy(outcome, reason);
  if (message === null) return null;
  const stop = outcome === 'stop';
  return (
    <p
      role={stop ? 'alert' : 'status'}
      className={`flex items-center gap-2 rounded-[16px] px-3 py-2 text-[13px] leading-snug ${
        stop
          ? 'border border-[color:var(--blocked-border)] [background:var(--blocked-stripe)]'
          : 'bg-[color:var(--cell)]'
      }`}
    >
      <CircleGauge size={15} strokeWidth={1.75} aria-hidden="true" />
      {message}
    </p>
  );
}
