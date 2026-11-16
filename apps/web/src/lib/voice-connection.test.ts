import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';
import { preflightKey } from './calls';
import {
  disconnectVoiceOptions,
  onVoiceDisconnected,
  saveVoiceConnectionOptions,
  voiceConnectionErrorCopy,
  voiceConnectionKey,
  voiceStatusKey,
  voiceStatusQueryOptions,
} from './voice-connection';

const KEY = 'KEY0123456789ABCDEFunitonly';
const INPUT = { apiKey: KEY, connectionId: '1234567890', callerIdE164: '+12025550123' };
const SAVED = {
  provider: 'telnyx',
  apiKeyLast4: 'only',
  connectionId: '1234567890',
  callerIdE164: '+12025550123',
  updatedAt: '2026-11-12T10:00:00.000Z',
};

type PutResult = Awaited<ReturnType<typeof api.PUT>>;
type DeleteResult = Awaited<ReturnType<typeof api.DELETE>>;

/** What the mutation cache still holds, as text, after the timers that collect it have run. */
async function heldAfterSettle(queryClient: QueryClient): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  return JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  );
}

/** A mounted form's view of the save: it subscribes, saves, then resets once settled. */
async function saveLikeTheForm(queryClient: QueryClient): Promise<void> {
  const observer = new MutationObserver(queryClient, saveVoiceConnectionOptions(queryClient));
  observer.subscribe(() => undefined);
  await observer.mutate(INPUT).catch(() => undefined);
  observer.reset();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saveVoiceConnectionOptions', () => {
  it('leaves no apiKey in the mutation cache after a save', async () => {
    vi.spyOn(api, 'PUT').mockResolvedValue({
      data: { data: SAVED },
      response: { status: 200 },
    } as unknown as PutResult);
    const queryClient = new QueryClient();
    await saveLikeTheForm(queryClient);
    expect(await heldAfterSettle(queryClient)).not.toContain(KEY);
    expect(queryClient.getQueryData(voiceConnectionKey)).toEqual(SAVED);
  });

  it('leaves no apiKey in the mutation cache after a failed save', async () => {
    vi.spyOn(api, 'PUT').mockResolvedValue({
      error: { error: { code: 'conflict', message: 'taken' } },
      response: { status: 409 },
    } as unknown as PutResult);
    const queryClient = new QueryClient();
    await saveLikeTheForm(queryClient);
    expect(await heldAfterSettle(queryClient)).not.toContain(KEY);
  });

  it('invalidates the voice status and every pre-call check after a save', async () => {
    vi.spyOn(api, 'PUT').mockResolvedValue({
      data: { data: SAVED },
      response: { status: 200 },
    } as unknown as PutResult);
    const queryClient = new QueryClient();
    queryClient.setQueryData(voiceStatusKey, { provider: 'none', connected: false, last4: null });
    queryClient.setQueryData(preflightKey('+12025550123', undefined), { to: '+12025550123' });
    await saveLikeTheForm(queryClient);
    expect(queryClient.getQueryState(voiceStatusKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(preflightKey('+12025550123', undefined))?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryData(voiceConnectionKey)).toEqual(SAVED);
  });

  it('invalidates nothing when the save fails', async () => {
    vi.spyOn(api, 'PUT').mockResolvedValue({
      error: { error: { code: 'conflict', message: 'taken' } },
      response: { status: 409 },
    } as unknown as PutResult);
    const queryClient = new QueryClient();
    queryClient.setQueryData(voiceStatusKey, { provider: 'none', connected: false, last4: null });
    await saveLikeTheForm(queryClient);
    expect(queryClient.getQueryState(voiceStatusKey)?.isInvalidated).toBe(false);
  });

  it('collects the mutation at once (gcTime 0)', () => {
    expect(saveVoiceConnectionOptions(new QueryClient()).gcTime).toBe(0);
  });
});

describe('voiceStatusKey', () => {
  it('is the voice status query key', () => {
    expect(voiceStatusKey).toEqual(['voice', 'status']);
  });

  it('is always stale, so every mount and focus fetches it again', () => {
    const options = voiceStatusQueryOptions();
    expect(options.queryKey).toEqual(voiceStatusKey);
    expect(options.staleTime).toBe(0);
  });
});

describe('disconnectVoiceOptions', () => {
  function seeded(): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData(voiceConnectionKey, SAVED);
    queryClient.setQueryData(voiceStatusKey, {
      provider: 'telnyx',
      connected: true,
      last4: 'only',
    });
    queryClient.setQueryData(preflightKey('+12025550123', undefined), { to: '+12025550123' });
    return queryClient;
  }

  async function disconnect(queryClient: QueryClient, onDisconnected?: () => void) {
    const observer = new MutationObserver(
      queryClient,
      disconnectVoiceOptions(queryClient, onDisconnected),
    );
    return observer.mutate();
  }

  it('clears the connection, invalidates status and preflight, and calls the hook', async () => {
    vi.spyOn(api, 'DELETE').mockResolvedValue({
      response: { status: 204 },
    } as unknown as DeleteResult);
    const queryClient = seeded();
    const onDisconnected = vi.fn();
    await disconnect(queryClient, onDisconnected);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(voiceConnectionKey)).toBeNull();
    expect(queryClient.getQueryState(voiceConnectionKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(voiceStatusKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(preflightKey('+12025550123', undefined))?.isInvalidated).toBe(
      true,
    );
  });

  it('tells every subscriber by default, until it unsubscribes', async () => {
    vi.spyOn(api, 'DELETE').mockResolvedValue({
      response: { status: 204 },
    } as unknown as DeleteResult);
    const listener = vi.fn();
    const unsubscribe = onVoiceDisconnected(listener);
    await disconnect(seeded());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await disconnect(seeded());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps everything and calls no hook when the delete fails', async () => {
    vi.spyOn(api, 'DELETE').mockResolvedValue({
      error: { error: { code: 'forbidden', message: 'no' } },
      response: { status: 403 },
    } as unknown as DeleteResult);
    const queryClient = seeded();
    const onDisconnected = vi.fn();
    await expect(disconnect(queryClient, onDisconnected)).rejects.toMatchObject({ status: 403 });
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(voiceConnectionKey)).toEqual(SAVED);
    expect(queryClient.getQueryState(voiceStatusKey)?.isInvalidated).toBe(false);
  });
});

describe('voiceConnectionErrorCopy', () => {
  it('names the provider the workspace is connected to instead', () => {
    expect(
      voiceConnectionErrorCopy(
        new ApiError(
          409,
          'This workspace is connected to Plivo. Disconnect Plivo first.',
          'connector_conflict',
        ),
      ),
    ).toBe('This workspace is connected to Plivo. Disconnect Plivo first.');
    expect(voiceConnectionErrorCopy(new ApiError(409, 'raw', 'validation_error'))).toBe(
      "This number can't be connected to this workspace.",
    );
  });
});
