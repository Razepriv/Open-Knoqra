import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rule = { path: string; lines: string[] };

function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (/^\s/.test(raw)) rules.at(-1)?.lines.push(raw.trim());
    else rules.push({ path: raw.trim(), lines: [] });
  }
  return rules;
}

const rules = parseHeaders(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
const rule = (path: string) => rules.find((r) => r.path === path);

describe('public/_headers', () => {
  it('caches hashed assets immutably and detaches the inherited Cache-Control', () => {
    const assets = rule('/assets/*');
    expect(assets?.lines).toContain('! Cache-Control');
    expect(assets?.lines).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(assets?.lines.indexOf('! Cache-Control')).toBeLessThan(
      assets?.lines.indexOf('Cache-Control: public, max-age=31536000, immutable') ?? -1,
    );
  });

  it('makes everything else revalidate', () => {
    expect(rule('/*')?.lines).toEqual(['Cache-Control: no-cache']);
  });

  it('has no rule for /api', () => {
    expect(rules.some((r) => r.path.includes('/api'))).toBe(false);
  });
});

describe('public/.assetsignore', () => {
  it('keeps the Vite build manifest out of the published assets', () => {
    const lines = readFileSync(new URL('../public/.assetsignore', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain('.vite');
  });
});
