import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureLogging,
  currentLogContext,
  logger,
  redactMessage,
  serializeError,
  withLogContext,
} from '../src/lib/logger';

const PHONE = '+12025550123';
const TOKEN = 'secret_token';

/** Shaped like drizzle-orm's DrizzleQueryError wrapping a pg DatabaseError. */
function drizzleQueryError(): Error {
  const pgError = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "contact_organization_id_phone_e164_unique"',
    ),
    {
      name: 'DatabaseError',
      code: '23505',
      constraint: 'contact_organization_id_phone_e164_unique',
      detail: `Key (organization_id, phone_e164)=(org_1, ${PHONE}) already exists.`,
    },
  );
  const error = new Error(
    `Failed query: insert into "contact" ("phone_e164", "token") values ($1, $2)\nparams: ${PHONE},${TOKEN}`,
    { cause: pgError },
  );
  error.name = 'DrizzleQueryError';
  return error;
}

afterEach(() => {
  configureLogging({ appEnv: 'test' });
  vi.restoreAllMocks();
});

describe('logger error serialization', () => {
  it('never emits query params, details or stacks outside development', () => {
    configureLogging({ appEnv: 'production' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('request.failed', { error: drizzleQueryError() });
    const line = String(spy.mock.calls.at(-1)?.[0]);
    expect(line).not.toContain(PHONE);
    expect(line).not.toContain(TOKEN);
    expect(JSON.parse(line).error).toEqual({
      name: 'DrizzleQueryError',
      message:
        'Failed query: insert into "contact" ("phone_e164", "token") values ($1, $2)\nparams: [redacted]',
      cause: {
        name: 'DatabaseError',
        code: '23505',
        constraint: 'contact_organization_id_phone_e164_unique',
        message:
          'duplicate key value violates unique constraint "contact_organization_id_phone_e164_unique"',
      },
    });
  });

  it.each(['test', 'staging', 'production'] as const)('is redacted for APP_ENV=%s', (appEnv) => {
    configureLogging({ appEnv });
    const serialized = JSON.stringify(serializeError(drizzleQueryError()));
    expect(serialized).not.toContain(PHONE);
    expect(serialized).not.toContain(TOKEN);
  });

  it('keeps full detail in development', () => {
    configureLogging({ appEnv: 'development' });
    const serialized = serializeError(drizzleQueryError());
    expect(serialized.message).toContain(TOKEN);
    expect(serialized.stack).toEqual(expect.any(String));
  });

  it('redacts params regardless of case, and leaves other messages alone', () => {
    expect(redactMessage('Failed query: select 1 PARAMS: a,b')).toBe(
      'Failed query: select 1 params: [redacted]',
    );
    expect(redactMessage('connect ECONNREFUSED 127.0.0.1:1')).toBe(
      'connect ECONNREFUSED 127.0.0.1:1',
    );
  });
});

describe('log context', () => {
  it('adds requestId to every line inside withLogContext, and nothing outside', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    withLogContext({ requestId: 'r-1' }, () => {
      expect(currentLogContext()).toEqual({ requestId: 'r-1' });
      logger.info('inside');
    });
    logger.info('outside');
    expect(JSON.parse(String(spy.mock.calls[0]?.[0])).requestId).toBe('r-1');
    expect(JSON.parse(String(spy.mock.calls[1]?.[0]))).not.toHaveProperty('requestId');
    expect(currentLogContext()).toEqual({});
  });
});
