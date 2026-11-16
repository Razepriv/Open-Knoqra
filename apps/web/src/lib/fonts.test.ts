import { describe, expect, it, vi } from 'vitest';
import { FONT_FACES, preloadFonts } from './fonts';

describe('preloadFonts', () => {
  it('asks the font set to load every face the Desk uses', () => {
    const load = vi.fn((_face: string) => Promise.resolve([] as FontFace[]));
    preloadFonts({ load });
    expect(load.mock.calls.map(([face]) => face)).toEqual([...FONT_FACES]);
    expect(FONT_FACES).toContain('500 1em "IBM Plex Mono"');
  });

  it('swallows a face that fails to load', async () => {
    const load = vi.fn((_face: string) => Promise.reject(new Error('offline')));
    expect(() => preloadFonts({ load })).not.toThrow();
    await Promise.resolve();
  });

  it('does nothing without a font set', () => {
    expect(() => preloadFonts(undefined)).not.toThrow();
  });
});
