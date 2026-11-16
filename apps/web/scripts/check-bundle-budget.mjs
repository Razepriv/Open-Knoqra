// Fails the web build when the initial JS (entry plus its static-import closure, gzipped) goes over
// budget, or when a route chunk (anything under src/routes/ except __root.tsx) becomes eager.
// Reads dist/.vite/manifest.json. `--json` prints the result for perf:web.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const ROOT_ROUTE = 'src/routes/__root.tsx';

/** Manifest keys of the entry chunk and everything it reaches through static `imports`. */
export function initialChunks(manifest) {
  const entry = Object.keys(manifest).find((key) => manifest[key].isEntry);
  if (entry === undefined) return [];
  const seen = new Set();
  const order = [];
  const visit = (key) => {
    if (seen.has(key) || manifest[key] === undefined) return;
    seen.add(key);
    order.push(key);
    for (const next of manifest[key].imports ?? []) visit(next);
  };
  visit(entry);
  return order;
}

function routeSource(key, chunk, routesPrefix) {
  // Rolldown names split route chunks `src/routes/x.tsx?tsr-split=component`; strip the query.
  for (const candidate of [chunk.src, key]) {
    if (typeof candidate !== 'string') continue;
    const path = candidate.split('?')[0];
    if (path.startsWith(routesPrefix) && path !== ROOT_ROUTE) return path;
  }
  return null;
}

export function checkBudget({
  manifest,
  sizes,
  budgetBytes = 200 * KB,
  routesPrefix = 'src/routes/',
}) {
  const keys = initialChunks(manifest);
  const files = keys.map((key) => manifest[key].file);
  const initialBytes = files.reduce((sum, file) => sum + (sizes.get(file) ?? 0), 0);
  const violations = [];
  if (initialBytes > budgetBytes) {
    violations.push(
      `initial JS ${(initialBytes / KB).toFixed(1)} KB gzipped is over the ${Math.round(budgetBytes / KB)} KB budget`,
    );
  }
  for (const key of keys) {
    const route = routeSource(key, manifest[key], routesPrefix);
    if (route !== null) {
      violations.push(`route chunk ${route} is in the initial bundle (must be lazy)`);
    }
  }
  return { initialBytes, files, violations };
}

function run(argv) {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));
  const sizes = new Map();
  for (const key of initialChunks(manifest)) {
    const file = manifest[key].file;
    sizes.set(file, gzipSync(readFileSync(join(dist, file))).length);
  }
  const result = checkBudget({ manifest, sizes });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...result, sizes: Object.fromEntries(sizes) })}\n`);
  } else {
    for (const file of result.files) {
      process.stdout.write(
        `  ${((sizes.get(file) ?? 0) / KB).toFixed(1).padStart(7)} KB  ${file}\n`,
      );
    }
    process.stdout.write(
      `initial JS: ${(result.initialBytes / KB).toFixed(1)} KB gzipped (${result.initialBytes} bytes, budget 200 KB)\n`,
    );
  }
  if (result.violations.length > 0) {
    for (const violation of result.violations) process.stderr.write(`FAIL ${violation}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2));
}
