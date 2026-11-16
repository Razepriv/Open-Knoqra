import { describe, expect, it, vi } from 'vitest';
import { type RemoteAudio, type TelnyxClientCtor, TelnyxVoiceClient } from './telnyx-voice-client';
import { VoiceError } from './voice-client';

type Handler = (payload?: unknown) => void;

class StubCall {
  hangup = vi.fn();
  answer = vi.fn();
  muteAudio = vi.fn();
  unmuteAudio = vi.fn();
  dtmf = vi.fn();
}

class StubClient {
  static last: StubClient | undefined;
  /** The event `connect` fires on the next microtask. */
  mode = 'telnyx.ready';
  handlers = new Map<string, Handler>();
  call = new StubCall();
  disconnected = false;
  newCall = vi.fn((_options: unknown) => this.call);
  constructor(readonly options: { login_token: string }) {
    StubClient.last = this;
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  off(event: string) {
    this.handlers.delete(event);
    return this;
  }
  connect() {
    queueMicrotask(() => this.handlers.get(this.mode)?.());
  }
  disconnect() {
    this.disconnected = true;
  }
  emit(event: string, payload?: unknown) {
    this.handlers.get(event)?.(payload);
  }
}

function harness(mode = 'telnyx.ready') {
  class Ctor extends StubClient {
    constructor(options: { login_token: string }) {
      super(options);
      this.mode = mode;
    }
  }
  return {
    Ctor: Ctor as unknown as TelnyxClientCtor,
    instance: () => StubClient.last as StubClient,
  };
}

const DIAL = {
  callId: 'cl_0123456789abcdef0123456789abcdef',
  to: '+12025550123',
  from: '+12025550100',
  clientState: 'abc123',
};

async function connected() {
  const h = harness();
  const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }) });
  await client.connect({ provider: 'telnyx', token: 'jwt-token' });
  return { client, stub: h.instance() };
}

describe('TelnyxVoiceClient', () => {
  it('connects with the login token once the SDK is ready', async () => {
    const { stub } = await connected();
    expect(stub.options).toEqual({ login_token: 'jwt-token' });
  });

  it('fails connect_failed when the SDK reports an error', async () => {
    const h = harness('telnyx.error');
    const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }) });
    await expect(client.connect({ provider: 'telnyx', token: 't' })).rejects.toMatchObject({
      code: 'connect_failed',
    });
  });

  it('disposes the SDK client when connect fails', async () => {
    const h = harness('telnyx.error');
    const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }) });
    await expect(client.connect({ provider: 'telnyx', token: 't' })).rejects.toBeInstanceOf(
      VoiceError,
    );
    const stub = h.instance();
    expect(stub.disconnected).toBe(true);
    expect(stub.handlers.size).toBe(0);
  });

  it('disposes the SDK client when connect times out', async () => {
    vi.useFakeTimers();
    try {
      const h = harness('never');
      const client = new TelnyxVoiceClient({
        loadSdk: async () => ({ TelnyxRTC: h.Ctor }),
        connectTimeoutMs: 1_000,
      });
      const result = client.connect({ provider: 'telnyx', token: 't' });
      const assertion = expect(result).rejects.toMatchObject({ code: 'connect_failed' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(h.instance().disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects the first client when connecting again', async () => {
    const h = harness();
    const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }) });
    await client.connect({ provider: 'telnyx', token: 'a' });
    const one = h.instance();
    await client.connect({ provider: 'telnyx', token: 'b' });
    expect(one.disconnected).toBe(true);
    expect(h.instance()).not.toBe(one);
  });

  it('reports SDK errors after ready through onError', async () => {
    const h = harness();
    const onError = vi.fn();
    const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }), onError });
    await client.connect({ provider: 'telnyx', token: 't' });
    h.instance().emit('telnyx.socket.error');
    h.instance().emit('telnyx.error');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'connect_failed' });
  });

  it('forgets a call the SDK says has hung up or been destroyed', async () => {
    const { client, stub } = await connected();
    await client.dial(DIAL);
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(stub.call, { state: 'hangup' }),
    });
    client.sendDigits('1');
    client.setMuted(true);
    expect(stub.call.dtmf).not.toHaveBeenCalled();
    expect(stub.call.muteAudio).not.toHaveBeenCalled();

    const incoming = new StubCall();
    const ring = Object.assign(incoming, { state: 'ringing', direction: 'inbound' });
    stub.emit('telnyx.notification', { type: 'callUpdate', call: ring });
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(incoming, { state: 'destroy' }),
    });
    await expect(client.answer({ callId: DIAL.callId, clientState: 'x' })).rejects.toMatchObject({
      code: 'dial_failed',
    });
  });

  it('hangup acts only on the matching call', async () => {
    const { client, stub } = await connected();
    await client.dial(DIAL);
    await client.hangup('cl_other');
    expect(stub.call.hangup).not.toHaveBeenCalled();
    await client.hangup(DIAL.callId);
    expect(stub.call.hangup).toHaveBeenCalledTimes(1);
  });

  it('fails connect_failed when the SDK cannot load', async () => {
    const client = new TelnyxVoiceClient({
      loadSdk: async () => {
        throw new Error('chunk failed');
      },
    });
    await expect(client.connect({ provider: 'telnyx', token: 't' })).rejects.toBeInstanceOf(
      VoiceError,
    );
  });

  it('rejects a fake credential', async () => {
    const h = harness();
    const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }) });
    await expect(client.connect({ provider: 'fake', token: 't' })).rejects.toMatchObject({
      code: 'connect_failed',
    });
  });

  it('dials with base64 client state', async () => {
    const { client, stub } = await connected();
    await client.dial(DIAL);
    expect(stub.newCall).toHaveBeenCalledWith({
      destinationNumber: '+12025550123',
      callerNumber: '+12025550100',
      clientState: btoa('abc123'),
    });
  });

  it('rejects dial before connect', async () => {
    const h = harness();
    const client = new TelnyxVoiceClient({ loadSdk: async () => ({ TelnyxRTC: h.Ctor }) });
    await expect(client.dial(DIAL)).rejects.toMatchObject({ code: 'dial_failed' });
  });

  it('wraps a newCall throw as dial_failed', async () => {
    const { client, stub } = await connected();
    stub.newCall.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(client.dial(DIAL)).rejects.toMatchObject({ code: 'dial_failed' });
  });

  it('hangs up, mutes, unmutes and sends digits on the live call', async () => {
    const { client, stub } = await connected();
    await client.dial(DIAL);
    client.setMuted(true);
    client.setMuted(false);
    client.sendDigits('12#');
    await client.hangup(DIAL.callId);
    expect(stub.call.muteAudio).toHaveBeenCalledTimes(1);
    expect(stub.call.unmuteAudio).toHaveBeenCalledTimes(1);
    expect(stub.call.dtmf).toHaveBeenCalledWith('12#');
    expect(stub.call.hangup).toHaveBeenCalledTimes(1);
  });

  it('answers the incoming call announced by the SDK', async () => {
    const { client, stub } = await connected();
    const incoming = new StubCall();
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(incoming, { state: 'ringing', direction: 'inbound' }),
    });
    await client.answer({ callId: DIAL.callId, clientState: 'abc123' });
    expect(incoming.answer).toHaveBeenCalledTimes(1);
    await client.hangup(DIAL.callId);
    expect(incoming.hangup).toHaveBeenCalledTimes(1);
  });

  it('rejects answer when nothing is ringing', async () => {
    const { client } = await connected();
    await expect(client.answer({ callId: DIAL.callId, clientState: 'x' })).rejects.toMatchObject({
      code: 'dial_failed',
    });
  });

  it('maps a denied microphone before dialing', async () => {
    const h = harness();
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('no', 'NotAllowedError');
    });
    const client = new TelnyxVoiceClient({
      loadSdk: async () => ({ TelnyxRTC: h.Ctor }),
      getUserMedia,
    });
    await client.connect({ provider: 'telnyx', token: 't' });
    await expect(client.dial(DIAL)).rejects.toMatchObject({ code: 'mic_denied' });
    expect(h.instance().newCall).not.toHaveBeenCalled();
  });

  it('disconnects the SDK client', async () => {
    const { client, stub } = await connected();
    client.disconnect();
    expect(stub.disconnected).toBe(true);
  });
});

describe('TelnyxVoiceClient remote audio', () => {
  /** A stand-in for the hidden <audio> element, one per call. */
  function fakeAudio() {
    const made: Array<{
      element: { srcObject: unknown; play: ReturnType<typeof vi.fn> };
      release: ReturnType<typeof vi.fn>;
    }> = [];
    const createRemoteAudio = vi.fn(() => {
      const audio = {
        element: { srcObject: null as unknown, play: vi.fn(async () => {}) },
        release: vi.fn(),
      };
      made.push(audio);
      return audio as unknown as RemoteAudio;
    });
    return { made, createRemoteAudio };
  }

  async function withAudio() {
    const h = harness();
    const audio = fakeAudio();
    const client = new TelnyxVoiceClient({
      loadSdk: async () => ({ TelnyxRTC: h.Ctor }),
      createRemoteAudio: audio.createRemoteAudio,
    });
    await client.connect({ provider: 'telnyx', token: 'jwt-token' });
    return { client, stub: h.instance(), audio };
  }

  it('gives each dialed call its own remote element, released on hangup', async () => {
    const { client, stub, audio } = await withAudio();
    await client.dial(DIAL);
    const [first] = audio.made;
    expect(stub.newCall).toHaveBeenCalledWith(
      expect.objectContaining({ remoteElement: first?.element }),
    );
    await client.hangup(DIAL.callId);
    expect(first?.release).toHaveBeenCalledTimes(1);
  });

  it('plays an answered call through its own remote element', async () => {
    const { client, stub, audio } = await withAudio();
    const incoming = new StubCall();
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(incoming, { state: 'ringing', direction: 'inbound' }),
    });
    await client.answer({ callId: DIAL.callId, clientState: 'abc123' });
    expect(incoming.answer).toHaveBeenCalledWith({ remoteElement: audio.made[0]?.element });
  });

  it('releases the element when the SDK ends the call, and on disconnect', async () => {
    const { client, stub, audio } = await withAudio();
    await client.dial(DIAL);
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(stub.call, { state: 'hangup' }),
    });
    expect(audio.made[0]?.release).toHaveBeenCalledTimes(1);

    await client.dial(DIAL);
    client.disconnect();
    expect(audio.made[1]?.release).toHaveBeenCalledTimes(1);
  });

  it('attaches the remote stream itself when the live call has none on its element', async () => {
    const { client, stub, audio } = await withAudio();
    await client.dial(DIAL);
    const remoteStream = { id: 'remote' };
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(stub.call, { state: 'active', remoteStream }),
    });
    expect(audio.made[0]?.element.srcObject).toBe(remoteStream);
    expect(audio.made[0]?.element.play).toHaveBeenCalledTimes(1);
  });

  it('leaves an element the SDK already attached alone', async () => {
    const { client, stub, audio } = await withAudio();
    await client.dial(DIAL);
    const attached = { id: 'from-sdk' };
    const element = audio.made[0]?.element;
    if (element) element.srcObject = attached;
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(stub.call, { state: 'active', remoteStream: { id: 'other' } }),
    });
    expect(element?.srcObject).toBe(attached);
    expect(element?.play).not.toHaveBeenCalled();
  });

  it('releases the element when newCall throws', async () => {
    const { client, stub, audio } = await withAudio();
    stub.newCall.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(client.dial(DIAL)).rejects.toMatchObject({ code: 'dial_failed' });
    expect(audio.made[0]?.release).toHaveBeenCalledTimes(1);
  });
});

describe('TelnyxVoiceClient leg end', () => {
  async function withEnded() {
    const h = harness();
    const onCallEnded = vi.fn();
    const client = new TelnyxVoiceClient({
      loadSdk: async () => ({ TelnyxRTC: h.Ctor }),
      onCallEnded,
    });
    await client.connect({ provider: 'telnyx', token: 'jwt-token' });
    return { client, stub: h.instance(), onCallEnded };
  }

  it('reports our own hangup at once', async () => {
    const { client, onCallEnded } = await withEnded();
    await client.dial(DIAL);
    await client.hangup(DIAL.callId);
    expect(onCallEnded).toHaveBeenCalledExactlyOnceWith(DIAL.callId);
  });

  it('reports the far end hanging up, once', async () => {
    const { client, stub, onCallEnded } = await withEnded();
    await client.dial(DIAL);
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(stub.call, { state: 'hangup' }),
    });
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(stub.call, { state: 'destroy' }),
    });
    expect(onCallEnded).toHaveBeenCalledExactlyOnceWith(DIAL.callId);
  });

  it('says nothing for a call that is not the live one', async () => {
    const { client, stub, onCallEnded } = await withEnded();
    await client.hangup(DIAL.callId);
    const other = new StubCall();
    stub.emit('telnyx.notification', {
      type: 'callUpdate',
      call: Object.assign(other, { state: 'hangup' }),
    });
    expect(onCallEnded).not.toHaveBeenCalled();
  });
});
