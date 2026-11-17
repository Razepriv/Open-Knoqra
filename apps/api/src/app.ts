import { OpenAPIHono } from '@hono/zod-openapi';
import { LICENSE_PUBLIC_KEY } from '@knoqra/core';
import type { ErrorHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { UNSUBSCRIBE_PATH } from './email/unsubscribe';
import { type ApiExtension, withExtensions } from './extensions';
import { requestAuth } from './lib/auth-context';
import type { AppEnv } from './lib/context';
import { requestDb } from './lib/db';
import { fail } from './lib/envelope';
import { httpExceptionResponse } from './lib/http-error';
import { configureLogging, logger } from './lib/logger';
import { AUTH_BASE_PATH, RATE_LIMITED_AUTH_ROUTES, RULES, rateLimit } from './lib/rate-limit';
import { redactPath } from './lib/redact-path';
import { createLicenseChecker } from './license/status';
import { requestId } from './middleware/request-id';
import { tenant } from './middleware/tenant';
import { reportError } from './observability/report';
import { calls } from './routes/calls';
import { connectors } from './routes/connectors';
import { contactDuplicates } from './routes/contact-duplicates';
import { contactImport } from './routes/contact-import';
import { contactPermissions } from './routes/contact-permissions';
import { contactTimeline } from './routes/contact-timeline';
import { contacts } from './routes/contacts';
import { conversations } from './routes/conversations';
import { devFakeProvider } from './routes/dev-fake-provider';
import { devFakeVoice } from './routes/dev-fake-voice';
import { emailUnsubscribe } from './routes/email-unsubscribe';
import { health } from './routes/health';
import { healthDeep } from './routes/health-deep';
import { licenseGate, licenseRoutes } from './routes/license';
import { me } from './routes/me';
import { media, mediaFile } from './routes/media';
import { messageTemplates } from './routes/message-templates';
import { messages } from './routes/messages';
import { messagingChannels } from './routes/messaging-channels';
import { messagingSenders } from './routes/messaging-senders';
import { notifications } from './routes/notifications';
import { numberPurchase } from './routes/number-purchase';
import { numbers } from './routes/numbers';
import { otto } from './routes/otto';
import { ottoConnectionRoutes } from './routes/otto-connection';
import { plivoAnswer } from './routes/plivo-answer';
import { prefs } from './routes/prefs';
import { REALTIME_PATH, realtime, realtimeGuard } from './routes/realtime';
import { reconciliationRoutes } from './routes/reconciliations';
import { setupRoutes } from './routes/setup';
import { tasks } from './routes/tasks';
import { today } from './routes/today';
import { todayPrefs } from './routes/today-prefs';
import { usageRoutes } from './routes/usage';
import { usageBalanceRoutes } from './routes/usage-balance';
import { voice } from './routes/voice';
import { voicemails } from './routes/voicemails';
import { walletRoutes } from './routes/wallet';
import { webhooks } from './routes/webhooks';

/** Document settings for /api/openapi.json; the Task 8 emitter must pass the same object. */
export const openApiDocConfig = {
  openapi: '3.1.0',
  info: { title: 'KNOQRA API', version: '0.1.0' },
} as const;

/**
 * The whole HTTP API, with each extension's routes mounted at its slot (extensions.ts). Pure
 * module: no `cloudflare:*` imports, so Node scripts (OpenAPI emit) can import it. Worker wiring
 * lives in worker.ts.
 */
export function createApp(extensions: readonly ApiExtension[] = []): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    // Zod failures on params and bodies become the standard envelope.
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
        return fail(c, 400, 'validation_error', `${where}${issue?.message ?? 'Invalid request'}`);
      }
    },
  });

  // Every handler sees the extensions this app was built with (lib/pricing.ts reads them).
  app.use(
    '*',
    createMiddleware<AppEnv>(async (c, next) => {
      c.env = withExtensions(c.env ?? ({} as AppEnv['Bindings']), extensions);
      await next();
    }),
  );

  app.use('*', requestId);

  // Full error detail in logs only for local development (see lib/logger.ts).
  app.use('*', async (c, next) => {
    configureLogging({ appEnv: c.env.APP_ENV });
    await next();
  });

  // API and webhook responses are per-user or live data: never cache them. A route (or Better Auth)
  // that already set its own Cache-Control keeps it.
  app.use('*', async (c, next) => {
    await next();
    const path = c.req.path;
    if (
      (path.startsWith('/api/') || path.startsWith('/webhooks/')) &&
      !c.res.headers.has('Cache-Control')
    ) {
      c.header('Cache-Control', 'no-store');
    }
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
    description:
      'Better Auth session cookie, set by /api/auth/sign-in/email. Over HTTPS the cookie is named __Secure-better-auth.session_token.',
  });

  app.route('/', health);

  // Session-gated: owners and admins of the active organization (SYSTEM_STATUS_ROLES).
  app.use('/api/health/deep', requestDb, requestAuth, tenant());
  app.route('/', healthDeep);

  app.route('/', plivoAnswer);
  // Extension webhooks go before the generic /webhooks/:provider route, which would answer them 404.
  for (const extension of extensions) extension.webhooks?.(app);
  app.route('/', webhooks);

  // Extension pages with no session (for example the cloud's license key issuing pages).
  for (const extension of extensions) extension.publicRoutes?.(app);

  // The newsletter's signed unsubscribe link: no session, limited per address like the auth routes.
  app.on(['GET', 'POST'], UNSUBSCRIBE_PATH, rateLimit(RULES.auth));
  app.on('POST', UNSUBSCRIBE_PATH, requestDb);
  app.route('/', emailUnsubscribe);

  // Message files behind signed, short-lived links: no session (routes/media.ts).
  app.use('/api/media/*', requestDb);
  app.route('/', mediaFile);

  // Durable per-address limits on the auth routes that guess or spend a secret. Registered before
  // the database chain, so a limited request opens no connection. Exact paths only: Better Auth
  // answers any other spelling of these paths (trailing slash, doubled slash, other case) with 404.
  app.on(
    'POST',
    RATE_LIMITED_AUTH_ROUTES.map((route) => `${AUTH_BASE_PATH}/${route}`),
    rateLimit(RULES.auth),
  );
  app.use('/api/auth/*', requestDb, requestAuth);
  app.on(['GET', 'POST'], '/api/auth/*', (c) => c.var.auth.handler(c.req.raw));

  // Before the session chain: upgrade and Origin checks need no database (see routes/realtime.ts).
  app.use(REALTIME_PATH, realtimeGuard);
  app.use('/api/v1/*', requestDb, requestAuth, tenant());
  // A self-hosted instance answers 403 license_required until a valid key is set (routes/license.ts).
  const licenseChecker = createLicenseChecker(LICENSE_PUBLIC_KEY);
  app.use('/api/v1/*', licenseGate(licenseChecker));
  // Durable per-user and per-organization limits. After tenant(), which supplies the keys, and
  // before the route handlers, so a limited dial makes no call row, reserve or lock.
  app.on('POST', ['/api/v1/calls', '/api/v1/calls/:id/answer'], rateLimit(RULES.dial));
  app.on('POST', '/api/v1/voice/token', rateLimit(RULES.voice_token));
  app.on('DELETE', '/api/v1/me', rateLimit(RULES.account_delete));
  app.on('POST', '/api/v1/conversations/:id/messages', rateLimit(RULES.message_send));
  // Extension guards on core session routes: after the limits above, before the routes below.
  for (const extension of extensions) extension.sessionGuards?.(app);
  app.route('/', me);
  app.route('/', licenseRoutes(licenseChecker));
  app.route('/', prefs);
  app.route('/', contactImport);
  app.route('/', contacts);
  app.route('/', contactTimeline);
  app.route('/', contactPermissions);
  app.route('/', contactDuplicates);
  app.route('/', tasks);
  app.route('/', notifications);
  app.route('/', otto);
  app.route('/', ottoConnectionRoutes());
  app.route('/', today);
  app.route('/', todayPrefs);
  app.route('/', messagingSenders);
  app.route('/', messagingChannels);
  app.route('/', messageTemplates);
  app.route('/', conversations);
  app.route('/', messages);
  app.route('/', media);
  app.route('/', voice);
  app.route('/', connectors);
  app.route('/', walletRoutes);
  app.route('/', numbers);
  app.route('/', numberPurchase);
  app.route('/', setupRoutes);
  app.route('/', usageBalanceRoutes);
  app.route('/', usageRoutes);
  app.route('/', reconciliationRoutes);
  app.route('/', calls);
  app.route('/', voicemails);
  app.route('/', devFakeVoice);
  app.route('/', devFakeProvider);
  app.route('/', realtime);
  // Extension session routes: after the tenant check and the license gate above.
  for (const extension of extensions) extension.routes?.(app);

  app.doc31('/api/openapi.json', openApiDocConfig);

  app.notFound((c) =>
    c.req.path.startsWith('/api/v1/')
      ? fail(c, 404, 'not_found', 'No such route.')
      : c.json({ error: 'not_found' }, 404),
  );

  app.onError(handleAppError);
  return app;
}

/** Exported so tests can mount it on a throwaway app. Unexpected errors go to reportError. */
export const handleAppError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof HTTPException) {
    return c.req.path.startsWith('/api/v1/')
      ? httpExceptionResponse(error, c)
      : error.getResponse();
  }
  logger.error('request.failed', { method: c.req.method, path: redactPath(c.req.path), error });
  reportError(error, { where: 'http', requestId: c.get('requestId') });
  return fail(c, 500, 'internal_error', 'Something went wrong.');
};

/** The open-source core API: no extensions. */
export const app = createApp();
