// Fakes and fixtures for the scripts/knoqra tests: a fake Cloudflare API, a scripted prompt, an
// output collector and base wrangler configs. Not a test file itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
export const TELNYX_KEY = Buffer.alloc(32, 3).toString('base64');
export const LICENSE_KEY = 'KNOQRA-LICENSE-1.eyJ2IjoxfQ.c2lnbmF0dXJl';

/** A base API config like apps/api/wrangler.jsonc, with an env block that must not leak. */
export const API_BASE = `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "knoqra-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  // Cron triggers.
  "triggers": { "crons": ["*/5 * * * *", "*/30 * * * *", "15 3 * * *"] },
  "vars": { "APP_ENV": "development", "PROVIDER": "fake", "KNOQRA_EDITION": "cloud" },
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      /* Placeholder id. */
      "id": "00000000000000000000000000000000",
      "localConnectionString": "postgres://knoqra_app:knoqra_app@localhost:54329/knoqra"
    }
  ],
  "queues": {
    "producers": [{ "binding": "PROVIDER_EVENTS", "queue": "knoqra-provider-events" }],
    "consumers": [
      {
        "queue": "knoqra-provider-events",
        "max_retries": 5,
        "dead_letter_queue": "knoqra-provider-events-dlq",
        "max_batch_timeout": 1,
      },
      { "queue": "knoqra-provider-events-dlq" }
    ]
  },
  "durable_objects": {
    "bindings": [
      { "name": "ORG_REALTIME", "class_name": "OrgRealtime" },
      { "name": "USER_CALL_LOCK", "class_name": "UserCallLock" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["OrgRealtime", "UserCallLock"] }],
  "env": {
    "staging": {
      "name": "knoqra-api-staging",
      "vars": { "APP_ENV": "staging", "KNOQRA_EDITION": "cloud" },
      "routes": [{ "pattern": "api.staging.example.app", "custom_domain": true }],
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "staging-hyperdrive-id" }]
    }
  }
}
`;

/** A base web config like apps/web/wrangler.jsonc. */
export const WEB_BASE = `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "knoqra-web",
  "main": "worker/index.ts",
  "compatibility_date": "2026-11-01",
  "observability": { "enabled": true },
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    // Only /api/* reaches the Worker script.
    "run_worker_first": ["/api/*"]
  },
  "services": [{ "binding": "API", "service": "knoqra-api" }],
  "env": {
    "staging": {
      "name": "knoqra-web-staging",
      "services": [{ "binding": "API", "service": "knoqra-api-staging" }]
    }
  }
}
`;

/** Complete saved settings for a domain deployment with every optional value set. */
export function fullSettings(overrides = {}) {
  return {
    CLOUDFLARE_API_TOKEN: 'cf-token-SECRET-0001',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    POSTGRES_OWNER_URL:
      'postgresql://neondb_owner:pg%2Fowner-SECRET@ep-example-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
    KNOQRA_ADDRESS: 'domain',
    KNOQRA_DOMAIN: 'example.com',
    CONNECTORS: 'telnyx,plivo',
    TELNYX_PUBLIC_KEY: TELNYX_KEY,
    RESEND_API_KEY: 're_resend_SECRET_0002',
    EMAIL_FROM: 'KNOQRA <no-reply@example.com>',
    AI_PROVIDER: 'openai',
    AI_API_KEY: 'sk-ai-SECRET-0003',
    AI_MODEL: 'example-model',
    AI_BASE_URL: 'https://ai.example.com/v1',
    KNOQRA_LICENSE_KEY: LICENSE_KEY,
    BETTER_AUTH_SECRET: Buffer.alloc(32, 1).toString('base64'),
    CREDENTIALS_MASTER_KEY: Buffer.alloc(32, 2).toString('base64'),
    KNOQRA_APP_DB_PASSWORD: 'abcdef0123456789abcdef0123456789abcdef0123456789',
    ...overrides,
  };
}

/** Every value in `settings` that must never be printed. */
export function secretsIn(settings) {
  return [
    settings.CLOUDFLARE_API_TOKEN,
    settings.POSTGRES_OWNER_URL,
    'pg%2Fowner-SECRET',
    'pg/owner-SECRET',
    settings.RESEND_API_KEY,
    settings.AI_API_KEY,
    settings.KNOQRA_LICENSE_KEY,
    settings.BETTER_AUTH_SECRET,
    settings.CREDENTIALS_MASTER_KEY,
    settings.KNOQRA_APP_DB_PASSWORD,
  ].filter(Boolean);
}

/** Collects written output. */
export function collector() {
  const chunks = [];
  return {
    write: (text) => {
      chunks.push(String(text));
    },
    text: () => chunks.join(''),
  };
}

/**
 * A prompt that answers by question id. An array answers successive asks of the same id; a
 * missing or used-up id answers '' (Enter). Throws after too many questions (a loop).
 */
export function scriptedPrompt(answers = {}) {
  const queues = new Map(
    Object.entries(answers).map(([id, value]) => [id, Array.isArray(value) ? [...value] : [value]]),
  );
  const asked = [];
  return {
    asked,
    closed: false,
    async ask(question) {
      asked.push(question);
      if (asked.length > 100) throw new Error(`Too many questions; last: ${question.id}`);
      const queue = queues.get(question.id);
      return queue && queue.length > 0 ? queue.shift() : '';
    },
    close() {
      this.closed = true;
    },
  };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake Cloudflare API (and health endpoint) that records every request. */
export function fakeCloudflare(options = {}) {
  const {
    accounts = [{ id: ACCOUNT_ID, name: 'Example account' }],
    zones = ['example.com'],
    subdomain = 'example-sub',
    hyperdrive = [],
    queues = [],
    buckets = [],
    tokenOk = true,
    health = { status: 200, body: '{"status":"ok"}' },
  } = options;
  const requests = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = `${url.pathname.replace(/^\/client\/v4/, '')}${url.search}`;
    requests.push({
      method,
      host: url.host,
      path,
      auth: init.headers?.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (url.host !== 'api.cloudflare.com')
      return new Response(health.body, { status: health.status });
    if (!tokenOk)
      return json(403, {
        success: false,
        errors: [{ code: 9109, message: 'Invalid access token' }],
      });
    const ok = (result) => json(200, { success: true, errors: [], result });
    const route = `${method} ${url.pathname.replace(/^\/client\/v4/, '')}`;
    const acc = `/accounts/${ACCOUNT_ID}`;
    if (route === 'GET /accounts') return ok(accounts);
    if (route === 'GET /zones') return ok(zones.map((name) => ({ name })));
    if (route === `GET ${acc}/workers/subdomain`) {
      return subdomain
        ? ok({ subdomain })
        : json(404, { success: false, errors: [{ code: 10007, message: 'not found' }] });
    }
    if (route === `GET ${acc}/hyperdrive/configs`) return ok(hyperdrive);
    if (route === `POST ${acc}/hyperdrive/configs`) return ok({ id: 'new-hyperdrive-id' });
    if (route.startsWith(`PUT ${acc}/hyperdrive/configs/`)) return ok({});
    if (route === `GET ${acc}/queues`) return ok(queues.map((queue_name) => ({ queue_name })));
    if (route === `POST ${acc}/queues`) return ok({});
    if (route === `GET ${acc}/r2/buckets`)
      return ok({ buckets: buckets.map((name) => ({ name })) });
    if (route === `POST ${acc}/r2/buckets`) return ok({});
    return json(404, { success: false, errors: [{ code: 7003, message: `No route ${route}` }] });
  };
  return { fetch, requests };
}

/** A temp repository root with base wrangler configs. */
export function makeRoot(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knoqra-cli-'));
  const all = {
    'apps/api/wrangler.jsonc': API_BASE,
    'apps/web/wrangler.jsonc': WEB_BASE,
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fake exec that records each command. */
export function fakeExec(onRun) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    await onRun?.({ command, args, ...options });
  };
  return { exec, calls };
}

/** A fake Postgres adapter. */
export function fakeDb(
  check = {
    ok: true,
    user: 'neondb_owner',
    database: 'neondb',
    version: '17.2',
    major: 17,
    canCreateRole: true,
  },
) {
  const calls = [];
  return {
    calls,
    async check(url) {
      calls.push({ op: 'check', url });
      return check;
    },
    async ensureAppRole(ownerUrl, password) {
      calls.push({ op: 'ensureAppRole', ownerUrl, password });
      return { created: true };
    },
  };
}

/** Deterministic random bytes. */
export const fixedRandom = (n) => Buffer.alloc(n, 7);
