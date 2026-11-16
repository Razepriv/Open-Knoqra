import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface PendingRoute {
  route: string;
  owner: string;
  files: string[];
}

/** Routes whose real screens still live on unmerged branches (apps/web/completeness-allowlist.json). */
export function readPendingRoutes(): PendingRoute[] {
  const file = fileURLToPath(new URL('../../completeness-allowlist.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const pending = (parsed as { pending?: unknown }).pending;
  if (!Array.isArray(pending)) {
    throw new Error('completeness-allowlist.json needs a "pending" array');
  }
  return pending as PendingRoute[];
}

export function isPending(pattern: string, pending: PendingRoute[]): boolean {
  return pending.some((entry) => entry.route === pattern);
}
