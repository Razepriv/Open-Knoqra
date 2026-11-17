import type { components } from '@knoqra/api-client';
import { EMERGENCY_CALL_MESSAGE } from '@knoqra/core';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, api, throwIfFailed } from './api';
import { useDebouncedValue } from './use-debounced-value';
import { walletKey } from './wallet';

export type Call = components['schemas']['Call'];
export type CallOutcome = components['schemas']['CallOutcome']['outcome'];
export type CreatedCall = components['schemas']['CreatedCall'];
export type AnsweredCall = components['schemas']['AnsweredCall'];
export type CallPreflight = components['schemas']['CallPreflight'];
export type Voicemail = components['schemas']['Voicemail'];
export type CallDirectionFilter = 'all' | 'outbound' | 'inbound';

export const callsRoot = ['calls'] as const;
export const callsListRoot = ['calls', 'list'] as const;
export const activeCallKey = ['calls', 'active'] as const;
export const callKey = (id: string) => ['calls', id] as const;
export const callsListKey = (direction: CallDirectionFilter) =>
  [...callsListRoot, direction] as const;
export const voicemailsKey = ['voicemails'] as const;
export const preflightKey = (to: string | undefined, contactId: string | undefined) =>
  ['calls', 'preflight', to, contactId] as const;

const PREFLIGHT_DEBOUNCE_MS = 250;
/** Call states that end a call (mirrors TERMINAL_CALL_STATES in @knoqra/core). */
const ENDED_STATES = new Set(['completed', 'failed', 'busy', 'no_answer', 'canceled']);

export function isEndedCallState(state: string): boolean {
  return ENDED_STATES.has(state);
}

/** How far along a call is (mirrors the rank in @knoqra/core call-state); terminal states tie. */
const STATE_RANK: Record<string, number> = {
  queued: 0,
  initiating: 1,
  ringing: 2,
  connected: 3,
  ending: 4,
};
const TERMINAL_RANK = 5;

/** A call state's rank; an unknown state ranks below every known one. */
export function callStateRank(state: string): number {
  if (isEndedCallState(state)) return TERMINAL_RANK;
  return STATE_RANK[state] ?? -1;
}

const OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: 'Connected',
  rescheduled: 'Rescheduled',
  follow_up: 'Follow-up',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
};

export function outcomeLabel(outcome: CallOutcome): string {
  return OUTCOME_LABELS[outcome];
}

// --- Pure helpers -----------------------------------------------------------------------------

/** Seconds as `m:ss` (minutes are not wrapped into hours). */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.trunc(seconds)) : 0;
  const minutes = Math.trunc(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

const RECENT_STATE_COPY: Record<Call['state'], string> = {
  queued: 'Calling',
  initiating: 'Calling',
  ringing: 'Ringing',
  connected: 'Connected',
  ending: 'Ending',
  completed: 'Completed',
  failed: 'Failed',
  busy: 'Busy',
  no_answer: 'No answer',
  canceled: 'Canceled',
};

/**
 * How a call reads in Recents: `Completed · 2:14` once talked, `Missed` for an inbound call nobody
 * answered (as the contact timeline says), otherwise the state.
 */
export function recentStateCopy(call: Call): string {
  const answered = call.answeredAt !== null;
  if (call.direction === 'inbound' && !answered && isEndedCallState(call.state)) return 'Missed';
  if (call.state === 'completed') return `Completed · ${formatDuration(call.billableSeconds ?? 0)}`;
  return RECENT_STATE_COPY[call.state];
}

/**
 * An ended call of mine can still get an outcome, except a canceled one: that call never really
 * happened. Another member's call is theirs to log (the API refuses it), and so is every call
 * while we do not yet know who is signed in.
 */
export function canLogOutcome(call: Call, meId: string | undefined): boolean {
  return (
    meId !== undefined &&
    call.userId === meId &&
    isEndedCallState(call.state) &&
    call.state !== 'canceled' &&
    call.outcome === null
  );
}

/** Voicemails nobody has listened to yet. */
export function unreadCount(items: readonly { listenedAt: string | null }[] | undefined): number {
  return items?.filter((item) => item.listenedAt === null).length ?? 0;
}

const BLOCKED_COPY: Record<string, string> = {
  do_not_contact: 'Do not contact. Policy, not a task.',
  revoked: 'Call consent was revoked.',
  opted_out: 'This contact opted out of calls.',
};

const SPEND_COPY: Record<string, string> = {
  insufficient_funds: 'Not enough credit for this call. Add credit to continue.',
  stop_cap: 'This call would pass the monthly spend cap.',
  provider_low: 'Your phone provider balance is low. Top it up with your provider to keep calling.',
  provider_exhausted:
    'Your phone provider balance is too low to place a call. Top it up with your provider.',
};

const ERROR_COPY: Record<string, string> = {
  mic_denied: 'Microphone access is blocked. Allow it in your browser settings and try again.',
  mic_unavailable: 'No working microphone was found. Connect one and try again.',
  connect_failed: 'Could not connect to the phone service. Try again in a moment.',
  dial_failed: 'The call could not be placed. Try again in a moment.',
  hangup_failed: 'The call could not be ended. Press Hang up to try again.',
  voice_not_configured: 'Calling is not set up for this workspace yet.',
  call_blocked: 'This contact cannot be called.',
  needs_review: 'Call consent is unknown. Confirm you may call this number.',
  call_in_progress: 'Another call is in progress. End it before starting a new one.',
  spend_blocked: 'Your spending limits do not allow this call.',
  invalid_state: 'This call can no longer be changed.',
  outcome_exists: 'An outcome is already logged for this call.',
  invalid_phone: 'Enter a full number with country code, like +1 202 555 0123.',
  emergency_not_supported: EMERGENCY_CALL_MESSAGE,
  not_found: 'That call or contact no longer exists.',
  validation_error: 'Some details are not valid. Check them and try again.',
  unauthenticated: 'Your session ended. Sign in again.',
  no_active_org: 'Choose a workspace first.',
  forbidden: 'You do not have access to do that.',
  internal_error: 'Something went wrong on our side. Try again in a moment.',
  rate_limited: 'Too many call attempts. Wait a minute and try again.',
  rate_unavailable:
    "KNOQRA can't call this destination yet. Call rates lists the countries you can call.",
};

const FALLBACK_COPY = 'Something went wrong. Try again in a moment.';

/** Our own wording for an API or voice error code, so no code or server text reaches the screen. */
export function callErrorCopy(code: string | undefined, reason?: string): string {
  if (code === undefined) return FALLBACK_COPY;
  const byReason =
    code === 'call_blocked' ? BLOCKED_COPY : code === 'spend_blocked' ? SPEND_COPY : undefined;
  const specific = reason === undefined ? undefined : byReason?.[reason];
  return specific ?? ERROR_COPY[code] ?? FALLBACK_COPY;
}

/** The note under the dialer for a spend decision, or null when there is nothing to say. */
export function spendNoteCopy(outcome: string, reason: string): string | null {
  if (outcome === 'ok') return null;
  if (reason === 'provider_low' || reason === 'provider_exhausted')
    return SPEND_COPY[reason] ?? null;
  if (outcome !== 'stop') return "You're near this month's spend cap";
  return reason === 'insufficient_funds'
    ? 'Balance too low to hold a call.'
    : 'Spend cap reached. Raise it in the wallet to call.';
}

export type CallCutOffReason = NonNullable<Call['cutOff']>['reason'];

const CUT_OFF_WARNING: Record<CallCutOffReason, string> = {
  insufficient_funds: 'Out of credit. This call will end soon. Add credit to keep talking.',
  stop_cap:
    'Monthly spend cap reached. This call will end soon. An owner or admin can raise the cap in the wallet.',
  paid_time_over: 'This call will end soon: no more minutes could be held for it.',
};

const CUT_OFF_ENDED: Record<CallCutOffReason, string> = {
  insufficient_funds: 'Call ended: out of credit',
  stop_cap: 'Call ended: monthly spend cap reached',
  paid_time_over: 'Call ended: no more minutes could be held',
};

/** The warning on a live call the server will end because no more minutes could be held. */
export function cutOffWarningCopy(reason: CallCutOffReason): string {
  return CUT_OFF_WARNING[reason];
}

/** How a call KNOQRA ended for lack of credit ended, or null for any other call. */
export function cutOffEndedCopy(
  call: Pick<Call, 'hangupCause' | 'cutOff' | 'state'>,
): string | null {
  if (!isEndedCallState(call.state) || call.hangupCause !== 'cut_off' || !call.cutOff) return null;
  return CUT_OFF_ENDED[call.cutOff.reason];
}

/** Whole seconds until a live call's cut-off, never below 0; null when none is planned. */
export function secondsUntilCutOff(call: Pick<Call, 'cutOff' | 'state'>, now: Date): number | null {
  if (!call.cutOff || isEndedCallState(call.state)) return null;
  const ms = Date.parse(call.cutOff.at) - now.getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : null;
}

/** The copy for whatever a call mutation threw (ApiError and VoiceError both carry a `code`). */
export function callErrorMessage(error: unknown, reason?: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  return callErrorCopy(typeof code === 'string' ? code : undefined, reason);
}

// --- Queries ----------------------------------------------------------------------------------

interface NullableResult<T> {
  data?: { data?: T | null } | undefined;
  error?: { error?: { message?: string; code?: string } | null } | undefined;
  response: { status: number };
}

/** Like throwIfFailed, but a successful `{ data: null }` is a value, not a failure. */
function unwrapNullable<T>(result: NullableResult<T>, fallback: string): T | null {
  if (result.data && result.data.data !== undefined) return result.data.data;
  throw new ApiError(
    result.response.status,
    result.error?.error?.message ?? fallback,
    result.error?.error?.code,
  );
}

/** What dialing this number or contact would do now; waits 250 ms after the last keystroke. */
export function usePreflight({ to, contactId }: { to?: string; contactId?: string }) {
  const debouncedTo = useDebouncedValue(to?.trim() || undefined, PREFLIGHT_DEBOUNCE_MS);
  const debouncedContact = useDebouncedValue(contactId || undefined, PREFLIGHT_DEBOUNCE_MS);
  const enabled = debouncedTo !== undefined || debouncedContact !== undefined;
  const query = useQuery({
    queryKey: preflightKey(debouncedTo, debouncedContact),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/calls/preflight', {
          params: {
            query: {
              ...(debouncedTo === undefined ? {} : { to: debouncedTo }),
              ...(debouncedContact === undefined ? {} : { contactId: debouncedContact }),
            },
          },
          signal,
        }),
        'Could not check this call.',
      ),
    enabled,
    // Keep the last answer while typing, but never show one for an empty input.
    placeholderData: enabled ? keepPreviousData : undefined,
    retry: false,
  });
  // The debounce lags the input, so a cleared input must hide the last answer at once.
  const inputEmpty = !to?.trim() && !contactId;
  return inputEmpty ? { ...query, data: undefined } : query;
}

/** The signed-in user's call in progress, or null. Kept fresh by `useRealtime`. */
export function useActiveCall() {
  return useQuery({
    queryKey: activeCallKey,
    queryFn: async ({ signal }) =>
      unwrapNullable(
        await api.GET('/api/v1/calls/active', { signal }),
        'Could not load your call.',
      ),
  });
}

export function useCalls(direction: CallDirectionFilter) {
  return useInfiniteQuery({
    queryKey: callsListKey(direction),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/calls', {
          params: { query: { direction, ...(pageParam ? { cursor: pageParam } : {}) } },
          signal,
        }),
        'Could not load calls.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useCall(id: string | undefined) {
  return useQuery({
    queryKey: callKey(id ?? ''),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/calls/{id}', { params: { path: { id: id ?? '' } }, signal }),
        'Could not load this call.',
      ),
    enabled: Boolean(id),
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 1,
  });
}

export function useVoicemails() {
  return useQuery({
    queryKey: voicemailsKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(await api.GET('/api/v1/voicemails', { signal }), 'Could not load voicemails.')
        .items,
  });
}

// --- Mutations --------------------------------------------------------------------------------

export interface StartCallInput {
  to?: string;
  contactId?: string;
  reviewConfirmed?: boolean;
  /** Reuse the same key to retry one dial attempt safely; a fresh one is made when omitted. */
  idempotencyKey?: string;
}

/** Cache writes shared by the call mutations. */
function useCallCaches() {
  const queryClient = useQueryClient();
  return {
    queryClient,
    /** Writes a call into the single-call and active-call caches. */
    put(call: Call) {
      queryClient.setQueryData(callKey(call.id), call);
      queryClient.setQueryData(activeCallKey, isEndedCallState(call.state) ? null : call);
    },
    refreshLists() {
      void queryClient.invalidateQueries({ queryKey: callsListRoot });
    },
    refreshWallet() {
      void queryClient.invalidateQueries({ queryKey: walletKey });
    },
    refreshTimeline() {
      void queryClient.invalidateQueries({ queryKey: ['timeline'] });
    },
  };
}

export function useStartCall() {
  const caches = useCallCaches();
  return useMutation({
    mutationFn: async (input: StartCallInput): Promise<CreatedCall> =>
      throwIfFailed(
        await api.POST('/api/v1/calls', {
          body: {
            ...(input.to === undefined ? {} : { to: input.to }),
            ...(input.contactId === undefined ? {} : { contactId: input.contactId }),
            ...(input.reviewConfirmed === undefined
              ? {}
              : { reviewConfirmed: input.reviewConfirmed }),
            idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
          },
        }),
        'Could not start the call.',
      ),
    onSuccess: ({ call }) => {
      caches.put(call);
      caches.refreshLists();
      caches.refreshWallet();
    },
  });
}

export function useCancelCall() {
  const caches = useCallCaches();
  return useMutation({
    mutationFn: async (id: string): Promise<Call> =>
      throwIfFailed(
        await api.POST('/api/v1/calls/{id}/cancel', { params: { path: { id } } }),
        'Could not cancel the call.',
      ),
    onSuccess: (call) => {
      caches.put(call);
      caches.refreshLists();
      caches.refreshWallet();
    },
  });
}

export function useAnswerCall() {
  const caches = useCallCaches();
  return useMutation({
    mutationFn: async (id: string): Promise<AnsweredCall> =>
      throwIfFailed(
        await api.POST('/api/v1/calls/{id}/answer', { params: { path: { id } } }),
        'Could not answer the call.',
      ),
    onSuccess: ({ call }) => {
      caches.put(call);
      caches.refreshLists();
      caches.refreshWallet();
    },
  });
}

export function useLogOutcome() {
  const caches = useCallCaches();
  return useMutation({
    mutationFn: async (input: { id: string; outcome: CallOutcome; note?: string }): Promise<Call> =>
      throwIfFailed(
        await api.POST('/api/v1/calls/{id}/outcome', {
          params: { path: { id: input.id } },
          body: { outcome: input.outcome, ...(input.note ? { note: input.note } : {}) },
        }),
        'Could not save the outcome.',
      ),
    onSuccess: (call) => {
      caches.queryClient.setQueryData(callKey(call.id), call);
      caches.refreshLists();
      caches.refreshTimeline();
    },
  });
}

export function useMarkListened() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Voicemail> =>
      throwIfFailed(
        await api.POST('/api/v1/voicemails/{id}/listened', { params: { path: { id } } }),
        'Could not update the voicemail.',
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData<Voicemail[] | undefined>(voicemailsKey, (items) =>
        items?.map((item) => (item.id === updated.id ? updated : item)),
      );
      void queryClient.invalidateQueries({ queryKey: voicemailsKey });
    },
  });
}
