import {
  type AnswerInput,
  checkMicrophone,
  type DialInput,
  type GetUserMedia,
  type VoiceClient,
  type VoiceCredential,
  VoiceError,
} from './voice-client';

/** The slice of a Telnyx call this client uses. */
export interface TelnyxCallLike {
  answer(options?: { remoteElement?: HTMLMediaElement }): void;
  hangup(): void;
  muteAudio(): void;
  unmuteAudio(): void;
  dtmf(digits: string): void;
}

/**
 * A hidden media element that plays one call's remote audio. The SDK plays nothing unless it is
 * given one, and its docs ask for one element per call so two calls never share a stream.
 */
export interface RemoteAudio {
  element: HTMLMediaElement;
  /** Detaches the stream and removes the element. */
  release(): void;
}

export type CreateRemoteAudio = () => RemoteAudio | null;

/** A hidden `<audio autoplay playsinline>` on the page; null outside a browser. */
const defaultCreateRemoteAudio: CreateRemoteAudio = () => {
  if (typeof document === 'undefined') return null;
  const element = document.createElement('audio');
  element.autoplay = true;
  element.setAttribute('playsinline', '');
  element.hidden = true;
  element.dataset.callAudio = '';
  document.body.appendChild(element);
  return {
    element,
    release: () => {
      element.pause();
      element.srcObject = null;
      element.remove();
    },
  };
};

/** The slice of `TelnyxRTC` this client uses, typed locally so tests can inject a stub. */
export interface TelnyxClientLike {
  on(event: string, handler: (payload?: unknown) => void): unknown;
  off(event: string, handler?: (payload?: unknown) => void): unknown;
  connect(): unknown;
  disconnect(): void;
  newCall(options: {
    destinationNumber: string;
    callerNumber: string;
    clientState: string;
    remoteElement?: HTMLMediaElement;
  }): TelnyxCallLike;
}

export type TelnyxClientCtor = new (options: { login_token: string }) => TelnyxClientLike;

export interface TelnyxVoiceClientOptions {
  /** Loads the SDK. The default is a dynamic import, so the SDK stays out of the main chunk. */
  loadSdk?: (() => Promise<{ TelnyxRTC: TelnyxClientCtor }>) | undefined;
  getUserMedia?: GetUserMedia | undefined;
  connectTimeoutMs?: number | undefined;
  /** Told about SDK errors after the connection is up (socket drops and the like). */
  onError?: ((error: VoiceError) => void) | undefined;
  /** Makes the element a call's remote audio plays through. The default adds a hidden `<audio>`. */
  createRemoteAudio?: CreateRemoteAudio | undefined;
  /**
   * Told the moment the live call's leg ends here: our own hangup, or the SDK reporting the far
   * end hung up. The server's state follows through the provider event a few seconds later.
   */
  onCallEnded?: ((callId: string) => void) | undefined;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

const defaultLoadSdk = async (): Promise<{ TelnyxRTC: TelnyxClientCtor }> =>
  (await import('@telnyx/webrtc')) as unknown as { TelnyxRTC: TelnyxClientCtor };

interface Notification {
  type?: string;
  call?:
    | (TelnyxCallLike & { state?: string; direction?: string; remoteStream?: MediaStream })
    | undefined;
}

const CALL_ENDED_STATES = new Set(['hangup', 'destroy']);
const SDK_ERROR_EVENTS = ['telnyx.error', 'telnyx.socket.error'] as const;

export class TelnyxVoiceClient implements VoiceClient {
  private client: TelnyxClientLike | null = null;
  private current: TelnyxCallLike | null = null;
  private currentId: string | null = null;
  private ringing: TelnyxCallLike | null = null;
  /** The live call's remote audio element, removed when the call ends. */
  private audio: RemoteAudio | null = null;

  constructor(private readonly options: TelnyxVoiceClientOptions = {}) {}

  private createAudio(): RemoteAudio | null {
    return (this.options.createRemoteAudio ?? defaultCreateRemoteAudio)();
  }

  /** Makes `audio` the live call's element, removing any previous one. */
  private setAudio(audio: RemoteAudio | null): void {
    if (this.audio && this.audio !== audio) this.audio.release();
    this.audio = audio;
  }

  async connect(cred: VoiceCredential): Promise<void> {
    if (cred.provider !== 'telnyx') throw new VoiceError('connect_failed');
    this.disconnect();
    let client: TelnyxClientLike | null = null;
    try {
      const { TelnyxRTC } = await (this.options.loadSdk ?? defaultLoadSdk)();
      client = new TelnyxRTC({ login_token: cred.token });
      client.on('telnyx.notification', (payload) => this.onNotification(payload));
      await this.waitReady(client);
      this.client = client;
    } catch (error) {
      if (client) dispose(client);
      throw error instanceof VoiceError
        ? error
        : new VoiceError('connect_failed', { cause: error });
    }
  }

  async dial(input: DialInput): Promise<void> {
    const client = this.client;
    if (!client) throw new VoiceError('dial_failed');
    await checkMicrophone(this.options.getUserMedia);
    const audio = this.createAudio();
    try {
      this.current = client.newCall({
        destinationNumber: input.to,
        callerNumber: input.from,
        clientState: btoa(input.clientState),
        ...(audio ? { remoteElement: audio.element } : {}),
      });
      this.currentId = input.callId;
      this.setAudio(audio);
    } catch (error) {
      audio?.release();
      throw new VoiceError('dial_failed', { cause: error });
    }
  }

  async answer(input: AnswerInput): Promise<void> {
    const call = this.ringing;
    if (!call) throw new VoiceError('dial_failed');
    await checkMicrophone(this.options.getUserMedia);
    const audio = this.createAudio();
    try {
      call.answer(audio ? { remoteElement: audio.element } : undefined);
    } catch (error) {
      audio?.release();
      throw new VoiceError('dial_failed', { cause: error });
    }
    this.current = call;
    this.currentId = input.callId;
    this.ringing = null;
    this.setAudio(audio);
  }

  /** Hangs up the call with this id; a call that is not the live one is left alone. */
  async hangup(callId: string): Promise<void> {
    if (!this.current || this.currentId !== callId) return;
    const call = this.current;
    this.current = null;
    this.currentId = null;
    this.setAudio(null);
    call.hangup();
    this.options.onCallEnded?.(callId);
  }

  setMuted(muted: boolean): void {
    if (muted) this.current?.muteAudio();
    else this.current?.unmuteAudio();
  }

  sendDigits(digits: string): void {
    this.current?.dtmf(digits);
  }

  disconnect(): void {
    if (this.client) dispose(this.client);
    this.client = null;
    this.current = null;
    this.currentId = null;
    this.ringing = null;
    this.setAudio(null);
  }

  private onNotification(payload: unknown): void {
    const note = payload as Notification | undefined;
    const call = note?.call;
    if (note?.type !== 'callUpdate' || !call) return;
    if (call.direction === 'inbound' && call.state === 'ringing') this.ringing = call;
    // Belt and braces: the SDK attaches the remote stream to remoteElement itself. If the call is
    // live and the element still has nothing, attach it here so the other side is heard.
    if (call.state === 'active' && this.current === call && this.audio && call.remoteStream) {
      const element = this.audio.element;
      if (!element.srcObject) {
        element.srcObject = call.remoteStream;
        void element.play?.()?.catch(() => {});
      }
    }
    if (call.state !== undefined && CALL_ENDED_STATES.has(call.state)) {
      if (this.current === call) {
        const endedId = this.currentId;
        this.current = null;
        this.currentId = null;
        this.setAudio(null);
        if (endedId) this.options.onCallEnded?.(endedId);
      }
      if (this.ringing === call) this.ringing = null;
    }
  }

  private waitReady(client: TelnyxClientLike): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => settle(new VoiceError('connect_failed')), timeoutMs);
      const settle = (error?: VoiceError) => {
        settled = true;
        clearTimeout(timer);
        client.off('telnyx.ready');
        if (error) reject(error);
        else resolve();
      };
      client.on('telnyx.ready', () => {
        if (!settled) settle();
      });
      // These stay registered after ready: later SDK errors go to `onError`.
      for (const event of SDK_ERROR_EVENTS) {
        client.on(event, () => {
          const error = new VoiceError('connect_failed');
          if (settled) this.options.onError?.(error);
          else settle(error);
        });
      }
      client.connect();
    });
  }
}

/** Drops every listener this client added, then disconnects the SDK instance. */
function dispose(client: TelnyxClientLike): void {
  for (const event of ['telnyx.notification', 'telnyx.ready', ...SDK_ERROR_EVENTS]) {
    client.off(event);
  }
  client.disconnect();
}
