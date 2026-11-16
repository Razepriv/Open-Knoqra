// @vitest-environment jsdom
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { type Call, callKey } from '../../lib/calls';
import type { VoiceProvider } from '../../lib/voice';
import { disconnectVoiceOptions, voiceStatusKey } from '../../lib/voice-connection';
import type {
  CallSessionValue,
  CallSessionProvider as Provider,
  useCallSession as UseCallSession,
} from './call-session';

interface StubClient {
  provider: VoiceProvider;
  connect: ReturnType<typeof vi.fn>;
  dial: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

const voice = vi.hoisted(() => ({ clients: [] as StubClient[] }));
const startCall = vi.hoisted(() => vi.fn());

vi.mock('../../lib/voice', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/voice')>()),
  createVoiceClient: (provider: VoiceProvider) => {
    const client: StubClient = {
      provider,
      connect: vi.fn().mockResolvedValue(undefined),
      dial: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    voice.clients.push(client);
    return {
      ...client,
      answer: vi.fn(),
      hangup: vi.fn().mockResolvedValue(undefined),
      setMuted: vi.fn(),
      sendDigits: vi.fn(),
    };
  },
}));

vi.mock('../../lib/calls', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/calls')>()),
  useStartCall: () => ({ mutateAsync: startCall }),
  useCancelCall: () => ({ mutateAsync: vi.fn() }),
  useAnswerCall: () => ({ mutateAsync: vi.fn() }),
}));

type DeleteResult = Awaited<ReturnType<typeof api.DELETE>>;

const CALL_ID = 'call_1';
function ok<T>(data: T) {
  return { data: { data }, response: { status: 200 } };
}
const callIn = (state: string): Call =>
  ({ id: CALL_ID, direction: 'outbound', state, outcome: null }) as unknown as Call;

let CallSessionProvider: typeof Provider;
let useCallSession: typeof UseCallSession;
let session: CallSessionValue;
let callState: string;
let tokens: number;
let statusFetches: number;
/** When set, the next token request waits for this promise before it answers. */
let tokenGate: Promise<void> | null;
/** When set, token requests answer with this failure. */
let tokenFailure: { status: number; code: string } | null;

// The first import of the session (the UI kit, the voice clients) is slow under jsdom.
beforeAll(async () => {
  ({ CallSessionProvider, useCallSession } = await import('./call-session'));
}, 60_000);

beforeEach(() => {
  voice.clients.length = 0;
  tokens = 0;
  statusFetches = 0;
  tokenGate = null;
  tokenFailure = null;
  callState = 'completed';
  startCall.mockReset().mockResolvedValue({
    call: callIn('initiated'),
    dial: { to: '+12025550123', from: '+12025550100', clientState: 'cs' },
  });
  vi.spyOn(api, 'GET').mockImplementation((async (path: string) => {
    if (path === '/api/v1/voice/status') {
      statusFetches += 1;
      return ok({ provider: 'fake', connected: false, last4: null });
    }
    if (path === '/api/v1/calls/active') return { data: { data: null }, response: { status: 200 } };
    return ok(callIn(callState));
  }) as unknown as typeof api.GET);
  vi.spyOn(api, 'POST').mockImplementation((async () => {
    tokens += 1;
    const gate = tokenGate;
    tokenGate = null;
    if (gate) await gate;
    if (tokenFailure) {
      return {
        error: { error: { code: tokenFailure.code, message: 'refused' } },
        response: { status: tokenFailure.status },
      };
    }
    return ok({
      provider: 'fake',
      token: `token-${tokens}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  }) as unknown as typeof api.POST);
  vi.spyOn(api, 'DELETE').mockResolvedValue({
    response: { status: 204 },
  } as unknown as DeleteResult);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Probe() {
  session = useCallSession();
  return null;
}

function renderSession(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CallSessionProvider realtimeStatus="open">
        <Probe />
      </CallSessionProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

async function dial() {
  await act(async () => {
    await session.dial({ to: '+12025550123', reviewConfirmed: true });
  });
}

async function disconnectTelnyx(queryClient: QueryClient) {
  await act(async () => {
    await new MutationObserver(queryClient, disconnectVoiceOptions(queryClient)).mutate();
  });
}

describe('the call session after Disconnect Telnyx', () => {
  it('drops the voice client, and the next dial mints a fresh token', async () => {
    const queryClient = renderSession();
    await dial();
    expect(voice.clients).toHaveLength(1);
    await waitFor(() => expect(session.current?.state).toBe('completed'));

    await disconnectTelnyx(queryClient);
    expect(voice.clients[0]?.disconnect).toHaveBeenCalledTimes(1);

    await dial();
    expect(tokens).toBe(2);
    expect(voice.clients).toHaveLength(2);
    expect(voice.clients[1]?.disconnect).not.toHaveBeenCalled();
  });

  it('keeps the line of a call in progress, and drops it once that call ends', async () => {
    callState = 'answered';
    const queryClient = renderSession();
    await dial();
    await waitFor(() => expect(session.current?.state).toBe('answered'));

    await disconnectTelnyx(queryClient);
    expect(voice.clients[0]?.disconnect).not.toHaveBeenCalled();

    act(() => {
      queryClient.setQueryData(callKey(CALL_ID), callIn('completed'));
    });
    await waitFor(() => expect(voice.clients[0]?.disconnect).toHaveBeenCalledTimes(1));

    await dial();
    expect(tokens).toBe(2);
  });
});

describe('the call session when the voice status changes', () => {
  it('drops the client when the provider changes, and keeps it when it does not', async () => {
    const queryClient = renderSession();
    await waitFor(() => expect(queryClient.getQueryData(voiceStatusKey)).toBeDefined());
    await dial();
    await waitFor(() => expect(session.current?.state).toBe('completed'));

    act(() => {
      queryClient.setQueryData(voiceStatusKey, {
        provider: 'fake',
        connected: true,
        last4: 'abcd',
      });
    });
    expect(voice.clients[0]?.disconnect).not.toHaveBeenCalled();

    act(() => {
      queryClient.setQueryData(voiceStatusKey, { provider: 'none', connected: false, last4: null });
    });
    await waitFor(() => expect(voice.clients[0]?.disconnect).toHaveBeenCalledTimes(1));
  });
});

describe('the call session while a token is being minted', () => {
  it('throws away a line minted across a disconnect, and the next dial mints again', async () => {
    const queryClient = renderSession();
    let release: () => void = () => undefined;
    tokenGate = new Promise((resolve) => {
      release = resolve;
    });
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = session.dial({ to: '+12025550123', reviewConfirmed: true });
    });
    await waitFor(() => expect(tokens).toBe(1));

    await disconnectTelnyx(queryClient);
    await act(async () => {
      release();
      await first;
    });
    expect(voice.clients).toHaveLength(1);
    expect(voice.clients[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(startCall).not.toHaveBeenCalled();
    expect(session.error).not.toBeNull();

    await dial();
    expect(tokens).toBe(2);
    expect(voice.clients).toHaveLength(2);
    expect(voice.clients[1]?.disconnect).not.toHaveBeenCalled();
    expect(voice.clients[1]?.dial).toHaveBeenCalledTimes(1);
  });
});

describe('the call session when the server says calling is not set up', () => {
  it('fetches the voice status again', async () => {
    renderSession();
    await waitFor(() => expect(statusFetches).toBe(1));
    tokenFailure = { status: 409, code: 'voice_not_configured' };
    await dial();
    expect(session.error).not.toBeNull();
    await waitFor(() => expect(statusFetches).toBe(2));
  });

  it('leaves the status alone for other failures', async () => {
    renderSession();
    await waitFor(() => expect(statusFetches).toBe(1));
    tokenFailure = { status: 502, code: 'internal_error' };
    await dial();
    expect(session.error).not.toBeNull();
    expect(statusFetches).toBe(1);
  });
});
