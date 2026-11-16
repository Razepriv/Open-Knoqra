import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseEnv } from './env-file.mjs';
import { main } from './main.mjs';
import { runSetup } from './questions.mjs';
import { isBase64Of32Bytes } from './settings.mjs';
import {
  ACCOUNT_ID,
  collector,
  fakeCloudflare,
  fakeDb,
  fixedRandom,
  fullSettings,
  LICENSE_KEY,
  scriptedPrompt,
  secretsIn,
  TELNYX_KEY,
} from './test-helpers.mjs';

const TOKEN = 'cf-token-SECRET-0001';
const POOLED =
  'postgresql://neondb_owner:pg-owner-SECRET@ep-example-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

/** Runs the questionnaire with fakes and returns everything worth checking. */
async function setup(
  answers,
  { values = {}, cloudflare = {}, db = fakeDb(), dryRun = false } = {},
) {
  const prompt = scriptedPrompt(answers);
  const cf = fakeCloudflare(cloudflare);
  const out = collector();
  const saves = [];
  const result = await runSetup({
    values,
    prompt,
    fetch: cf.fetch,
    checkPostgres: (url) => db.check(url),
    randomBytes: fixedRandom,
    write: out.write,
    dryRun,
    save: (next) => {
      saves.push({ ...next });
    },
  });
  const ids = prompt.asked.map((q) => q.id);
  return { result, prompt, ids, output: out.text(), saves, requests: cf.requests, db };
}

function assertNoSecrets(output, values) {
  for (const secret of secretsIn(values)) {
    assert.equal(
      output.includes(secret),
      false,
      `output shows a secret (${secret.slice(0, 6)}...)`,
    );
  }
}

const base = {
  CLOUDFLARE_API_TOKEN: TOKEN,
  POSTGRES_OWNER_URL: POOLED,
};

describe('runSetup', () => {
  it('domain, Telnyx and the mock AI from scratch', async () => {
    const run = await setup({
      ...base,
      testPostgres: 'y',
      KNOQRA_ADDRESS: '1',
      KNOQRA_DOMAIN: '',
      CONNECTORS: '1',
      TELNYX_PUBLIC_KEY: TELNYX_KEY,
      AI_PROVIDER: '1',
    });
    const v = run.result;
    assert.equal(v.CLOUDFLARE_API_TOKEN, TOKEN);
    assert.equal(v.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID, 'the only account is picked');
    assert.equal(v.POSTGRES_OWNER_URL.includes('-pooler.'), false);
    assert.match(v.POSTGRES_OWNER_URL, /@ep-example-123\.us-east-2/);
    assert.equal(v.KNOQRA_ADDRESS, 'domain');
    assert.equal(v.KNOQRA_DOMAIN, 'example.com', 'Enter uses the only zone');
    assert.equal(v.CONNECTORS, 'telnyx');
    assert.equal(v.TELNYX_PUBLIC_KEY, TELNYX_KEY);
    assert.equal(v.AI_PROVIDER, 'mock');
    assert.equal(v.RESEND_API_KEY ?? '', '');
    assert.equal(v.KNOQRA_LICENSE_KEY ?? '', '');
    assert.ok(isBase64Of32Bytes(v.BETTER_AUTH_SECRET));
    assert.ok(isBase64Of32Bytes(v.CREDENTIALS_MASTER_KEY));
    assert.match(v.KNOQRA_APP_DB_PASSWORD, /^[0-9a-f]{48}$/);
    assert.equal('KNOQRA_EDITION' in v, false);
    assert.equal(run.ids.includes('CLOUDFLARE_ACCOUNT_ID'), false, 'not asked');

    assert.match(run.output, /Switched it to the direct \(non-pooled\) host/);
    assert.match(run.output, /Connected as neondb_owner to neondb, Postgres 17\.2/);
    assert.match(run.output, /https:\/\/app\.example\.com, the API at https:\/\/api\.example\.com/);
    assert.match(run.output, /Settings › Connectors/);
    assert.match(run.output, /Neon/);
    assert.match(run.output, /Account · Hyperdrive · Edit/);
    assert.match(run.output, /Account · Queues · Edit/);
    assert.match(run.output, /Zone · DNS · Edit/);
    assert.match(run.output, /Account · Workers Scripts · Edit/);
    assert.match(run.output, /Edit Cloudflare Workers/);
    assert.match(run.output, /CREDENTIALS_MASTER_KEY is lost/);
    assert.match(run.output, /Next: pnpm knoqra deploy/);
    assert.equal(run.saves.length, 8, 'saved after every step');
    assert.deepEqual(run.saves.at(-1), v);
    assert.equal(run.db.calls[0].url, v.POSTGRES_OWNER_URL, 'tests the direct host');
    assert.ok(run.requests.every((r) => r.method === 'GET'));
    assert.ok(run.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
    assertNoSecrets(run.output, v);
  });

  it('workers.dev, Plivo and an OpenAI-compatible key', async () => {
    const run = await setup({
      ...base,
      testPostgres: 'n',
      KNOQRA_ADDRESS: 'workers.dev',
      CONNECTORS: '2',
      AI_PROVIDER: '2',
      AI_API_KEY: 'sk-ai-SECRET-0003',
      AI_MODEL: 'example-model',
      AI_BASE_URL: 'https://ai.example.com/v1/',
    });
    const v = run.result;
    assert.equal(v.KNOQRA_ADDRESS, 'workers.dev');
    assert.equal(v.KNOQRA_WORKERS_SUBDOMAIN, 'example-sub');
    assert.equal(v.CONNECTORS, 'plivo');
    assert.equal(run.ids.includes('TELNYX_PUBLIC_KEY'), false, 'no Telnyx key for Plivo only');
    assert.equal(run.ids.includes('KNOQRA_WORKERS_SUBDOMAIN'), false, 'looked up, not asked');
    assert.equal(v.AI_PROVIDER, 'openai');
    assert.equal(v.AI_API_KEY, 'sk-ai-SECRET-0003');
    assert.equal(v.AI_MODEL, 'example-model');
    assert.equal(v.AI_BASE_URL, 'https://ai.example.com/v1');
    assert.equal(run.db.calls.length, 0, 'connection test skipped');
    assert.match(run.output, /https:\/\/knoqra-web\.example-sub\.workers\.dev/);
    assert.match(run.output, /https:\/\/knoqra-api\.example-sub\.workers\.dev/);
    assert.ok(
      run.requests.some((r) => r.path === `/accounts/${ACCOUNT_ID}/workers/subdomain`),
      'looks up the subdomain',
    );
    assert.ok(run.prompt.asked.find((q) => q.id === 'AI_API_KEY').secret, 'the key is hidden');
    assertNoSecrets(run.output, v);
  });

  it('both providers, ChatGPT sign-in, email and a license key', async () => {
    const run = await setup({
      ...base,
      KNOQRA_ADDRESS: '1',
      KNOQRA_DOMAIN: 'https://Example.COM/',
      CONNECTORS: '3',
      TELNYX_PUBLIC_KEY: ['not-a-key', ''],
      RESEND_API_KEY: 're_resend_SECRET_0002',
      EMAIL_FROM: 'KNOQRA <no-reply@example.com>',
      AI_PROVIDER: 'chatgpt',
      KNOQRA_LICENSE_KEY: ['KNOQRA-LICENSE-2.abc.def', LICENSE_KEY],
    });
    const v = run.result;
    assert.equal(v.KNOQRA_DOMAIN, 'example.com');
    assert.equal(v.CONNECTORS, 'telnyx,plivo');
    assert.equal(v.TELNYX_PUBLIC_KEY, '', 'an invalid key is refused, Enter skips');
    assert.match(run.output, /not a base64 key of 32 bytes/);
    assert.equal(v.RESEND_API_KEY, 're_resend_SECRET_0002');
    assert.equal(v.EMAIL_FROM, 'KNOQRA <no-reply@example.com>');
    assert.equal(v.AI_PROVIDER, 'chatgpt');
    assert.match(run.output, /coming in a later release.*mock/);
    assert.equal(v.KNOQRA_LICENSE_KEY, LICENSE_KEY);
    assert.match(run.output, /not a license key/);
    assert.match(run.output, /api\/license\/github\/start/);
    assert.match(run.output, /not a software license/);
    assert.match(run.output, /AGPL-3\.0/);
    assert.ok(run.prompt.asked.find((q) => q.id === 'KNOQRA_LICENSE_KEY').secret);
    assertNoSecrets(run.output, v);
  });

  it('never asks about the edition', async () => {
    const run = await setup({ ...base, KNOQRA_ADDRESS: '2', CONNECTORS: '1', AI_PROVIDER: '1' });
    for (const q of run.prompt.asked) {
      assert.doesNotMatch(`${q.id} ${q.label}`, /edition/i);
    }
    assert.doesNotMatch(run.output, /KNOQRA_EDITION|cloud edition/i);
    assert.equal('KNOQRA_EDITION' in run.result, false);
  });

  it('keeps every saved value on Enter, and generated secrets are not replaced', async () => {
    const saved = fullSettings();
    const run = await setup({}, { values: saved });
    assert.deepEqual(run.result, saved);
    const tokenQuestion = run.prompt.asked.find((q) => q.id === 'CLOUDFLARE_API_TOKEN');
    assert.equal(tokenQuestion.hint, 'saved, Enter keeps it');
    assert.equal(tokenQuestion.secret, true);
    assert.equal(
      run.prompt.asked.find((q) => q.id === 'EMAIL_FROM').hint,
      'saved, Enter keeps it, - clears it',
    );
    assert.match(run.output, /BETTER_AUTH_SECRET \(kept\)/);
    assertNoSecrets(run.output, saved);
  });

  it('clears a saved optional value with -', async () => {
    const run = await setup({ RESEND_API_KEY: '-', EMAIL_FROM: '-' }, { values: fullSettings() });
    assert.equal(run.result.RESEND_API_KEY, '');
    assert.equal(run.result.EMAIL_FROM, '');
  });

  it('asks for the account when the token is refused, and re-asks a required answer', async () => {
    const run = await setup(
      {
        CLOUDFLARE_API_TOKEN: TOKEN,
        retryCloudflare: 'n',
        CLOUDFLARE_ACCOUNT_ID: ['', 'not-an-id', ACCOUNT_ID.toUpperCase()],
        POSTGRES_OWNER_URL: ['mysql://nope', POOLED],
        testPostgres: 'n',
        KNOQRA_ADDRESS: '2',
        KNOQRA_WORKERS_SUBDOMAIN: 'example-sub',
        CONNECTORS: '1',
        AI_PROVIDER: '1',
      },
      { cloudflare: { tokenOk: false, subdomain: null } },
    );
    assert.match(run.output, /Cloudflare did not accept that token \(.*Invalid access token\)/);
    assert.match(run.output, /This one is required/);
    assert.match(run.output, /32 hex characters/);
    assert.match(run.output, /not a connection string/);
    assert.equal(run.result.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID);
    assert.equal(run.result.CLOUDFLARE_API_TOKEN, TOKEN, 'kept, so it can be fixed later');
  });

  it('picks an account by number when there are several', async () => {
    const other = 'fedcba9876543210fedcba9876543210';
    const run = await setup(
      {
        ...base,
        CLOUDFLARE_ACCOUNT_ID: '2',
        KNOQRA_ADDRESS: '1',
        CONNECTORS: '1',
        AI_PROVIDER: '1',
      },
      {
        cloudflare: {
          accounts: [
            { id: ACCOUNT_ID, name: 'First' },
            { id: other, name: 'Second' },
          ],
        },
      },
    );
    assert.equal(run.result.CLOUDFLARE_ACCOUNT_ID, other);
    assert.match(run.output, /2\) Second/);
  });

  it('asks for the workers.dev subdomain when the account has none yet', async () => {
    const run = await setup(
      {
        ...base,
        KNOQRA_ADDRESS: '2',
        KNOQRA_WORKERS_SUBDOMAIN: 'My-Sub.workers.dev',
        CONNECTORS: '1',
        AI_PROVIDER: '1',
      },
      { cloudflare: { subdomain: null } },
    );
    assert.equal(run.result.KNOQRA_WORKERS_SUBDOMAIN, 'my-sub');
    assert.match(run.output, /knoqra-web\.my-sub\.workers\.dev/);
  });

  it('warns about a domain the token cannot see', async () => {
    const run = await setup({
      ...base,
      KNOQRA_ADDRESS: '1',
      KNOQRA_DOMAIN: 'example.org',
      CONNECTORS: '1',
      AI_PROVIDER: '1',
    });
    assert.match(run.output, /example\.org is not among the domains this token can see/);
  });

  it('skips the connection test with a note when pg is not installed', async () => {
    const db = fakeDb({
      skipped: true,
      reason: 'pg is not installed yet (run pnpm install first).',
    });
    const run = await setup(
      { ...base, KNOQRA_ADDRESS: '2', CONNECTORS: '1', AI_PROVIDER: '1' },
      { db },
    );
    assert.match(run.output, /Skipped the connection test: pg is not installed/);
  });

  it('reports a failed connection without the connection string', async () => {
    const db = fakeDb({
      ok: false,
      error: 'password authentication failed for user "neondb_owner"',
    });
    const run = await setup(
      { ...base, retryPostgres: 'n', KNOQRA_ADDRESS: '2', CONNECTORS: '1', AI_PROVIDER: '1' },
      { db },
    );
    assert.match(run.output, /Could not connect: password authentication failed/);
    assertNoSecrets(run.output, run.result);
  });
});

describe('pnpm knoqra setup', () => {
  const dirs = [];
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function cli(argv, answers) {
    const dir = mkdtempSync(join(tmpdir(), 'knoqra-setup-'));
    dirs.push(dir);
    const out = collector();
    const prompt = scriptedPrompt(answers);
    const code = await main(argv(dir), {
      root: dir,
      cwd: dir,
      write: out.write,
      fetch: fakeCloudflare().fetch,
      createPrompt: () => prompt,
      createExec: () => assert.fail('setup runs no commands'),
      db: fakeDb(),
      randomBytes: fixedRandom,
    });
    return { code, dir, output: out.text(), prompt };
  }

  const answers = { ...base, KNOQRA_ADDRESS: '1', CONNECTORS: '1', AI_PROVIDER: '1' };

  it('writes .env.selfhost with mode 600 and prints no secret', async () => {
    const run = await cli(() => ['setup'], answers);
    assert.equal(run.code, 0);
    const path = join(run.dir, '.env.selfhost');
    const values = parseEnv(readFileSync(path, 'utf8'));
    assert.equal(values.CLOUDFLARE_API_TOKEN, TOKEN);
    assert.equal(values.KNOQRA_DOMAIN, 'example.com');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(run.prompt.closed);
    assertNoSecrets(run.output, values);
  });

  it('honours --env-file', async () => {
    const run = await cli((dir) => ['setup', '--env-file', join(dir, 'custom.env')], answers);
    assert.equal(run.code, 0);
    assert.ok(existsSync(join(run.dir, 'custom.env')));
    assert.equal(existsSync(join(run.dir, '.env.selfhost')), false);
  });

  it('writes nothing with --dry-run', async () => {
    const run = await cli(() => ['setup', '--dry-run'], answers);
    assert.equal(run.code, 0);
    assert.equal(existsSync(join(run.dir, '.env.selfhost')), false);
    assert.match(run.output, /Dry run: nothing was saved/);
  });
});
