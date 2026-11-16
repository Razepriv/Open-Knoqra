import { ALLOWED_HEADERS, scrubEvent } from '@knoqra/core/scrub';
import type { WebObservabilityConfig } from './config';
// Type-only: erased at build time, so the SDK stays in its own lazy chunk (see startSentry).
import type { Breadcrumb, BrowserOptions } from './sentry-sdk';

export type SentryConfig = NonNullable<WebObservabilityConfig['sentry']>;

export interface ErrorContext {
  /** Where the error was caught: `react` (the app boundary), `route` (a route error screen). */
  where: string;
}

/** The few SDK functions KNOQRA calls, re-exported by ./sentry-sdk (never the whole package). */
type SentrySdk = Pick<
  typeof import('./sentry-sdk'),
  'init' | 'captureException' | 'tanstackRouterBrowserTracingIntegration'
>;

interface PendingReport {
  error: unknown;
  context?: ErrorContext;
}

/** Errors raised before the SDK loads are kept, up to this many, and sent once it does. */
const MAX_BUFFERED = 20;

/**
 * `pending`: not started, or the SDK is loading; reports are buffered.
 * `on`: the SDK is initialised; reports go straight to it.
 * `off`: no config, or the SDK failed to load; reports are dropped.
 */
type State =
  | { status: 'pending'; buffer: readonly PendingReport[] }
  | { status: 'on'; sdk: SentrySdk }
  | { status: 'off' };

let state: State = { status: 'pending', buffer: [] };
let starting: Promise<void> | null = null;

function capture(sdk: SentrySdk, { error, context }: PendingReport): void {
  sdk.captureException(error, context ? { tags: { where: context.where } } : undefined);
}

/**
 * Sends an error to Sentry. Before the SDK has loaded it is buffered (at most 20); when Sentry is
 * off it is dropped. Never throws.
 */
export function reportError(error: unknown, context?: ErrorContext): void {
  if (state.status === 'on') {
    capture(state.sdk, { error, context });
  } else if (state.status === 'pending' && state.buffer.length < MAX_BUFFERED) {
    state = { status: 'pending', buffer: [...state.buffer, { error, context }] };
  }
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  // Console breadcrumbs would replay whatever was logged in the browser.
  if (crumb.category === 'console') return null;
  // ui.click / ui.input serialise the aria-label, title and name of the element and its
  // ancestors, which name contacts ("Merge Ada …").
  if (crumb.category?.startsWith('ui.')) return null;
  return scrubEvent({ breadcrumbs: [crumb] }).breadcrumbs?.[0] ?? null;
}

/**
 * The global rule "no default PII", in Sentry 11 terms (11.x removed `sendDefaultPii` in favour of
 * `dataCollection`, whose defaults collect everything). Mirrors the Worker's settings.
 */
function privateDataCollection(): NonNullable<BrowserOptions['dataCollection']> {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: { allow: [...ALLOWED_HEADERS] }, response: false },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
  };
}

/** SDK options from the validated config. No Replay, no session or user data. */
export function sentryOptions(
  sdk: SentrySdk,
  config: SentryConfig,
  router: unknown,
): BrowserOptions {
  return {
    dsn: config.dsn,
    release: config.release ?? undefined,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
    // Trace headers only reach KNOQRA's own API, never a third party.
    tracePropagationTargets: [/^\/api\//],
    integrations: [sdk.tanstackRouterBrowserTracingIntegration(router)],
    dataCollection: privateDataCollection(),
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

async function load(config: SentryConfig, router: unknown): Promise<void> {
  try {
    const sdk: SentrySdk = await import('./sentry-sdk');
    sdk.init(sentryOptions(sdk, config, router));
    const buffered = state.status === 'pending' ? state.buffer : [];
    state = { status: 'on', sdk };
    for (const report of buffered) capture(sdk, report);
  } catch (error) {
    state = { status: 'off' };
    throw error;
  }
}

/**
 * Loads and starts the Sentry SDK when `config` is set; with no config nothing is downloaded and
 * reports become no-ops. Idempotent. Rejects when the SDK chunk fails to load (Sentry then stays
 * off); the caller decides whether that matters.
 */
export function startSentry(config: SentryConfig | null, router: unknown): Promise<void> {
  if (starting) return starting;
  if (!config) {
    state = { status: 'off' };
    starting = Promise.resolve();
  } else {
    starting = load(config, router);
  }
  return starting;
}
