// Repository paths shared by the perf tools.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The monorepo root (this file lives in packages/perf/src). */
export const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where `perf:seed` records the ids later tools need. Gitignored. */
export const FIXTURES_PATH: string = join(REPO_ROOT, '.perf', 'fixtures.json');

/** True when `metaUrl` (an `import.meta.url`) is the script node was started with. */
export function isEntryPoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(entry).href;
}
