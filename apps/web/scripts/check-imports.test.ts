import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Covers the repo-wide guard in /scripts/check-imports.mjs (loading states only go through
// @knoqra/ui, so apps never import ascii-reveal).
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '../../../scripts/check-imports.mjs');
const repoRoot = join(here, '../../..');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-imports-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

// Built from parts so this file does not itself contain an import of the package.
const pkg = ['ascii', 'reveal'].join('-');

const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

describe('check-imports', () => {
  it.each([
    (name: string) => `import { AsciiSkeleton } from '${name}';`,
    (name: string) => `import "${name}";`,
    (name: string) => `import type { SkeletonVariant } from '${name}/react';`,
    (name: string) => `const mod = await import('${name}');`,
    (name: string) => `const mod = require('${name}');`,
  ])('exits 1 when a file under apps/ imports ascii-reveal (form %#)', (write) => {
    const source = write(pkg);
    const result = run(fixture({ 'apps/web/src/loading.tsx': `${source}\n` }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/web/src/loading.tsx');
  });

  it('catches a multi-line import', () => {
    const source = `import {\n  AsciiSkeleton,\n  type SkeletonVariant,\n} from\n  '${pkg}';\n`;
    const result = run(fixture({ 'apps/web/src/multi.ts': source }));
    expect(result.status).toBe(1);
  });

  it('is not blinded by a comment opener inside a string earlier in the file', () => {
    const source = `const alias = '@/*';\nimport { AsciiSkeleton } from '${pkg}';\n/* later comment */\n`;
    const result = run(fixture({ 'apps/web/src/alias.ts': source }));
    expect(result.status).toBe(1);
  });

  it('exits 1 when an app declares ascii-reveal as a dependency', () => {
    const result = run(
      fixture({ 'apps/web/package.json': JSON.stringify({ dependencies: { [pkg]: '0.3.0' } }) }),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('apps/web/package.json');
  });

  it('allows ascii-reveal in packages/ui and ignores comments and node_modules', () => {
    const result = run(
      fixture({
        'packages/ui/src/skeleton.tsx': `import { AsciiSkeleton } from '${pkg}';\n`,
        'apps/web/src/note.ts': `// Never import '${pkg}' here; use Skeleton from @knoqra/ui.\n/* import '${pkg}' */\n`,
        'apps/web/node_modules/dep/index.js': `require('${pkg}');\n`,
      }),
    );
    expect(result.status).toBe(0);
  });

  it('exits 0 on the repo', () => {
    const result = run(repoRoot);
    expect(result.stdout).toContain('check-imports: OK');
    expect(result.status).toBe(0);
  });
});
