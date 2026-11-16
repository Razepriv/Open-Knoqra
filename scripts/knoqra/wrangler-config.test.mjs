import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.mjs';
import { API_BASE, fullSettings, WEB_BASE } from './test-helpers.mjs';
import {
  buildApiConfig,
  buildWebConfig,
  CONFIG_HEADER,
  queueNames,
  RATE_LIMITS,
  renderConfig,
} from './wrangler-config.mjs';

const apiBase = parseJsonc(API_BASE);
const webBase = parseJsonc(WEB_BASE);
const workersDev = { KNOQRA_ADDRESS: 'workers.dev', KNOQRA_WORKERS_SUBDOMAIN: 'example-sub' };

describe('buildApiConfig', () => {
  it('builds a selfhost production config for a domain', () => {
    const config = buildApiConfig(apiBase, fullSettings(), 'hd-123');
    assert.equal(config.name, 'knoqra-api');
    assert.deepEqual(config.vars, {
      APP_ENV: 'production',
      PROVIDER: 'connectors',
      CONNECTORS: 'telnyx,plivo',
      KNOQRA_EDITION: 'selfhost',
      API_PUBLIC_ORIGIN: 'https://api.example.com',
      AI_PROVIDER: 'openai',
      AI_MODEL: 'example-model',
      AI_BASE_URL: 'https://ai.example.com/v1',
    });
    assert.deepEqual(config.hyperdrive, [{ binding: 'HYPERDRIVE', id: 'hd-123' }]);
    assert.deepEqual(config.routes, [{ pattern: 'api.example.com', custom_domain: true }]);
    assert.equal(config.workers_dev, false);
    assert.equal('env' in config, false);
    assert.doesNotMatch(JSON.stringify(config), /localConnectionString|staging/);
  });

  it('keeps main, schema, compatibility, crons, queues, Durable Objects and migrations', () => {
    const config = buildApiConfig(apiBase, fullSettings(), 'hd-123');
    for (const key of [
      '$schema',
      'main',
      'compatibility_date',
      'compatibility_flags',
      'observability',
      'triggers',
      'queues',
      'durable_objects',
      'migrations',
    ]) {
      assert.deepEqual(config[key], apiBase[key], key);
    }
  });

  it('declares the four rate limits with namespace ids 1001 to 1004', () => {
    const { ratelimits } = buildApiConfig(apiBase, fullSettings(), 'hd-123');
    assert.deepEqual(
      ratelimits.map((r) => [r.name, r.namespace_id, r.simple.limit, r.simple.period]),
      [
        ['RL_AUTH', '1001', 10, 60],
        ['RL_DIAL', '1002', 10, 60],
        ['RL_VOICE_TOKEN', '1003', 20, 60],
        ['RL_MESSAGE_SEND', '1004', 30, 60],
      ],
    );
    ratelimits[0].simple.limit = 999;
    assert.equal(RATE_LIMITS[0].simple.limit, 10, 'the shared constant is not mutated');
  });

  it('uses workers.dev without routes', () => {
    const config = buildApiConfig(apiBase, fullSettings(workersDev), 'hd-123');
    assert.equal(config.workers_dev, true);
    assert.equal('routes' in config, false);
    assert.equal(config.vars.API_PUBLIC_ORIGIN, 'https://knoqra-api.example-sub.workers.dev');
  });

  it('always sets the selfhost edition, whatever the base or the settings say', () => {
    const config = buildApiConfig(apiBase, fullSettings({ KNOQRA_EDITION: 'cloud' }), 'hd-1');
    assert.equal(config.vars.KNOQRA_EDITION, 'selfhost');
    assert.doesNotMatch(JSON.stringify(config), /"cloud"/);
  });

  it('adds AI_MODEL and AI_BASE_URL only for the openai provider, and only when set', () => {
    const mock = buildApiConfig(apiBase, fullSettings({ AI_PROVIDER: 'mock' }), 'hd');
    assert.equal(mock.vars.AI_PROVIDER, 'mock');
    assert.equal('AI_MODEL' in mock.vars, false);
    assert.equal('AI_BASE_URL' in mock.vars, false);
    const chatgpt = buildApiConfig(apiBase, fullSettings({ AI_PROVIDER: 'chatgpt' }), 'hd');
    assert.equal(chatgpt.vars.AI_PROVIDER, 'chatgpt');
    assert.equal('AI_MODEL' in chatgpt.vars, false);
    const bare = buildApiConfig(apiBase, fullSettings({ AI_MODEL: '', AI_BASE_URL: '' }), 'hd');
    assert.equal('AI_MODEL' in bare.vars, false);
    assert.equal('AI_BASE_URL' in bare.vars, false);
    const unset = buildApiConfig(apiBase, fullSettings({ AI_PROVIDER: '' }), 'hd');
    assert.equal('AI_PROVIDER' in unset.vars, false);
  });

  it('refuses incomplete settings', () => {
    assert.throws(
      () => buildApiConfig(apiBase, fullSettings({ CONNECTORS: '' }), 'hd'),
      /CONNECTORS/,
    );
    assert.throws(
      () => buildApiConfig(apiBase, fullSettings({ KNOQRA_ADDRESS: '' }), 'hd'),
      /ADDRESS/,
    );
    assert.throws(() => buildApiConfig(apiBase, fullSettings(), ''), /Hyperdrive/);
  });
});

describe('buildWebConfig', () => {
  it('builds the Desk config with the API service binding for a domain', () => {
    const config = buildWebConfig(webBase, fullSettings());
    assert.equal(config.name, 'knoqra-web');
    assert.deepEqual(config.vars, { APP_ENV: 'production' });
    assert.deepEqual(config.services, [{ binding: 'API', service: 'knoqra-api' }]);
    assert.deepEqual(config.routes, [{ pattern: 'app.example.com', custom_domain: true }]);
    assert.equal(config.workers_dev, false);
    assert.deepEqual(config.assets, webBase.assets);
    assert.equal(config.main, webBase.main);
    assert.equal('env' in config, false);
  });

  it('uses workers.dev without routes', () => {
    const config = buildWebConfig(webBase, fullSettings(workersDev));
    assert.equal(config.workers_dev, true);
    assert.equal('routes' in config, false);
  });
});

describe('renderConfig and queueNames', () => {
  it('renders a header comment and JSON that parses back', () => {
    const config = buildApiConfig(apiBase, fullSettings(), 'hd-123');
    const text = renderConfig(config);
    assert.ok(text.startsWith(CONFIG_HEADER));
    assert.match(text, /pnpm knoqra deploy/);
    assert.match(text, /Do not commit/);
    assert.deepEqual(parseJsonc(text), config);
  });

  it('lists the queues of the base API config', () => {
    assert.deepEqual(queueNames(apiBase), ['knoqra-provider-events', 'knoqra-provider-events-dlq']);
  });

  it('builds both configs from the repository base files', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const api = parseJsonc(readFileSync(`${root}apps/api/wrangler.jsonc`, 'utf8'));
    const web = parseJsonc(readFileSync(`${root}apps/web/wrangler.jsonc`, 'utf8'));
    const apiConfig = buildApiConfig(api, fullSettings(), 'hd-123');
    const webConfig = buildWebConfig(web, fullSettings());
    assert.equal(apiConfig.vars.KNOQRA_EDITION, 'selfhost');
    assert.equal('env' in apiConfig || 'env' in webConfig, false);
    assert.doesNotMatch(JSON.stringify(apiConfig), /localConnectionString/);
    assert.deepEqual(queueNames(api), ['knoqra-provider-events', 'knoqra-provider-events-dlq']);
    assert.equal(webConfig.services.find((s) => s.binding === 'API').service, 'knoqra-api');
  });
});
