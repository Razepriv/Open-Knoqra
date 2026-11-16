import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realtimeUrl, startRealtime } from './realtime';

class StubSocket {
  static instances: StubSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    StubSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  drop() {
    this.onclose?.();
  }
}

const ME = 'u_me';
const CALL = (state: string, id = 'cl_a', userId = ME) => ({
  id,
  userId,
  state,
  direction: 'outbound',
  createdAt: '2026-01-01T00:00:00.000Z',
});
const WALLET = {
  balanceMicros: 5,
  heldMicros: 0,
  availableMicros: 5,
  periodSpendMicros: 0,
  status: { outcome: 'ok', reason: 'ok' },
  dialStatus: { outcome: 'ok', reason: 'ok' },
};
const last = () => StubSocket.instances[StubSocket.instances.length - 1] as StubSocket;

function setup({ signedIn = true }: { signedIn?: boolean } = {}) {
  const queryClient = new QueryClient();
  if (signedIn) queryClient.setQueryData(['me'], { user: { id: ME } });
  const statuses: string[] = [];
  const stop = startRealtime({
    url: 'wss://app.test/api/v1/realtime',
    queryClient,
    WebSocketCtor: StubSocket as unknown as typeof WebSocket,
    onStatus: (s) => statuses.push(s),
  });
  return { queryClient, statuses, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  StubSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('realtimeUrl', () => {
  it('uses ws for http and wss for https, on the page origin', () => {
    expect(realtimeUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/api/v1/realtime',
    );
    expect(realtimeUrl({ protocol: 'https:', host: 'app.example.test' })).toBe(
      'wss://app.example.test/api/v1/realtime',
    );
  });
});

describe('startRealtime messages', () => {
  it('reports connecting then open', () => {
    const { statuses } = setup();
    expect(statuses).toEqual(['connecting']);
    last().open();
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('sets the active call and the call itself for a non-terminal update', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    expect(queryClient.getQueryData(['calls', 'active'])).toEqual(CALL('ringing'));
    expect(queryClient.getQueryData(['calls', 'cl_a'])).toEqual(CALL('ringing'));
  });

  it('nulls the active call for a terminal update but keeps the call', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    last().message({ type: 'call.updated', data: CALL('completed') });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeNull();
    expect(queryClient.getQueryData(['calls', 'cl_a'])).toEqual(CALL('completed'));
  });

  it('does not null the active call when another call ends', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('connected', 'cl_a') });
    last().message({ type: 'call.updated', data: CALL('busy', 'cl_other') });
    expect(queryClient.getQueryData(['calls', 'active'])).toEqual(CALL('connected', 'cl_a'));
  });

  it('invalidates the call lists on call.updated', () => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls', 'list'] });
  });

  it('sets the wallet on wallet.updated', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'wallet.updated', data: WALLET });
    expect(queryClient.getQueryData(['wallet'])).toEqual(WALLET);
  });

  it.each([
    ['x'],
    [[]],
    [null],
    [{ balanceMicros: 5 }],
    [{ ...WALLET, status: 'ok' }],
    [{ ...WALLET, dialStatus: undefined }],
  ])('refetches instead of caching a malformed wallet.updated (%j)', (data) => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    last().message({ type: 'wallet.updated', data });
    expect(queryClient.getQueryData(['wallet'])).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['wallet'] });
  });

  it('refetches calls instead of caching a call without direction or createdAt', () => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    last().message({ type: 'call.updated', data: { id: 'cl_a', state: 'ringing' } });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeUndefined();
    expect(queryClient.getQueryData(['calls', 'cl_a'])).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls'] });
  });

  it("only invalidates the list for another member's call in progress", () => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing', 'cl_b', 'u_other') });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeUndefined();
    expect(queryClient.getQueryData(['calls', 'cl_b'])).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls', 'list'] });
  });

  it("keeps the signed-in user's call when another member's call rings", () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('connected', 'cl_a') });
    last().message({ type: 'call.updated', data: CALL('ringing', 'cl_b', 'u_other') });
    last().message({ type: 'call.updated', data: CALL('completed', 'cl_b', 'u_other') });
    expect(queryClient.getQueryData(['calls', 'active'])).toEqual(CALL('connected', 'cl_a'));
  });

  it('refetches the active call instead of writing it while the user is unknown', () => {
    const { queryClient } = setup({ signedIn: false });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls', 'active'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls', 'list'] });
  });

  it('refetches calls instead of caching a call without its userId', () => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { userId: _drop, ...noUser } = CALL('ringing');
    last().open();
    last().message({ type: 'call.updated', data: noUser });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls'] });
  });

  it('ignores a call.updated that ranks below the cached state of the same call', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    last().message({ type: 'call.updated', data: CALL('connected') });
    last().message({ type: 'call.updated', data: CALL('ringing') });
    last().message({ type: 'call.updated', data: CALL('initiating') });
    expect(queryClient.getQueryData(['calls', 'active'])).toEqual(CALL('connected'));
    expect(queryClient.getQueryData(['calls', 'cl_a'])).toEqual(CALL('connected'));
  });

  it('never brings an ended call back from a late, lower-ranked update', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('connected') });
    last().message({ type: 'call.updated', data: CALL('completed') });
    last().message({ type: 'call.updated', data: CALL('ending') });
    last().message({ type: 'call.updated', data: CALL('connected') });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeNull();
    expect(queryClient.getQueryData(['calls', 'cl_a'])).toEqual(CALL('completed'));
  });

  it('applies an update of the same or a higher rank', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('ending') });
    last().message({ type: 'call.updated', data: { ...CALL('ending'), userId: ME } });
    last().message({ type: 'call.updated', data: CALL('busy') });
    expect(queryClient.getQueryData(['calls', 'cl_a'])).toEqual(CALL('busy'));
  });

  it('refetches the active call when another member takes my ringing call', () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().message({ type: 'call.updated', data: CALL('connected', 'cl_a', 'u_other') });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls', 'active'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls', 'list'] });
  });

  it("leaves my active call alone when another member's other call moves", () => {
    const { queryClient } = setup();
    last().open();
    last().message({ type: 'call.updated', data: CALL('connected') });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().message({ type: 'call.updated', data: CALL('connected', 'cl_b', 'u_other') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['calls', 'active'] });
    expect(queryClient.getQueryData(['calls', 'active'])).toEqual(CALL('connected'));
  });

  it('invalidates voicemails on voicemail.created', () => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    last().message({ type: 'voicemail.created', data: { id: 'vm_a' } });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['voicemails'] });
  });

  it('ignores pong, malformed and unknown frames', () => {
    const { queryClient } = setup();
    last().open();
    last().message('pong');
    last().message('{not json');
    last().message({ type: 'message.created', data: {} });
    expect(queryClient.getQueryData(['calls', 'active'])).toBeUndefined();
  });
});

describe('startRealtime connection', () => {
  it('pings every 25 seconds while open', () => {
    setup();
    last().open();
    vi.advanceTimersByTime(24_999);
    expect(last().sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(last().sent).toEqual(['ping']);
    vi.advanceTimersByTime(25_000);
    expect(last().sent).toEqual(['ping', 'ping']);
  });

  it('reconnects with backoff 1, 2, 4 ... capped at 30 seconds', () => {
    const { statuses } = setup();
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const count = StubSocket.instances.length;
      last().drop();
      let waited = 0;
      while (StubSocket.instances.length === count && waited < 40_000) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(statuses).toContain('closed');
  });

  it('resets the backoff after a successful open', () => {
    setup();
    last().drop();
    vi.advanceTimersByTime(1_000);
    last().drop();
    vi.advanceTimersByTime(2_000);
    last().open();
    last().drop();
    const count = StubSocket.instances.length;
    vi.advanceTimersByTime(999);
    expect(StubSocket.instances.length).toBe(count);
    vi.advanceTimersByTime(1);
    expect(StubSocket.instances.length).toBe(count + 1);
  });

  it('does not invalidate on the first open, but does on reconnect', () => {
    const { queryClient } = setup();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    last().open();
    expect(spy).not.toHaveBeenCalled();
    last().drop();
    vi.advanceTimersByTime(1_000);
    last().open();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['calls'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['wallet'] });
  });

  it('stops pinging after the socket drops', () => {
    setup();
    const first = last();
    first.open();
    first.drop();
    vi.advanceTimersByTime(60_000);
    expect(first.sent).toEqual([]);
  });

  it('starts no ping and applies nothing when stopped before the socket opens', () => {
    const { stop, queryClient } = setup();
    const ws = last();
    const onmessage = ws.onmessage;
    stop();
    ws.onopen?.();
    onmessage?.({ data: JSON.stringify({ type: 'wallet.updated', data: WALLET }) });
    vi.advanceTimersByTime(60_000);
    expect(ws.sent).toEqual([]);
    expect(queryClient.getQueryData(['wallet'])).toBeUndefined();
  });

  it('surfaces an apply failure instead of swallowing it', () => {
    const { queryClient } = setup();
    vi.spyOn(queryClient, 'setQueryData').mockImplementation(() => {
      throw new Error('cache broke');
    });
    const queued: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => {
      queued.push(fn);
    });
    last().open();
    last().message({ type: 'call.updated', data: CALL('ringing') });
    spy.mockRestore();
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow('cache broke');
  });

  it('closes the socket and never reconnects after stop', () => {
    const { stop, statuses } = setup();
    const first = last();
    first.open();
    stop();
    expect(first.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(StubSocket.instances.length).toBe(1);
    expect(statuses.at(-1)).toBe('closed');
  });
});
