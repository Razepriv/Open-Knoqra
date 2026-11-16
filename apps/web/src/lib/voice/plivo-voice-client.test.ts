import { describe, expect, it, vi } from 'vitest';
import { CLIENT_STATE_HEADER, type PlivoSdkCtor, PlivoVoiceClient } from './plivo-voice-client';
import { VoiceError } from './voice-client';

type Handler = (...args: unknown[]) => void;

class StubClient {
  handlers = new Map<string, Handler>();
  /** What `loginWithAccessToken` fires on the next microtask. */
  loginResult: 'onLogin' | 'onLoginFailed' | 'never' = 'onLogin';
  accepted = true;
  token: string | null = null;
  call = vi.fn((_to: string, _headers: Record<string, string>) => this.accepted);
  answer = vi.fn((_uuid?: string, _action?: string) => true);
  hangup = vi.fn(() => true);
  reject = vi.fn(() => true);
  mute = vi.fn(() => true);
  unmute = vi.fn(() => true);
  sendDtmf = vi.fn((_digit: string) => undefined);
  logout = vi.fn(() => true);
  removeAllListeners = vi.fn((event?: string) => {
    if (event) this.handlers.delete(event);
  });
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  loginWithAccessToken(token: string) {
    this.token = token;
    if (this.loginResult !== 'never') {
      const event = this.loginResult;
      queueMicrotask(() => this.handlers.get(event)?.());
    }
    return true;
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
}

function harness(setup: (client: StubClient) => void = () => undefined) {
  let last: StubClient | undefined;
  const options: Record<string, unknown>[] = [];
  class Sdk {
    client: StubClient;
    constructor(opts: Record<string, unknown>) {
      options.push(opts);
      this.client = new StubClient();
      setup(this.client);
      last = this.client;
    }
  }
  return {
    loadSdk: async () => Sdk as unknown as PlivoSdkCtor,
    client: () => last as StubClient,
    options,
  };
}

const CRED = { provider: 'plivo' as const, token: 'eyJ.jwt.token' };
const DIAL = {
  callId: 'cl_0123456789abcdef0123456789abcdef',
  to: '+12025550123',
  from: '+12025550110',
  clientState: '0123456789abcdef0123456789abcdef',
};

describe('PlivoVoiceClient', () => {
  it('logs in with the access token, then dials with the client state header', async () => {
    const h = harness();
    const client = new PlivoVoiceClient({ loadSdk: h.loadSdk });
    await client.connect(CRED);
    expect(h.client().token).toBe('eyJ.jwt.token');
    expect(h.options[0]).toMatchObject({ permOnClick: true });
    await client.dial(DIAL);
    expect(h.client().call).toHaveBeenCalledWith('+12025550123', {
      [CLIENT_STATE_HEADER]: '0123456789abcdef0123456789abcdef',
    });
  });

  it('keeps the header within the SDK’s rules for custom headers', () => {
    expect(CLIENT_STATE_HEADER.slice('X-PH-'.length)).toMatch(/^[A-Za-z0-9-]{1,19}$/);
    expect(DIAL.clientState).toMatch(/^[a-z0-9A-Z_\-+()%.]{1,120}$/);
  });

  it('refuses another provider’s credential and a failed or silent login', async () => {
    await expect(
      new PlivoVoiceClient({ loadSdk: harness().loadSdk }).connect({
        provider: 'telnyx',
        token: 't',
      }),
    ).rejects.toBeInstanceOf(VoiceError);
    const failed = harness((c) => {
      c.loginResult = 'onLoginFailed';
    });
    await expect(
      new PlivoVoiceClient({ loadSdk: failed.loadSdk }).connect(CRED),
    ).rejects.toMatchObject({
      code: 'connect_failed',
    });
    expect(failed.client().logout).toHaveBeenCalled();
    const silent = harness((c) => {
      c.loginResult = 'never';
    });
    await expect(
      new PlivoVoiceClient({ loadSdk: silent.loadSdk, connectTimeoutMs: 5 }).connect(CRED),
    ).rejects.toMatchObject({ code: 'connect_failed' });
  });

  it('fails a dial the SDK does not place, or one before connect', async () => {
    await expect(new PlivoVoiceClient().dial(DIAL)).rejects.toMatchObject({ code: 'dial_failed' });
    const h = harness((c) => {
      c.accepted = false;
    });
    const client = new PlivoVoiceClient({ loadSdk: h.loadSdk });
    await client.connect(CRED);
    await expect(client.dial(DIAL)).rejects.toMatchObject({ code: 'dial_failed' });
  });

  it('answers the ringing call by its id', async () => {
    const h = harness();
    const client = new PlivoVoiceClient({ loadSdk: h.loadSdk });
    await client.connect(CRED);
    await expect(client.answer({ callId: 'cl_in', clientState: 'x' })).rejects.toBeInstanceOf(
      VoiceError,
    );
    h.client().emit('onIncomingCall', 'caller@phone.plivo.com', {}, { callUUID: 'uuid-in-1' });
    await client.answer({ callId: 'cl_in', clientState: 'x' });
    expect(h.client().answer).toHaveBeenCalledWith('uuid-in-1', 'reject');
  });

  it('hangs up, mutes and sends digits only for the live call', async () => {
    const h = harness();
    const client = new PlivoVoiceClient({ loadSdk: h.loadSdk });
    await client.connect(CRED);
    client.setMuted(true);
    client.sendDigits('1');
    expect(h.client().mute).not.toHaveBeenCalled();
    await client.dial(DIAL);
    client.setMuted(true);
    client.setMuted(false);
    client.sendDigits('12#');
    expect(h.client().mute).toHaveBeenCalledTimes(1);
    expect(h.client().unmute).toHaveBeenCalledTimes(1);
    expect(h.client().sendDtmf.mock.calls.map((c) => c[0])).toEqual(['1', '2', '#']);
    await client.hangup('cl_other');
    expect(h.client().hangup).not.toHaveBeenCalled();
    await client.hangup(DIAL.callId);
    expect(h.client().hangup).toHaveBeenCalledTimes(1);
  });

  it('reports a failed live call and logs out on disconnect', async () => {
    const onError = vi.fn();
    const h = harness();
    const client = new PlivoVoiceClient({ loadSdk: h.loadSdk, onError });
    await client.connect(CRED);
    await client.dial(DIAL);
    h.client().emit('onCallFailed', 'Busy');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'dial_failed' }));
    client.disconnect();
    expect(h.client().logout).toHaveBeenCalled();
    expect(h.client().removeAllListeners).toHaveBeenCalledWith('onLogin');
  });
});
