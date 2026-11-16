// The `pnpm knoqra setup` questionnaire. Pure apart from what is injected: a prompt, `fetch`, a
// Postgres check, a random source and a `save` callback, so tests run it with scripted answers.
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { createCloudflare } from './cloudflare.mjs';
import {
  ALL_KEYS,
  connectorsOf,
  directHost,
  isBase64Of32Bytes,
  isDomain,
  isLicenseKeyShape,
  isPostgresUrl,
  LICENSE_START_URL,
  normalizeDomain,
  normalizeSubdomain,
  originsOf,
  secretStrings,
} from './settings.mjs';
import { createUi } from './ui.mjs';

/**
 * Asks for one setting. Enter keeps the saved value (or skips an optional one); `-` clears a
 * saved optional value. Returns the value to store ('' for none).
 */
async function askValue(ctx, options) {
  const { id, label, secret = false, required = false, validate, suggested } = options;
  const normalize = options.normalize ?? ((v) => v);
  const current = ctx.values[id] ?? '';
  for (;;) {
    let hint = '';
    if (current) hint = required ? 'saved, Enter keeps it' : 'saved, Enter keeps it, - clears it';
    else if (suggested) hint = `Enter uses ${suggested}`;
    else if (!required) hint = 'optional, Enter skips';
    const input = String(await ctx.prompt.ask({ id, label, secret, hint })).trim();
    if (input === '') {
      if (current) return current;
      if (suggested) return suggested;
      if (!required) return '';
      ctx.ui.bad('This one is required.');
      continue;
    }
    if (input === '-' && !required) return '';
    const value = normalize(input);
    const problem = validate?.(value);
    if (problem) {
      ctx.ui.bad(problem);
      continue;
    }
    return value;
  }
}

/** Asks a yes/no question. */
async function confirm(ctx, { id, label, defaultYes = true }) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  for (;;) {
    const input = String(await ctx.prompt.ask({ id, label, hint }))
      .trim()
      .toLowerCase();
    if (input === '') return defaultYes;
    if (input === 'y' || input === 'yes') return true;
    if (input === 'n' || input === 'no') return false;
    ctx.ui.bad('Answer y or n.');
  }
}

/** Asks for one of `choices` ({ value, label }) by number or value. Enter keeps `current`. */
async function choose(ctx, { id, label, choices, current }) {
  choices.forEach((choice, index) => {
    ctx.ui.text(`${index + 1}) ${choice.label}`);
  });
  const known = choices.find((c) => c.value === current);
  for (;;) {
    const hint = known ? `1-${choices.length}, Enter keeps ${known.value}` : `1-${choices.length}`;
    const input = String(await ctx.prompt.ask({ id, label, hint }))
      .trim()
      .toLowerCase();
    if (input === '' && known) return known.value;
    const byNumber = /^\d+$/.test(input) ? choices[Number(input) - 1] : undefined;
    const picked = byNumber ?? choices.find((c) => c.value === input);
    if (picked) return picked.value;
    ctx.ui.bad(`Type a number from 1 to ${choices.length}.`);
  }
}

function cloudflareFor(ctx) {
  return createCloudflare({ token: ctx.values.CLOUDFLARE_API_TOKEN ?? '', fetch: ctx.fetch });
}

async function cloudflareStep(ctx) {
  const { ui, values } = ctx;
  ui.step('1/7  Cloudflare (hosting: Workers, Hyperdrive, Queues)');
  ui.info(
    'dash.cloudflare.com → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers".',
  );
  ui.info('Before you save it, check that Permissions has these rows (add the missing ones):');
  ui.info('  Account · Workers Scripts · Edit      Account · Hyperdrive · Edit');
  ui.info('  Account · Queues · Edit               Zone · DNS · Edit');
  ui.info('Account Resources: your account. Zone Resources: your domain, or All zones.');
  ui.info('Then Continue to summary → Create Token, and copy the token.');

  let accounts = null;
  for (;;) {
    values.CLOUDFLARE_API_TOKEN = await askValue(ctx, {
      id: 'CLOUDFLARE_API_TOKEN',
      label: 'Cloudflare API token',
      secret: true,
      required: true,
    });
    try {
      accounts = await cloudflareFor(ctx).listAccounts();
      if (accounts.length > 0) {
        ui.ok('Token works.');
        break;
      }
      ui.bad('The token works but cannot see an account. Set Account Resources to your account.');
    } catch (error) {
      ui.bad(`Cloudflare did not accept that token (${error.message}).`);
    }
    accounts = null;
    if (!(await confirm(ctx, { id: 'retryCloudflare', label: 'Try again?' }))) break;
  }

  if (accounts?.length === 1) {
    values.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
    ui.ok(`Account: ${accounts[0].name}`);
    return;
  }
  if (accounts && accounts.length > 1) {
    ui.text('Your accounts:');
    accounts.forEach((account, index) => {
      ui.text(`  ${index + 1}) ${account.name}  ${account.id}`);
    });
  } else {
    ui.info('Find the account ID in the dashboard: Workers & Pages → Account details.');
  }
  values.CLOUDFLARE_ACCOUNT_ID = await askValue(ctx, {
    id: 'CLOUDFLARE_ACCOUNT_ID',
    label: accounts ? 'Account to deploy to (number or ID)' : 'Cloudflare account ID',
    required: true,
    normalize: (input) => {
      const index = Number(input);
      return accounts && Number.isInteger(index) && index >= 1 && index <= accounts.length
        ? accounts[index - 1].id
        : input.toLowerCase();
    },
    validate: (v) => (/^[0-9a-f]{32}$/.test(v) ? null : 'An account ID is 32 hex characters.'),
  });
}

async function postgresStep(ctx) {
  const { ui, values } = ctx;
  ui.step('2/7  Postgres (the database)');
  ui.info(
    'Any Postgres 15 or newer works. Neon (neon.tech) is recommended: free to start, no server.',
  );
  ui.info('Neon: console.neon.tech → your project → Connect. Pick the owner role (usually');
  ui.info('neondb_owner), turn off "Connection pooling" and copy the connection string.');
  ui.info('Another Postgres: use a login that owns the database and can create roles.');
  ui.info(
    "This login is used only to create the app's own restricted login and to run migrations.",
  );

  for (;;) {
    let url = await askValue(ctx, {
      id: 'POSTGRES_OWNER_URL',
      label: 'Postgres owner connection string',
      secret: true,
      required: true,
      validate: (v) =>
        isPostgresUrl(v) ? null : 'That is not a connection string (it starts with postgresql://).',
    });
    if (url.includes('-pooler.')) {
      url = directHost(url);
      ui.warn('Switched it to the direct (non-pooled) host. Hyperdrive does its own pooling.');
    }
    values.POSTGRES_OWNER_URL = url;
    if (!(await confirm(ctx, { id: 'testPostgres', label: 'Test the connection now?' }))) return;
    const result = await ctx.checkPostgres(url);
    if (result.skipped) {
      ui.warn(`Skipped the connection test: ${result.reason}`);
      return;
    }
    if (result.ok) {
      ui.ok(`Connected as ${result.user} to ${result.database}, Postgres ${result.version}.`);
      if (result.major && result.major < 15) ui.warn('KNOQRA needs Postgres 15 or newer.');
      if (!result.canCreateRole) {
        ui.warn('This login cannot create roles. Use the owner login, or one with CREATEROLE.');
      }
      return;
    }
    ui.bad(`Could not connect: ${result.error}`);
    if (!(await confirm(ctx, { id: 'retryPostgres', label: 'Try again?' }))) return;
  }
}

async function addressStep(ctx) {
  const { ui, values } = ctx;
  ui.step('3/7  Address (where the Desk and the API live)');
  values.KNOQRA_ADDRESS = await choose(ctx, {
    id: 'KNOQRA_ADDRESS',
    label: 'Address',
    current: values.KNOQRA_ADDRESS,
    choices: [
      {
        value: 'domain',
        label: 'A domain on Cloudflare: the Desk at app.<domain>, the API at api.<domain>',
      },
      { value: 'workers.dev', label: 'A free workers.dev address: no domain needed' },
    ],
  });

  if (values.KNOQRA_ADDRESS === 'domain') {
    let zones = null;
    try {
      zones = await cloudflareFor(ctx).listZones();
    } catch {
      zones = null;
    }
    if (zones?.length) ui.info(`Domains this token can see: ${zones.join(', ')}`);
    else if (zones) {
      ui.warn('This token cannot see any domain. Give it Zone · DNS · Edit on your domain,');
      ui.warn('or choose the workers.dev address instead.');
    }
    const domain = await askValue(ctx, {
      id: 'KNOQRA_DOMAIN',
      label: 'Domain (for example example.com)',
      required: true,
      suggested: zones?.length === 1 ? zones[0] : undefined,
      normalize: normalizeDomain,
      validate: (v) => (isDomain(v) ? null : 'That is not a domain name.'),
    });
    values.KNOQRA_DOMAIN = domain;
    if (zones && !zones.some((zone) => domain === zone || domain.endsWith(`.${zone}`))) {
      ui.warn(`${domain} is not among the domains this token can see; it needs DNS access to it.`);
    }
  } else {
    let subdomain = null;
    try {
      subdomain = await cloudflareFor(ctx).workersSubdomain(values.CLOUDFLARE_ACCOUNT_ID);
    } catch (error) {
      ui.warn(`Could not look up your workers.dev subdomain (${error.message}).`);
    }
    if (subdomain) {
      values.KNOQRA_WORKERS_SUBDOMAIN = subdomain;
      ui.ok(`Your workers.dev subdomain: ${subdomain}.workers.dev`);
    } else {
      ui.info(
        'No workers.dev subdomain found. Open Workers & Pages in the Cloudflare dashboard once',
      );
      ui.info('to choose one, then type it here.');
      values.KNOQRA_WORKERS_SUBDOMAIN = await askValue(ctx, {
        id: 'KNOQRA_WORKERS_SUBDOMAIN',
        label: 'workers.dev subdomain (the part before .workers.dev)',
        required: true,
        normalize: normalizeSubdomain,
        validate: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'That is not a subdomain.'),
      });
    }
  }
  const origins = originsOf(values);
  ui.ok(`The Desk will be at ${origins.desk}, the API at ${origins.api}.`);
}

async function providerStep(ctx) {
  const { ui, values } = ctx;
  ui.step('4/7  Telephony provider');
  values.CONNECTORS = await choose(ctx, {
    id: 'CONNECTORS',
    label: 'Provider',
    current: connectorsOf(values).join(','),
    choices: [
      { value: 'telnyx', label: 'Telnyx (recommended: calls, SMS and WhatsApp)' },
      { value: 'plivo', label: 'Plivo' },
      { value: 'telnyx,plivo', label: 'Both: each workspace may connect either one' },
    ],
  });
  ui.info('You connect the provider account itself later, in the Desk: Settings › Connectors.');
  ui.info('Phone numbers and WhatsApp are set up on the Setup page there.');

  if (connectorsOf(values).includes('telnyx')) {
    ui.info('Optional: the Telnyx webhook public key lets the API check that webhooks come from');
    ui.info('Telnyx. portal.telnyx.com → Keys & Credentials → Public Key: copy the base64 key');
    ui.info('(about 44 characters). It is public, not a secret. You can add it later.');
    values.TELNYX_PUBLIC_KEY = await askValue(ctx, {
      id: 'TELNYX_PUBLIC_KEY',
      label: 'Telnyx public key',
      validate: (v) => (isBase64Of32Bytes(v) ? null : 'That is not a base64 key of 32 bytes.'),
    });
  }
}

async function emailStep(ctx) {
  const { ui, values } = ctx;
  ui.step('5/7  Email (optional)');
  ui.info('Password-reset mail goes through Resend (resend.com), with a verified sending domain.');
  ui.info('Without both values below, password-reset mail is not sent. Everything else works.');
  values.RESEND_API_KEY = await askValue(ctx, {
    id: 'RESEND_API_KEY',
    label: 'Resend API key',
    secret: true,
  });
  values.EMAIL_FROM = await askValue(ctx, {
    id: 'EMAIL_FROM',
    label: 'Sender, for example KNOQRA <no-reply@example.com>',
    validate: (v) => (/@[^@\s>]+\.[^@\s>]+/.test(v) ? null : 'That has no email address in it.'),
  });
  if (Boolean(values.RESEND_API_KEY) !== Boolean(values.EMAIL_FROM)) {
    ui.warn('Set both the Resend API key and the sender, or no mail is sent.');
  }
}

async function aiStep(ctx) {
  const { ui, values } = ctx;
  ui.step('6/7  AI for Otto');
  values.AI_PROVIDER = await choose(ctx, {
    id: 'AI_PROVIDER',
    label: 'AI',
    current: values.AI_PROVIDER || 'mock',
    choices: [
      { value: 'mock', label: 'No model: Otto writes simple, predictable drafts (no key needed)' },
      { value: 'openai', label: 'An OpenAI-compatible API key' },
      { value: 'chatgpt', label: 'ChatGPT sign-in: each user signs in with ChatGPT in the Desk' },
    ],
  });
  if (values.AI_PROVIDER === 'openai') {
    ui.info('OpenAI or any provider with an OpenAI-compatible API.');
    values.AI_API_KEY = await askValue(ctx, {
      id: 'AI_API_KEY',
      label: 'API key',
      secret: true,
      required: true,
    });
    values.AI_MODEL = await askValue(ctx, {
      id: 'AI_MODEL',
      label: 'Model name (Enter: the default)',
    });
    values.AI_BASE_URL = await askValue(ctx, {
      id: 'AI_BASE_URL',
      label: 'API base URL, for example https://api.example.com/v1 (Enter: OpenAI)',
      normalize: (v) => v.replace(/\/+$/, ''),
      validate: (v) => (/^https:\/\/[^\s/]+/.test(v) ? null : 'Use an https:// URL.'),
    });
    ui.ok('Otto will use that API.');
  } else if (values.AI_PROVIDER === 'chatgpt') {
    ui.warn('ChatGPT sign-in is coming in a later release. Until then Otto uses the mock.');
  } else {
    ui.ok('Otto will use the mock. Re-run setup any time to change it.');
  }
}

async function licenseStep(ctx) {
  const { ui, values } = ctx;
  ui.step('7/7  License key (optional here)');
  ui.info('A self-hosted KNOQRA asks for a free license key before it unlocks. To get one:');
  ui.info('  1. Star the KNOQRA repository on GitHub.');
  ui.info(`  2. Open ${LICENSE_START_URL} and sign in with GitHub.`);
  ui.info('  3. Copy the key the page shows.');
  ui.info('You can also skip this and paste the key in the Desk after you sign up.');
  ui.info('The key is not a software license: your rights to the code come from the AGPL-3.0.');
  values.KNOQRA_LICENSE_KEY = await askValue(ctx, {
    id: 'KNOQRA_LICENSE_KEY',
    label: 'License key',
    secret: true,
    normalize: (v) => v.replace(/\s+/g, ''),
    validate: (v) =>
      isLicenseKeyShape(v) ? null : 'That is not a license key (it starts with KNOQRA-LICENSE-1.).',
  });
}

function generateStep(ctx) {
  const { ui, values, randomBytes } = ctx;
  ui.step('Generated secrets');
  const generators = {
    BETTER_AUTH_SECRET: () => randomBytes(32).toString('base64'),
    CREDENTIALS_MASTER_KEY: () => randomBytes(32).toString('base64'),
    KNOQRA_APP_DB_PASSWORD: () => randomBytes(24).toString('hex'),
  };
  for (const [key, generate] of Object.entries(generators)) {
    if (values[key]) ui.ok(`${key} (kept)`);
    else {
      values[key] = generate();
      ui.ok(`${key} (generated)`);
    }
  }
  if (!isBase64Of32Bytes(values.CREDENTIALS_MASTER_KEY)) {
    ui.warn('CREDENTIALS_MASTER_KEY is not base64 of 32 bytes. It was left as it is.');
  }
  if (!/^[0-9a-f]{16,}$/.test(values.KNOQRA_APP_DB_PASSWORD)) {
    ui.warn(
      'KNOQRA_APP_DB_PASSWORD must be hex (at least 16 characters). Delete it to regenerate.',
    );
  }
  ui.warn('Back up .env.selfhost somewhere safe, such as a password manager. If');
  ui.warn(
    'CREDENTIALS_MASTER_KEY is lost, the provider keys stored in the database cannot be read',
  );
  ui.warn('and every workspace has to connect its provider again.');
}

/**
 * Runs the questionnaire.
 * @param {object} deps
 * @param {Record<string,string>} deps.values    the saved settings (not modified)
 * @param {{ ask(q: { id: string, label: string, secret?: boolean, hint?: string }): Promise<string> }} deps.prompt
 * @param {typeof fetch} deps.fetch
 * @param {(url: string) => Promise<object>} deps.checkPostgres
 * @param {(values: Record<string,string>) => void | Promise<void>} deps.save  called after each step
 * @param {(text: string) => void} deps.write  output; every line is passed through redact
 * @param {boolean} [deps.color]
 * @param {(n: number) => Buffer} [deps.randomBytes]
 * @param {boolean} [deps.dryRun]
 * @param {string} [deps.envFileLabel]  how to name the settings file in messages
 * @returns {Promise<Record<string,string>>} the new settings
 */
export async function runSetup(deps) {
  const values = { ...deps.values };
  const ui = createUi({
    write: deps.write,
    color: deps.color,
    secrets: () => secretStrings(values),
  });
  const ctx = { ...deps, values, ui, randomBytes: deps.randomBytes ?? nodeRandomBytes };
  ui.line(ui.paint('bold', 'KNOQRA self-host setup'));
  ui.info(
    deps.dryRun
      ? 'Dry run: answers are checked but nothing is saved.'
      : `Saving to ${deps.envFileLabel ?? '.env.selfhost'} (owner-only). Nothing you paste is shown.`,
  );
  ui.info('Re-run it any time. Enter keeps a saved value.');

  const steps = [
    cloudflareStep,
    postgresStep,
    addressStep,
    providerStep,
    emailStep,
    aiStep,
    licenseStep,
    generateStep,
  ];
  for (const step of steps) {
    await step(ctx);
    await deps.save(values);
  }

  ui.step(deps.dryRun ? 'Dry run: nothing was saved' : 'Saved');
  for (const key of ALL_KEYS) {
    if (values[key]) ui.ok(key);
    else ui.info(`– ${key} (not set)`);
  }
  ui.line();
  ui.line(ui.paint('bold', 'Next: pnpm knoqra deploy'));
  return values;
}
