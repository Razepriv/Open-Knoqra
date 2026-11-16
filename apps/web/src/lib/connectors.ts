import type { components } from '@knoqra/api-client';
import {
  type MutationOptions,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, api, throwIfFailed } from './api';
import { invalidateVoiceQueries, notifyVoiceDisconnected } from './voice-connection';

export type Connectors = components['schemas']['Connectors'];
export type ConnectorProvider = components['schemas']['ConnectorProvider'];
export type ConnectorConnection = NonNullable<components['schemas']['ConnectorConnection']>;
export type ConnectorId = ConnectorProvider['id'];
export type TelnyxInput = components['schemas']['ConnectTelnyx'];
export type PlivoInput = components['schemas']['ConnectPlivo'];
export type ConnectInput =
  | { provider: 'telnyx'; body: TelnyxInput }
  | { provider: 'plivo'; body: PlivoInput };

export const connectorsKey = ['connectors'] as const;

/**
 * The providers this workspace can connect and its one connection. Always stale: a connect or
 * disconnect in another tab, or a credential check, must show on the next mount or focus.
 */
export function connectorsQueryOptions() {
  return {
    queryKey: connectorsKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Connectors> =>
      throwIfFailed(
        await api.GET('/api/v1/connectors', { signal }),
        'Could not load the connectors.',
      ),
    staleTime: 0,
  };
}

export function useConnectors() {
  return useQuery(connectorsQueryOptions());
}

async function put(input: ConnectInput): Promise<ConnectorConnection> {
  const result =
    input.provider === 'telnyx'
      ? await api.PUT('/api/v1/connectors/telnyx', { body: input.body })
      : await api.PUT('/api/v1/connectors/plivo', { body: input.body });
  return throwIfFailed(result, 'Could not save the connector.');
}

/** Everything that depends on which provider is connected, fetched again. */
function invalidateAll(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: connectorsKey });
  invalidateVoiceQueries(queryClient);
}

/**
 * The connect mutation. Its variables hold the secret, so the cache drops the mutation as soon as
 * nothing observes it (`gcTime: 0`); the form resets its observer once the save settles. After
 * the save it asks the provider for the balance, which is the credential check.
 */
export function saveConnectorOptions(
  queryClient: QueryClient,
): MutationOptions<ConnectorConnection, Error, ConnectInput> {
  return {
    gcTime: 0,
    mutationFn: async (input) => {
      const saved = await put(input);
      // Best effort: a failed check shows on the card, not as a failed save.
      await api.POST('/api/v1/usage/balance/refresh').catch(() => undefined);
      return saved;
    },
    onSuccess: () => invalidateAll(queryClient),
  };
}

export function useSaveConnector() {
  const queryClient = useQueryClient();
  return useMutation(saveConnectorOptions(queryClient));
}

/** Disconnect: the audited delete, then every open voice client drops its line. */
export function disconnectConnectorOptions(
  queryClient: QueryClient,
  onDisconnected: () => void = notifyVoiceDisconnected,
): MutationOptions<void, Error, ConnectorId> {
  return {
    mutationFn: async (provider) => {
      const result = await api.DELETE('/api/v1/connectors/{provider}', {
        params: { path: { provider } },
      });
      if (result.response.status !== 204) {
        throw new ApiError(
          result.response.status,
          'Could not disconnect.',
          (result.error as { error?: { code?: string } } | undefined)?.error?.code,
        );
      }
    },
    onSuccess: () => {
      queryClient.setQueryData<Connectors>(connectorsKey, (old) =>
        old ? { ...old, connection: null } : old,
      );
      onDisconnected();
      invalidateAll(queryClient);
    },
  };
}

export function useDisconnectConnector() {
  const queryClient = useQueryClient();
  return useMutation(disconnectConnectorOptions(queryClient));
}

/** Check now: the balance read is the credential check; the card shows its result. */
export function useCheckConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await api.POST('/api/v1/usage/balance/refresh');
      if (result.response.status >= 400) {
        throw new ApiError(result.response.status, 'Could not check the connection.');
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: connectorsKey });
    },
  });
}

const SAVE_COPY: Record<number, string> = {
  403: 'Only owners and admins can change connectors.',
  404: 'This provider is not offered here.',
  503: 'Provider credentials are not set up on this server yet.',
};

/** Our wording for a failed save, disconnect or check; the server's only for a conflict. */
export function connectorErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    // The server's conflict text names the connected provider ("Disconnect Telnyx first").
    if (error.code === 'connector_conflict') return error.message;
    if (error.status === 409) return "This number can't be connected to this workspace.";
    if (error.code === 'validation_error' && error.status === 400) {
      return 'Some details were not accepted. Check them and try again.';
    }
    const copy = SAVE_COPY[error.status];
    if (copy) return copy;
  }
  return 'Something went wrong. Try again in a moment.';
}

/** "Calls · Numbers · Buy numbers", from the registry's capabilities. */
export function capabilityLine(capabilities: ConnectorProvider['capabilities']): string {
  const parts: string[] = [];
  if (capabilities.voice) parts.push('Calls');
  if (capabilities.numbers) parts.push('Numbers');
  if (capabilities.purchase) parts.push('Buy numbers');
  if (capabilities.messaging) parts.push('SMS and WhatsApp');
  return parts.join(' · ');
}

const CHECK_COPY: Record<NonNullable<ConnectorConnection['check']>['status'], string> = {
  ok: 'Credentials accepted',
  auth_failed: 'Credentials refused',
  unavailable: 'Provider did not answer',
};

export function checkCopy(check: ConnectorConnection['check']): string {
  return check ? CHECK_COPY[check.status] : 'Not checked yet';
}
