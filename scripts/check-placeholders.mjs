// Fails (exit 1) when shipped UI source contains placeholder copy: StubPage, "coming soon", TODO,
// lorem. Routes still owned by unmerged branches are listed in apps/web/completeness-allowlist.json.
// Usage: node scripts/check-placeholders.mjs [repoRoot]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from './lib/source-text.mjs';

const SCAN_DIRS = ['apps/web/src', 'packages/ui/src', 'packages/brand/src'];
const EXTRA_FILES = ['apps/web/index.html'];
const SCANNED_FILE = /\.(?:tsx?|css)$/;
const SKIPPED_FILE = /\.test\.[^/]+$|(?:^|\/)routeTree\.gen\.ts$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);
const STUB_PAGE_FILE = 'apps/web/src/components/stub-page.tsx';
const ALLOWLIST_FILE = 'apps/web/completeness-allowlist.json';
const ROUTE_TREE_FILE = 'apps/web/src/routeTree.gen.ts';

const PATTERNS = [/\bStubPage\b/, /coming soon/i, /\bTODO\b/, /\blorem\b/i];

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : filesUnder(join(dir, entry.name));
    }
    return [join(dir, entry.name)];
  });
}

function readPending(root) {
  const file = join(root, ALLOWLIST_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed.pending) ? parsed.pending : [];
}

function routeKeys(root) {
  const file = join(root, ROUTE_TREE_FILE);
  if (!existsSync(file)) return new Set();
  const source = readFileSync(file, 'utf8');
  const block = /interface FileRoutesByFullPath\s*\{([^}]*)\}/.exec(source);
  const keys = [...(block?.[1] ?? '').matchAll(/^\s*'([^']+)'\s*:/gm)];
  return new Set(keys.map((match) => match[1]));
}

function staleAllowlistHits(root, pending) {
  const routes = routeKeys(root);
  const hits = [];
  for (const entry of pending) {
    for (const file of entry.files ?? []) {
      if (!existsSync(join(root, file))) hits.push(`stale allowlist: ${file} does not exist`);
    }
    if (!routes.has(entry.route)) hits.push(`stale allowlist: ${entry.route} is not a route`);
  }
  return hits;
}

// Block comments collapse to a space, which shifts line numbers up; the real line is the first
// one at or after the stripped line that still holds the matched text.
function lineOf(rawLines, strippedIndex, matched) {
  const needle = matched.toLowerCase();
  for (let i = strippedIndex; i < rawLines.length; i += 1) {
    if (rawLines[i].toLowerCase().includes(needle)) return i + 1;
  }
  return strippedIndex + 1;
}

function fileHits(name, source) {
  const rawLines = source.split('\n');
  const found = [];
  withoutComments(source)
    .split('\n')
    .forEach((line, index) => {
      for (const pattern of PATTERNS) {
        const match = pattern.exec(line);
        if (!match) continue;
        const snippet = line.trim().slice(0, 80);
        found.push(`${name}:${lineOf(rawLines, index, match[0])}: ${pattern} "${snippet}"`);
      }
    });
  return found;
}

export function findPlaceholders(root) {
  const pending = readPending(root);
  const allowed = new Set(pending.flatMap((entry) => entry.files ?? []));
  if (pending.length > 0) allowed.add(STUB_PAGE_FILE);

  const candidates = [
    ...SCAN_DIRS.flatMap((dir) => filesUnder(join(root, dir))).filter((file) =>
      SCANNED_FILE.test(file),
    ),
    ...EXTRA_FILES.map((file) => join(root, file)).filter((file) => existsSync(file)),
  ];
  const hits = [];
  let scanned = 0;
  for (const file of candidates) {
    const name = relative(root, file).split(sep).join('/');
    if (SKIPPED_FILE.test(name)) continue;
    scanned += 1;
    if (allowed.has(name)) continue;
    hits.push(...fileHits(name, readFileSync(file, 'utf8')));
  }
  hits.push(...staleAllowlistHits(root, pending));
  return { hits, scanned };
}

function main() {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  const { hits, scanned } = findPlaceholders(root);
  if (hits.length > 0) {
    process.stdout.write(`check-placeholders: ${hits.length} problem(s)\n`);
    for (const hit of hits) process.stdout.write(`  ${hit}\n`);
    process.exit(1);
  }
  const pending = readPending(root).length;
  process.stdout.write(
    `check-placeholders: OK (${scanned} files scanned, ${pending} pending routes allowlisted)\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
