// Reads apps/api/.dev.vars (gitignored) so the in-process API harness runs with the same
// secrets as `wrangler dev`. Mirrors the parser in apps/web/e2e/dev-vars.ts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths';

function unquote(value: string): string | null {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2) return null;
  const end = value.indexOf(quote, 1);
  return end === -1 ? null : value.slice(1, end);
}

/** Parses dotenv-style text the way wrangler does (export prefix, quotes, inline comments). */
export function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    const rest = line.slice(eq + 1).trim();
    vars[line.slice(0, eq).trim()] = unquote(rest) ?? rest.replace(/\s+#.*$/, '').trim();
  }
  return vars;
}

/** The variables in apps/api/.dev.vars, or an empty record when the file is absent. */
export function readDevVars(): Record<string, string> {
  const file = join(REPO_ROOT, 'apps', 'api', '.dev.vars');
  return existsSync(file) ? parseDevVars(readFileSync(file, 'utf8')) : {};
}
