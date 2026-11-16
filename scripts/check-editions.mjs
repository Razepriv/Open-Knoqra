// Edition boundary check: no file outside a `pro/` folder may import from one. KNOQRA Cloud keeps
// its private code in `pro/` folders (EDITIONS.md); the open-source tree is the repository without
// them, so a core file that reaches into one breaks the public build. Also checks that every
// `pro/` folder carries its own LICENSE. Plain Node, no dependencies: `pnpm check:editions`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = /\.(?:[cm]?[jt]sx?|astro)$/;
/** Files whose Pro-looking specifiers are test data, not imports (scripts/export is private too). */
const IGNORED = new Set(['scripts/check-editions.test.mjs']);
/** Static imports and re-exports, side-effect imports, dynamic imports and require calls. */
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Whether a repository path is inside a `pro/` folder. */
export const isPro = (path) => path.split('/').includes('pro');

/** Every module specifier written literally in `text`. */
export function specifiersOf(text) {
  const found = new Set();
  for (const pattern of SPECIFIERS) for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

/** Whether `specifier`, written in the core file `from`, points into a `pro/` folder. */
export function reachesPro(from, specifier) {
  if (specifier.startsWith('.')) {
    return isPro(posix.normalize(posix.join(posix.dirname(from), specifier)));
  }
  // A workspace package's private subpath, such as `@knoqra/core/pro`.
  return /^@knoqra\/[^/]+\/pro(?:\/|$)/.test(specifier);
}

/**
 * The violations among `files` (repository paths): core files importing Pro code, and `pro/`
 * folders without a LICENSE. `read` returns a file's text; `exists` says whether a path exists.
 */
export function checkEditions(files, read, exists) {
  const errors = [];
  const proRoots = new Set();
  for (const file of files) {
    if (isPro(file)) {
      const parts = file.split('/');
      proRoots.add(parts.slice(0, parts.indexOf('pro') + 1).join('/'));
      continue;
    }
    if (!SOURCE.test(file) || IGNORED.has(file) || file.startsWith('scripts/export/')) continue;
    for (const specifier of specifiersOf(read(file))) {
      if (reachesPro(file, specifier)) errors.push(`${file}: imports Pro code (${specifier})`);
    }
  }
  for (const root of [...proRoots].sort()) {
    if (!exists(`${root}/LICENSE`)) errors.push(`${root}: a pro/ folder needs its own LICENSE`);
  }
  return errors;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', '.wrangler', 'dist', 'coverage']);

function walk(dir, root, found = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, found);
    else found.push(relative(root, full).split(sep).join('/'));
  }
  return found;
}

/** The repository's files: git's list when this is a checkout, else a walk (an exported tree). */
function listFiles(root) {
  try {
    const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return listed.split('\n').filter((f) => f && existsSync(join(root, f)));
  } catch {
    return walk(root, root);
  }
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = listFiles(root);
  const errors = checkEditions(
    files,
    (f) => readFileSync(join(root, f), 'utf8'),
    (f) => existsSync(join(root, f)),
  );
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.stdout.write(
    errors.length === 0
      ? `check:editions: ${files.length} files, no core file imports Pro code\n`
      : `check:editions: ${errors.length} problem(s)\n`,
  );
  if (errors.length > 0) process.exitCode = 1;
}
