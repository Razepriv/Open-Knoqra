/** How long a dialed call may stay pre-connect after its leg was hung up before we cancel it. */
export const HANGUP_FALLBACK_MS = 10_000;

const PRE_CONNECT = new Set(['queued', 'initiating', 'ringing']);

/** True while nobody has answered yet. */
export function isPreConnect(state: string): boolean {
  return PRE_CONNECT.has(state);
}

/** The pieces a hangup needs, injected by the call session (and by tests). */
export interface HangupSteps {
  callId: string;
  /** True for a call the voice client never dialed (the abandoned path): only `/cancel` ends it. */
  neverDialed: boolean;
  /** Ends the provider leg; the provider's hangup event then settles the call. */
  endLeg(callId: string): Promise<void>;
  /** `POST /calls/{id}/cancel`. */
  cancel(callId: string): Promise<unknown>;
  /** The call's latest known state (the cache, kept fresh by realtime or the fallback poll). */
  stateOf(callId: string): string | undefined;
  /** Shows a failure as a session error. */
  report(error: unknown): void;
  /** Runs `fn` after `ms` (the session clears it on unmount). */
  later(fn: () => void, ms: number): void;
}

const isInvalidState = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'invalid_state';

/**
 * Hangs up a call (R30). A dialed call ends through the provider leg first, so the provider's
 * hangup event settles and bills it; `/cancel` only follows when the call is still pre-connect,
 * either right after the leg hangup failed or 10 seconds later. A call that never reached the
 * provider is canceled directly, and a failure to do so rejects. Anything stuck longer is ended
 * by the server's stale-call sweep.
 */
export async function hangupCall(steps: HangupSteps): Promise<void> {
  const { callId } = steps;
  if (steps.neverDialed) {
    await steps.cancel(callId);
    return;
  }
  const cancelIfPreConnect = async (): Promise<void> => {
    const state = steps.stateOf(callId);
    if (state === undefined || !isPreConnect(state)) return;
    try {
      await steps.cancel(callId);
    } catch (error) {
      // It connected or ended meanwhile: the provider settles it.
      if (!isInvalidState(error)) steps.report(error);
    }
  };
  try {
    await steps.endLeg(callId);
  } catch (error) {
    steps.report(error);
    await cancelIfPreConnect();
    return;
  }
  steps.later(() => void cancelIfPreConnect(), HANGUP_FALLBACK_MS);
}
