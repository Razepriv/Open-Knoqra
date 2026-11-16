import { env } from 'cloudflare:workers';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { CloudflareOptions, ErrorEvent } from '@sentry/cloudflare';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAppError } from '../src/app';
import type { Env } from '../src/env';
import type { AppEnv } from '../src/lib/context';
import { requestId } from '../src/middleware/request-id';
import { readObservabilityConfig } from '../src/observability/config';
import { reportError, setErrorReporter } from '../src/observability/report';
import {
  type KnoqraHandler,
  observed,
  type SentryWrap,
  sentryOptions,
} from '../src/observability/sentry';

const PHONE = '+12025550123';

/** Not re-exported by @sentry/cloudflare. */
type TransactionEvent = Parameters<NonNullable<CloudflareOptions['beforeSendTransaction']>>[0];
const DSN = 'https://publickey@sentry.example.test/42';

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

const controller = {
  cron: '*/5 * * * *',
  scheduledTime: Date.now(),
  noRetry() {},
} as ScheduledController;

const batch = { queue: 'q', messages: [] } as unknown as MessageBatch<{ rawEventId: string }>;

/** A fresh env object per call: readObservabilityConfig memoizes per object. */
function testEnv(extra: Partial<Env> = {}): Env {
  return { ...env, ...extra } as Env;
}

function spyHandler() {
  return {
    fetch: vi.fn(async () => new Response('ok')),
    queue: vi.fn(async () => undefined),
    scheduled: vi.fn(async () => undefined),
  } satisfies KnoqraHandler;
}

afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

describe('observed', () => {
  it('runs the plain handler and never wraps when no DSN is set', async () => {
    const handler = spyHandler();
    const wrapSpy = vi.fn<SentryWrap>(() => spyHandler());
    const worker = observed(handler, wrapSpy);
    const plain = testEnv();

    await worker.fetch(new Request('http://localhost/x'), plain, ctx);
    await worker.queue(batch, plain, ctx);
    await worker.scheduled(controller, plain, ctx);

    expect(handler.fetch).toHaveBeenCalledTimes(1);
    expect(handler.queue).toHaveBeenCalledTimes(1);
    expect(handler.scheduled).toHaveBeenCalledTimes(1);
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it('treats an invalid DSN as off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = spyHandler();
    const wrapSpy = vi.fn<SentryWrap>(() => spyHandler());
    await observed(handler, wrapSpy).fetch(
      new Request('http://localhost/x'),
      testEnv({ SENTRY_DSN: 'not a dsn' }),
      ctx,
    );
    expect(handler.fetch).toHaveBeenCalledTimes(1);
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it('wraps a copy once with a valid DSN and leaves the original handler alone', async () => {
    const handler = spyHandler();
    const original = { ...handler };
    const wrapped = spyHandler();
    // Mutates its argument the way withSentry does.
    const wrapSpy = vi.fn<SentryWrap>((_options, target) => {
      target.fetch = wrapped.fetch;
      target.queue = wrapped.queue;
      target.scheduled = wrapped.scheduled;
      return target;
    });
    const worker = observed(handler, wrapSpy);
    const sentryEnv = testEnv({ SENTRY_DSN: DSN });

    await worker.fetch(new Request('http://localhost/x'), sentryEnv, ctx);
    await worker.scheduled(controller, sentryEnv, ctx);

    expect(wrapSpy).toHaveBeenCalledTimes(1);
    expect(wrapSpy.mock.calls[0]?.[1]).not.toBe(handler);
    expect(handler).toEqual(original);
    expect(handler.fetch).not.toHaveBeenCalled();
    expect(wrapped.fetch).toHaveBeenCalledTimes(1);
    expect(wrapped.scheduled).toHaveBeenCalledTimes(1);

    const options = wrapSpy.mock.calls[0]?.[0](sentryEnv);
    expect(options?.dsn).toBe(DSN);
  });
});

describe('sentryOptions', () => {
  function options() {
    const sentryEnv = testEnv({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'abc123' });
    const config = readObservabilityConfig(sentryEnv).sentry;
    if (!config) throw new Error('expected a Sentry config');
    return sentryOptions(sentryEnv, config);
  }

  it('passes every setting explicitly, with default PII off and the default sample rate', () => {
    const o = options();
    expect(o.dsn).toBe(DSN);
    expect(o.release).toBe('abc123');
    expect(o.environment).toBe('test');
    expect(o.tracesSampleRate).toBe(0.05);
    // Sentry 11 replaced `sendDefaultPii: false` with `dataCollection` (defaults: collect all).
    expect(o.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
    expect(o).not.toHaveProperty('sendDefaultPii');
  });

  it('leaves the release unset when none is configured', () => {
    const sentryEnv = testEnv({ SENTRY_DSN: DSN });
    const config = readObservabilityConfig(sentryEnv).sentry;
    if (!config) throw new Error('expected a Sentry config');
    const o = sentryOptions(sentryEnv, config);
    expect(o).toHaveProperty('release', undefined);
  });

  it('scrubs phones, cookies, auth headers and request bodies in beforeSend', async () => {
    const event = {
      type: undefined,
      exception: {
        values: [{ type: 'Error', value: `Failed query: select 1\nparams: ${PHONE}` }],
      },
      request: {
        url: 'https://api.example.test/api/v1/contacts?phone=1',
        headers: {
          cookie: 'better-auth.session_token=abc',
          authorization: 'Bearer abc',
          'user-agent': 'vitest',
        },
        data: { phone: PHONE },
      },
    } as ErrorEvent;
    const result = await options().beforeSend?.(event, {});
    const text = JSON.stringify(result);
    expect(text).not.toContain('12025550123');
    expect(result?.request?.headers).toEqual({ 'user-agent': 'vitest' });
    expect(result?.request).not.toHaveProperty('data');
    expect(result?.request?.url).toBe('https://api.example.test/api/v1/contacts');
  });

  it('keeps the dynamic sampling context intact in beforeSend', async () => {
    const sdkProcessingMetadata = {
      dynamicSamplingContext: {
        trace_id: '1234567890abcdef1234567890abcdef',
        sample_rand: '0.8374651928374',
        sample_rate: '0.05',
      },
    };
    const event = {
      type: undefined,
      message: `hello ${PHONE}`,
      sdkProcessingMetadata,
    } as ErrorEvent;
    const result = await options().beforeSend?.(event, {});
    expect(result?.message).toBe('hello [phone]');
    expect(result?.sdkProcessingMetadata).toBe(sdkProcessingMetadata);
    expect(result?.sdkProcessingMetadata?.dynamicSamplingContext?.sample_rand).toBe(
      '0.8374651928374',
    );
  });

  it('scrubs span descriptions in beforeSendTransaction and keeps trace ids', async () => {
    const traceId = '1234567890abcdef1234567890abcdef';
    const event = {
      type: 'transaction',
      transaction: 'GET /api/v1/contacts',
      contexts: { trace: { trace_id: traceId, span_id: '1234567890123456' } },
      spans: [
        {
          trace_id: traceId,
          span_id: '6543210987654321',
          parent_span_id: '1234567890123456',
          description: `select * from contact where phone = '${PHONE}'`,
          start_timestamp: 1,
          data: {},
        },
      ],
    } as TransactionEvent;
    const result = await options().beforeSendTransaction?.(event, {});
    expect(JSON.stringify(result)).not.toContain('12025550123');
    expect(result?.spans?.[0]?.description).toBe("select * from contact where phone = '[phone]'");
    expect(result?.spans?.[0]?.trace_id).toBe(traceId);
    expect(result?.spans?.[0]?.span_id).toBe('6543210987654321');
    expect(result?.contexts?.trace?.trace_id).toBe(traceId);
    expect(result?.contexts?.trace?.span_id).toBe('1234567890123456');
  });

  it('redacts a reset token from every path in beforeSendTransaction', async () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123';
    const path = `/api/auth/reset-password/${token}`;
    const url = `https://api.example.test${path}?callbackURL=%2Freset`;
    const sdkProcessingMetadata = { dynamicSamplingContext: { transaction: 'kept as is' } };
    const event = {
      type: 'transaction',
      transaction: `GET ${path}`,
      request: { url, method: 'GET' },
      contexts: {
        trace: {
          trace_id: '1234567890abcdef1234567890abcdef',
          span_id: '1234567890123456',
          data: {
            'url.full': url,
            'url.path': path,
            'http.target': `${path}?callbackURL=%2Freset`,
            'http.url': url,
            'http.route': path,
            'http.request.method': 'GET',
          },
        },
      },
      spans: [
        {
          trace_id: '1234567890abcdef1234567890abcdef',
          span_id: '6543210987654321',
          description: `GET ${path}`,
          start_timestamp: 1,
          timestamp: 2,
          status: 'ok',
          data: { 'url.full': url },
        },
      ],
      sdkProcessingMetadata,
    } as TransactionEvent;
    const result = await options().beforeSendTransaction?.(event, {});
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('callbackURL');
    expect(result?.transaction).toBe('GET /api/auth/reset-password/[redacted]');
    expect(result?.request?.url).toBe(
      'https://api.example.test/api/auth/reset-password/[redacted]',
    );
    expect(result?.contexts?.trace?.data).toEqual({
      'url.full': 'https://api.example.test/api/auth/reset-password/[redacted]',
      'url.path': '/api/auth/reset-password/[redacted]',
      'http.target': '/api/auth/reset-password/[redacted]',
      'http.url': 'https://api.example.test/api/auth/reset-password/[redacted]',
      'http.route': '/api/auth/reset-password/[redacted]',
      'http.request.method': 'GET',
    });
    expect(result?.spans?.[0]?.description).toBe('GET /api/auth/reset-password/[redacted]');
    expect(result?.contexts?.trace?.trace_id).toBe('1234567890abcdef1234567890abcdef');
    expect(result?.sdkProcessingMetadata).toBe(sdkProcessingMetadata);
  });

  it('redacts the request path in beforeSend', async () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123';
    const event = {
      type: undefined,
      transaction: `POST /api/auth/reset-password/${token}`,
      request: { url: `https://api.example.test/api/auth/reset-password/${token}` },
    } as ErrorEvent;
    const result = await options().beforeSend?.(event, {});
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('drops console breadcrumbs and scrubs the rest', () => {
    const o = options();
    expect(o.beforeBreadcrumb?.({ category: 'console', message: 'hi' })).toBeNull();
    const crumb = o.beforeBreadcrumb?.({ category: 'fetch', message: `called ${PHONE}` });
    expect(crumb?.message).toBe('called [phone]');
  });
});

describe('reportError', () => {
  it('is a no-op without a reporter', () => {
    expect(() => reportError(new Error('boom'), { where: 'http' })).not.toThrow();
  });

  it('never throws when the reporter does', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setErrorReporter(() => {
      throw new Error('reporter down');
    });
    expect(() => reportError(new Error('boom'), { where: 'queue' })).not.toThrow();
  });
});

describe('handleAppError', () => {
  function testApp() {
    const app = new OpenAPIHono<AppEnv>();
    app.use('*', requestId);
    app.get('/boom', () => {
      throw new Error('boom');
    });
    app.get('/forbidden', () => {
      throw new HTTPException(403, { message: 'nope' });
    });
    app.onError(handleAppError);
    return app;
  }

  it('reports an unexpected route error with where http and the request id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const spy = vi.fn();
    setErrorReporter(spy);

    const r = await testApp().request(
      '/boom',
      { headers: { 'x-request-id': 'req-12345678' } },
      testEnv(),
    );

    expect(r.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(spy.mock.calls[0]?.[1]).toEqual({ where: 'http', requestId: 'req-12345678' });
  });

  it('does not report an HTTPException', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const spy = vi.fn();
    setErrorReporter(spy);
    const r = await testApp().request('/forbidden', undefined, testEnv());
    expect(r.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
});
