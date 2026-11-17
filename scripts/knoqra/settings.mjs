// Names, derived values and checks shared by `pnpm knoqra setup` and `pnpm knoqra deploy`.

export const ENV_FILE_NAME = '.env.selfhost';
export const API_WORKER = 'knoqra-api';
export const WEB_WORKER = 'knoqra-web';
export const HYPERDRIVE_NAME = 'knoqra';
export const APP_ROLE = 'knoqra_app';
export const CONFIG_FILE_NAME = 'wrangler.selfhost.jsonc';
export const LICENSE_START_URL = 'https://app.knoqra.app/api/license/github/start';
export const CONNECTOR_NAMES = ['telnyx', 'plivo'];
export const AI_PROVIDERS = ['mock', 'openai', 'none', 'chatgpt'];

/** Settings whose values are never printed. */
export const SECRET_KEYS = [
  'CLOUDFLARE_API_TOKEN',
  'POSTGRES_OWNER_URL',
  'RESEND_API_KEY',
  'AI_API_KEY',
  'KNOQRA_LICENSE_KEY',
  'BETTER_AUTH_SECRET',
  'CREDENTIALS_MASTER_KEY',
  'KNOQRA_APP_DB_PASSWORD',
];

/** Every setting, in the order the summary lists them. */
export const ALL_KEYS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'POSTGRES_OWNER_URL',
  'KNOQRA_ADDRESS',
  'KNOQRA_DOMAIN',
  'KNOQRA_WORKERS_SUBDOMAIN',
  'CONNECTORS',
  'TELNYX_PUBLIC_KEY',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_BASE_URL',
  'KNOQRA_LICENSE_KEY',
  'BETTER_AUTH_SECRET',
  'CREDENTIALS_MASTER_KEY',
  'KNOQRA_APP_DB_PASSWORD',
];

/** Thrown for a problem the user fixes by re-running setup or editing the settings file. */
export class SetupError extends Error {}

/** Lowercases a domain and drops a scheme, path, port and trailing dot the user may have pasted. */
export function normalizeDomain(input) {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#:].*$/, '')
    .replace(/\.$/, '');
}

/** True for a plausible DNS name with at least two labels. */
export function isDomain(input) {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(
    input,
  );
}

/** Reduces `example.workers.dev` or a full URL to the account part, `example`. */
export function normalizeSubdomain(input) {
  return normalizeDomain(input).replace(/\.workers\.dev$/, '');
}

/** The comma list of connectors as an array of known names, in canonical order. */
export function connectorsOf(values) {
  const listed = String(values.CONNECTORS ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return CONNECTOR_NAMES.filter((name) => listed.includes(name));
}

/** The Desk and API origins for the chosen address. Throws a SetupError when it is incomplete. */
export function originsOf(values) {
  if (values.KNOQRA_ADDRESS === 'domain') {
    const domain = normalizeDomain(values.KNOQRA_DOMAIN ?? '');
    if (!isDomain(domain)) throw new SetupError('KNOQRA_DOMAIN is not set to a domain.');
    return { desk: `https://app.${domain}`, api: `https://api.${domain}`, mode: 'domain', domain };
  }
  if (values.KNOQRA_ADDRESS === 'workers.dev') {
    const sub = normalizeSubdomain(values.KNOQRA_WORKERS_SUBDOMAIN ?? '');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) {
      throw new SetupError('KNOQRA_WORKERS_SUBDOMAIN is not set.');
    }
    return {
      desk: `https://${WEB_WORKER}.${sub}.workers.dev`,
      api: `https://${API_WORKER}.${sub}.workers.dev`,
      mode: 'workers.dev',
      subdomain: sub,
    };
  }
  throw new SetupError('KNOQRA_ADDRESS is not set (domain or workers.dev).');
}

/** True for a postgres:// or postgresql:// URL with a host. */
export function isPostgresUrl(input) {
  try {
    const url = new URL(String(input));
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** Neon's pooled host (`...-pooler.region...`) switched to its direct host. Others unchanged. */
export function directHost(url) {
  return String(url).replace('-pooler.', '.');
}

/** The app role's connection string: the owner URL with knoqra_app's login, on the direct host. */
export function appDatabaseUrl(ownerUrl, password) {
  const url = new URL(directHost(ownerUrl));
  url.username = APP_ROLE;
  url.password = password;
  return url.toString();
}

/** True for a key of the form KNOQRA-LICENSE-1.<base64url>.<base64url>. Shape only. */
export function isLicenseKeyShape(input) {
  return /^KNOQRA-LICENSE-1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(input).trim());
}

/** True for base64 of exactly 32 bytes (a Telnyx Ed25519 public key, a master key). */
export function isBase64Of32Bytes(input) {
  const text = String(input).trim();
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text) && Buffer.from(text, 'base64').length === 32;
}

/** The values to hide from every line of output: secret settings and parts derived from them. */
export function secretStrings(values) {
  const found = new Set();
  for (const key of SECRET_KEYS) {
    const value = values[key];
    if (typeof value === 'string' && value.length >= 6) found.add(value);
  }
  for (const key of ['POSTGRES_OWNER_URL']) {
    const value = values[key];
    if (!isPostgresUrl(value)) continue;
    const url = new URL(value);
    for (const part of [url.password, decodeURIComponent(url.password)]) {
      if (part.length >= 4) found.add(part);
    }
    found.add(directHost(value));
    if (values.KNOQRA_APP_DB_PASSWORD) {
      found.add(appDatabaseUrl(value, values.KNOQRA_APP_DB_PASSWORD));
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** Replaces each secret string in `text` with [hidden]. */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[hidden]');
  }
  return out;
}
