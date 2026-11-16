// `pnpm knoqra deploy [step]`: sets up and deploys a self-hosted KNOQRA from the saved settings.
// Everything with a side effect is injected (fetch, exec, the Postgres adapter, the file system),
// and in dry-run mode only reads happen: each write is printed instead.
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createCloudflare } from './cloudflare.mjs';
import { parseJsonc } from './jsonc.mjs';
import {
  APP_ROLE,
  appDatabaseUrl,
  CONFIG_FILE_NAME,
  connectorsOf,
  HYPERDRIVE_NAME,
  LICENSE_START_URL,
  originsOf,
  SetupError,
  secretStrings,
} from './settings.mjs';
import { createUi } from './ui.mjs';
import { buildApiConfig, buildWebConfig, queueNames, renderConfig } from './wrangler-config.mjs';

export const STEPS = ['db', 'cloudflare', 'config', 'api', 'secrets', 'web', 'status'];
export const DRY_RUN_HYPERDRIVE_ID = '<created by deploy cloudflare>';

const WORKERS = {
  api: { dir: ['apps', 'api'], build: buildApiConfig },
  web: { dir: ['apps', 'web'], build: buildWebConfig },
};

function need(values, keys) {
  const missing = keys.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new SetupError(
      `Not set in the settings file: ${missing.join(', ')}. Run: pnpm knoqra setup`,
    );
  }
}

/** The Worker secrets for the API, from the settings: only those that are set and in use. */
export function workerSecrets(values) {
  need(values, ['BETTER_AUTH_SECRET', 'CREDENTIALS_MASTER_KEY']);
  const secrets = {
    BETTER_AUTH_SECRET: values.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: originsOf(values).desk,
    CREDENTIALS_MASTER_KEY: values.CREDENTIALS_MASTER_KEY,
  };
  if (values.TELNYX_PUBLIC_KEY && connectorsOf(values).includes('telnyx')) {
    secrets.TELNYX_PUBLIC_KEY = values.TELNYX_PUBLIC_KEY;
  }
  if (values.RESEND_API_KEY && values.EMAIL_FROM) {
    secrets.RESEND_API_KEY = values.RESEND_API_KEY;
    secrets.EMAIL_FROM = values.EMAIL_FROM;
  }
  if (values.AI_API_KEY && values.AI_PROVIDER === 'openai') secrets.AI_API_KEY = values.AI_API_KEY;
  if (values.KNOQRA_LICENSE_KEY) secrets.KNOQRA_LICENSE_KEY = values.KNOQRA_LICENSE_KEY;
  return secrets;
}

/** The Hyperdrive create/update body for the app role's connection string, caching off. */
export function hyperdriveBody(appUrl) {
  const url = new URL(appUrl);
  return {
    name: HYPERDRIVE_NAME,
    caching: { disabled: true },
    origin: {
      scheme: 'postgres',
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    },
  };
}

function quote(arg) {
  return /^[\w@%+=:,./<>-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** A command line for display: the directory, env names (values hidden), command and args. */
export function formatCommand(root, { command, args, cwd, showEnv = {} }) {
  const where = relative(root, cwd).split(sep).join('/');
  const env = Object.keys(showEnv).map((key) => `${key}=<hidden>`);
  return [where ? `cd ${where} &&` : '', ...env, command, ...args.map(quote)]
    .filter(Boolean)
    .join(' ');
}

function createContext(deps) {
  const { values, dryRun = false } = deps;
  const fs = deps.fs ?? nodeFs;
  const ui = createUi({
    write: deps.write,
    color: deps.color,
    secrets: () => secretStrings(values),
  });
  const ctx = {
    ...deps,
    fs,
    ui,
    dryRun,
    tmpDir: deps.tmpDir ?? tmpdir(),
    hyperdriveId: null,
    written: new Set(),
  };
  ctx.cf = () => {
    need(values, ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
    ctx.cfClient ??= createCloudflare({
      token: values.CLOUDFLARE_API_TOKEN,
      fetch: deps.fetch,
      dryRun,
      onRequest: (method, path, sent) =>
        ui.info(`${method} ${path}${sent ? '' : '  (dry run: not sent)'}`),
    });
    return ctx.cfClient;
  };
  ctx.wranglerEnv = () => ({
    CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
    WRANGLER_SEND_METRICS: 'false',
  });
  return ctx;
}

/** Runs a command, or only prints it in dry-run mode. `showEnv` names are shown, values hidden. */
async function run(ctx, { command, args, cwd, env = {}, showEnv = {} }) {
  ctx.ui.text(`$ ${formatCommand(ctx.root, { command, args, cwd, showEnv })}`);
  if (ctx.dryRun) return;
  await ctx.exec(command, args, { cwd, env: { ...env, ...showEnv } });
}

/** A read that may fail in dry-run mode (offline, token not ready): warn and use `fallback`. */
async function read(ctx, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    if (!ctx.dryRun) throw error;
    ctx.ui.warn(`Could not read from Cloudflare (${error.message}). Assuming none.`);
    return fallback;
  }
}

function readBase(ctx, worker) {
  const path = join(ctx.root, ...WORKERS[worker].dir, 'wrangler.jsonc');
  return parseJsonc(ctx.fs.readFileSync(path, 'utf8'));
}

async function findHyperdriveId(ctx) {
  if (ctx.hyperdriveId) return ctx.hyperdriveId;
  const found = await read(
    ctx,
    () => ctx.cf().findHyperdrive(ctx.values.CLOUDFLARE_ACCOUNT_ID, HYPERDRIVE_NAME),
    null,
  );
  if (found) {
    ctx.hyperdriveId = found.id;
    return found.id;
  }
  if (ctx.dryRun) {
    ctx.ui.warn(`No Hyperdrive config named ${HYPERDRIVE_NAME} yet: deploy cloudflare creates it.`);
    return DRY_RUN_HYPERDRIVE_ID;
  }
  throw new SetupError(
    `No Hyperdrive config named ${HYPERDRIVE_NAME} yet. Run: pnpm knoqra deploy cloudflare`,
  );
}

/** Writes one Worker's generated config (printed instead in dry-run mode), once per run. */
async function ensureConfig(ctx, worker) {
  if (ctx.written.has(worker)) return;
  const base = readBase(ctx, worker);
  const config =
    worker === 'api'
      ? buildApiConfig(base, ctx.values, await findHyperdriveId(ctx))
      : buildWebConfig(base, ctx.values);
  const text = renderConfig(config);
  const display = [...WORKERS[worker].dir, CONFIG_FILE_NAME].join('/');
  if (ctx.dryRun) {
    ctx.ui.text(`${display} (dry run: printed, not written):`);
    ctx.ui.raw(text);
  } else {
    ctx.fs.writeFileSync(join(ctx.root, ...WORKERS[worker].dir, CONFIG_FILE_NAME), text);
    ctx.ui.ok(`Wrote ${display}`);
  }
  ctx.written.add(worker);
}

async function dbStep(ctx) {
  const { ui, values } = ctx;
  ui.step('Database: app role and migrations');
  need(values, ['POSTGRES_OWNER_URL', 'KNOQRA_APP_DB_PASSWORD']);
  if (ctx.dryRun) {
    ui.text(`Would create or update the ${APP_ROLE} login role (NOSUPERUSER NOBYPASSRLS).`);
  } else {
    const { created } = await ctx.db.ensureAppRole(
      values.POSTGRES_OWNER_URL,
      values.KNOQRA_APP_DB_PASSWORD,
    );
    ui.ok(`${APP_ROLE} role ${created ? 'created' : 'updated'}`);
  }
  await run(ctx, {
    command: 'pnpm',
    args: ['--filter', '@knoqra/db', 'migrate'],
    cwd: ctx.root,
    showEnv: { MIGRATION_DATABASE_URL: values.POSTGRES_OWNER_URL },
  });
  if (!ctx.dryRun) ui.ok('Migrations applied');
}

async function cloudflareStep(ctx) {
  const { ui, values, dryRun } = ctx;
  ui.step('Cloudflare: Hyperdrive and queues');
  need(values, ['POSTGRES_OWNER_URL', 'KNOQRA_APP_DB_PASSWORD']);
  const cf = ctx.cf();
  const account = values.CLOUDFLARE_ACCOUNT_ID;
  const body = hyperdriveBody(
    appDatabaseUrl(values.POSTGRES_OWNER_URL, values.KNOQRA_APP_DB_PASSWORD),
  );
  const existing = await read(ctx, () => cf.findHyperdrive(account, HYPERDRIVE_NAME), null);
  const would = dryRun ? 'would be ' : '';
  if (existing) {
    await cf.updateHyperdrive(account, existing.id, body);
    ctx.hyperdriveId = existing.id;
    ui.ok(`Hyperdrive ${HYPERDRIVE_NAME} ${would}updated (${existing.id}), caching off`);
  } else {
    const id = await cf.createHyperdrive(account, body);
    ctx.hyperdriveId = id ?? (dryRun ? DRY_RUN_HYPERDRIVE_ID : null);
    if (!ctx.hyperdriveId) throw new SetupError('Cloudflare returned no Hyperdrive id.');
    ui.ok(`Hyperdrive ${HYPERDRIVE_NAME} ${would}created${id ? ` (${id})` : ''}, caching off`);
  }
  const have = await read(ctx, () => cf.listQueues(account), []);
  for (const queue of queueNames(readBase(ctx, 'api'))) {
    if (have.includes(queue)) ui.ok(`Queue ${queue} exists`);
    else {
      await cf.createQueue(account, queue);
      ui.ok(`Queue ${queue} ${would}created`);
    }
  }
}

async function configStep(ctx) {
  ctx.ui.step('Wrangler configs');
  await ensureConfig(ctx, 'api');
  await ensureConfig(ctx, 'web');
}

async function apiStep(ctx) {
  const origins = originsOf(ctx.values);
  ctx.ui.step(`Deploy the API → ${origins.api}`);
  await ensureConfig(ctx, 'api');
  await run(ctx, {
    command: 'pnpm',
    args: ['exec', 'wrangler', 'deploy', '-c', CONFIG_FILE_NAME],
    cwd: join(ctx.root, 'apps', 'api'),
    env: ctx.wranglerEnv(),
  });
}

async function secretsStep(ctx) {
  const { ui, fs } = ctx;
  ui.step('API secrets');
  const secrets = workerSecrets(ctx.values);
  const names = Object.keys(secrets).join(', ');
  await ensureConfig(ctx, 'api');
  const command = (file) => ({
    command: 'pnpm',
    args: ['exec', 'wrangler', 'secret', 'bulk', file, '-c', CONFIG_FILE_NAME],
    cwd: join(ctx.root, 'apps', 'api'),
    env: ctx.wranglerEnv(),
  });
  if (ctx.dryRun) {
    await run(ctx, command('<secrets-file>'));
    ui.ok(`Would set: ${names}`);
    return;
  }
  const dir = fs.mkdtempSync(join(ctx.tmpDir, 'knoqra-secrets-'));
  const file = join(dir, 'secrets.json');
  try {
    fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    await run(ctx, command(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ui.ok(`Secrets set: ${names}`);
}

function removeSourceMaps(fs, dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += removeSourceMaps(fs, full);
    else if (entry.name.endsWith('.map')) {
      fs.rmSync(full);
      count += 1;
    }
  }
  return count;
}

async function webStep(ctx) {
  const origins = originsOf(ctx.values);
  ctx.ui.step(`Build and deploy the Desk → ${origins.desk}`);
  await ensureConfig(ctx, 'web');
  await run(ctx, { command: 'pnpm', args: ['--filter', '@knoqra/web', 'build'], cwd: ctx.root });
  if (ctx.dryRun) ctx.ui.text('Would delete the *.map files under apps/web/dist');
  else {
    const count = removeSourceMaps(ctx.fs, join(ctx.root, 'apps', 'web', 'dist'));
    ctx.ui.ok(`Deleted ${count} source map file(s) from apps/web/dist`);
  }
  await run(ctx, {
    command: 'pnpm',
    args: ['exec', 'wrangler', 'deploy', '-c', CONFIG_FILE_NAME],
    cwd: join(ctx.root, 'apps', 'web'),
    env: ctx.wranglerEnv(),
  });
}

async function statusStep(ctx) {
  const { ui } = ctx;
  const origins = originsOf(ctx.values);
  ui.step('Status');
  ui.text(`Desk: ${origins.desk}`);
  ui.text(`API:  ${origins.api}`);
  const url = `${origins.api}/api/health`;
  ui.info(`GET ${url}`);
  try {
    const response = await ctx.fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await response.text()).replace(/\s+/g, ' ').slice(0, 300);
    if (response.ok) ui.ok(`/api/health: ${response.status} ${body}`);
    else ui.warn(`/api/health: ${response.status} ${body}`);
  } catch (error) {
    ui.warn(`/api/health: not reachable yet (${error.message})`);
  }
}

function nextSteps(ctx) {
  const { ui, values } = ctx;
  const origins = originsOf(values);
  const connectors = connectorsOf(values);
  ui.step('Next steps');
  ui.text(`1. Open the Desk at ${origins.desk} and sign up.`);
  if (values.KNOQRA_LICENSE_KEY) ui.text('2. The license key is set, so the Desk opens unlocked.');
  else {
    ui.text('2. Paste your license key on the license screen. To get one, star the KNOQRA');
    ui.text(`   repository on GitHub, then open ${LICENSE_START_URL}`);
  }
  ui.text('3. Connect your provider account in Settings › Connectors.');
  ui.text('4. Follow the Setup page to add phone numbers and WhatsApp.');
  if (connectors.includes('telnyx')) {
    ui.info(`Telnyx webhooks go to ${origins.api}/webhooks/telnyx (the Desk shows each`);
    ui.info("connection's exact URL).");
  }
  if (connectors.includes('plivo')) {
    ui.info('Plivo: the Desk shows the answer URL to set on your Plivo application.');
  }
}

const RUNNERS = {
  db: dbStep,
  cloudflare: cloudflareStep,
  config: configStep,
  api: apiStep,
  secrets: secretsStep,
  web: webStep,
  status: statusStep,
};

/**
 * Runs one deploy step, or all of them in order.
 * @param {object} deps
 * @param {string} [deps.step]      'all' (default) or one of STEPS
 * @param {Record<string,string>} deps.values  the saved settings
 * @param {string} deps.root        the repository root
 * @param {typeof fetch} deps.fetch
 * @param {(command: string, args: string[], options: { cwd: string, env: object }) => Promise<void>} deps.exec
 * @param {{ ensureAppRole(ownerUrl: string, password: string): Promise<{ created: boolean }> }} deps.db
 * @param {(text: string) => void} deps.write
 * @param {boolean} [deps.color]
 * @param {boolean} [deps.dryRun]
 * @param {typeof import('node:fs')} [deps.fs]
 * @param {string} [deps.tmpDir]
 */
export async function runDeploy(deps) {
  const step = deps.step ?? 'all';
  if (step !== 'all' && !STEPS.includes(step)) {
    throw new SetupError(`Unknown step "${step}". Steps: all, ${STEPS.join(', ')}.`);
  }
  const ctx = createContext(deps);
  ctx.ui.line(
    ctx.ui.paint('bold', `KNOQRA self-host deploy: ${step}${ctx.dryRun ? ' (dry run)' : ''}`),
  );
  if (ctx.dryRun) ctx.ui.info('Dry run: reads only. Nothing is created, changed or written.');
  ctx.ui.info(
    'Wrangler runs with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the settings.',
  );
  for (const name of step === 'all' ? STEPS : [step]) {
    ctx.currentStep = name;
    try {
      await RUNNERS[name](ctx);
    } catch (error) {
      error.step = name;
      throw error;
    }
  }
  if (step === 'all') nextSteps(ctx);
  return ctx;
}
