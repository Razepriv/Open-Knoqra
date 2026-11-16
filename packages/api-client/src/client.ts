import createClient from 'openapi-fetch';
import type { paths } from './schema';

export interface ApiClientOptions {
  baseUrl: string;
  /** Override fetch (tests, React Native, SSR). Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Typed KNOQRA API client. Sends the Better Auth session cookie on every request. */
export function createApiClient(opts: ApiClientOptions) {
  return createClient<paths>({
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    credentials: 'include',
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
