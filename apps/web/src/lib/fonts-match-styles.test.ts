import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FONT_FACES } from './fonts';

/**
 * FONT_FACES must name exactly the webfont faces styles.css imports, or preloading misses a face
 * (and it reflows late content again) or asks for one that never loads. Each @fontsource import is
 * resolved and its own @font-face read for the family and weight; a variable font (a weight range)
 * is loaded once, at 400.
 */

const stylesPath = fileURLToPath(new URL('../styles.css', import.meta.url));
const styles = readFileSync(stylesPath, 'utf8');
const require = createRequire(stylesPath);

function faceOf(specifier: string): string {
  const css = readFileSync(require.resolve(specifier), 'utf8');
  const family = /font-family:\s*'([^']+)'/.exec(css)?.[1];
  const weight = /font-weight:\s*([^;]+);/.exec(css)?.[1]?.trim();
  if (!family || !weight) throw new Error(`No @font-face in ${specifier}`);
  return `${weight.includes(' ') ? '400' : weight} 1em "${family}"`;
}

const imported = [...styles.matchAll(/@import\s+"(@fontsource[^"]+)";/g)].map((match) =>
  faceOf(match[1] ?? ''),
);

describe('FONT_FACES', () => {
  it('reads the faces styles.css imports', () => {
    expect(imported.length).toBeGreaterThanOrEqual(4);
  });

  it('names exactly the faces styles.css imports', () => {
    expect([...FONT_FACES].sort()).toEqual([...imported].sort());
  });
});
