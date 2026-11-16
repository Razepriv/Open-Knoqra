import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatCommand, hyperdriveBody, runDeploy, workerSecrets } from './deploy.mjs';
import { updateEnvText } from './env-file.mjs';
import { parseJsonc } from './jsonc.mjs';
import { main } from './main.mjs';
import { appDatabaseUrl, redact, secretStrings } from './settings.mjs';
import {
  ACCOUNT_ID,
  collector,
  fakeCloudflare,
  fakeDb,
  fakeExec,
  fullSettings,
  makeRoot,
  secretsIn,
} from './test-helpers.mjs';

const cleanups = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function root(files) {
  const made = makeRoot(files);
  cleanups.push(made.cleanup);
  return made.root;
}

/** Runs `pnpm knoqra deploy ...` through main() with fakes. */
async function cli(argv, { settings = fullSettings(), cloudflare = {}, onRun, files } = {}) {
  const dir = root(files);
  const envPath = join(dir, 'settings.env');
  writeFileSync(envPath, updateEnvText('', settings), { mode: 0o600 });
  const cf = fakeCloudflare(cloudflare);
  const exec = fakeExec(onRun);
  const db = fakeDb();
  const out = collector();
  const code = await main([...argv, '--env-file', envPath], {
    root: dir,
    cwd: dir,
    write: out.write,
    fetch: cf.fetch,
    createPrompt: () => assert.fail('deploy asks nothing'),
    createExec: () => exec.exec,
    db,
  });
  return { code, dir, envPath, output: out.text(), requests: cf.requests, exec, db, settings };
}

function assertNoSecrets(output, settings) {
  for (const secret of secretsIn(settings)) {
    assert.equal(
      output.includes(secret),
      false,
      `output shows a secret (${secret.slice(0, 6)}...)`,
    );
  }
}

const acc = `/accounts/${ACCOUNT_ID}`;

describe('pnpm knoqra deploy --dry-run', () => {
  it('plans every step, sends only reads, runs nothing and writes nothing', async () => {
    const run = await cli(['deploy', '--dry-run']);
    assert.equal(run.code, 0, run.output);
    const out = run.output;

    // Only reads reach the network.
    assert.deepEqual(
      run.requests.map(
        (r) => `${r.method} ${r.host === 'api.cloudflare.com' ? r.path : r.host + r.path}`,
      ),
      [
        `GET ${acc}/hyperdrive/configs`,
        `GET ${acc}/queues?per_page=100`,
        'GET api.example.com/api/health',
      ],
    );
    assert.equal(run.exec.calls.length, 0, 'no child process');
    assert.equal(run.db.calls.length, 0, 'no database change');
    assert.equal(existsSync(join(run.dir, 'apps/api/wrangler.selfhost.jsonc')), false);
    assert.equal(existsSync(join(run.dir, 'apps/web/wrangler.selfhost.jsonc')), false);
    assert.equal(readFileSync(run.envPath, 'utf8'), updateEnvText('', run.settings));

    // Every step, in order.
    const order = [
      'Database: app role and migrations',
      'Would create or update the knoqra_app login role (NOSUPERUSER NOBYPASSRLS).',
      '$ MIGRATION_DATABASE_URL=<hidden> pnpm --filter @knoqra/db migrate',
      'Cloudflare: Hyperdrive and queues',
      `GET ${acc}/hyperdrive/configs`,
      `POST ${acc}/hyperdrive/configs  (dry run: not sent)`,
      'Hyperdrive knoqra would be created, caching off',
      `GET ${acc}/queues?per_page=100`,
      `POST ${acc}/queues  (dry run: not sent)`,
      'Queue knoqra-provider-events would be created',
      'Queue knoqra-provider-events-dlq would be created',
      'Wrangler configs',
      'apps/api/wrangler.selfhost.jsonc (dry run: printed, not written):',
      'apps/web/wrangler.selfhost.jsonc (dry run: printed, not written):',
      'Deploy the API → https://api.example.com',
      '$ cd apps/api && pnpm exec wrangler deploy -c wrangler.selfhost.jsonc',
      'API secrets',
      '$ cd apps/api && pnpm exec wrangler secret bulk <secrets-file> -c wrangler.selfhost.jsonc',
      'Would set: BETTER_AUTH_SECRET, BETTER_AUTH_URL, CREDENTIALS_MASTER_KEY, TELNYX_PUBLIC_KEY, RESEND_API_KEY, EMAIL_FROM, AI_API_KEY, KNOQRA_LICENSE_KEY',
      'Build and deploy the Desk → https://app.example.com',
      '$ pnpm --filter @knoqra/web build',
      'Would delete the *.map files under apps/web/dist',
      '$ cd apps/web && pnpm exec wrangler deploy -c wrangler.selfhost.jsonc',
      'Status',
      'Desk: https://app.example.com',
      '/api/health: 200',
      'Next steps',
      '1. Open the Desk at https://app.example.com and sign up.',
      'The license key is set',
      'Settings › Connectors',
      'Setup page',
      'https://api.example.com/webhooks/telnyx',
      'Plivo',
    ];
    let at = -1;
    for (const text of order) {
      const found = out.indexOf(text, at + 1);
      assert.ok(found > at, `expected "${text}" after position ${at}`);
      at = found;
    }

    // The generated configs are printed in full.
    const printed = out.match(/^\{\n[\s\S]*?^\}\n/gm).map((block) => JSON.parse(block));
    assert.equal(printed.length, 2);
    const [api, web] = printed;
    assert.equal(api.name, 'knoqra-api');
    assert.equal(api.vars.KNOQRA_EDITION, 'selfhost');
    assert.equal(api.hyperdrive[0].id, '<created by deploy cloudflare>');
    assert.equal(web.name, 'knoqra-web');
    assert.deepEqual(web.services, [{ binding: 'API', service: 'knoqra-api' }]);

    assertNoSecrets(out, run.settings);
  });

  it('plans an update when Hyperdrive and the queues already exist', async () => {
    const run = await cli(['deploy', 'cloudflare', '--dry-run'], {
      cloudflare: {
        hyperdrive: [{ id: 'hd-existing', name: 'knoqra' }],
        queues: ['knoqra-provider-events', 'knoqra-provider-events-dlq'],
      },
    });
    assert.equal(run.code, 0, run.output);
    assert.match(
      run.output,
      new RegExp(`PUT ${acc}/hyperdrive/configs/hd-existing {2}\\(dry run: not sent\\)`),
    );
    assert.match(run.output, /Queue knoqra-provider-events exists/);
    assert.doesNotMatch(run.output, /POST/);
    assert.ok(run.requests.every((r) => r.method === 'GET'));
    assertNoSecrets(run.output, run.settings);
  });

  it('prints the workers.dev configs for a single config step', async () => {
    const settings = fullSettings({
      KNOQRA_ADDRESS: 'workers.dev',
      KNOQRA_WORKERS_SUBDOMAIN: 'example-sub',
      KNOQRA_EDITION: 'cloud',
    });
    const run = await cli(['deploy', 'config', '--dry-run'], {
      settings,
      cloudflare: { hyperdrive: [{ id: 'hd-existing', name: 'knoqra' }] },
    });
    assert.equal(run.code, 0, run.output);
    const [api, web] = run.output.match(/^\{\n[\s\S]*?^\}\n/gm).map((block) => JSON.parse(block));
    assert.equal(api.hyperdrive[0].id, 'hd-existing');
    assert.equal(api.workers_dev, true);
    assert.equal(web.workers_dev, true);
    assert.equal('routes' in api || 'routes' in web, false);
    assert.equal(
      api.vars.KNOQRA_EDITION,
      'selfhost',
      'the settings file cannot change the edition',
    );
    assert.doesNotMatch(run.output, /Database:|Deploy the API/);
  });

  it('keeps going when Cloudflare cannot be read', async () => {
    const run = await cli(['deploy', 'config', '--dry-run'], { cloudflare: { tokenOk: false } });
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /Could not read from Cloudflare \(.*Invalid access token\)/);
    assert.match(run.output, /"id": "<created by deploy cloudflare>"/);
  });
});

describe('pnpm knoqra deploy', () => {
  it('runs every step with the right commands, requests, files and secrets', async () => {
    const seen = {};
    const dist = {
      'apps/web/dist/index.html': '<html></html>',
      'apps/web/dist/assets/a.js': 'x',
      'apps/web/dist/assets/a.js.map': '{}',
      'apps/web/dist/b.css.map': '{}',
    };
    const run = await cli(['deploy'], {
      files: dist,
      onRun: ({ args }) => {
        if (args[2] === 'secret') {
          const file = args[4];
          seen.secretFile = file;
          seen.secretMode = statSync(file).mode & 0o777;
          seen.secrets = JSON.parse(readFileSync(file, 'utf8'));
        }
      },
    });
    assert.equal(run.code, 0, run.output);
    const { settings } = run;

    // Database.
    assert.deepEqual(run.db.calls, [
      {
        op: 'ensureAppRole',
        ownerUrl: settings.POSTGRES_OWNER_URL,
        password: settings.KNOQRA_APP_DB_PASSWORD,
      },
    ]);

    // Commands, in order.
    const commands = run.exec.calls.map((c) => [
      c.cwd.slice(run.dir.length) || '/',
      `${c.command} ${c.args.join(' ')}`,
    ]);
    assert.deepEqual(commands, [
      ['/', 'pnpm --filter @knoqra/db migrate'],
      ['/apps/api', 'pnpm exec wrangler deploy -c wrangler.selfhost.jsonc'],
      ['/apps/api', `pnpm exec wrangler secret bulk ${seen.secretFile} -c wrangler.selfhost.jsonc`],
      ['/', 'pnpm --filter @knoqra/web build'],
      ['/apps/web', 'pnpm exec wrangler deploy -c wrangler.selfhost.jsonc'],
    ]);
    assert.equal(run.exec.calls[0].env.MIGRATION_DATABASE_URL, settings.POSTGRES_OWNER_URL);
    for (const call of [run.exec.calls[1], run.exec.calls[2], run.exec.calls[4]]) {
      assert.equal(call.env.CLOUDFLARE_API_TOKEN, settings.CLOUDFLARE_API_TOKEN);
      assert.equal(call.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT_ID);
    }

    // Cloudflare writes.
    const writes = run.requests.filter((r) => r.method !== 'GET');
    assert.deepEqual(
      writes.map((r) => `${r.method} ${r.path}`),
      [`POST ${acc}/hyperdrive/configs`, `POST ${acc}/queues`, `POST ${acc}/queues`],
    );
    assert.deepEqual(writes[0].body, {
      name: 'knoqra',
      caching: { disabled: true },
      origin: {
        scheme: 'postgres',
        host: 'ep-example-123.us-east-2.aws.neon.tech',
        port: 5432,
        database: 'neondb',
        user: 'knoqra_app',
        password: settings.KNOQRA_APP_DB_PASSWORD,
      },
    });
    assert.deepEqual(
      writes.slice(1).map((r) => r.body.queue_name),
      ['knoqra-provider-events', 'knoqra-provider-events-dlq'],
    );

    // Generated configs.
    const api = parseJsonc(readFileSync(join(run.dir, 'apps/api/wrangler.selfhost.jsonc'), 'utf8'));
    const web = parseJsonc(readFileSync(join(run.dir, 'apps/web/wrangler.selfhost.jsonc'), 'utf8'));
    assert.equal(api.hyperdrive[0].id, 'new-hyperdrive-id');
    assert.equal(api.vars.KNOQRA_EDITION, 'selfhost');
    assert.deepEqual(api.routes, [{ pattern: 'api.example.com', custom_domain: true }]);
    assert.deepEqual(web.routes, [{ pattern: 'app.example.com', custom_domain: true }]);

    // Secrets: a private temp file, deleted afterwards; only names printed.
    if (process.platform !== 'win32') assert.equal(seen.secretMode, 0o600);
    assert.equal(existsSync(seen.secretFile), false, 'temp secrets file removed');
    assert.deepEqual(seen.secrets, workerSecrets(settings));
    assert.equal(seen.secrets.BETTER_AUTH_URL, 'https://app.example.com');
    assert.match(
      run.output,
      /Secrets set: BETTER_AUTH_SECRET, BETTER_AUTH_URL, CREDENTIALS_MASTER_KEY/,
    );

    // Source maps removed, other files kept.
    assert.equal(existsSync(join(run.dir, 'apps/web/dist/assets/a.js.map')), false);
    assert.equal(existsSync(join(run.dir, 'apps/web/dist/b.css.map')), false);
    assert.ok(existsSync(join(run.dir, 'apps/web/dist/assets/a.js')));
    assert.match(run.output, /Deleted 2 source map file\(s\)/);

    assertNoSecrets(run.output, settings);
  });

  it('stops with a hint when the Hyperdrive config is missing', async () => {
    const run = await cli(['deploy', 'api']);
    assert.equal(run.code, 1);
    assert.match(
      run.output,
      /No Hyperdrive config named knoqra yet\. Run: pnpm knoqra deploy cloudflare/,
    );
    assert.match(run.output, /run that step again: pnpm knoqra deploy api/);
    assert.equal(run.exec.calls.length, 0);
  });

  it('names missing settings', async () => {
    const settings = fullSettings({ BETTER_AUTH_SECRET: '', CREDENTIALS_MASTER_KEY: '' });
    const run = await cli(['deploy', 'secrets', '--dry-run'], { settings });
    assert.equal(run.code, 1);
    assert.match(run.output, /BETTER_AUTH_SECRET, CREDENTIALS_MASTER_KEY\. Run: pnpm knoqra setup/);
  });

  it('hides secrets that appear in an error message', async () => {
    const settings = fullSettings();
    const run = await cli(['deploy', 'api'], {
      settings,
      cloudflare: { hyperdrive: [{ id: 'hd', name: 'knoqra' }] },
      onRun: () => {
        throw new Error(`boom ${settings.CLOUDFLARE_API_TOKEN} ${settings.POSTGRES_OWNER_URL}`);
      },
    });
    assert.equal(run.code, 1);
    assert.match(run.output, /boom \[hidden\] \[hidden\]/);
    assertNoSecrets(run.output, settings);
  });

  it('refuses a missing settings file and an unknown step', async () => {
    const dir = root();
    const out = collector();
    const deps = {
      root: dir,
      cwd: dir,
      write: out.write,
      fetch: fakeCloudflare().fetch,
      createPrompt: () => assert.fail('no prompt'),
      createExec: () => assert.fail('no exec'),
      db: fakeDb(),
    };
    assert.equal(await main(['deploy'], deps), 1);
    assert.match(out.text(), /No settings file at \.env\.selfhost\. Run: pnpm knoqra setup/);
    assert.equal(await main(['deploy', 'everything'], deps), 2);
    assert.match(out.text(), /Unknown step "everything"/);
    assert.equal(await main(['deploy', '--force'], deps), 2);
    assert.equal(await main(['--help'], deps), 0);
  });
});

describe('deploy helpers', () => {
  it('sends only the secrets that are set and in use', () => {
    const minimal = workerSecrets(
      fullSettings({
        CONNECTORS: 'plivo',
        EMAIL_FROM: '',
        AI_PROVIDER: 'mock',
        KNOQRA_LICENSE_KEY: '',
      }),
    );
    assert.deepEqual(Object.keys(minimal), [
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_URL',
      'CREDENTIALS_MASTER_KEY',
    ]);
    const workersDev = workerSecrets(
      fullSettings({ KNOQRA_ADDRESS: 'workers.dev', KNOQRA_WORKERS_SUBDOMAIN: 'example-sub' }),
    );
    assert.equal(workersDev.BETTER_AUTH_URL, 'https://knoqra-web.example-sub.workers.dev');
    assert.equal('KNOQRA_EDITION' in workersDev, false);
  });

  it('builds the app-role URL and the Hyperdrive body on the direct host', () => {
    const url = appDatabaseUrl(
      'postgres://owner:secret@ep-x-pooler.eu.aws.neon.tech:6543/my%20db?sslmode=require',
      'abc123abc123abc1',
    );
    assert.equal(
      url,
      'postgres://knoqra_app:abc123abc123abc1@ep-x.eu.aws.neon.tech:6543/my%20db?sslmode=require',
    );
    assert.deepEqual(hyperdriveBody(url).origin, {
      scheme: 'postgres',
      host: 'ep-x.eu.aws.neon.tech',
      port: 6543,
      database: 'my db',
      user: 'knoqra_app',
      password: 'abc123abc123abc1',
    });
  });

  it('formats commands with env values hidden', () => {
    const text = formatCommand('/repo', {
      command: 'pnpm',
      args: ['exec', 'wrangler', 'x y'],
      cwd: join('/repo', 'apps', 'api'),
      showEnv: { MIGRATION_DATABASE_URL: 'postgres://a:b@c/d' },
    });
    assert.equal(text, "cd apps/api && MIGRATION_DATABASE_URL=<hidden> pnpm exec wrangler 'x y'");
  });

  it('redacts secret settings, including the decoded owner password', () => {
    const settings = fullSettings();
    const secrets = secretStrings(settings);
    const text = `a ${settings.POSTGRES_OWNER_URL} b pg/owner-SECRET c ${settings.AI_API_KEY}`;
    assert.equal(redact(text, secrets), 'a [hidden] b [hidden] c [hidden]');
  });

  it('runs in the order db, cloudflare, config, api, secrets, web, status', async () => {
    const dir = root();
    mkdirSync(join(dir, 'apps/web/dist'), { recursive: true });
    const out = collector();
    const ctx = await runDeploy({
      values: fullSettings(),
      root: dir,
      fetch: fakeCloudflare().fetch,
      exec: fakeExec().exec,
      db: fakeDb(),
      write: out.write,
      dryRun: true,
    });
    assert.equal(ctx.currentStep, 'status');
  });
});

describe('cli.mjs', () => {
  const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  const node = (args) =>
    spawnSync(process.execPath, ['--', cliPath, ...args], { encoding: 'utf8' });

  it('prints help', () => {
    const result = node(['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: pnpm knoqra <command>/);
  });

  it('reports a missing settings file without touching the network', () => {
    const dir = root();
    const result = node(['deploy', '--dry-run', '--env-file', join(dir, 'missing.env')]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No settings file at .*missing\.env\. Run: pnpm knoqra setup/);
  });
});
