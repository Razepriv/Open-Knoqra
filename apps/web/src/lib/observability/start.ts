import type { AnyRouter } from '@tanstack/react-router';
import { track } from './analytics';
import { webObservability } from './config';
import { startSentry } from './sentry';

/**
 * Starts the Desk's optional integrations once the router exists. Never awaited by render: each
 * SDK is a lazy chunk, and an integration that is off downloads nothing.
 */
export function startObservability(router: AnyRouter): void {
  // A failed chunk load leaves Sentry off (reports become no-ops); the Desk works without it and
  // there is nowhere else to report the failure, so it is deliberately ignored here.
  startSentry(webObservability.sentry, router).catch(() => undefined);

  // Product analytics: `page_viewed` carries the leaf route id, never the URL or its params.
  // `track` drops it unless the user has opted in and PostHog is loaded.
  router.subscribe('onResolved', () => {
    const leaf = router.state.matches.at(-1);
    if (leaf) track('page_viewed', { route: analyticsRoute(leaf.routeId) });
  });
}

/** The pathless `/_app` layout is an implementation detail: `/_app/contacts` reads `/contacts`. */
export function analyticsRoute(routeId: string): string {
  return routeId.replace(/^\/_app(?=\/|$)/, '') || '/';
}
