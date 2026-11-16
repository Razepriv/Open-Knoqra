import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findPlaceholders } from './check-placeholders.mjs';

const roots = [];
const ROUTE_TREE = `export interface FileRoutesByFullPath {
  '/': typeof A
  '/calls': typeof B
}
`;
const NOTE = 'test';

/** Builds a temp repo root from a map of relative path to contents. */
function makeRoot(files, pending = []) {
  const root = mkdtempSync(join(tmpdir(), 'placeholders-'));
  roots.push(root);
  const all = {
    'apps/web/src/routeTree.gen.ts': ROUTE_TREE,
    'apps/web/completeness-allowlist.json': JSON.stringify({ _note: NOTE, pending }),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const CALLS = 'apps/web/src/routes/_app/calls.tsx';
const STUB = 'apps/web/src/components/stub-page.tsx';
const pendingCalls = [{ route: '/calls', owner: 'M2', files: [CALLS] }];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('findPlaceholders', () => {
  it('passes a TODO inside a comment', () => {
    const root = makeRoot({
      'apps/web/src/a.tsx': '// TODO later\n/* TODO */\nexport const a = 1;\n',
    });
    assert.deepEqual(findPlaceholders(root).hits, []);
  });

  it('fails TODO in JSX text with file and line', () => {
    const root = makeRoot({ 'apps/web/src/a.tsx': 'export const a = (\n  <p>TODO</p>\n);\n' });
    const { hits } = findPlaceholders(root);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /^apps\/web\/src\/a\.tsx:2: /);
  });

  it('fails "Coming soon" in a string literal, case-insensitively', () => {
    const root = makeRoot({ 'apps/web/src/a.ts': "export const a = 'COMING Soon';\n" });
    assert.equal(findPlaceholders(root).hits.length, 1);
  });

  it('fails lorem in UI copy', () => {
    const root = makeRoot({ 'packages/ui/src/a.tsx': 'export const a = <p>Lorem ipsum</p>;\n' });
    assert.equal(findPlaceholders(root).hits.length, 1);
  });

  it('scans css and index.html', () => {
    const root = makeRoot({
      'packages/brand/src/a.css': '.a::after { content: "coming soon"; }\n',
      'apps/web/index.html': '<title>TODO</title>\n',
    });
    assert.equal(findPlaceholders(root).hits.length, 2);
  });

  it('fails StubPage outside an allowlisted file', () => {
    const root = makeRoot({ 'apps/web/src/routes/_app/x.tsx': 'export const x = <StubPage />;\n' });
    assert.equal(findPlaceholders(root).hits.length, 1);
  });

  it('allows StubPage in an allowlisted file and in stub-page.tsx while pending is non-empty', () => {
    const root = makeRoot(
      { [CALLS]: 'export const x = <StubPage />;\n', [STUB]: 'export function StubPage() {}\n' },
      pendingCalls,
    );
    assert.deepEqual(findPlaceholders(root).hits, []);
  });

  it('fails stub-page.tsx once pending is empty', () => {
    const root = makeRoot({ [STUB]: 'export function StubPage() {}\n' });
    assert.equal(findPlaceholders(root).hits.length, 1);
  });

  it('fails a stale allowlist file', () => {
    const root = makeRoot({}, pendingCalls);
    assert.deepEqual(findPlaceholders(root).hits, [`stale allowlist: ${CALLS} does not exist`]);
  });

  it('fails a stale allowlist route', () => {
    const root = makeRoot({ [CALLS]: 'export const x = 1;\n' }, [
      { route: '/gone', owner: 'M9', files: [CALLS] },
    ]);
    assert.deepEqual(findPlaceholders(root).hits, ['stale allowlist: /gone is not a route']);
  });

  it('ignores test files, routeTree.gen.ts, node_modules and dist', () => {
    const root = makeRoot({
      'apps/web/src/a.test.tsx': '<p>TODO</p>\n',
      'apps/web/src/routeTree.gen.ts': `${ROUTE_TREE}// StubPage TODO\nconst s = 'lorem';\n`,
      'apps/web/src/node_modules/x.ts': "const s = 'lorem';\n",
      'apps/web/src/dist/x.ts': "const s = 'lorem';\n",
    });
    assert.deepEqual(findPlaceholders(root).hits, []);
  });

  it('counts scanned files', () => {
    const root = makeRoot({ 'apps/web/src/a.ts': 'export const a = 1;\n' });
    assert.ok(findPlaceholders(root).scanned >= 1);
  });
});
