/** The slice of a Workers binding this script uses (service binding and static assets). */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The knoqra-api Worker (service binding). */
  API: Fetcher;
  /** The built SPA in ./dist. */
  ASSETS: Fetcher;
}

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/**
 * Serves the Desk on one origin: /api/* goes to the API Worker, so auth cookies stay first-party,
 * and everything else is a static asset (unknown paths fall back to index.html for the SPA).
 */
// /webhooks/* is deliberately NOT proxied here: providers call the API Worker's own domain.
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    return isApiPath(pathname) ? env.API.fetch(request) : env.ASSETS.fetch(request);
  },
};
