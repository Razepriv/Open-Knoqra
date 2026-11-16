import { useSyncExternalStore } from 'react';

/** Whether the realtime socket is open, shared by everything that would otherwise poll. */
export type RealtimeStatus = 'connecting' | 'open' | 'closed';

let current: RealtimeStatus = 'connecting';
const listeners = new Set<() => void>();

export function setRealtimeStatus(status: RealtimeStatus): void {
  if (status === current) return;
  current = status;
  for (const listener of listeners) listener();
}

export function realtimeStatus(): RealtimeStatus {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(subscribe, realtimeStatus, realtimeStatus);
}

/** While the socket is closed the Inbox falls back to a slow poll; open, realtime drives it. */
export const FALLBACK_POLL_MS = 30_000;

/** The refetch interval for live inbox data: none while realtime is open. */
export function pollWhileOffline(status: RealtimeStatus): number | false {
  return status === 'open' ? false : FALLBACK_POLL_MS;
}
