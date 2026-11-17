import { ALLOWED_HEADERS, scrubEvent } from '@knoqra/core/scrub';
import {
  type Breadcrumb,
  type CloudflareOptions,
  captureException,
  cronTriggersIntegration,
  withSentry,
} from '@sentry/cloudflare';
import { CRON_JOBS } from '../cron/jobs';
import type { Env } from '../env';
import type { QueueMessage } from '../queue/messages';
import { type ObservabilityConfig, readObservabilityConfig } from './config';
import { redactEventPaths } from './redact-event-paths';
import { setErrorReporter } from './report';

/** The Worker's entry points. Every one of them goes through `observed`. */
export type KnoqraHandler = Required<
  Pick<ExportedHandler<Env, QueueMessage>, 'fetch' | 'queue' | 'scheduled'>
>;

export type SentryConfig = NonNullable<ObservabilityConfig['sentry']>;

/** `withSentry`'s shape, narrowed to KNOQRA's handler; tests pass a spy instead. */
export type SentryWrap = (
  options: (env: Env) => CloudflareOptions,
  handler: KnoqraHandler,
) => KnoqraHandler;

const sentryWrap: SentryWrap = (options, handler) => withSentry(options, handler);

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  // Console breadcrumbs would replay log lines, and logs are already in Workers Logs.
  if (crumb.category === 'console') return null;
  return scrubEvent({ breadcrumbs: [crumb] }).breadcrumbs?.[0] ?? null;
}

/**
 * The global rule `sendDefaultPii: false`, in Sentry 11 terms: 11.x removed `sendDefaultPii`
 * (types and runtime) in favour of `dataCollection`, whose defaults collect everything. No user
 * info or IP, cookies, bodies, query strings, local variables, query or queue data; request
 * headers limited to the two the scrubber also keeps.
 */
function privateDataCollection(): NonNullable<CloudflareOptions['dataCollection']> {
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

/**
 * SDK options from the validated config. Every setting is explicit: the SDK would otherwise fall
 * back to reading raw SENTRY_* values from env, skipping our validation.
 */
export function sentryOptions(_env: Env, config: SentryConfig): CloudflareOptions {
  return {
    dsn: config.dsn,
    release: config.release ?? undefined,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
    debug: false,
    dataCollection: privateDataCollection(),
    // Paths can carry live credentials (Better Auth's reset token): redact them after scrubbing.
    beforeSend: (event) => redactEventPaths(scrubEvent(event)),
    beforeSendTransaction: (event) => redactEventPaths(scrubEvent(event)),
    beforeBreadcrumb: scrubBreadcrumb,
    integrations: [
      cronTriggersIntegration({
        monitorSlug: (cron) => CRON_JOBS.find((job) => job.cron === cron)?.name,
      }),
    ],
  };
}

function reportToSentry(error: unknown, context: { requestId?: string; where: string }): void {
  captureException(error, {
    tags: {
      where: context.where,
      ...(context.requestId === undefined ? {} : { request_id: context.requestId }),
    },
  });
}

/**
 * Dispatches each invocation to the plain handler when Sentry is off (no valid DSN), so the SDK
 * is never entered. With a DSN, `wrap` is applied once, lazily, to a COPY of the handler
 * (`withSentry` replaces the methods of the object it is given), and caught errors are routed to
 * Sentry through the error reporter.
 */
export function observed(handler: KnoqraHandler, wrap: SentryWrap = sentryWrap): KnoqraHandler {
  let wrapped: KnoqraHandler | null = null;
  const target = (env: Env): KnoqraHandler => {
    const config = readObservabilityConfig(env).sentry;
    if (!config) return handler;
    if (!wrapped) {
      wrapped = wrap(
        (current) => sentryOptions(current, readObservabilityConfig(current).sentry ?? config),
        { ...handler },
      );
      setErrorReporter(reportToSentry);
    }
    return wrapped;
  };
  return {
    fetch: (request, env, ctx) => target(env).fetch(request, env, ctx),
    queue: (batch, env, ctx) => target(env).queue(batch, env, ctx),
    scheduled: (controller, env, ctx) => target(env).scheduled(controller, env, ctx),
  };
}
