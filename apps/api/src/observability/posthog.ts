import type { Context } from 'hono';
import type { AppEnv } from '../lib/context';
import { logger } from '../lib/logger';
import { loadPrefs } from '../lib/prefs';
import { type ObservabilityConfig, readObservabilityConfig } from './config';

/** Server-side events and the only props each may carry: non-negative integers, nothing else. */
export const SERVER_EVENTS = {
  contacts_import_batch: ['created', 'updated', 'skipped', 'rejected'],
} as const;

export type ServerEvent = keyof typeof SERVER_EVENTS;
export type ServerEventProps<E extends ServerEvent> = Record<
  (typeof SERVER_EVENTS)[E][number],
  number
>;

export interface ServerAnalytics {
  enabled: boolean;
  capture<E extends ServerEvent>(
    event: E,
    distinctId: string,
    props: ServerEventProps<E>,
  ): Promise<void>;
}

const CAPTURE_TIMEOUT_MS = 3000;

/** Keeps only the allowed keys of the event, each coerced to a non-negative integer. */
function allowedProps(event: ServerEvent, props: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of SERVER_EVENTS[event]) {
    const value = props[key];
    out[key] = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  }
  return out;
}

const NOOP: ServerAnalytics = { enabled: false, capture: async () => undefined };

export function createServerAnalytics(
  config: ObservabilityConfig['posthog'],
  doFetch: typeof fetch = fetch,
): ServerAnalytics {
  if (!config) return NOOP;
  const endpoint = `${config.host.replace(/\/+$/, '')}/i/v0/e/`;
  return {
    enabled: true,
    async capture(event, distinctId, props) {
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_key: config.key,
            event,
            distinct_id: distinctId,
            properties: {
              ...allowedProps(event, props),
              $lib: 'knoqra-api',
              $process_person_profile: false,
            },
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
        });
        if (!response.ok)
          logger.warn('analytics.capture_failed', { event, status: response.status });
      } catch {
        logger.warn('analytics.capture_failed', { event, status: 0 });
      }
    },
  };
}

export const CONSENT_LOOKUP_TIMEOUT_MS = 1000;

/** Resolves the consent flag, or null when the read takes longer than the timeout. */
async function readConsent(c: Context<AppEnv>, userId: string): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CONSENT_LOOKUP_TIMEOUT_MS);
  });
  try {
    const prefs = loadPrefs(c.var.db, userId).then((p) => p.analyticsConsent);
    return await Promise.race([prefs, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Captures a server event for the session user, only when PostHog is configured and the user
 * opted in. Never throws. The consent read happens here, before the response (the request's DB
 * handle is closed after it) and is bounded to 1 s; only the network call goes to `waitUntil`.
 */
export async function captureForUser<E extends ServerEvent>(
  c: Context<AppEnv>,
  event: E,
  props: ServerEventProps<E>,
  doFetch: typeof fetch = fetch,
): Promise<void> {
  try {
    const analytics = createServerAnalytics(readObservabilityConfig(c.env).posthog, doFetch);
    if (!analytics.enabled) return;
    const { userId } = c.var.tenant;
    const consent = await readConsent(c, userId);
    if (consent === null) {
      logger.warn('analytics.consent_lookup_timeout', { event });
      return;
    }
    if (!consent) return;
    c.executionCtx.waitUntil(analytics.capture(event, userId, props));
  } catch (error) {
    logger.warn('analytics.capture_failed', { event, status: 0, error });
  }
}
