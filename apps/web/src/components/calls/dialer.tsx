import { EMERGENCY_CALL_MESSAGE, isEmergencyNumber } from '@knoqra/core';
import { Avatar, Panel } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { Delete, Phone, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { callErrorMessage, usePreflight } from '../../lib/calls';
import { formatPhone, gradientFor, useContacts } from '../../lib/contacts';
import { dialTarget, isLiveState } from '../../lib/dial';
import { focusRing, iconPill } from '../../lib/ui-classes';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { VoiceError } from '../../lib/voice';
import { useVoiceStatus } from '../../lib/voice-connection';
import { sessionErrorCopy, useCallSession } from './call-session';
import { type DialCheck, DialStateBanner } from './dial-state-banner';
import { Keypad } from './keypad';

export interface DialerProps {
  /** From `/calls?contactId=`: dial this contact. */
  initialContactId?: string | undefined;
  /** From `/calls?to=`: put this number in the field. */
  initialTo?: string | undefined;
}

const eyebrow =
  'font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] uppercase leading-[1.3] tracking-[.04em]';

const SUGGESTION_LIMIT = 4;

/**
 * The lime Call button. Disabled, it drops the accent for a neutral sunk surface in both themes:
 * a faded lime on the dark page still read as pressable.
 */
const callButton = `inline-flex h-14 cursor-pointer items-center justify-center gap-[7px] rounded-[28px] bg-[color:var(--accent)] px-4 font-semibold text-[16px] text-[color:var(--on-accent)] leading-none [box-shadow:var(--pillShadow)] enabled:hover:bg-[color:var(--accent-hover)] disabled:cursor-not-allowed disabled:bg-[color:var(--cell)] disabled:text-[color:var(--muted)] disabled:[box-shadow:var(--cellShadow)] ${focusRing}`;

/**
 * The left panel of the Calls page: a number field (E.164 or a US 10-digit number, or a name to
 * search contacts), the keypad, the pre-call check and the Call button. Enter dials, Escape clears.
 */
export function Dialer({ initialContactId, initialTo }: DialerProps) {
  const session = useCallSession();
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => {
    const target = initialTo ? dialTarget(initialTo) : null;
    return target ? formatPhone(target) : (initialTo ?? '');
  });
  const [contactId, setContactId] = useState(initialContactId);
  const target = dialTarget(text);
  // 911, 112 and other emergency codes are never dialed; say where to call instead.
  const emergency = !contactId && isEmergencyNumber(text);
  const checkKey = `${contactId ?? ''}|${target ?? ''}`;
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const confirmed = confirmedFor === checkKey;

  const preflight = usePreflight(contactId ? { contactId } : target ? { to: target } : {});
  const hasInput = Boolean(contactId || target);
  const data = preflight.data;
  const matches =
    hasInput &&
    data !== undefined &&
    !preflight.isPlaceholderData &&
    (contactId ? data.contact?.id === contactId : data.to === target);

  // A contact from the URL: show its number once the server has told us what it is.
  const preflightTo = matches ? data.to : null;
  useEffect(() => {
    if (contactId && preflightTo) setText((now) => (now === '' ? formatPhone(preflightTo) : now));
  }, [contactId, preflightTo]);

  const voiceStatus = useVoiceStatus();
  const check = dialCheck({
    notSetUp: voiceStatus.data?.provider === 'none',
    statusPending: voiceStatus.isPending,
    hasInput,
    preflight,
    matches,
  });

  const inCall = session.current !== null && isLiveState(session.current.state);
  const decision = check.kind === 'ready' ? check.preflight.decision : null;
  const canCall =
    check.kind === 'ready' &&
    decision !== null &&
    decision.outcome !== 'blocked' &&
    (decision.outcome !== 'needs_review' || confirmed) &&
    check.preflight.spend.outcome !== 'stop' &&
    !session.dialing &&
    !inCall;

  const edit = (next: string) => {
    setText(next);
    setContactId(undefined);
  };
  const reset = () => {
    edit('');
    setConfirmedFor(null);
    field.current?.focus();
  };
  const choose = (id: string, phoneE164: string) => {
    setContactId(id);
    setText(formatPhone(phoneE164));
    field.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canCall) return;
    void session.dial(
      contactId
        ? { contactId, reviewConfirmed: confirmed }
        : { to: target ?? undefined, reviewConfirmed: confirmed },
    );
  };

  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && text !== '') {
      event.preventDefault();
      reset();
    }
  };

  const who = check.kind === 'ready' ? check.preflight.contact : null;
  const showSuggestions = !contactId && !target && !emergency && text.trim().length >= 2;
  const sessionError =
    session.error && !(session.error instanceof VoiceError && session.error.code === 'mic_denied')
      ? session.error
      : null;

  return (
    <Panel className="flex min-h-0 flex-col p-[18px]">
      <section aria-label="Dialer" className="flex min-h-0 flex-col gap-[14px]">
        {/* The page heading: the visible headings below name the panels. */}
        <h1 className="sr-only">Calls</h1>
        <div className="flex items-center gap-[10px]">
          <div className="flex flex-col gap-[5px]">
            <span className={eyebrow}>New call</span>
            <h2 className="font-[family-name:var(--font-display)] text-[22px] leading-none tracking-[-0.02em]">
              Dialer
            </h2>
          </div>
          <span className="flex-1" />
          <RealtimePill status={session.realtime} />
        </div>
        <form onSubmit={submit} className="flex flex-col gap-[14px]" noValidate>
          <div className="flex flex-col gap-[6px] rounded-[22px] bg-[color:var(--cell)] px-4 py-[14px] [box-shadow:var(--cellShadow)]">
            <div className="flex items-center gap-2">
              <label htmlFor="dial-number" className="sr-only">
                Number to call
              </label>
              <input
                id="dial-number"
                ref={field}
                value={text}
                onChange={(event) => edit(event.target.value)}
                onKeyDown={onFieldKey}
                inputMode="tel"
                autoComplete="off"
                spellCheck={false}
                placeholder="Number or name"
                className={`min-h-10 min-w-0 flex-1 rounded-[12px] bg-transparent font-[family-name:var(--font-display)] text-[32px] leading-[1.1] tracking-[-0.02em] outline-none [font-variant-numeric:tabular-nums] placeholder:text-[20px] placeholder:text-[color:var(--muted)] ${focusRing}`}
              />
              <button
                type="button"
                aria-label="Delete digit"
                title="Delete digit"
                disabled={text === ''}
                onClick={() => edit(text.slice(0, -1))}
                className={`${iconPill} size-10 disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <Delete size={17} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <TargetLine contact={who} ready={check.kind === 'ready'} />
          </div>
          {emergency ? (
            <p
              role="alert"
              className="rounded-[18px] bg-[color:var(--cell)] px-4 py-3 text-[13px] text-[color:var(--danger-text)] leading-snug"
            >
              {EMERGENCY_CALL_MESSAGE}
            </p>
          ) : null}
          {showSuggestions ? <Suggestions query={text.trim()} onChoose={choose} /> : null}
          <Keypad label="Keypad" onPress={(key) => edit(text + key)} />
          <button
            type="submit"
            disabled={!canCall}
            aria-busy={session.dialing}
            className={callButton}
          >
            <Phone size={18} strokeWidth={1.75} aria-hidden="true" />
            Call
          </button>
          <DialStateBanner
            check={check}
            confirmed={confirmed}
            onConfirmedChange={(on) => setConfirmedFor(on ? checkKey : null)}
            onReset={reset}
          />
          {inCall ? (
            <p className="text-center text-[13px] text-[color:var(--muted)]">
              A call is in progress. End it to place another.
            </p>
          ) : null}
        </form>
        {sessionError ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-[18px] bg-[color:var(--cell)] px-4 py-3"
          >
            <p className="flex-1 text-[13px] text-[color:var(--danger-text)] leading-snug">
              {sessionErrorCopy(sessionError)}
              {'code' in sessionError && sessionError.code === 'voice_not_configured' ? (
                <>
                  {' '}
                  <Link
                    to="/setup"
                    search={{ step: 'connect' }}
                    className="text-[color:var(--text)] underline underline-offset-4"
                  >
                    Set up calling
                  </Link>
                </>
              ) : null}
            </p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={session.clearError}
              className={`${iconPill} size-8`}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </section>
    </Panel>
  );
}

/**
 * Where the pre-call check stands. Status `none` means no provider can place calls, so the dialer
 * asks to set calling up instead. While the status loads, the check skeleton shows. A status that
 * fails to load does not block: the server refuses the call itself.
 */
function dialCheck({
  notSetUp,
  statusPending,
  hasInput,
  preflight,
  matches,
}: {
  notSetUp: boolean;
  statusPending: boolean;
  hasInput: boolean;
  preflight: ReturnType<typeof usePreflight>;
  matches: boolean;
}): DialCheck {
  if (notSetUp) return { kind: 'setup' };
  // Until the status is known, the shaped skeleton holds the place: no hint that then jumps.
  if (statusPending) return { kind: 'checking' };
  if (!hasInput) return { kind: 'empty' };
  if (preflight.isError && !preflight.data) {
    return {
      kind: 'error',
      message: callErrorMessage(preflight.error),
      retry: () => void preflight.refetch(),
    };
  }
  return matches && preflight.data
    ? { kind: 'ready', preflight: preflight.data }
    : { kind: 'checking' };
}

function TargetLine({
  contact,
  ready,
}: {
  contact: { id: string; displayName: string } | null;
  ready: boolean;
}) {
  if (!ready) return <span className="min-h-[18px]" />;
  return (
    <span className="flex min-h-[18px] items-center gap-2 text-[13px] text-[color:var(--muted)] leading-[1.3]">
      {contact ? (
        <>
          <span className="font-medium text-[color:var(--text)]">{contact.displayName}</span>
          <span aria-hidden="true">·</span>
          <span>In your contacts</span>
        </>
      ) : (
        <span>New number · Not in your contacts</span>
      )}
    </span>
  );
}

function RealtimePill({ status }: { status: 'connecting' | 'open' | 'closed' }) {
  const open = status === 'open';
  return (
    <span className="flex h-[30px] items-center gap-[6px] rounded-[15px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[11px] font-[family-name:var(--font-mono)] font-medium text-[11px] uppercase leading-none [box-shadow:var(--pillShadow)]">
      <span
        aria-hidden="true"
        className="size-[7px] rounded-full"
        style={{ background: open ? 'var(--dot-ok)' : 'var(--dot-warn)' }}
      />
      {open ? 'Live updates' : 'Connecting'}
    </span>
  );
}

/** Contacts whose name or number matches what is typed; choosing one dials that contact. */
function Suggestions({
  query,
  onChoose,
}: {
  query: string;
  onChoose: (id: string, phoneE164: string) => void;
}) {
  const q = useDebouncedValue(query, 200);
  const contacts = useContacts({ q });
  const items = (contacts.data?.pages.flatMap((p) => p.items) ?? []).slice(0, SUGGESTION_LIMIT);
  if (items.length === 0) return null;
  return (
    <ul aria-label="Matching contacts" className="flex flex-col gap-[6px]">
      {items.map((contact) => (
        <li key={contact.id}>
          <button
            type="button"
            onClick={() => onChoose(contact.id, contact.phoneE164)}
            className={`flex w-full cursor-pointer items-center gap-3 rounded-[16px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 py-2 text-left [box-shadow:var(--pillShadow)] ${focusRing}`}
          >
            <Avatar name={contact.displayName} gradient={gradientFor(contact.id)} size={30} />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-semibold text-[14px] leading-none">
                {contact.displayName}
              </span>
              <span className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] leading-none">
                {formatPhone(contact.phoneE164)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
