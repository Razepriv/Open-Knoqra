import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface RoutePattern {
  pattern: string;
  auth: 'public' | 'app';
}
export interface RouteTarget {
  pattern: string;
  url: string;
  auth: 'public' | 'app';
  label: string;
  throwaway: boolean;
}
export interface SeedIds {
  full: string;
  mergeTarget: string;
  mergedSource: string;
  archived: string;
  empty: string;
}

const APP_PREFIX = '/_app';

/** The body of `interface FileRoutesById { ... }`, or throws. */
function routesByIdBlock(source: string): string {
  const match = /interface FileRoutesById \{([\s\S]*?)\n\}/.exec(source);
  if (!match?.[1]) throw new Error('FileRoutesById not found in the route tree source');
  return match[1];
}

/** Parses FileRoutesById keys from routeTree.gen.ts source; ids under '/_app' are 'app'. Trailing '/' is dropped. */
export function parseRoutePatterns(routeTreeSource: string): RoutePattern[] {
  const ids = [...routesByIdBlock(routeTreeSource).matchAll(/^\s*'([^']+)':/gm)].map(
    (m) => m[1] as string,
  );
  const patterns: RoutePattern[] = [];
  for (const id of ids) {
    if (id === APP_PREFIX) continue; // the pathless layout route
    const isApp = id.startsWith(`${APP_PREFIX}/`);
    const path = isApp ? id.slice(APP_PREFIX.length) : id;
    const pattern = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    patterns.push({ pattern, auth: isApp ? 'app' : 'public' });
  }
  return patterns;
}

export function readRoutePatterns(): RoutePattern[] {
  const file = fileURLToPath(new URL('../../src/routeTree.gen.ts', import.meta.url));
  return parseRoutePatterns(readFileSync(file, 'utf8'));
}

/** `$contactId` expands to these seeded contacts, in this order. */
const CONTACT_VARIANTS: ReadonlyArray<readonly [keyof SeedIds, string]> = [
  ['full', 'full'],
  ['mergeTarget', 'merge target'],
  ['mergedSource', 'merged source'],
  ['archived', 'archived'],
  ['empty', 'empty'],
];

function paramsOf(pattern: string): string[] {
  return [...pattern.matchAll(/\$([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/**
 * '$contactId' expands to full, mergeTarget, mergedSource, archived, empty, plus one throwaway target.
 * Any other $param throws `No seed mapping for $<name> in <pattern>`.
 */
export function expandRoutes(
  patterns: RoutePattern[],
  seed: SeedIds,
  throwawayId?: string,
): RouteTarget[] {
  const targets: RouteTarget[] = [];
  for (const { pattern, auth } of patterns) {
    const params = paramsOf(pattern);
    for (const name of params) {
      if (name !== 'contactId') throw new Error(`No seed mapping for $${name} in ${pattern}`);
    }
    if (params.length === 0) {
      targets.push({ pattern, url: pattern, auth, label: pattern, throwaway: false });
      continue;
    }
    for (const [key, label] of CONTACT_VARIANTS) {
      targets.push({
        pattern,
        url: pattern.replace('$contactId', seed[key]),
        auth,
        label: `${pattern} (${label})`,
        throwaway: false,
      });
    }
    if (throwawayId !== undefined) {
      targets.push({
        pattern,
        url: pattern.replace('$contactId', throwawayId),
        auth,
        label: `${pattern} (throwaway)`,
        throwaway: true,
      });
    }
  }
  return targets;
}

function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
}

function toRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((segment) => (segment.startsWith('$') ? '[^/]+' : escapeSegment(segment)))
    .join('/');
  return new RegExp(`^${body}$`);
}

export function matchesKnownRoute(pathname: string, patterns: RoutePattern[]): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return patterns.some((p) => toRegExp(p.pattern).test(path));
}
