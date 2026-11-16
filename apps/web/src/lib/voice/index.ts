import { api, throwIfFailed } from '../api';
import { FakeVoiceClient, type FakeVoiceClientOptions } from './fake-voice-client';
import { PlivoVoiceClient, type PlivoVoiceClientOptions } from './plivo-voice-client';
import { TelnyxVoiceClient, type TelnyxVoiceClientOptions } from './telnyx-voice-client';
import type { GetUserMedia, VoiceClient, VoiceProvider } from './voice-client';

export { type FakeOutboundScenario, fakeOutboundScenario } from './fake-scenario';
export { FakeVoiceClient, type FakeVoiceEventBody } from './fake-voice-client';
export { PlivoVoiceClient } from './plivo-voice-client';
export { TelnyxVoiceClient } from './telnyx-voice-client';
export {
  type AnswerInput,
  type DialInput,
  type GetUserMedia,
  type VoiceClient,
  type VoiceCredential,
  VoiceError,
  type VoiceErrorCode,
  type VoiceProvider,
} from './voice-client';

export interface CreateVoiceClientOptions {
  /** Checked before every dial and answer; the session layer passes the browser's own. */
  getUserMedia?: GetUserMedia | undefined;
  fake?: Partial<Pick<FakeVoiceClientOptions, 'delays' | 'onError'>> | undefined;
  telnyx?:
    | Pick<TelnyxVoiceClientOptions, 'loadSdk' | 'connectTimeoutMs' | 'onError' | 'onCallEnded'>
    | undefined;
  plivo?:
    | Pick<PlivoVoiceClientOptions, 'loadSdk' | 'connectTimeoutMs' | 'onError' | 'onCallEnded'>
    | undefined;
}

/** Sends a fake call event through the dev endpoint (404s outside the fake provider). */
async function postFakeEvent(
  callId: string,
  body: Parameters<FakeVoiceClientOptions['post']>[1],
): Promise<void> {
  throwIfFailed(
    await api.POST('/api/v1/dev/fake-voice/calls/{id}/events', {
      params: { path: { id: callId } },
      body,
    }),
    'Could not send the call event.',
  );
}

export function createVoiceClient(
  provider: VoiceProvider,
  options: CreateVoiceClientOptions = {},
): VoiceClient {
  if (provider === 'telnyx') {
    return new TelnyxVoiceClient({ ...options.telnyx, getUserMedia: options.getUserMedia });
  }
  if (provider === 'plivo') {
    return new PlivoVoiceClient({ ...options.plivo, getUserMedia: options.getUserMedia });
  }
  return new FakeVoiceClient({
    ...options.fake,
    post: postFakeEvent,
    getUserMedia: options.getUserMedia,
  });
}
