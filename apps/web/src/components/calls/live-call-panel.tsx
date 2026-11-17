import { Avatar, Button, Panel } from '@knoqra/ui';
import { Grid3x3, Mic, MicOff, PhoneOff } from 'lucide-react';
import { type CSSProperties, useState } from 'react';
import { deskSlot } from '../../extensions';
import { type Call, formatDuration, outcomeLabel } from '../../lib/calls';
import { formatPhone, gradientFor } from '../../lib/contacts';
import { callStateDot, callStateLine, elapsedSeconds, isLiveState } from '../../lib/dial';
import { focusRing } from '../../lib/ui-classes';
import { useNow } from '../../lib/use-now';
import { useCallSession } from './call-session';
import { Keypad } from './keypad';

const mono = 'font-[family-name:var(--font-mono)] font-medium';

/** The far side of a call: who we dialed, or who rang us. */
export function remoteNumber(call: Call): string {
  return call.direction === 'inbound' ? call.fromE164 : call.toE164;
}

export function callName(call: Call): string {
  return call.contact?.displayName ?? formatPhone(remoteNumber(call));
}

/** A dark panel in both themes: the design's live call surface, tinted with the accent. */
const liveSurface: CSSProperties = {
  background:
    'radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, var(--accent) 16%, var(--shell)) 0%, var(--shell) 55%)',
};

/**
 * Seconds talked, ticking once a second while connected. `stoppedAt` (ms) freezes it at the moment
 * the line ended here, until the server's own end time arrives.
 */
export function CallTimer({
  call,
  className,
  stoppedAt = null,
}: {
  call: Call;
  className?: string;
  stoppedAt?: number | null;
}) {
  const now = useNow(1000);
  const at = stoppedAt !== null && call.endedAt === null ? new Date(stoppedAt) : now;
  return (
    <span role="timer" aria-label="Call duration" className={className}>
      {formatDuration(elapsedSeconds(call, at))}
    </span>
  );
}

/**
 * When the browser's line for this call ended before the server confirmed it, in ms; null when
 * the call is still up here, or the server already has its end.
 */
export function useLineEndedAt(call: Call): number | null {
  const session = useCallSession();
  if (session.current?.id !== call.id || !isLiveState(call.state)) return null;
  return session.lineEndedAt;
}

const roundButton = `flex size-[62px] cursor-pointer items-center justify-center rounded-full border border-[color:var(--pillBorder)] ${focusRing}`;

/**
 * The middle panel during a call: who, the state line (a polite live region), a mono timer from
 * `answeredAt`, and Mute, Keypad (DTMF) and Hang up. Once the call ends it shows how it ended.
 */
export function LiveCallPanel({ call }: { call: Call }) {
  const session = useCallSession();
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [digits, setDigits] = useState('');
  const endedHere = useLineEndedAt(call);
  const live = isLiveState(call.state) && endedHere === null;
  const name = callName(call);
  const muted = session.mute.muted;
  const LiveCallAudio = deskSlot('LiveCallAudio');

  const press = (key: string) => {
    setDigits((now) => `${now}${key}`.slice(-24));
    session.sendDigits(key);
  };

  return (
    <section
      aria-label="Live call"
      data-theme="dark"
      style={liveSurface}
      className="flex min-h-0 flex-1 flex-col items-center gap-[10px] rounded-[30px] border border-[color:var(--panelBorder)] p-[22px] text-center text-[color:var(--text)] [box-shadow:var(--panelShadow)]"
    >
      <span
        className={`${mono} flex h-[30px] items-center gap-2 rounded-[15px] bg-[color:var(--pill)] px-3 text-[11px] uppercase leading-none tracking-[.04em]`}
      >
        <span
          aria-hidden="true"
          className="size-[7px] rounded-full"
          style={{ background: `var(--dot-${callStateDot(call.state)})` }}
        />
        {call.direction === 'inbound' ? 'Inbound call' : 'Outbound call'}
      </span>
      <Avatar
        name={name}
        gradient={gradientFor(call.contact?.id ?? remoteNumber(call))}
        size={84}
        className="mt-[6px] [box-shadow:var(--shadow-avatar)]"
      />
      <h2 className="font-[family-name:var(--font-display)] font-medium text-[27px] leading-[1.05] tracking-[-0.02em]">
        {name}
      </h2>
      <span className={`${mono} text-[12px] text-[color:var(--muted)] leading-none`}>
        {formatPhone(remoteNumber(call))}
      </span>
      <CallTimer
        call={call}
        stoppedAt={endedHere}
        className="mt-[6px] mb-[2px] font-[family-name:var(--font-mono)] text-[60px] text-[color:var(--accent)] leading-none tracking-[-0.03em] [font-variant-numeric:tabular-nums]"
      />
      {live && LiveCallAudio ? <LiveCallAudio call={call} /> : null}
      <p role="status" aria-live="polite" className="font-medium text-[15px] leading-[1.3]">
        {endedHere === null ? callStateLine(call.state, call.direction) : 'Call ended'}
      </p>
      {live ? (
        <>
          <div className="mt-1 flex justify-center gap-[14px]">
            <button
              type="button"
              aria-label="Mute"
              aria-pressed={muted}
              title={muted ? 'Unmute' : 'Mute'}
              onClick={session.mute.toggle}
              className={`${roundButton} ${
                muted
                  ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                  : 'bg-[color:var(--pill)] text-[color:var(--text)]'
              }`}
            >
              {muted ? (
                <MicOff size={22} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Mic size={22} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              aria-label="Keypad"
              aria-expanded={keypadOpen}
              aria-controls="dtmf-keypad"
              title="Keypad"
              onClick={() => setKeypadOpen((open) => !open)}
              className={`${roundButton} ${
                keypadOpen
                  ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
                  : 'bg-[color:var(--pill)]'
              } text-[color:var(--text)]`}
            >
              <Grid3x3 size={22} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Hang up"
              title="Hang up"
              onClick={() => void session.hangup()}
              className={`${roundButton} border-transparent text-[color:var(--on-accent)] [background:var(--grad-red)]`}
            >
              <PhoneOff size={22} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          {keypadOpen ? (
            <div id="dtmf-keypad" className="mt-2 flex w-full max-w-[280px] flex-col gap-2">
              <span
                aria-live="polite"
                className={`${mono} min-h-[18px] text-[15px] tracking-[.12em] text-[color:var(--muted)]`}
              >
                {digits}
              </span>
              <Keypad label="Send tones" size="compact" onPress={press} />
            </div>
          ) : null}
        </>
      ) : (
        <EndedActions call={call} />
      )}
    </section>
  );
}

function EndedActions({ call }: { call: Call }) {
  const session = useCallSession();
  // Ended here, but the server has not recorded the end yet: an outcome or Done would be refused
  // for a call it still thinks is live, so wait for it (usually a second or two).
  if (isLiveState(call.state)) {
    return (
      <p
        aria-busy="true"
        className={`${mono} mt-2 text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]`}
      >
        Saving the call…
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
      {call.outcome ? (
        <span
          className={`${mono} inline-flex h-7 items-center rounded-[14px] bg-[color:var(--pill)] px-[10px] text-[11px] leading-none`}
        >
          {`Outcome: ${outcomeLabel(call.outcome)}`}
        </span>
      ) : (
        <Button variant="primary" onClick={() => session.openOutcome(call.id)}>
          Log outcome
        </Button>
      )}
      <Button variant="ghost" onClick={session.dismiss}>
        Done
      </Button>
    </div>
  );
}

/** Shown instead of the live panel when the browser refused the microphone. */
export function MicBlockedPanel() {
  const session = useCallSession();
  return (
    <Panel className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Microphone blocked"
        className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <span className="flex size-14 items-center justify-center rounded-full border border-[color:var(--blocked-border)] [background:var(--blocked-stripe)]">
          <MicOff size={24} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="max-w-[34ch] font-medium text-[16px] leading-snug">
          Microphone blocked. Allow microphone access for this site, then try again.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => void session.retry()}>
            Try again
          </Button>
          <Button variant="ghost" onClick={session.clearError}>
            Dismiss
          </Button>
        </div>
      </section>
    </Panel>
  );
}
