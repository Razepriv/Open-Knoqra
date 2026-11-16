import {
  type AnswerInput,
  checkMicrophone,
  type DialInput,
  type GetUserMedia,
  type VoiceClient,
  type VoiceCredential,
  VoiceError,
} from './voice-client';

/** The slice of the Plivo browser SDK's `client` this class uses, typed locally so tests can stub it. */
export interface PlivoClientLike {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
  loginWithAccessToken(token: string): boolean;
  logout(): boolean;
  call(destination: string, extraHeaders: Record<string, string>): boolean;
  answer(callUUID?: string, actionOnOtherIncomingCalls?: string): boolean;
  hangup(): boolean;
  reject(callUUID?: string): boolean;
  mute(): boolean;
  unmute(): boolean;
  sendDtmf(digit: string): void;
}

export type PlivoSdkCtor = new (options: Record<string, unknown>) => { client: PlivoClientLike };

export interface PlivoVoiceClientOptions {
  /** Loads the SDK. The default is a dynamic import, so the SDK stays out of the main chunk. */
  loadSdk?: (() => Promise<PlivoSdkCtor>) | undefined;
  getUserMedia?: GetUserMedia | undefined;
  connectTimeoutMs?: number | undefined;
  /** Told about SDK failures after login (a dropped call, a failed call). */
  onError?: ((error: VoiceError) => void) | undefined;
  /** Told the moment the live call's leg ends here (our hangup or the far end's). */
  onCallEnded?: ((callId: string) => void) | undefined;
}

/**
 * The custom SIP header that carries KNOQRA's client state to the answer URL. Plivo's SDK only
 * passes `X-PH-` headers whose name is 1-19 characters of `[A-Za-z0-9-]` and whose value is 1-120
 * characters of `[A-Za-z0-9_\-+()%.]`; the client state is 32 hex characters.
 */
export const CLIENT_STATE_HEADER = 'X-PH-ClientState';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const SDK_OPTIONS = { debug: 'ERROR', permOnClick: true, enableTracking: false };
const LOGIN_EVENTS = ['onLogin', 'onLoginFailed'] as const;
const CALL_EVENTS = [
  'onIncomingCall',
  'onIncomingCallCanceled',
  'onCallTerminated',
  'onCallFailed',
];

/** The CommonJS bundle arrives as `default` (or `default.default`) through a bundler. */
const defaultLoadSdk = async (): Promise<PlivoSdkCtor> => {
  const mod = (await import('plivo-browser-sdk')) as unknown as {
    default?: PlivoSdkCtor | { default?: PlivoSdkCtor };
  };
  const first = mod.default;
  const ctor = typeof first === 'function' ? first : first?.default;
  if (typeof ctor !== 'function') throw new VoiceError('connect_failed');
  return ctor;
};

interface CallInfo {
  callUUID?: string;
}

/**
 * One browser phone line on Plivo. Built from Plivo's SDK typings and docs; not yet run against a
 * live account. Like the Telnyx client, it only places and answers calls: the server learns call
 * progress from Plivo's webhooks and decides, at the answer URL, what each call may dial.
 */
export class PlivoVoiceClient implements VoiceClient {
  private client: PlivoClientLike | null = null;
  private currentId: string | null = null;
  private ringing: string | null = null;

  constructor(private readonly options: PlivoVoiceClientOptions = {}) {}

  async connect(cred: VoiceCredential): Promise<void> {
    if (cred.provider !== 'plivo') throw new VoiceError('connect_failed');
    this.disconnect();
    let client: PlivoClientLike | null = null;
    try {
      const Sdk = await (this.options.loadSdk ?? defaultLoadSdk)();
      client = new Sdk(SDK_OPTIONS).client;
      this.listen(client);
      await this.login(client, cred.token);
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
    let placed = false;
    try {
      placed = client.call(input.to, { [CLIENT_STATE_HEADER]: input.clientState });
    } catch (error) {
      throw new VoiceError('dial_failed', { cause: error });
    }
    if (!placed) throw new VoiceError('dial_failed');
    this.currentId = input.callId;
  }

  async answer(input: AnswerInput): Promise<void> {
    const client = this.client;
    const uuid = this.ringing;
    if (!client || uuid === null) throw new VoiceError('dial_failed');
    await checkMicrophone(this.options.getUserMedia);
    let answered = false;
    try {
      answered = client.answer(uuid, 'reject');
    } catch (error) {
      throw new VoiceError('dial_failed', { cause: error });
    }
    if (!answered) throw new VoiceError('dial_failed');
    this.currentId = input.callId;
    this.ringing = null;
  }

  /** Hangs up the call with this id; a call that is not the live one is left alone. */
  async hangup(callId: string): Promise<void> {
    if (!this.client || this.currentId !== callId) return;
    this.currentId = null;
    this.client.hangup();
    this.options.onCallEnded?.(callId);
  }

  setMuted(muted: boolean): void {
    if (this.currentId === null) return;
    if (muted) this.client?.mute();
    else this.client?.unmute();
  }

  sendDigits(digits: string): void {
    if (this.currentId === null) return;
    for (const digit of digits) this.client?.sendDtmf(digit);
  }

  disconnect(): void {
    if (this.client) dispose(this.client);
    this.client = null;
    this.currentId = null;
    this.ringing = null;
  }

  private listen(client: PlivoClientLike): void {
    client.on('onIncomingCall', (_callerId, _headers, info) => {
      this.ringing = (info as CallInfo | undefined)?.callUUID ?? null;
    });
    client.on('onIncomingCallCanceled', () => {
      this.ringing = null;
    });
    client.on('onCallTerminated', () => {
      const endedId = this.currentId;
      this.currentId = null;
      if (endedId) this.options.onCallEnded?.(endedId);
    });
    client.on('onCallFailed', () => {
      const live = this.currentId !== null;
      this.currentId = null;
      if (live) this.options.onError?.(new VoiceError('dial_failed'));
    });
  }

  private login(client: PlivoClientLike, token: string): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => settle(new VoiceError('connect_failed')), timeoutMs);
      const settle = (error?: VoiceError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      client.on('onLogin', () => settle());
      client.on('onLoginFailed', () => settle(new VoiceError('connect_failed')));
      let started = false;
      try {
        started = client.loginWithAccessToken(token);
      } catch (error) {
        settle(new VoiceError('connect_failed', { cause: error }));
        return;
      }
      if (!started) settle(new VoiceError('connect_failed'));
    });
  }
}

/** Drops every listener this client added, then logs the SDK out. */
function dispose(client: PlivoClientLike): void {
  for (const event of [...LOGIN_EVENTS, ...CALL_EVENTS]) client.removeAllListeners?.(event);
  try {
    client.logout();
  } catch {
    // Already logged out.
  }
}
