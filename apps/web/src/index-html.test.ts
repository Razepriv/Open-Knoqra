import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * index.html paints its outline before tokens.css loads, so it carries `--o-*` fallbacks for the
 * few token colours it uses. They must equal the tokens, or the first paint flashes a different
 * colour when the real stylesheet lands.
 */

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const tokens = readFileSync(
  fileURLToPath(new URL('../../../packages/tokens/src/tokens.css', import.meta.url)),
  'utf8',
);

/** The declarations of the first rule whose selector (after `start`) matches, as name -> value. */
function declarations(css: string, selector: RegExp, start = 0): Map<string, string> {
  const rest = css.slice(start);
  const match = selector.exec(rest);
  if (!match) throw new Error(`No rule for ${selector}`);
  const open = rest.indexOf('{', match.index + match[0].length - 1);
  const close = rest.indexOf('}', open);
  const body = rest.slice(open + 1, close);
  const out = new Map<string, string>();
  for (const part of body.split(/;(?![^(]*\))/)) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    out.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return out;
}

/** Same colour written either way: case and spacing do not matter. */
const normal = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

function fallbacks(rule: Map<string, string>): [string, string][] {
  return [...rule].filter(([name]) => name.startsWith('--o-'));
}

const outlineStyle = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const mediaAt = (css: string): number => css.indexOf('@media (prefers-color-scheme');

const themes = [
  {
    name: 'light (:root)',
    outline: declarations(outlineStyle, /:root\s*\{/),
    tokens: declarations(tokens, /:root\s*\{/),
  },
  {
    name: 'dark ([data-theme="dark"])',
    outline: declarations(outlineStyle, /\[data-theme="dark"\]\s*\{/),
    tokens: declarations(tokens, /\[data-theme="dark"\]\s*\{/),
  },
  {
    name: 'system dark (prefers-color-scheme)',
    outline: declarations(
      outlineStyle,
      /:root:not\(\[data-theme="light"\]\)\s*\{/,
      mediaAt(outlineStyle),
    ),
    tokens: declarations(tokens, /:root:not\(\[data-theme="light"\]\)\s*\{/, mediaAt(tokens)),
  },
];

describe('index.html outline fallbacks', () => {
  for (const theme of themes) {
    it(`match tokens.css in ${theme.name}`, () => {
      const pairs = fallbacks(theme.outline);
      expect(pairs.length).toBeGreaterThanOrEqual(8);
      for (const [name, value] of pairs) {
        const token = theme.tokens.get(`--${name.slice('--o-'.length)}`);
        expect(token, `${name} has no token`).toBeDefined();
        expect(normal(value), name).toBe(normal(token ?? ''));
      }
    });
  }

  it('every theme falls back for the same tokens', () => {
    const names = themes.map((theme) =>
      fallbacks(theme.outline)
        .map(([name]) => name)
        .sort(),
    );
    expect(names[1]).toEqual(names[0]);
    expect(names[2]).toEqual(names[0]);
  });
});
