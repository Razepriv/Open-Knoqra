import { useCallback, useSyncExternalStore } from 'react';

export type MicState = 'granted' | 'prompt' | 'denied' | 'unsupported';

interface PermissionStatusLike extends EventTarget {
  state: string;
}

/** The slice of `navigator` this module reads, so tests can stub it. */
export interface MicNavigator {
  permissions?:
    | { query(descriptor: { name: 'microphone' }): Promise<PermissionStatusLike> }
    | undefined;
  mediaDevices?:
    | {
        getUserMedia(constraints: { audio: true }): Promise<{
          getTracks(): { stop(): void }[];
        }>;
      }
    | undefined;
}

export interface MicPermissionStore {
  getState(): MicState;
  subscribe(listener: () => void): () => void;
  request(): Promise<'granted' | 'denied'>;
}

function toMicState(value: string): MicState {
  return value === 'granted' || value === 'denied' ? value : 'prompt';
}

/**
 * The microphone permission as an external store. It reads `navigator.permissions` and follows its
 * `change` event while anyone is subscribed; where the API is missing it is `unsupported`.
 */
export function createMicPermissionStore(nav: MicNavigator): MicPermissionStore {
  let state: MicState = nav.permissions ? 'prompt' : 'unsupported';
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;
  let generation = 0;

  const set = (next: MicState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const attach = () => {
    const permissions = nav.permissions;
    if (!permissions) return;
    const mine = ++generation;
    permissions.query({ name: 'microphone' }).then(
      (status) => {
        if (mine !== generation) return;
        const onChange = () => set(toMicState(status.state));
        status.addEventListener('change', onChange);
        detach = () => status.removeEventListener('change', onChange);
        onChange();
      },
      () => {
        if (mine === generation) set('unsupported');
      },
    );
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1;
          detach?.();
          detach = null;
        }
      };
    },
    async request() {
      const devices = nav.mediaDevices;
      if (!devices?.getUserMedia) return 'denied';
      try {
        const stream = await devices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        set('granted');
        return 'granted';
      } catch {
        set('denied');
        return 'denied';
      }
    },
  };
}

let browserStore: MicPermissionStore | undefined;

function getBrowserStore(): MicPermissionStore {
  browserStore ??= createMicPermissionStore(typeof navigator === 'undefined' ? {} : navigator);
  return browserStore;
}

export function useMicPermission(): {
  state: MicState;
  request(): Promise<'granted' | 'denied'>;
} {
  const store = getBrowserStore();
  const state = useSyncExternalStore(store.subscribe, store.getState, () => 'unsupported' as const);
  const request = useCallback(() => store.request(), [store]);
  return { state, request };
}
