import type { components } from '@knoqra/api-client';
import { fakeOutboundScenario } from './fake-scenario';
import {
  type AnswerInput,
  checkMicrophone,
  type DialInput,
  type GetUserMedia,
  type VoiceClient,
  type VoiceCredential,
  VoiceError,
} from './voice-client';

export type FakeVoiceEventBody = components['schemas']['FakeVoiceEvent'];

export interface FakeVoiceClientOptions {
  /** Posts one event to the dev endpoint `/api/v1/dev/fake-voice/calls/{id}/events`. */
  post: (callId: string, body: FakeVoiceEventBody) => Promise<void>;
  /** Passed by the session layer; when given, the microphone is checked before dialing. */
  getUserMedia?: GetUserMedia | undefined;
  /** Milliseconds before ringing and before answering. Use 0 in tests. */
  delays?: { ringing: number; answer: number } | undefined;
  /** Called when a scripted event after `dial` returns cannot be posted. */
  onError?: ((error: unknown) => void) | undefined;
  now?: (() => number) | undefined;
}

const DEFAULT_DELAYS = { ringing: 600, answer: 1200 };

interface Leg {
  answeredAt: number | null;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Plays the browser side of a call against the dev endpoint, so the real pipeline runs. */
export class FakeVoiceClient implements VoiceClient {
  private readonly legs = new Map<string, Leg>();
  private readonly delays: { ringing: number; answer: number };
  private readonly now: () => number;

  constructor(private readonly options: FakeVoiceClientOptions) {
    this.delays = options.delays ?? DEFAULT_DELAYS;
    this.now = options.now ?? Date.now;
  }

  async connect(_cred: VoiceCredential): Promise<void> {}

  async dial(input: DialInput): Promise<void> {
    await checkMicrophone(this.options.getUserMedia);
    const leg: Leg = { answeredAt: null, ended: false, timer: null };
    this.legs.set(input.callId, leg);
    try {
      await this.options.post(input.callId, { event: 'initiated' });
    } catch (error) {
      this.legs.delete(input.callId);
      throw new VoiceError('dial_failed', { cause: error });
    }
    this.script(input, leg);
  }

  async answer(input: AnswerInput): Promise<void> {
    await checkMicrophone(this.options.getUserMedia);
    const leg: Leg = { answeredAt: null, ended: false, timer: null };
    this.legs.set(input.callId, leg);
    try {
      await this.options.post(input.callId, { event: 'answered' });
    } catch (error) {
      this.legs.delete(input.callId);
      throw new VoiceError('dial_failed', { cause: error });
    }
    leg.answeredAt = this.now();
  }

  async hangup(callId: string): Promise<void> {
    const leg = this.legs.get(callId);
    if (leg?.ended) return;
    if (leg) {
      leg.ended = true;
      if (leg.timer) clearTimeout(leg.timer);
    }
    const answeredAt = leg?.answeredAt ?? null;
    if (answeredAt === null) {
      await this.options.post(callId, { event: 'completed', hangupCause: 'canceled' });
      return;
    }
    const seconds = Math.max(1, Math.floor((this.now() - answeredAt) / 1000));
    await this.options.post(callId, {
      event: 'completed',
      hangupCause: 'normal',
      billableSeconds: seconds,
    });
  }

  setMuted(_muted: boolean): void {}

  sendDigits(_digits: string): void {}

  disconnect(): void {
    for (const leg of this.legs.values()) {
      leg.ended = true;
      if (leg.timer) clearTimeout(leg.timer);
    }
    this.legs.clear();
  }

  /** Ringing, then the scenario's ending, in the background so `dial` returns promptly. */
  private script(input: DialInput, leg: Leg): void {
    const report = (error: unknown) => this.options.onError?.(error);
    const wait = (ms: number) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            leg.timer = setTimeout(resolve, ms);
          });
    void (async () => {
      await wait(this.delays.ringing);
      if (leg.ended) return;
      await this.options.post(input.callId, { event: 'ringing' });
      await wait(this.delays.answer);
      if (leg.ended) return;
      const scenario = fakeOutboundScenario(input.to);
      if (scenario === 'answered') {
        leg.answeredAt = this.now();
        await this.options.post(input.callId, { event: 'answered' });
        return;
      }
      leg.ended = true;
      await this.options.post(input.callId, { event: 'completed', hangupCause: scenario });
    })().catch(report);
  }
}
