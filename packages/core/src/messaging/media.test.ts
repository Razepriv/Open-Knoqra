import { describe, expect, it } from 'vitest';
import {
  attachmentFileName,
  baseMimeType,
  classifyUpload,
  messagePreviewText,
  parseWaveform,
} from './media';

describe('classifyUpload', () => {
  it("sorts files into WhatsApp's kinds and enforces its limits", () => {
    expect(classifyUpload('image/jpeg', 1000)).toEqual({ ok: true, value: 'image' });
    expect(classifyUpload('video/mp4', 1000)).toEqual({ ok: true, value: 'video' });
    expect(classifyUpload('audio/mpeg', 1000)).toEqual({ ok: true, value: 'audio' });
    expect(classifyUpload('application/pdf', 1000)).toEqual({ ok: true, value: 'document' });
    expect(classifyUpload('audio/ogg; codecs=opus', 1000, { voice: true })).toEqual({
      ok: true,
      value: 'voice',
    });
    expect(classifyUpload('image/jpeg', 6 * 1024 * 1024)).toEqual({
      ok: false,
      error: 'too_large',
    });
    expect(classifyUpload('video/mp4', 17 * 1024 * 1024)).toEqual({
      ok: false,
      error: 'too_large',
    });
    expect(classifyUpload('text/html', 10)).toEqual({ ok: false, error: 'unsupported_type' });
    expect(classifyUpload('audio/ogg; codecs=vorbis', 10)).toEqual({
      ok: false,
      error: 'unsupported_type',
    });
    expect(classifyUpload('audio/mpeg', 10, { voice: true })).toEqual({
      ok: false,
      error: 'unsupported_type',
    });
    expect(classifyUpload('image/png', 0)).toEqual({ ok: false, error: 'empty' });
  });
});

describe('media helpers', () => {
  it('previews, names and waveforms', () => {
    expect(baseMimeType('Audio/OGG; codecs=opus')).toBe('audio/ogg');
    expect(messagePreviewText('', 'voice')).toBe('Voice message');
    expect(messagePreviewText('Look', 'image')).toBe('Photo: Look');
    expect(messagePreviewText('Hi', null)).toBe('Hi');
    expect(attachmentFileName('../../etc/passwd', 'document', 'application/pdf')).toBe(
      '....etcpasswd',
    );
    expect(attachmentFileName(null, 'image', 'image/png')).toBe('image.png');
    expect(attachmentFileName('  ', 'voice', 'audio/ogg')).toBe('voice.ogg');
    expect(parseWaveform('0,50,100')).toEqual([0, 50, 100]);
    expect(parseWaveform('0,101')).toBeNull();
    expect(parseWaveform('a,b')).toBeNull();
    expect(parseWaveform(null)).toBeNull();
  });
});
