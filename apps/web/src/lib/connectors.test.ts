import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import {
  type Connectors,
  capabilityLine,
  checkCopy,
  connectorErrorCopy,
  connectorsKey,
  disconnectConnectorOptions,
  saveConnectorOptions,
} from './connectors';

const TOKEN = 'plivounitonlytoken000000000000000000000';
const SAVED = {
  provider: 'plivo',
  last4: '0000',
  accountId: 'MAUNITONLYAUTHID0000',
  connectionId: 'app-1',
  callerIdE164: '+12025550123',
  webhook: {
    events: '/webhooks/plivo/org_1',
    answer: '/webhooks/plivo/org_1/answer',
    absolute: false,
    ownKey: true,
  },
  check: null,
  updatedAt: '2026-11-15T10:00:00.000Z',
};

type PutResult = Awaited<ReturnType<typeof api.PUT>>;
type DeleteResult = Awaited<ReturnType<typeof api.DELETE>>;
type PostResult = Awaited<ReturnType<typeof api.POST>>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveConnectorOptions', () => {
  it('saves through the provider’s route and keeps no secret in the mutation cache', async () => {
    const put = vi.spyOn(api, 'PUT').mockResolvedValue({
      data: { data: SAVED },
      response: { status: 200 },
    } as unknown as PutResult);
    vi.spyOn(api, 'POST').mockResolvedValue({ response: { status: 200 } } as unknown as PostResult);
    const queryClient = new QueryClient();
    const observer = new MutationObserver(queryClient, saveConnectorOptions(queryClient));
    observer.subscribe(() => undefined);
    await observer.mutate({
      provider: 'plivo',
      body: {
        authId: 'MAUNITONLYAUTHID0000',
        authToken: TOKEN,
        appId: 'app-1',
        callerIdE164: '+12025550123',
      },
    });
    observer.reset();
    expect(put).toHaveBeenCalledWith('/api/v1/connectors/plivo', expect.anything());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const held = JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    );
    expect(held).not.toContain(TOKEN);
  });
});

describe('disconnectConnectorOptions', () => {
  it('clears the connection and tells the open voice clients', async () => {
    vi.spyOn(api, 'DELETE').mockResolvedValue({
      response: { status: 204 },
    } as unknown as DeleteResult);
    const queryClient = new QueryClient();
    queryClient.setQueryData<Connectors>(connectorsKey, {
      providers: [],
      connection: SAVED as Connectors['connection'],
    });
    const onDisconnected = vi.fn();
    const observer = new MutationObserver(
      queryClient,
      disconnectConnectorOptions(queryClient, onDisconnected),
    );
    await observer.mutate('plivo');
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData<Connectors>(connectorsKey)?.connection).toBeNull();
  });

  it('throws on anything but 204', async () => {
    vi.spyOn(api, 'DELETE').mockResolvedValue({
      response: { status: 403 },
    } as unknown as DeleteResult);
    const queryClient = new QueryClient();
    const observer = new MutationObserver(
      queryClient,
      disconnectConnectorOptions(queryClient, vi.fn()),
    );
    await expect(observer.mutate('telnyx')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('connector copy', () => {
  it('keeps the server’s conflict text, and our words for the rest', () => {
    expect(
      connectorErrorCopy(
        new ApiError(
          409,
          'This workspace is connected to Telnyx. Disconnect Telnyx first.',
          'connector_conflict',
        ),
      ),
    ).toBe('This workspace is connected to Telnyx. Disconnect Telnyx first.');
    expect(connectorErrorCopy(new ApiError(409, 'raw', 'validation_error'))).toBe(
      "This number can't be connected to this workspace.",
    );
    expect(connectorErrorCopy(new ApiError(403, 'raw'))).toBe(
      'Only owners and admins can change connectors.',
    );
    expect(connectorErrorCopy(new Error('boom'))).toBe(
      'Something went wrong. Try again in a moment.',
    );
  });

  it('names what a provider can do and how its last check went', () => {
    expect(
      capabilityLine({
        voice: true,
        numbers: true,
        purchase: true,
        balance: true,
        usage: true,
        messaging: false,
      }),
    ).toBe('Calls · Numbers · Buy numbers');
    expect(checkCopy(null)).toBe('Not checked yet');
    expect(checkCopy({ status: 'auth_failed', checkedAt: '2026-11-15T10:00:00.000Z' })).toBe(
      'Credentials refused',
    );
  });
});
