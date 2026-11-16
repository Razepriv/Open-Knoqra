import { describe, expect, it } from 'vitest';
import { finishRecording, pickRecordingFormat, waveformBars } from './recorder';

describe('pickRecordingFormat', () => {
  it('prefers Ogg/Opus, then WebM/Opus (remuxed), then MP4 as plain audio', () => {
    expect(pickRecordingFormat(() => true)?.container).toBe('ogg');
    expect(pickRecordingFormat((t) => t.startsWith('audio/webm'))?.container).toBe('webm');
    expect(pickRecordingFormat((t) => t === 'audio/mp4')?.container).toBe('mp4');
    expect(pickRecordingFormat(() => false)).toBeNull();
  });
});

describe('waveformBars', () => {
  it('folds levels into at most 48 bars scaled so the loudest is 100', () => {
    const bars = waveformBars(Array.from({ length: 480 }, (_, i) => (i % 10) / 10));
    expect(bars).toHaveLength(48);
    expect(Math.max(...bars)).toBe(100);
    expect(bars.every((b) => Number.isInteger(b) && b >= 0 && b <= 100)).toBe(true);
    expect(waveformBars([0.5, 0.25])).toEqual([100, 50]);
    expect(waveformBars([])).toEqual([]);
  });
});

describe('finishRecording', () => {
  it('sends Ogg as a voice note, MP4 as plain audio, and refuses a WebM it cannot remux', async () => {
    const ogg = await finishRecording(new Blob(['x']), {
      mimeType: 'audio/ogg;codecs=opus',
      container: 'ogg',
    });
    expect(ogg).toMatchObject({ voice: true, name: 'voice-note.ogg' });
    expect(ogg.file.type).toBe('audio/ogg');
    const mp4 = await finishRecording(new Blob(['x']), { mimeType: 'audio/mp4', container: 'mp4' });
    expect(mp4).toMatchObject({ voice: false, name: 'voice-note.m4a' });
    await expect(
      finishRecording(new Blob([new Uint8Array([0x1a, 0x45])]), {
        mimeType: 'audio/webm;codecs=opus',
        container: 'webm',
      }),
    ).rejects.toThrow(/could not be prepared/);
  });
});
