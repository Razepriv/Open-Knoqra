// Fails (exit 1) when anything under apps/ imports or depends on ascii-reveal.
// Loading states go through Skeleton and Reveal from @knoqra/ui, which pins ascii-reveal, so
// apps never touch the library directly. Usage: node scripts/check-imports.mjs [repoRoot]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from './lib/source-text.mjs';

const PACKAGE = 'ascii-reveal';
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.wrangler', '.turbo', 'coverage']);

// `from 'ascii-reveal'`, `import 'ascii-reveal'`, `import('ascii-reveal')`, `require('ascii-reveal')`,
// plus subpaths. Requiring the keyword keeps comments and strings that merely name it from tripping.
const IMPORT_OF_PACKAGE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]ascii-reveal(?:\/[^'"`]*)?['"`]/;

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const appsDir = join(root, 'apps');

function out(line) {
  process.stdout.write(`${line}\n`);
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIPPED_DIRS.has(entry.name) ? [] : filesUnder(join(dir, entry.name));
    }
    return [join(dir, entry.name)];
  });
}

function declaresDependency(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
      (field) => manifest[field] && PACKAGE in manifest[field],
    );
  } catch {
    return false;
  }
}

const hits = [];
const files = existsSync(appsDir) ? filesUnder(appsDir) : [];
for (const file of files) {
  const name = relative(root, file).split(sep).join('/');
  if (file.endsWith(`${sep}package.json`)) {
    if (declaresDependency(file)) hits.push(`${name}: declares a dependency on ${PACKAGE}`);
  } else if (
    SOURCE_FILE.test(file) &&
    IMPORT_OF_PACKAGE.test(withoutComments(readFileSync(file, 'utf8')))
  ) {
    hits.push(`${name}: imports ${PACKAGE}`);
  }
}

if (hits.length > 0) {
  out(
    `check-imports: ${hits.length} violation(s). Use Skeleton or Reveal from @knoqra/ui instead.`,
  );
  for (const hit of hits) out(`  ${hit}`);
  process.exit(1);
}
out(`check-imports: OK (${files.length} files under apps/ scanned)`);
