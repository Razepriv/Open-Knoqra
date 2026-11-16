import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { isValidSentryDsn, readObservabilityConfig } from '../src/observability/config';

const DSN = 'https://abc123publickey@o1.ingest.sentry.io/4501';

function read(vars: Record<string, string>, appEnv: Env['APP_ENV'] = 'test') {
  return readObservabilityConfig({ APP_ENV: appEnv, ...vars } as unknown as Env);
}

describe('readObservabilityConfig', () => {
  it('is off with nothing configured', () => {
    expect(read({})).toEqual({ sentry: null, posthog: null, issues: [] });
  });

  it('enables Sentry with a valid DSN and defaults', () => {
    const { sentry, issues } = read({ SENTRY_DSN: DSN, SENTRY_RELEASE: 'abc' }, 'staging');
    expect(sentry).toEqual({
      dsn: DSN,
      release: 'abc',
      environment: 'staging',
      tracesSampleRate: 0.05,
    });
    expect(issues).toEqual([]);
  });

  it('turns Sentry off for an invalid DSN and never leaks the value', () => {
    const result = read({ SENTRY_DSN: 'foo' });
    expect(result.sentry).toBeNull();
    expect(result.issues).toEqual([{ key: 'SENTRY_DSN', reason: 'not a valid DSN' }]);
    const leaky = read({ SENTRY_DSN: 'http://abc123publickey@o1.ingest.sentry.io/x' });
    expect(JSON.stringify(leaky)).not.toContain('abc123publickey');
  });

  it('falls back to 0.05 for an out-of-range sample rate and reports it', () => {
    for (const bad of ['2', '-1', 'abc', '']) {
      const { sentry, issues } = read({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: bad });
      expect(sentry?.tracesSampleRate).toBe(0.05);
      expect(issues.map((i) => i.key)).toEqual(['SENTRY_TRACES_SAMPLE_RATE']);
    }
    expect(
      read({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0.5' }).sentry?.tracesSampleRate,
    ).toBe(0.5);
    expect(read({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: '0' }).sentry?.tracesSampleRate).toBe(
      0,
    );
  });

  it('defaults the PostHog host', () => {
    expect(read({ POSTHOG_KEY: 'phc_x' }).posthog).toEqual({
      key: 'phc_x',
      host: 'https://us.i.posthog.com',
    });
  });

  it('turns PostHog off for a non-https host', () => {
    const result = read({ POSTHOG_KEY: 'phc_x', POSTHOG_HOST: 'http://x' });
    expect(result.posthog).toBeNull();
    expect(result.issues).toEqual([{ key: 'POSTHOG_HOST', reason: 'must be an https URL' }]);
  });

  it('memoizes per env object', () => {
    const env = { APP_ENV: 'test' } as unknown as Env;
    expect(readObservabilityConfig(env)).toBe(readObservabilityConfig(env));
  });
});

describe('isValidSentryDsn', () => {
  it('requires https, a public key and a numeric project id', () => {
    expect(isValidSentryDsn(DSN)).toBe(true);
    expect(isValidSentryDsn('http://k@h/1')).toBe(false);
    expect(isValidSentryDsn('https://h/1')).toBe(false);
    expect(isValidSentryDsn('https://k@h/abc')).toBe(false);
    expect(isValidSentryDsn('nope')).toBe(false);
  });
});
