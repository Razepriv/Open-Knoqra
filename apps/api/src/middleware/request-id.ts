import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/context';
import { logger, withLogContext } from '../lib/logger';
import { redactPath } from '../lib/redact-path';

const ACCEPTABLE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Gives every request an id (a well-formed incoming `x-request-id`, else a fresh UUID), echoes it on
 * the response, scopes it into the log context and logs one `request.completed` line
 * (path redacted: reset links carry a live token).
 */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && ACCEPTABLE_ID.test(incoming) ? incoming : crypto.randomUUID();
  c.set('requestId', id);
  const started = Date.now();
  await withLogContext({ requestId: id }, async () => {
    try {
      await next();
    } finally {
      // Set after next() so it also lands on responses built by onError and notFound.
      c.header('x-request-id', id);
      logger.info('request.completed', {
        method: c.req.method,
        path: redactPath(new URL(c.req.url).pathname),
        status: c.res.status,
        durationMs: Date.now() - started,
      });
    }
  });
});
