import { WAVEFORM_BARS } from '@knoqra/core';
import { RemuxError, webmToOggOpus } from './ogg-opus';

/** What a browser can record a voice note as, best first. */
const CANDIDATES = [
  { mimeType: 'audio/ogg;codecs=opus', container: 'ogg' },
  { mimeType: 'audio/webm;codecs=opus', container: 'webm' },
  { mimeType: 'audio/mp4', container: 'mp4' },
] as const;

export type RecordingFormat = (typeof CANDIDATES)[number];

/**
 * Firefox records Ogg/Opus (WhatsApp's voice-note format) as is; Chrome records WebM/Opus, which is
 * remuxed to Ogg; Safari records MP4/AAC, which WhatsApp takes as plain audio.
 */
export function pickRecordingFormat(
  isTypeSupported: (type: string) => boolean,
): RecordingFormat | null {
  return CANDIDATES.find((c) => isTypeSupported(c.mimeType)) ?? null;
}

/** Levels (0 to 1, one per sample tick) folded into `count` bars from 0 to 100, loudest = 100. */
export function waveformBars(levels: readonly number[], count = WAVEFORM_BARS): number[] {
  if (levels.length === 0) return [];
  const bars: number[] = [];
  const per = levels.length / Math.min(count, levels.length);
  for (let i = 0; i < Math.min(count, levels.length); i++) {
    const slice = levels.slice(
      Math.floor(i * per),
      Math.max(Math.floor((i + 1) * per), Math.floor(i * per) + 1),
    );
    bars.push(Math.max(...slice));
  }
  const peak = Math.max(...bars, 0.0001);
  return bars.map((b) => Math.max(0, Math.min(100, Math.round((b / peak) * 100))));
}

/** The file to upload for a finished recording, and whether it can go as a voice note. */
export async function finishRecording(
  blob: Blob,
  format: RecordingFormat,
): Promise<{ file: Blob; voice: boolean; name: string }> {
  if (format.container === 'ogg')
    return { file: new Blob([blob], { type: 'audio/ogg' }), voice: true, name: 'voice-note.ogg' };
  if (format.container === 'webm') {
    try {
      const ogg = webmToOggOpus(new Uint8Array(await blob.arrayBuffer()));
      return {
        file: new Blob([ogg as Uint8Array<ArrayBuffer>], { type: 'audio/ogg' }),
        voice: true,
        name: 'voice-note.ogg',
      };
    } catch (error) {
      if (!(error instanceof RemuxError)) throw error;
      throw new Error('This recording could not be prepared for WhatsApp. Try again.');
    }
  }
  return { file: new Blob([blob], { type: 'audio/mp4' }), voice: false, name: 'voice-note.m4a' };
}

/** The longest voice note the composer records. */
export const MAX_RECORDING_MS = 5 * 60_000;

export interface VoiceRecording {
  format: RecordingFormat;
  /** Live levels so far (0 to 1), for the recording bar. */
  levels: () => number[];
  elapsedMs: () => number;
  /** Stops and answers the recording; `cancel` throws it away. */
  stop: () => Promise<Blob>;
  cancel: () => void;
}

/** Starts recording from the microphone. Throws when there is no microphone or no permission. */
export async function startVoiceRecording(): Promise<VoiceRecording> {
  const Recorder = globalThis.MediaRecorder;
  if (!Recorder || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't record voice notes.");
  }
  const format = pickRecordingFormat((type) => Recorder.isTypeSupported(type));
  if (!format) throw new Error("This browser can't record voice notes.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true },
  });
  const recorder = new Recorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: 32_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const levels: number[] = [];
  const buffer = new Uint8Array(analyser.fftSize);
  const tick = setInterval(() => {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const v of buffer) sum += ((v - 128) / 128) ** 2;
    levels.push(Math.sqrt(sum / buffer.length));
  }, 100);
  const started = performance.now();
  recorder.start(250);
  const release = () => {
    clearInterval(tick);
    for (const track of stream.getTracks()) track.stop();
    void audio.close().catch(() => undefined);
  };
  return {
    format,
    levels: () => levels,
    elapsedMs: () => performance.now() - started,
    stop: () =>
      new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: format.mimeType }));
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== 'inactive') recorder.stop();
      else release();
    },
  };
}
