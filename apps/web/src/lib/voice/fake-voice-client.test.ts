import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeVoiceClient,
  type FakeVoiceClientOptions,
  type FakeVoiceEventBody,
} from './fake-voice-client';
import { VoiceError } from './voice-client';

const CALL = 'cl_0123456789abcdef0123456789abcdef';
const DIAL = { callId: CALL, to: '+12025550123', from: '+12025550100', clientState: 'abc' };

type Posted = { callId: string; body: FakeVoiceEventBody };

function setup(options: Partial<FakeVoiceClientOptions> = {}) {
  const posted: Posted[] = [];
  const client = new FakeVoiceClient({
    post: async (callId, body) => {
      posted.push({ callId, body });
    },
    delays: { ringing: 0, answer: 0 },
    ...options,
  });
  return { client, posted };
}

const events = (posted: Posted[]) => posted.map((p) => p.body.event);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('FakeVoiceClient.dial', () => {
  it('posts initiated, ringing, then answered for an ordinary number', async () => {
    const { client, posted } = setup();
    await client.connect({ provider: 'fake', token: 't' });
    await client.dial(DIAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(posted).toEqual([
      { callId: CALL, body: { event: 'initiated' } },
      { callId: CALL, body: { event: 'ringing' } },
      { callId: CALL, body: { event: 'answered' } },
    ]);
  });

  it.each([
    ['+12025550190', 'busy'],
    ['+12025550191', 'no_answer'],
    ['+12025550192', 'failed'],
  ])('ends %s as completed with cause %s and never answers', async (to, cause) => {
    const { client, posted } = setup();
    await client.dial({ ...DIAL, to });
    await vi.advanceTimersByTimeAsync(0);
    expect(posted.map((p) => p.body)).toEqual([
      { event: 'initiated' },
      { event: 'ringing' },
      { event: 'completed', hangupCause: cause },
    ]);
  });

  it('honors the default ringing and answer delays', async () => {
    const posted: Posted[] = [];
    const client = new FakeVoiceClient({
      post: async (callId, body) => {
        posted.push({ callId, body });
      },
    });
    await client.dial(DIAL);
    expect(events(posted)).toEqual(['initiated']);
    await vi.advanceTimersByTimeAsync(599);
    expect(events(posted)).toEqual(['initiated']);
    await vi.advanceTimersByTimeAsync(1);
    expect(events(posted)).toEqual(['initiated', 'ringing']);
    await vi.advanceTimersByTimeAsync(1_199);
    expect(events(posted)).toEqual(['initiated', 'ringing']);
    await vi.advanceTimersByTimeAsync(1);
    expect(events(posted)).toEqual(['initiated', 'ringing', 'answered']);
  });

  it('asks for the microphone first and releases the tracks at once', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }, { stop }] }));
    const { client, posted } = setup({ getUserMedia });
    await client.dial(DIAL);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(events(posted)[0]).toBe('initiated');
  });

  it.each([
    ['NotAllowedError', 'mic_denied'],
    ['SecurityError', 'mic_denied'],
    ['NotFoundError', 'mic_unavailable'],
    ['NotReadableError', 'mic_unavailable'],
  ])('maps %s to VoiceError(%s) and posts nothing', async (name, code) => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('no', name);
    });
    const { client, posted } = setup({ getUserMedia });
    await expect(client.dial(DIAL)).rejects.toMatchObject({ name: 'VoiceError', code });
    await expect(client.dial(DIAL)).rejects.toBeInstanceOf(VoiceError);
    expect(posted).toEqual([]);
  });

  it('wraps a failed initiated post as dial_failed', async () => {
    const client = new FakeVoiceClient({
      post: async () => {
        throw new Error('network');
      },
      delays: { ringing: 0, answer: 0 },
    });
    await expect(client.dial(DIAL)).rejects.toMatchObject({ code: 'dial_failed' });
  });

  it('reports a failed later post through onError instead of dropping it', async () => {
    const onError = vi.fn();
    let n = 0;
    const client = new FakeVoiceClient({
      post: async () => {
        n += 1;
        if (n === 2) throw new Error('boom');
      },
      delays: { ringing: 0, answer: 0 },
      onError,
    });
    await client.dial(DIAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('FakeVoiceClient.hangup', () => {
  it('posts completed with whole billable seconds since answered', async () => {
    const { client, posted } = setup();
    await client.dial(DIAL);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(61_400);
    await client.hangup(CALL);
    expect(posted.at(-1)).toEqual({
      callId: CALL,
      body: { event: 'completed', hangupCause: 'normal', billableSeconds: 61 },
    });
  });

  it('bills at least one second', async () => {
    const { client, posted } = setup();
    await client.dial(DIAL);
    await vi.advanceTimersByTimeAsync(0);
    await client.hangup(CALL);
    expect(posted.at(-1)?.body).toEqual({
      event: 'completed',
      hangupCause: 'normal',
      billableSeconds: 1,
    });
  });

  it('cancels a call that is still ringing and stops the script', async () => {
    const posted: Posted[] = [];
    const client = new FakeVoiceClient({
      post: async (callId, body) => {
        posted.push({ callId, body });
      },
    });
    await client.dial(DIAL);
    await vi.advanceTimersByTimeAsync(600);
    await client.hangup(CALL);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(posted.map((p) => p.body)).toEqual([
      { event: 'initiated' },
      { event: 'ringing' },
      { event: 'completed', hangupCause: 'canceled' },
    ]);
  });

  it('does not post a second completed after the scenario already ended the call', async () => {
    const { client, posted } = setup();
    await client.dial({ ...DIAL, to: '+12025550190' });
    await vi.advanceTimersByTimeAsync(0);
    const before = posted.length;
    await client.hangup(CALL);
    expect(posted.length).toBe(before);
  });
});

describe('FakeVoiceClient.answer', () => {
  it('posts answered and bills from then', async () => {
    const { client, posted } = setup();
    await client.answer({ callId: CALL, clientState: 'abc' });
    expect(posted).toEqual([{ callId: CALL, body: { event: 'answered' } }]);
    await vi.advanceTimersByTimeAsync(3_000);
    await client.hangup(CALL);
    expect(posted.at(-1)?.body).toMatchObject({ event: 'completed', billableSeconds: 3 });
  });

  it('asks for the microphone before answering', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('no', 'NotAllowedError');
    });
    const { client, posted } = setup({ getUserMedia });
    await expect(client.answer({ callId: CALL, clientState: 'abc' })).rejects.toMatchObject({
      code: 'mic_denied',
    });
    expect(posted).toEqual([]);
  });
});

describe('FakeVoiceClient teardown', () => {
  it('disconnect cancels pending timers so nothing more is posted', async () => {
    const posted: Posted[] = [];
    const client = new FakeVoiceClient({
      post: async (callId, body) => {
        posted.push({ callId, body });
      },
    });
    await client.dial(DIAL);
    client.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events(posted)).toEqual(['initiated']);
  });

  it('a hangup during the in-flight ringing post posts no answered', async () => {
    const posted: Posted[] = [];
    let releaseRinging: () => void = () => {};
    const client = new FakeVoiceClient({
      post: async (callId, body) => {
        if (body.event === 'ringing') {
          await new Promise<void>((resolve) => {
            releaseRinging = resolve;
          });
        }
        posted.push({ callId, body });
      },
      delays: { ringing: 0, answer: 0 },
    });
    await client.dial(DIAL);
    await vi.advanceTimersByTimeAsync(0);
    const hangup = client.hangup(CALL);
    releaseRinging();
    await hangup;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(events(posted)).not.toContain('answered');
    expect(posted.map((p) => p.body)).toContainEqual({
      event: 'completed',
      hangupCause: 'canceled',
    });
  });
});

describe('FakeVoiceClient misc', () => {
  it('has harmless mute, digits and disconnect', async () => {
    const { client } = setup();
    client.setMuted(true);
    client.sendDigits('12#');
    client.disconnect();
    await expect(client.connect({ provider: 'fake', token: 't' })).resolves.toBeUndefined();
  });
});
