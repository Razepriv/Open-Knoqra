import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Route outlines load with the route tree, before any page: every pendingComponent and everything
 * an outline draws ends up in the initial bundle (200 KB budget, scripts/check-bundle-budget.mjs).
 * So a skeleton module is a leaf: its whole static import closure stays inside the UI kit, React,
 * the router, icons and other leaf files. It never reaches a route, a page component that loads
 * data, the API client, React Query or a heavy library. A page module an outline really needs is
 * imported lazily, which this walk does not follow.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** Packages a skeleton may reach. Anything else (the API client, React Query, three) fails. */
const LEAF_PACKAGES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@knoqra/ui',
  '@knoqra/tokens',
  'lucide-react',
  '@tanstack/react-router',
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const isSource = (path: string) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path);

/** Every skeleton module: the skeletons folder and any *-skeleton(s).tsx elsewhere. */
const skeletonModules = filesUnder(SRC).filter(
  (path) =>
    isSource(path) &&
    (path.includes(`${sep}components${sep}skeletons${sep}`) || /-skeletons?\.tsx$/.test(path)),
);

/** Static imports only: `import x from`, `export … from` and bare `import '…'`; not `import()`. */
function staticImports(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gms)) {
    const statement = match[0];
    // `import type` and `export type` vanish at build time.
    if (/^\s*(?:import|export)\s+type\s/.test(statement)) continue;
    out.push(match[1] ?? '');
  }
  for (const match of code.matchAll(/^\s*import\s+'([^']+)'/gm)) out.push(match[1] ?? '');
  return out;
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

const name = (path: string) => relative(SRC, path).split(sep).join('/');

/** Problems in one skeleton's closure, each as "chain: reason". */
function closureProblems(start: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (name(file).startsWith('routes/')) {
      problems.push(`${chain.join(' > ')}: reaches a route module`);
      return;
    }
    for (const specifier of staticImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const next = resolveRelative(file, specifier);
        walk(next, [...chain, name(next)]);
      } else if (!LEAF_PACKAGES.includes(specifier)) {
        problems.push(`${chain.join(' > ')}: imports ${specifier}`);
      }
    }
  };
  walk(start, [name(start)]);
  return problems;
}

describe('skeleton modules stay leaves', () => {
  it('finds the skeleton modules', () => {
    expect(skeletonModules.length).toBeGreaterThanOrEqual(10);
  });

  for (const module of skeletonModules) {
    it(`${name(module)} reaches no route, page data module or heavy library`, () => {
      expect(closureProblems(module)).toEqual([]);
    });
  }
});
