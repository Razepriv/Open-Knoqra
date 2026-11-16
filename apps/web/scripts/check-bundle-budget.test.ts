import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { checkBudget, initialChunks } from './check-bundle-budget.mjs';

type Chunk = {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
};

const KB = 1024;

const manifest: Record<string, Chunk> = {
  'index.html': {
    file: 'assets/entry.js',
    src: 'index.html',
    isEntry: true,
    imports: ['a'],
    dynamicImports: ['routes/x'],
  },
  a: { file: 'assets/a.js', imports: ['b'] },
  b: { file: 'assets/b.js' },
  'routes/x': { file: 'assets/x.js', src: 'src/routes/x.tsx' },
};

function sizes(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe('initialChunks', () => {
  it('follows static imports transitively and never dynamic imports', () => {
    expect(initialChunks(manifest)).toEqual(['index.html', 'a', 'b']);
  });
});

describe('checkBudget', () => {
  it('passes when under budget with lazy routes', () => {
    const result = checkBudget({
      manifest,
      sizes: sizes({ 'assets/entry.js': 50 * KB, 'assets/a.js': 20 * KB, 'assets/b.js': 10 * KB }),
    });
    expect(result.violations).toEqual([]);
    expect(result.initialBytes).toBe(80 * KB);
    expect(result.files).toEqual(['assets/entry.js', 'assets/a.js', 'assets/b.js']);
  });

  it('reports an over-budget total', () => {
    const result = checkBudget({
      manifest,
      sizes: sizes({
        'assets/entry.js': 100 * KB,
        'assets/a.js': 60 * KB,
        'assets/b.js': 50 * KB,
      }),
    });
    expect(result.violations).toEqual(['initial JS 210.0 KB gzipped is over the 200 KB budget']);
  });

  it('reports a route chunk in the initial set by src', () => {
    const eager = {
      ...manifest,
      b: { file: 'assets/b.js', src: 'src/routes/_app/contacts.index.tsx' },
    };
    const result = checkBudget({
      manifest: eager,
      sizes: sizes({ 'assets/entry.js': 1, 'assets/a.js': 1, 'assets/b.js': 1 }),
    });
    expect(result.violations).toEqual([
      'route chunk src/routes/_app/contacts.index.tsx is in the initial bundle (must be lazy)',
    ]);
  });

  it('reports a route chunk in the initial set by manifest key', () => {
    const eager = {
      ...manifest,
      'src/routes/_app/contacts.index.tsx?tsr-split=component': { file: 'assets/b.js' },
      a: {
        file: 'assets/a.js',
        imports: ['src/routes/_app/contacts.index.tsx?tsr-split=component'],
      },
    };
    delete (eager as Record<string, Chunk>).b;
    const result = checkBudget({
      manifest: eager,
      sizes: sizes({ 'assets/entry.js': 1, 'assets/a.js': 1, 'assets/b.js': 1 }),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('src/routes/_app/contacts.index.tsx');
  });

  it('allows __root.tsx in the initial set', () => {
    const withRoot = { ...manifest, b: { file: 'assets/b.js', src: 'src/routes/__root.tsx' } };
    const result = checkBudget({
      manifest: withRoot,
      sizes: sizes({ 'assets/entry.js': 1, 'assets/a.js': 1, 'assets/b.js': 1 }),
    });
    expect(result.violations).toEqual([]);
  });
});
