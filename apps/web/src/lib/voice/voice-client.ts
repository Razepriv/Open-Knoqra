export type VoiceProvider = 'fake' | 'telnyx' | 'plivo';

export type VoiceErrorCode =
  | 'mic_denied'
  | 'mic_unavailable'
  | 'connect_failed'
  | 'dial_failed'
  | 'hangup_failed';

export class VoiceError extends Error {
  readonly code: VoiceErrorCode;

  constructor(code: VoiceErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'VoiceError';
    this.code = code;
  }
}

export interface VoiceCredential {
  provider: VoiceProvider;
  token: string;
}

export interface DialInput {
  callId: string;
  to: string;
  from: string;
  clientState: string;
}

export interface AnswerInput {
  callId: string;
  clientState: string;
}

/**
 * The live call's audio, for level meters: the microphone stream sent to the far side and the
 * stream heard from it. Either is null until the call's media is up, or when the client has none
 * (the fake client, or an SDK that does not expose it).
 */
export interface CallAudioStreams {
  local: MediaStream | null;
  remote: MediaStream | null;
}

export const NO_CALL_AUDIO: CallAudioStreams = { local: null, remote: null };

/** One browser phone line. The server learns about call progress from provider events, not from here. */
export interface VoiceClient {
  connect(cred: VoiceCredential): Promise<void>;
  dial(input: DialInput): Promise<void>;
  answer(input: AnswerInput): Promise<void>;
  hangup(callId: string): Promise<void>;
  setMuted(muted: boolean): void;
  sendDigits(digits: string): void;
  disconnect(): void;
  /** The live call's audio streams; optional, and all null when there is no live call. */
  audioStreams?(): CallAudioStreams;
}

/** The slice of `navigator.mediaDevices.getUserMedia` the clients use. */
export type GetUserMedia = (constraints: { audio: true }) => Promise<{
  getTracks(): { stop(): void }[];
}>;

const DENIED_ERRORS = new Set(['NotAllowedError', 'SecurityError', 'PermissionDeniedError']);

/** Maps a getUserMedia failure to a VoiceError. */
export function micError(error: unknown): VoiceError {
  const name = error instanceof Error ? error.name : '';
  return new VoiceError(DENIED_ERRORS.has(name) ? 'mic_denied' : 'mic_unavailable', {
    cause: error,
  });
}

/** Proves the microphone works, then releases it at once: the provider opens its own stream. */
export async function checkMicrophone(getUserMedia: GetUserMedia | undefined): Promise<void> {
  if (!getUserMedia) return;
  let stream: Awaited<ReturnType<GetUserMedia>>;
  try {
    stream = await getUserMedia({ audio: true });
  } catch (error) {
    throw micError(error);
  }
  for (const track of stream.getTracks()) track.stop();
}
