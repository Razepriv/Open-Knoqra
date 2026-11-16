import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { meQueryKey } from './api';
import {
  activeCallKey,
  callKey,
  callStateRank,
  callsListRoot,
  callsRoot,
  isEndedCallState,
  voicemailsKey,
} from './calls';
import { walletKey } from './wallet';

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

const REALTIME_PATH = '/api/v1/realtime';
const PING_INTERVAL_MS = 25_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function realtimeUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${REALTIME_PATH}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface CallLike {
  id: string;
  userId: string;
  state: string;
}

/** The fields the call UI reads; anything less is refetched rather than cached. */
function isCall(value: unknown): value is CallLike {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.state === 'string' &&
    typeof value.direction === 'string' &&
    typeof value.createdAt === 'string'
  );
}

const WALLET_NUMBER_FIELDS = [
  'balanceMicros',
  'heldMicros',
  'availableMicros',
  'periodSpendMicros',
] as const;

function isWallet(value: unknown): boolean {
  return (
    isRecord(value) &&
    WALLET_NUMBER_FIELDS.every((field) => typeof value[field] === 'number') &&
    isRecord(value.status) &&
    isRecord(value.dialStatus)
  );
}

/** The signed-in user's id, from the `me` query the desk layout loads; undefined until it has. */
function signedInUserId(queryClient: QueryClient): string | undefined {
  const me = queryClient.getQueryData<{ user?: { id?: unknown } }>(meQueryKey);
  return typeof me?.user?.id === 'string' ? me.user.id : undefined;
}

/** True when the cache already holds this call further along than `data` (a late delivery). */
function isStale(queryClient: QueryClient, data: CallLike, active: CallLike | null | undefined) {
  const cached = queryClient.getQueryData<CallLike>(callKey(data.id));
  const known = Math.max(
    cached ? callStateRank(cached.state) : -1,
    active?.id === data.id ? callStateRank(active.state) : -1,
  );
  return callStateRank(data.state) < known;
}

function applyCall(queryClient: QueryClient, data: unknown): void {
  if (!isCall(data)) {
    void queryClient.invalidateQueries({ queryKey: callsRoot });
    return;
  }
  const active = queryClient.getQueryData<CallLike | null>(activeCallKey);
  // Every member of the workspace hears every call. Another member's call only refreshes the
  // lists; while we do not know who is signed in, the active call is asked of the server instead.
  // A call of mine that someone else took (they answered it first) is asked again too, so its
  // incoming dialog stops ringing here.
  const me = signedInUserId(queryClient);
  if (data.userId !== me) {
    if (me === undefined || active?.id === data.id) {
      void queryClient.invalidateQueries({ queryKey: activeCallKey });
    }
    void queryClient.invalidateQueries({ queryKey: callsListRoot });
    return;
  }
  // Events can arrive out of order: never move a call back to an earlier state.
  if (isStale(queryClient, data, active)) return;
  if (isEndedCallState(data.state)) {
    // Another call ending must not clear the one in progress.
    if (!active || active.id === data.id) queryClient.setQueryData(activeCallKey, null);
  } else {
    queryClient.setQueryData(activeCallKey, data);
  }
  queryClient.setQueryData(callKey(data.id), data);
  void queryClient.invalidateQueries({ queryKey: callsListRoot });
}

function apply(queryClient: QueryClient, message: unknown): void {
  if (!isRecord(message)) return;
  const { type, data } = message;
  if (type === 'call.updated') {
    applyCall(queryClient, data);
  } else if (type === 'wallet.updated') {
    if (isWallet(data)) queryClient.setQueryData(walletKey, data);
    else void queryClient.invalidateQueries({ queryKey: walletKey });
  } else if (type === 'voicemail.created') {
    void queryClient.invalidateQueries({ queryKey: voicemailsKey });
  }
}

/** The web app has no logger, so a failure is rethrown outside the socket handler to surface. */
function surface(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

export interface StartRealtimeOptions {
  url: string;
  queryClient: QueryClient;
  WebSocketCtor: typeof WebSocket;
  onStatus: (status: RealtimeStatus) => void;
}

/**
 * Keeps one realtime socket alive and writes what it hears into the query cache. Reconnects with
 * backoff (1, 2, 4 ... 30 seconds) and refetches calls, wallet and voicemails after a reconnect, since
 * events may have been missed. Returns a function that stops it.
 */
export function startRealtime(options: StartRealtimeOptions): () => void {
  const { url, queryClient, WebSocketCtor, onStatus } = options;
  let socket: WebSocket | null = null;
  let stopped = false;
  let everOpened = false;
  let backoff = BACKOFF_START_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stopPing = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  };

  const connect = () => {
    onStatus('connecting');
    const ws = new WebSocketCtor(url);
    socket = ws;
    ws.onopen = () => {
      if (stopped) return;
      backoff = BACKOFF_START_MS;
      onStatus('open');
      if (everOpened) {
        void queryClient.invalidateQueries({ queryKey: callsRoot });
        void queryClient.invalidateQueries({ queryKey: walletKey });
        void queryClient.invalidateQueries({ queryKey: voicemailsKey });
      }
      everOpened = true;
      stopPing();
      pingTimer = setInterval(() => ws.send('ping'), PING_INTERVAL_MS);
    };
    ws.onmessage = (event) => {
      if (stopped || typeof event.data !== 'string') return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        // `pong` and any frame that is not JSON carry nothing to apply.
        return;
      }
      try {
        apply(queryClient, message);
      } catch (error) {
        surface(error);
      }
    };
    ws.onclose = () => {
      stopPing();
      if (socket === ws) socket = null;
      onStatus('closed');
      if (stopped) return;
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
  };

  connect();

  return () => {
    stopped = true;
    stopPing();
    if (retryTimer) clearTimeout(retryTimer);
    const ws = socket;
    socket = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
    onStatus('closed');
  };
}

export interface UseRealtimeOptions {
  WebSocketCtor?: typeof WebSocket | undefined;
  queryClient?: QueryClient | undefined;
}

/** Opens the realtime socket for as long as the component is mounted. */
export function useRealtime(options: UseRealtimeOptions = {}): { status: RealtimeStatus } {
  const contextClient = useQueryClient();
  const queryClient = options.queryClient ?? contextClient;
  const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    return startRealtime({
      url: realtimeUrl(window.location),
      queryClient,
      WebSocketCtor,
      onStatus: setStatus,
    });
  }, [queryClient, WebSocketCtor]);

  return { status };
}
