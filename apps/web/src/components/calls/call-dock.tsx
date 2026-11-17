import { Avatar, Pill } from '@knoqra/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { ArrowUpRight, Mic, MicOff, PhoneOff } from 'lucide-react';
import { gradientFor } from '../../lib/contacts';
import { callStateDot, callStateLine, isLiveState } from '../../lib/dial';
import { focusRing, textPill } from '../../lib/ui-classes';
import { useCallSession } from './call-session';
import { CallDockSkeleton } from './call-skeletons';
import { CutOffWarning } from './cut-off-notice';
import { CallTimer, callName, remoteNumber } from './live-call-panel';

const CALLS_PATH = '/calls';

/**
 * A bar fixed to the bottom of every desk page except Calls while a call is in progress: who,
 * state, timer, Mute, Hang up, and a link back to the Calls page, with the cut-off warning above
 * them when the wallet or the spend cap cannot pay for more minutes.
 */
export function CallDock() {
  const session = useCallSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const call = session.current;
  if (pathname === CALLS_PATH) return null;
  if (!call) return session.loadingCurrent ? <CallDockSkeleton /> : null;
  // Gone as soon as the line ends here, not a few seconds later when the server confirms it.
  if (!isLiveState(call.state) || session.lineEndedAt !== null) return null;
  const name = callName(call);
  const muted = session.mute.muted;
  return (
    <>
      {/* Keeps the end of the page clear of the fixed bar. */}
      <div aria-hidden="true" className="h-[88px] shrink-0" />
      <section
        aria-label="Call in progress"
        className="fixed bottom-24 left-1/2 z-40 flex w-[min(720px,calc(100vw-24px))] -translate-x-1/2 flex-col gap-2 rounded-[26px] border border-[color:var(--panelBorder)] bg-[color:var(--shell)] py-2 pr-2 pl-3 text-[color:var(--text)] [box-shadow:var(--panelShadow)] lg:bottom-10"
      >
        <CutOffWarning call={call} compact />
        <div className="flex items-center gap-3">
          <Avatar
            name={name}
            gradient={gradientFor(call.contact?.id ?? remoteNumber(call))}
            size={36}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate font-semibold text-[14px] leading-none">{name}</span>
            <span className="flex items-center gap-2 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
              <span
                aria-hidden="true"
                className="size-[6px] rounded-full"
                style={{ background: `var(--dot-${callStateDot(call.state)})` }}
              />
              <span>{callStateLine(call.state, call.direction)}</span>
              <span aria-hidden="true">·</span>
              <CallTimer call={call} className="[font-variant-numeric:tabular-nums]" />
            </span>
          </div>
          <Pill pressed={muted} aria-label="Mute" onClick={session.mute.toggle}>
            {muted ? (
              <MicOff size={15} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Mic size={15} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span aria-hidden="true" className="hidden sm:inline">
              {muted ? 'Muted' : 'Mute'}
            </span>
          </Pill>
          <Link to={CALLS_PATH} className={textPill}>
            Open
            <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </Link>
          <button
            type="button"
            aria-label="Hang up"
            onClick={() => void session.hangup()}
            className={`inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-full px-3 font-semibold text-[13px] text-[color:var(--on-accent)] leading-none [background:var(--grad-red)] ${focusRing}`}
          >
            <PhoneOff size={15} strokeWidth={1.75} aria-hidden="true" />
            <span aria-hidden="true" className="hidden sm:inline">
              Hang up
            </span>
          </button>
        </div>
      </section>
    </>
  );
}
