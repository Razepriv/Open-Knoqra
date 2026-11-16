// Fails (exit 1) when the built web app contains a secret name or a local secret value.
// The web app only talks to /api/*; no secret may ever reach the browser bundle.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const devVarsFile = fileURLToPath(new URL('../../api/.dev.vars', import.meta.url));

/** Names that must never appear in the bundle. */
const FORBIDDEN_NAMES = [
  'KEY0',
  'BETTER_AUTH_SECRET',
  'FAKE_WEBHOOK_SECRET',
  'CREDENTIALS_MASTER_KEY',
  'TELNYX_API_KEY',
  'SENTRY_AUTH_TOKEN',
];

/** .dev.vars keys whose values are secret (connection strings carry a password). */
const SECRET_KEY = /SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL/i;

/**
 * Public by design: a Sentry DSN and a PostHog project key are meant to ship in browser code
 * (the Desk's own VITE_* copies do), so their values are not scanned for.
 */
const PUBLIC_KEYS = new Set(['SENTRY_DSN', 'POSTHOG_KEY']);

/** Shorter values are too generic to scan for without false hits. */
const MIN_VALUE_LENGTH = 8;

function out(line) {
  process.stdout.write(`${line}\n`);
}

/** Literal secret values from apps/api/.dev.vars, when the file exists. */
function localSecretValues() {
  if (!existsSync(devVarsFile)) return [];
  const values = [];
  for (const raw of readFileSync(devVarsFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    if (PUBLIC_KEYS.has(key)) continue;
    if (SECRET_KEY.test(key) && value.length >= MIN_VALUE_LENGTH) values.push({ key, value });
  }
  return values;
}

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

if (!existsSync(distDir)) {
  out('check-no-secrets: dist/ not found. Run `pnpm --filter @knoqra/web build` first.');
  process.exit(1);
}

const needles = [
  ...FORBIDDEN_NAMES.map((name) => ({ label: name, text: name })),
  // Report the key, never the value.
  ...localSecretValues().map(({ key, value }) => ({ label: `value of ${key}`, text: value })),
];

const hits = [];
const files = filesUnder(distDir);
for (const file of files) {
  const content = readFileSync(file).toString('latin1');
  for (const needle of needles) {
    if (content.includes(needle.text)) hits.push(`${relative(distDir, file)}: ${needle.label}`);
  }
}

if (hits.length > 0) {
  out(`check-no-secrets: ${hits.length} hit(s) in dist/:`);
  for (const hit of hits) out(`  ${hit}`);
  process.exit(1);
}
out(`check-no-secrets: no secrets found (${files.length} files, ${needles.length} patterns)`);
