import type { components } from '@knoqra/api-client';
import {
  type MutationOptions,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, api, throwIfFailed } from './api';
import { callsRoot } from './calls';
import { setupKey } from './setup';

export type VoiceConnection = NonNullable<components['schemas']['VoiceConnection']>;
export type VoiceConnectionInput = components['schemas']['PutVoiceConnection'];
export type VoiceStatus = components['schemas']['VoiceStatus'];

export const voiceConnectionKey = ['voice', 'connection'] as const;
export const voiceStatusKey = ['voice', 'status'] as const;
/** Every pre-call check (`preflightKey` in lib/calls.ts): their answers depend on the provider. */
const preflightRoot = [...callsRoot, 'preflight'] as const;

interface Result<T> {
  data?: { data?: T | null } | undefined;
  error?: { error?: { message?: string; code?: string } | null } | undefined;
  response: { status: number };
}

/** The `{ data }` envelope's value, where null (nothing set up) is an answer, not a failure. */
function unwrap<T>(result: Result<T>, fallback: string): T | null {
  if (result.data && result.data.data !== undefined) return result.data.data;
  throw new ApiError(
    result.response.status,
    result.error?.error?.message ?? fallback,
    result.error?.error?.code,
  );
}

/** The workspace's Telnyx connection without its key (only the last four), or null. */
export function useVoiceConnection() {
  return useQuery({
    queryKey: voiceConnectionKey,
    queryFn: async ({ signal }): Promise<VoiceConnection | null> =>
      unwrap(
        await api.GET('/api/v1/voice/connection', { signal }),
        'Could not load the voice connection.',
      ),
  });
}

/**
 * The voice status query. Always stale (`staleTime: 0`): it gates Call, it is cheap, and a
 * connect or disconnect in another tab must show up on the next mount or focus.
 */
export function voiceStatusQueryOptions() {
  return {
    queryKey: voiceStatusKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<VoiceStatus> =>
      throwIfFailed(
        await api.GET('/api/v1/voice/status', { signal }),
        'Could not load the voice status.',
      ),
    staleTime: 0,
  };
}

/** Whether this workspace can place calls now, and through which provider. Never cached by HTTP. */
export function useVoiceStatus() {
  return useQuery(voiceStatusQueryOptions());
}

/**
 * After a connect or a disconnect: the connection, the voice status and every pre-call check are
 * fetched again. Not awaited, so the card updates at once while these refetch.
 */
export function invalidateVoiceQueries(queryClient: QueryClient): void {
  for (const queryKey of [voiceConnectionKey, voiceStatusKey, preflightRoot, setupKey]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

type DisconnectListener = () => void;
const disconnectListeners = new Set<DisconnectListener>();

/**
 * Runs `listener` each time this tab disconnects Telnyx (the call session drops its voice client).
 * Returns the unsubscribe function.
 */
export function onVoiceDisconnected(listener: DisconnectListener): () => void {
  disconnectListeners.add(listener);
  return () => {
    disconnectListeners.delete(listener);
  };
}

/** Tells every `onVoiceDisconnected` subscriber that this tab disconnected the provider. */
export function notifyVoiceDisconnected(): void {
  for (const listener of [...disconnectListeners]) listener();
}

/**
 * The save mutation. Its variables hold the API key, so the cache drops the mutation as soon as
 * nothing observes it (`gcTime: 0`); the form resets its observer once the save settles. After the
 * save it asks the provider for the balance, so the setup wizard's credential check runs at once.
 */
export function saveVoiceConnectionOptions(
  queryClient: QueryClient,
): MutationOptions<VoiceConnection, Error, VoiceConnectionInput> {
  return {
    gcTime: 0,
    mutationFn: async (input: VoiceConnectionInput): Promise<VoiceConnection> => {
      const saved = unwrap(
        await api.PUT('/api/v1/voice/connection', { body: input }),
        'Could not save the voice connection.',
      );
      if (!saved) throw new ApiError(500, 'Could not save the voice connection.');
      // The refresh is best effort: a failed poll is shown by the credential check, not as a
      // failed save.
      await api.POST('/api/v1/usage/balance/refresh').catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: setupKey });
      return saved;
    },
    // Only now: the saved key and the credential check change together, never one before the other.
    onSuccess: (saved) => {
      queryClient.setQueryData(voiceConnectionKey, saved);
      invalidateVoiceQueries(queryClient);
    },
  };
}

export function useSaveVoiceConnection() {
  const queryClient = useQueryClient();
  return useMutation(saveVoiceConnectionOptions(queryClient));
}

/**
 * Disconnect Telnyx: the audited delete, then the card falls back to its connect form, and the
 * status and every pre-call check are fetched again. `onDisconnected` runs once the server has
 * deleted the key (by default it tells every `onVoiceDisconnected` subscriber).
 */
export function disconnectVoiceOptions(
  queryClient: QueryClient,
  onDisconnected: () => void = notifyVoiceDisconnected,
): MutationOptions<void, Error, void> {
  return {
    mutationFn: async (): Promise<void> => {
      const result = await api.DELETE('/api/v1/voice/connection');
      if (result.response.status !== 204) {
        throw new ApiError(
          result.response.status,
          'Could not disconnect your phone provider.',
          (result.error as { error?: { code?: string } } | undefined)?.error?.code,
        );
      }
    },
    onSuccess: () => {
      queryClient.setQueryData(voiceConnectionKey, null);
      onDisconnected();
      invalidateVoiceQueries(queryClient);
    },
  };
}

export function useDisconnectVoice() {
  const queryClient = useQueryClient();
  return useMutation(disconnectVoiceOptions(queryClient));
}

const SAVE_COPY: Record<number, string> = {
  403: 'Only owners and admins can change the connection.',
  409: "This number can't be connected to this workspace.",
  503: 'Voice credentials are not set up on this server yet.',
};

/** Our wording for a failed save or disconnect; never the server's text. */
export function voiceConnectionErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    // The server's conflict text names the provider connected instead ("Disconnect Plivo first").
    if (error.code === 'connector_conflict') return error.message;
    if (error.code === 'validation_error' && error.status === 400) {
      return 'Some details were not accepted. Check them and try again.';
    }
    const copy = SAVE_COPY[error.status];
    if (copy) return copy;
  }
  return 'Something went wrong. Try again in a moment.';
}
