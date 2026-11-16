import { runProviderContract } from '../contract.test-helpers';
import { PlivoProvider } from './client';
import { AUTH_ID, AUTH_TOKEN, fixtureText } from './test-fetch.test-helpers';

const NOW = Date.parse('2026-11-11T10:00:00Z');

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

/** Answers by path from the hand-written fixtures; anything else throws. */
const fixtureFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace(`/v1/Account/${AUTH_ID}`, '');
  const route = `${method} ${path}`;
  if (route === 'POST /Endpoint/') return json(fixtureText('endpoint-created'), 201);
  if (route === 'POST /JWT/Token/') return json(fixtureText('jwt-token'));
  if (route === 'GET /Number/') {
    return json(
      fixtureText(url.searchParams.get('offset') === '0' ? 'numbers-page-1' : 'numbers-page-2'),
    );
  }
  if (route === 'GET /PhoneNumber/') return json(fixtureText('phone-numbers-search'));
  if (route === 'GET /') return json(fixtureText('account'));
  if (route === 'GET /Call/') return json(fixtureText('cdrs'));
  throw new Error(`unexpected network call: ${route}`);
}) as typeof fetch;

runProviderContract('plivo', () => ({
  provider: new PlivoProvider({
    authId: AUTH_ID,
    authToken: AUTH_TOKEN,
    appId: 'app-contract',
    fetch: fixtureFetch,
    now: () => NOW,
  }),
  search: { country: 'US', areaCode: '202', features: ['voice'], limit: 5 },
  unlistedE164: '+12025550199',
  period: { from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z' },
  now: NOW,
}));
