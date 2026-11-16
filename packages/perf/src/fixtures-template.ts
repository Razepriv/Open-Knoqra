// Fills `{ids.heavy}`-style placeholders from the fixtures file, URL-encoding each value.
import type { Fixtures } from './seed/fixtures';

function lookup(fixtures: Fixtures, path: string): string | undefined {
  let current: unknown = fixtures;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current) : undefined;
}

/** Replaces every `{a.b}` with the URL-encoded fixture value; throws on a missing path. */
export function fillTemplate(template: string, fixtures: Fixtures): string {
  return template.replace(/\{([A-Za-z0-9_.]+)\}/g, (_match, path: string) => {
    const value = lookup(fixtures, path);
    if (value === undefined) throw new Error(`unknown placeholder {${path}}`);
    return encodeURIComponent(value);
  });
}
