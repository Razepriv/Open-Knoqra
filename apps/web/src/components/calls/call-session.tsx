import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api, NetworkError, throwIfFailed } from '../../lib/api';
import {
  activeCallKey,
  type Call,
  callErrorMessage,
  callKey,
  useActiveCall,
  useAnswerCall,
  useCall,
  useCancelCall,
  useStartCall,
} from '../../lib/calls';
import { isLiveState } from '../../lib/dial';
import { hangupCall } from '../../lib/hangup';
import type { RealtimeStatus } from '../../lib/realtime';
import {
  type CallAudioStreams,
  createVoiceClient,
  type GetUserMedia,
  NO_CALL_AUDIO,
  type VoiceClient,
  VoiceError,
  type VoiceProvider,
} from '../../lib/voice';
import { onVoiceDisconnected, useVoiceStatus, voiceStatusKey } from '../../lib/voice-connection';

/** The call that failed to start could not be canceled, so it is still held on the server. */
export class ReleaseFailedError extends Error {
  readonly code = 'release_failed';

  constructor(options?: { cause?: unknown }) {
    super('release_failed', options);
    this.name = 'ReleaseFailedError';
  }
}

export type CallSessionError = VoiceError | ApiError | NetworkError | ReleaseFailedError;

const RELEASE_FAILED_COPY = "We couldn't release that call. Hang up to try again.";

/** Copy for a session error: our own line for a failed release, else the shared call copy. */
export function sessionErrorCopy(error: CallSessionError): string {
  return error instanceof ReleaseFailedError ? RELEASE_FAILED_COPY : callErrorMessage(error);
}

export interface DialInput {
  to?: string;
  contactId?: string;
  reviewConfirmed: boolean;
}

export interface CallSessionValue {
  /** The signed-in user's call in progress, from the server (kept fresh by realtime). */
  active: Call | null;
  /** The call this session shows: the one in progress, or the one that just ended. */
  current: Call | null;
  /** True while the call this session shows is known but its details are still loading. */
  loadingCurrent: boolean;
  /**
   * When this browser's leg of `current` ended (our hangup, or the SDK saw the far end hang up),
   * in ms since the epoch; null otherwise. The server's state confirms it a few seconds later
   * through the provider event, so the panel shows the call as ended without waiting for that.
   */
  lineEndedAt: number | null;
  /** True from pressing Call until the voice client has started dialing. */
  dialing: boolean;
  dial(input: DialInput): Promise<void>;
  /** Dials the last number again (after the microphone was allowed, say). */
  retry(): Promise<void>;
  hangup(): Promise<void>;
  /** Resolves to the error when answering failed, or null once the call is answered. */
  answer(callId: string): Promise<CallSessionError | null>;
  mute: { muted: boolean; toggle(): void };
  sendDigits(digits: string): void;
  /**
   * The live call's microphone and far-side audio streams, for level meters. Read it when needed
   * (it is not state): the streams appear a moment after the call connects.
   */
  audioStreams(): CallAudioStreams;
  error: CallSessionError | null;
  clearError(): void;
  /** Forgets a call that has ended, so the Calls page goes back to the dialer and recents. */
  dismiss(): void;
  /** The ended call waiting for an outcome, or null; `closeOutcome` hides the dialog. */
  outcomeCall: Call | null;
  /** Opens the outcome dialog for an ended call (one that was skipped, say). */
  openOutcome(callId: string): void;
  closeOutcome(): void;
  realtime: RealtimeStatus;
}

const CallSessionContext = createContext<CallSessionValue | null>(null);

/** Re-mint the voice token when it has less than this left. */
const TOKEN_MARGIN_MS = 60_000;
/** While the realtime socket is down, poll the call in progress this often. */
const FALLBACK_POLL_MS = 3_000;
/** Once the line has ended here, poll the server this often until it confirms the end. */
const ENDING_POLL_MS = 1_000;
/** ...for at most this many polls; realtime (or the fallback poll) carries on after that. */
const ENDING_POLL_LIMIT = 20;
/** With a real provider, check the always-on line this often (re-minting near token expiry). */
const LINE_REFRESH_MS = 10 * 60_000;

interface HeldClient {
  client: VoiceClient;
  provider: VoiceProvider;
  expiresAt: number;
  /**
   * Telnyx was disconnected (or the provider changed) while a call was live: the line stays up for
   * that call, is never reused, and is dropped once the call ends.
   */
  retired: boolean;
}

function browserGetUserMedia(): GetUserMedia | undefined {
  const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!devices?.getUserMedia) return undefined;
  return devices.getUserMedia.bind(devices) as unknown as GetUserMedia;
}

function toSessionError(error: unknown): CallSessionError {
  if (error instanceof VoiceError || error instanceof ApiError || error instanceof NetworkError) {
    return error;
  }
  return new ApiError(0, 'Unexpected error', 'internal_error');
}

/** The server refused because no voice provider applies (Telnyx was disconnected elsewhere, say). */
const isNotConfigured = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'voice_not_configured';

const isIncomingRinging = (call: Call | null | undefined): boolean =>
  call?.direction === 'inbound' && call.state === 'ringing';

/**
 * Owns the browser phone line for the signed-in desk: the voice client (minted from
 * `POST /voice/token` on first use and re-minted near expiry), the call this session shows, mute,
 * and which ended call still waits for an outcome. Mounted once in the `_app` layout.
 *
 * Disconnecting Telnyx, or a voice status that names another provider, drops the client and its
 * token, so the next call mints a fresh one. A call in progress keeps its line until it ends.
 */
export function CallSessionProvider({
  realtimeStatus,
  children,
}: {
  realtimeStatus: RealtimeStatus;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const activeQuery = useActiveCall();
  const statusProvider = useVoiceStatus().data?.provider;
  // mutateAsync is stable, so the callbacks below (and the context value) stay stable too.
  const { mutateAsync: startCall } = useStartCall();
  const { mutateAsync: cancelCall } = useCancelCall();
  const { mutateAsync: answerCall } = useAnswerCall();

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [dialing, setDialing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<CallSessionError | null>(null);
  const [outcomeId, setOutcomeId] = useState<string | null>(null);
  const [lineEnded, setLineEnded] = useState<{ id: string; at: number } | null>(null);

  const held = useRef<HeldClient | null>(null);
  /** The voice client reports a leg's end through this, so the client never holds a stale closure. */
  const onLineEnded = useRef<(callId: string) => void>(() => undefined);
  /** Bumped on every retire, so a token minted across a disconnect is never kept. */
  const generation = useRef(0);
  const busy = useRef(false);
  const mutedRef = useRef(false);
  const lastDial = useRef<DialInput | null>(null);
  /** Calls whose outcome was asked for already, or that never really started. */
  const noPrompt = useRef(new Set<string>());
  /** Calls created but never dialed (the voice client failed): never adopted, never logged. */
  const abandoned = useRef(new Set<string>());
  /** Pending hangup fallbacks (cancel a call still pre-connect), cleared on unmount. */
  const fallbacks = useRef(new Set<ReturnType<typeof setTimeout>>());

  const active = activeQuery.data ?? null;
  const currentQuery = useCall(currentId ?? undefined);
  const current = currentId ? (currentQuery.data ?? null) : null;
  const loadingCurrent = currentId !== null && current === null && currentQuery.isPending;
  const outcomeQuery = useCall(outcomeId ?? undefined);
  const outcomeCall = outcomeId ? (outcomeQuery.data ?? null) : null;
  const live = current !== null && isLiveState(current.state);
  const lineEndedAt = current !== null && lineEnded?.id === current.id ? lineEnded.at : null;

  // The leg ended here: remember when, and ask the server at once rather than waiting for realtime.
  useEffect(() => {
    onLineEnded.current = (callId: string) => {
      setLineEnded((prev) => (prev?.id === callId ? prev : { id: callId, at: Date.now() }));
      void queryClient.invalidateQueries({ queryKey: callKey(callId) });
      void queryClient.invalidateQueries({ queryKey: activeCallKey });
    };
  }, [queryClient]);

  useEffect(
    () => () => {
      for (const timer of fallbacks.current) clearTimeout(timer);
      fallbacks.current.clear();
      held.current?.client.disconnect();
    },
    [],
  );

  /** Drops the voice client and its token now, or once the live call on it ends. */
  const retireClient = useCallback(() => {
    generation.current += 1;
    const line = held.current;
    if (!line) return;
    if (live) {
      held.current = { ...line, retired: true };
      return;
    }
    held.current = null;
    line.client.disconnect();
  }, [live]);

  useEffect(() => onVoiceDisconnected(retireClient), [retireClient]);

  // The status names another provider (Telnyx connected or disconnected elsewhere, say).
  useEffect(() => {
    if (statusProvider && held.current && held.current.provider !== statusProvider) {
      retireClient();
    }
  }, [statusProvider, retireClient]);

  // A retired line is dropped once the call it carried has ended.
  useEffect(() => {
    if (!live && held.current?.retired) retireClient();
  }, [live, retireClient]);

  // A call already in progress (after a reload, or answered elsewhere) becomes this session's call.
  useEffect(() => {
    if (currentId || !active || isIncomingRinging(active) || abandoned.current.has(active.id)) {
      return;
    }
    setCurrentId(active.id);
  }, [active, currentId]);

  // An abandoned call that has ended (released, or hung up after a failed release) leaves the
  // panel: it never happened, so there is nothing to show or log.
  useEffect(() => {
    if (current && abandoned.current.has(current.id) && !isLiveState(current.state)) {
      setCurrentId(null);
    }
  }, [current]);

  // When the call ends without an outcome, ask for one, once.
  useEffect(() => {
    if (!current || isLiveState(current.state) || current.outcome !== null) return;
    if (noPrompt.current.has(current.id)) return;
    noPrompt.current.add(current.id);
    setOutcomeId(current.id);
  }, [current]);

  // Realtime keeps the call fresh; if the socket is down, poll so the panel never freezes. Once the
  // line has ended here, poll fast for a while so the server's end (and the outcome prompt) lands
  // within a second or so of the provider event instead of whenever realtime next fans out.
  const liveId = current && isLiveState(current.state) ? current.id : null;
  const ending = liveId !== null && lineEndedAt !== null;
  useEffect(() => {
    if (!liveId || (!ending && realtimeStatus === 'open')) return;
    let polls = 0;
    const id = setInterval(
      () => {
        void queryClient.invalidateQueries({ queryKey: callKey(liveId) });
        void queryClient.invalidateQueries({ queryKey: activeCallKey });
        polls += 1;
        if (ending && polls >= ENDING_POLL_LIMIT && realtimeStatus === 'open') clearInterval(id);
      },
      ending ? ENDING_POLL_MS : FALLBACK_POLL_MS,
    );
    return () => clearInterval(id);
  }, [liveId, ending, realtimeStatus, queryClient]);

  const ensureClient = useCallback(async (): Promise<VoiceClient> => {
    const now = Date.now();
    const line = held.current;
    if (line && !line.retired && line.expiresAt - now > TOKEN_MARGIN_MS) return line.client;
    const minting = generation.current;
    const token = throwIfFailed(
      await api.POST('/api/v1/voice/token'),
      'Could not start the phone line.',
    );
    held.current?.client.disconnect();
    held.current = null;
    const client = createVoiceClient(token.provider, {
      getUserMedia: browserGetUserMedia(),
      // A scripted fake event that could not be posted after dial returned.
      fake: { onError: (cause) => setError(new VoiceError('dial_failed', { cause })) },
      // An SDK error after connect (the socket dropped, say), and the moment a leg ends here.
      telnyx: {
        onError: (voiceError) => setError(voiceError),
        onCallEnded: (callId) => onLineEnded.current(callId),
      },
      plivo: {
        onError: (voiceError) => setError(voiceError),
        onCallEnded: (callId) => onLineEnded.current(callId),
      },
    });
    await client.connect({ provider: token.provider, token: token.token });
    if (generation.current !== minting) {
      // Telnyx was disconnected (or the provider changed) while this token was minted.
      client.disconnect();
      throw new VoiceError('connect_failed');
    }
    held.current = {
      client,
      provider: token.provider,
      expiresAt: Date.parse(token.expiresAt),
      retired: false,
    };
    return client;
  }, []);

  // Inbound calls need the line up before they ring: the provider delivers a call only to a
  // client that is already connected, and answers "unavailable" (SIP 480) at once otherwise. So
  // with a real provider, connect as soon as the desk loads and keep the line fresh (ensureClient
  // re-mints only near expiry). No microphone prompt here: that waits for Call or Answer. Failures
  // stay quiet; dialing surfaces them if they persist.
  const liveProvider = statusProvider === 'telnyx' || statusProvider === 'plivo';
  useEffect(() => {
    if (!liveProvider) return;
    const keepUp = () => void ensureClient().catch(() => undefined);
    keepUp();
    const id = setInterval(keepUp, LINE_REFRESH_MS);
    return () => clearInterval(id);
  }, [liveProvider, ensureClient]);

  const dial = useCallback(
    async (input: DialInput) => {
      if (busy.current) return;
      // One call at a time: re-minting the token now would drop the line the live call is on.
      if (live) {
        setError(new ApiError(409, 'Another call is in progress.', 'call_in_progress'));
        return;
      }
      busy.current = true;
      setDialing(true);
      setError(null);
      lastDial.current = input;
      let createdId: string | null = null;
      try {
        const client = await ensureClient();
        const created = await startCall({
          ...(input.to === undefined ? {} : { to: input.to }),
          ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
          reviewConfirmed: input.reviewConfirmed,
        });
        createdId = created.call.id;
        mutedRef.current = false;
        setMuted(false);
        setCurrentId(created.call.id);
        await client.dial({
          callId: created.call.id,
          to: created.dial.to,
          from: created.dial.from,
          clientState: created.dial.clientState,
        });
      } catch (caught) {
        if (createdId && caught instanceof VoiceError) {
          // Nothing reached the provider: cancel the call so its hold is released, and never ask
          // for an outcome of a call that did not happen. It stays the current call until the
          // cancel lands, so a failed cancel leaves it on screen with Hang up to try again.
          abandoned.current.add(createdId);
          noPrompt.current.add(createdId);
          try {
            await cancelCall(createdId);
            setCurrentId(null);
          } catch (cancelError) {
            setError(new ReleaseFailedError({ cause: cancelError }));
            return;
          }
        }
        if (isNotConfigured(caught)) {
          void queryClient.invalidateQueries({ queryKey: voiceStatusKey });
        }
        setError(toSessionError(caught));
      } finally {
        busy.current = false;
        setDialing(false);
      }
    },
    [live, ensureClient, startCall, cancelCall, queryClient],
  );

  const retry = useCallback(async () => {
    if (lastDial.current) await dial(lastDial.current);
  }, [dial]);

  // R30: a dialed call ends through the provider leg and the provider's event settles it; only a
  // call that never reached the provider is canceled directly (see lib/hangup.ts).
  const hangup = useCallback(async () => {
    const call = current;
    if (!call || !isLiveState(call.state)) return;
    setError(null);
    const neverDialed = abandoned.current.has(call.id);
    try {
      await hangupCall({
        callId: call.id,
        neverDialed,
        endLeg: async (id) => {
          try {
            const client = held.current?.client ?? (await ensureClient());
            await client.hangup(id);
          } catch (cause) {
            throw new VoiceError('hangup_failed', { cause });
          }
        },
        cancel: (id) => cancelCall(id),
        stateOf: (id) => queryClient.getQueryData<Call>(callKey(id))?.state,
        report: (failure) => setError(toSessionError(failure)),
        later: (fn, ms) => {
          const timer = setTimeout(() => {
            fallbacks.current.delete(timer);
            fn();
          }, ms);
          fallbacks.current.add(timer);
        },
      });
      if (neverDialed) setCurrentId(null);
    } catch (caught) {
      // Only a never-dialed call's cancel rejects: it is still held on the server.
      setError(new ReleaseFailedError({ cause: caught }));
    }
  }, [current, cancelCall, ensureClient, queryClient]);

  const answer = useCallback(
    async (callId: string): Promise<CallSessionError | null> => {
      if (busy.current) return null;
      busy.current = true;
      setError(null);
      try {
        const client = await ensureClient();
        const answered = await answerCall(callId);
        mutedRef.current = false;
        setMuted(false);
        setCurrentId(callId);
        try {
          await client.answer({ callId, clientState: answered.dial.clientState });
        } catch (caught) {
          await client.hangup(callId).catch(() => undefined);
          throw caught;
        }
        return null;
      } catch (caught) {
        if (isNotConfigured(caught)) {
          void queryClient.invalidateQueries({ queryKey: voiceStatusKey });
        }
        const failure = toSessionError(caught);
        setError(failure);
        return failure;
      } finally {
        busy.current = false;
      }
    },
    [ensureClient, answerCall, queryClient],
  );

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    held.current?.client.setMuted(next);
    setMuted(next);
  }, []);

  const sendDigits = useCallback((digits: string) => {
    held.current?.client.sendDigits(digits);
  }, []);

  const audioStreams = useCallback(
    (): CallAudioStreams => held.current?.client.audioStreams?.() ?? NO_CALL_AUDIO,
    [],
  );

  const clearError = useCallback(() => setError(null), []);
  const closeOutcome = useCallback(() => setOutcomeId(null), []);
  const openOutcome = useCallback((callId: string) => setOutcomeId(callId), []);
  const dismiss = useCallback(() => {
    if (current && isLiveState(current.state)) return;
    setCurrentId(null);
  }, [current]);

  const value = useMemo<CallSessionValue>(
    () => ({
      active,
      current,
      loadingCurrent,
      lineEndedAt,
      dialing,
      dial,
      retry,
      hangup,
      answer,
      mute: { muted, toggle: toggleMute },
      sendDigits,
      audioStreams,
      error,
      clearError,
      dismiss,
      outcomeCall,
      openOutcome,
      closeOutcome,
      realtime: realtimeStatus,
    }),
    [
      active,
      current,
      loadingCurrent,
      lineEndedAt,
      dialing,
      dial,
      retry,
      hangup,
      answer,
      muted,
      toggleMute,
      sendDigits,
      audioStreams,
      error,
      clearError,
      dismiss,
      outcomeCall,
      openOutcome,
      closeOutcome,
      realtimeStatus,
    ],
  );

  return <CallSessionContext.Provider value={value}>{children}</CallSessionContext.Provider>;
}

export function useCallSession(): CallSessionValue {
  const value = useContext(CallSessionContext);
  if (!value) throw new Error('useCallSession must be used inside CallSessionProvider');
  return value;
}
