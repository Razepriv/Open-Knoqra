import { readFileSync } from 'node:fs';
import { runProviderContract } from '../contract.test-helpers';
import { TelnyxProvider } from './client';

const NOW = Date.parse('2026-11-11T10:00:00Z');

const fixture = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/telnyx/${name}.json`, import.meta.url), 'utf8');

const json = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

/** Answers by path from the hand-written fixtures; anything else throws, so nothing reaches the network. */
const fixtureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const route = `${method} ${url.pathname.replace(/^\/v2/, '')}`;
  switch (route) {
    case 'POST /telephony_credentials':
      return json(JSON.stringify({ data: { id: 'cred-contract' } }));
    case 'POST /telephony_credentials/cred-contract/token':
      return new Response('jwt.contract.token', { status: 200 });
    case 'GET /phone_numbers':
      return json(fixture(`phone-numbers-page-${url.searchParams.get('page[number]')}`));
    case 'GET /10dlc/phone_number_campaigns':
      return json(fixture('phone-number-campaigns'));
    case 'GET /available_phone_numbers':
      return json(fixture('available-phone-numbers'));
    case 'GET /balance':
      return json(fixture('balance'));
    case 'GET /detail_records':
      return json(fixture('detail-records'));
    default:
      throw new Error(`unexpected network call: ${route}`);
  }
}) as typeof fetch;

runProviderContract('telnyx', () => ({
  provider: new TelnyxProvider({
    apiKey: 'KEY_contract_test_value',
    connectionId: 'conn-contract',
    fetch: fixtureFetch,
    now: () => NOW,
  }),
  search: { country: 'US', areaCode: '202', features: ['voice'], limit: 5 },
  unlistedE164: '+12025550199',
  period: { from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z' },
  now: NOW,
}));
