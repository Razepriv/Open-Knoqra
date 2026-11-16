import { describe, expect, it } from 'vitest';
import {
  expandRoutes,
  matchesKnownRoute,
  parseRoutePatterns,
  type RoutePattern,
  readRoutePatterns,
  type SeedIds,
} from './routes';

const seed: SeedIds = {
  full: 'ct_full',
  mergeTarget: 'ct_target',
  mergedSource: 'ct_source',
  archived: 'ct_archived',
  empty: 'ct_empty',
};

describe('parseRoutePatterns', () => {
  const patterns = readRoutePatterns();
  const find = (pattern: string) => patterns.find((p) => p.pattern === pattern);

  it('finds every app route under /_app', () => {
    for (const pattern of [
      '/',
      '/contacts',
      '/contacts/$contactId',
      '/contacts/import',
      '/settings',
      '/calls',
      '/inbox',
      '/usage',
      '/numbers',
    ]) {
      expect(find(pattern)?.auth, pattern).toBe('app');
    }
  });

  it('finds every public route', () => {
    for (const pattern of [
      '/sign-in',
      '/sign-up',
      '/forgot-password',
      '/reset-password',
      '/two-factor',
      '/showcase',
    ]) {
      expect(find(pattern)?.auth, pattern).toBe('public');
    }
  });

  it('skips the root and the /_app layout, and drops trailing slashes', () => {
    const all = patterns.map((p) => p.pattern);
    expect(all).not.toContain('__root__');
    expect(all).not.toContain('/_app');
    expect(all.filter((p) => p.length > 1 && p.endsWith('/'))).toEqual([]);
  });

  it('parses a synthetic interface', () => {
    const source = `export interface FileRoutesById {
  __root__: typeof rootRouteImport
  '/_app': typeof AppRouteWithChildren
  '/login': typeof LoginRoute
  '/_app/': typeof AppIndexRoute
  '/_app/things/': typeof AppThingsIndexRoute
}
export interface FileRouteTypes {
  '/_app/ignored': typeof X
}`;
    expect(parseRoutePatterns(source)).toEqual([
      { pattern: '/login', auth: 'public' },
      { pattern: '/', auth: 'app' },
      { pattern: '/things', auth: 'app' },
    ]);
  });

  it('throws when the interface is missing', () => {
    expect(() => parseRoutePatterns('export const x = 1;')).toThrow(/FileRoutesById/);
  });
});

describe('expandRoutes', () => {
  it('expands $contactId to every seeded contact plus a throwaway', () => {
    const targets = expandRoutes(
      [{ pattern: '/contacts/$contactId', auth: 'app' }],
      seed,
      'ct_throwaway',
    );
    expect(targets.map((t) => t.url)).toEqual([
      '/contacts/ct_full',
      '/contacts/ct_target',
      '/contacts/ct_source',
      '/contacts/ct_archived',
      '/contacts/ct_empty',
      '/contacts/ct_throwaway',
    ]);
    expect(targets.filter((t) => t.throwaway)).toHaveLength(1);
    expect(targets[0]?.label).toContain('full');
  });

  it('passes static routes through', () => {
    const [target] = expandRoutes([{ pattern: '/settings', auth: 'app' }], seed);
    expect(target).toMatchObject({ url: '/settings', pattern: '/settings', throwaway: false });
  });

  it('omits the throwaway target when none is given', () => {
    const targets = expandRoutes([{ pattern: '/contacts/$contactId', auth: 'app' }], seed);
    expect(targets).toHaveLength(5);
  });

  it('throws on an unmapped param', () => {
    expect(() => expandRoutes([{ pattern: '/inbox/$threadId', auth: 'app' }], seed)).toThrow(
      'No seed mapping for $threadId in /inbox/$threadId',
    );
  });
});

describe('matchesKnownRoute', () => {
  const patterns: RoutePattern[] = readRoutePatterns();
  it('matches dynamic and static routes', () => {
    expect(matchesKnownRoute('/contacts/ct_abc', patterns)).toBe(true);
    expect(matchesKnownRoute('/contacts/', patterns)).toBe(true);
    expect(matchesKnownRoute('/contacts', patterns)).toBe(true);
    expect(matchesKnownRoute('/', patterns)).toBe(true);
    expect(matchesKnownRoute('/contacts/import', patterns)).toBe(true);
  });
  it('rejects unknown paths', () => {
    expect(matchesKnownRoute('/contact', patterns)).toBe(false);
    expect(matchesKnownRoute('/contacts/a/b', patterns)).toBe(false);
    expect(matchesKnownRoute('/nope', patterns)).toBe(false);
  });
});
