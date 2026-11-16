import { readFileSync } from 'node:fs';

export const AUTH_ID = 'MAFIXTUREAUTHID000000';
export const AUTH_TOKEN = 'fixture-auth-token-value-0000000000';
export const ACCOUNT = `https://api.plivo.com/v1/Account/${AUTH_ID}`;

export const fixtureText = (name: string): string =>
  readFileSync(new URL(`../../test/fixtures/plivo/${name}.json`, import.meta.url), 'utf8');

export const fixtureFields = (name: string): Record<string, string> =>
  JSON.parse(fixtureText(name)) as Record<string, string>;

export const json = (status: number, body: string | unknown) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export type Call = { url: string; method: string; headers: Headers; body: unknown };
export type Route = { method: string; url: string; respond: () => Response };

/** An injected fetch that answers declared routes only; anything else throws, so no test reaches the network. */
export function stubFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.url === url && r.method === method);
    if (!route) throw new Error(`unexpected network call: ${method} ${url}`);
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return route.respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}
