import { describe, expect, it } from 'vitest';
import { isPaletteShortcut } from './use-global-shortcut';

const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    key: '',
    ...init,
  }) as KeyboardEvent;

describe('isPaletteShortcut', () => {
  it('matches Ctrl+K off Apple platforms and Meta+K on them', () => {
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true }), 'Win32')).toBe(true);
    expect(isPaletteShortcut(key({ key: 'K', ctrlKey: true }), 'Linux x86_64')).toBe(true);
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true }), 'MacIntel')).toBe(true);
  });

  it('ignores the other platform modifier, Shift, Alt and a plain k', () => {
    expect(isPaletteShortcut(key({ key: 'k', metaKey: true }), 'Win32')).toBe(false);
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true }), 'MacIntel')).toBe(false);
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true, shiftKey: true }), 'Win32')).toBe(
      false,
    );
    expect(isPaletteShortcut(key({ key: 'k', ctrlKey: true, altKey: true }), 'Win32')).toBe(false);
    expect(isPaletteShortcut(key({ key: 'k' }), 'Win32')).toBe(false);
    expect(isPaletteShortcut(key({ key: 'j', ctrlKey: true }), 'Win32')).toBe(false);
  });
});
