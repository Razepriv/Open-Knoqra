import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accent, dark, dot, gradients, light, motion } from './tokens';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

type VarMap = Record<string, string>;

/** Returns the body of the first `{ ... }` block opened by `selector` at or after `from`. */
function blockAfter(selector: string, from = 0): { body: string; end: number } {
  const start = css.indexOf(selector, from);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return { body: css.slice(open + 1, close), end: close };
}

function parseVars(body: string): VarMap {
  const map: VarMap = {};
  for (const m of body.matchAll(/^\s*(--[\w-]+):\s*(.+?);\s*$/gm)) {
    const [, name, value] = m;
    if (name && value !== undefined) map[name] = value;
  }
  return map;
}

const themeKeys = new Set(Object.keys(light));
const themeOnly = (map: VarMap): VarMap =>
  Object.fromEntries(Object.entries(map).filter(([name]) => themeKeys.has(name)));

const rootBlock = parseVars(blockAfter(':root {').body);
const darkBlock = parseVars(blockAfter('[data-theme="dark"] {').body);
const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
const mediaBlock = parseVars(blockAfter(':root:not([data-theme="light"]) {', mediaStart).body);

describe('tokens', () => {
  it('light and dark define the same 48 variables', () => {
    expect(Object.keys(light)).toHaveLength(48);
    expect(Object.keys(dark)).toEqual(Object.keys(light));
  });

  it(':root holds exactly the light theme values', () => {
    expect(themeOnly(rootBlock)).toEqual(light);
  });

  it('[data-theme="dark"] holds exactly the dark theme values', () => {
    expect(themeOnly(darkBlock)).toEqual(dark);
    expect(Object.keys(darkBlock)).toHaveLength(48);
  });

  it('the prefers-color-scheme dark block holds exactly the dark theme values', () => {
    expect(themeOnly(mediaBlock)).toEqual(dark);
    expect(Object.keys(mediaBlock)).toHaveLength(48);
  });

  it('defines the shared app tokens in both themes', () => {
    for (const theme of [light, dark]) {
      expect(theme['--on-accent']).toBe('#131916');
      expect(theme['--blocked-stripe']).toContain('repeating-linear-gradient');
      expect(theme['--blocked-border']).toMatch(/^rgba\(229, ?83, ?75/);
      expect(theme['--paused-stripe']).toContain('repeating-linear-gradient');
      expect(theme['--paused-border']).toMatch(/^rgba\(200, ?140, ?40/);
      for (const shadow of ['--shadow-avatar', '--shadow-drawer', '--shadow-tile'] as const) {
        expect(theme[shadow]).toContain('rgba(');
      }
    }
  });

  it('defines the surface, shadow and danger-fill tokens in all three blocks', () => {
    const names = [
      '--shadow-mark',
      '--mark-bg',
      '--shadow-shell',
      '--shadow-button',
      '--shadow-toast',
      '--danger-fill',
    ] as const;
    for (const name of names) {
      expect(light[name]).toBeTruthy();
      expect(dark[name]).toBeTruthy();
      expect(rootBlock[name]).toBe(light[name]);
      expect(darkBlock[name]).toBe(dark[name]);
      expect(mediaBlock[name]).toBe(dark[name]);
    }
    expect(light['--shadow-shell']).toContain('inset 0 1px 0 rgba(255,255,255,.5)');
    expect(dark['--shadow-shell']).toContain('rgba(255,255,255,.04)');
  });

  it(':root exposes the motion tokens', () => {
    expect(motion).toEqual({
      '--dur-theme': '290ms',
      '--dur-fast': '160ms',
      '--ease-standard': 'cubic-bezier(.2,0,0,1)',
    });
    for (const [name, value] of Object.entries(motion)) expect(rootBlock[name]).toBe(value);
  });

  it('defines the Today heat levels, goal ring and streak panel in both themes', () => {
    const heat = ['#222A25', '#36502F', '#5E8A3A', '#94C552', '#C9FA74'];
    for (const theme of [light, dark]) {
      expect([0, 1, 2, 3, 4].map((n) => theme[`--heat-${n}` as keyof typeof light])).toEqual(heat);
      expect(theme['--streak-panel']).toContain('radial-gradient');
      expect(theme['--ink']).toBe('#131916');
      expect(theme['--on-ink']).toBe('#C9FA74');
    }
    expect([light['--ring-track'], light['--ring-fill']]).toEqual(['#E3E6E0', '#21513C']);
    expect([dark['--ring-track'], dark['--ring-fill']]).toEqual(['#26302A', '#C9FA74']);
  });

  it(':root exposes accent, dot and gradient vars with exact values', () => {
    const extras = Object.fromEntries(
      Object.entries(rootBlock).filter(([name]) => !themeKeys.has(name)),
    );
    const expected: VarMap = {
      ...motion,
      '--accent': accent.base,
      '--accent-hover': accent.hover,
      ...Object.fromEntries(Object.entries(dot).map(([k, v]) => [`--dot-${k}`, v])),
      ...Object.fromEntries(Object.entries(gradients).map(([k, v]) => [`--grad-${k}`, v])),
    };
    expect(extras).toEqual(expected);
    expect(accent.base).toBe('#C9FA74');
  });
});
