import { describe, expect, it } from 'vitest';
import { isValidSentryDsn, readWebObservabilityConfig } from './config';

const DSN = 'https://abc123publickey@o1.ingest.sentry.io/4501';

function read(vars: Record<string, string | boolean | undefined>) {
  return readWebObservabilityConfig({ MODE: 'test', ...vars });
}

describe('readWebObservabilityConfig', () => {
  it('is off with nothing configured', () => {
    expect(read({})).toEqual({ sentry: null, posthog: null, issues: [] });
  });

  it('is off for a plain production build without keys', () => {
    const config = readWebObservabilityConfig({ MODE: 'production', PROD: true, DEV: false });
    expect(config.sentry).toBeNull();
    expect(config.posthog).toBeNull();
    expect(config.issues).toEqual([]);
  });

  it('enables Sentry with a valid DSN and defaults', () => {
    const { sentry, issues } = read({
      VITE_SENTRY_DSN: DSN,
      VITE_SENTRY_RELEASE: 'abc',
      VITE_SENTRY_ENVIRONMENT: 'staging',
    });
    expect(sentry).toEqual({
      dsn: DSN,
      release: 'abc',
      environment: 'staging',
      tracesSampleRate: 0.05,
    });
    expect(issues).toEqual([]);
  });

  it('falls back to the Vite mode for the environment and null for the release', () => {
    const { sentry } = readWebObservabilityConfig({ MODE: 'production', VITE_SENTRY_DSN: DSN });
    expect(sentry?.environment).toBe('production');
    expect(sentry?.release).toBeNull();
  });

  it('turns Sentry off for an invalid DSN and never leaks the value', () => {
    const result = read({ VITE_SENTRY_DSN: 'foo' });
    expect(result.sentry).toBeNull();
    expect(result.issues).toEqual([{ key: 'VITE_SENTRY_DSN', reason: 'not a valid DSN' }]);
    const leaky = read({ VITE_SENTRY_DSN: 'http://abc123publickey@o1.ingest.sentry.io/x' });
    expect(JSON.stringify(leaky)).not.toContain('abc123publickey');
  });

  it('falls back to 0.05 for an out-of-range sample rate and reports it', () => {
    for (const bad of ['2', '-1', 'abc', '']) {
      const { sentry, issues } = read({
        VITE_SENTRY_DSN: DSN,
        VITE_SENTRY_TRACES_SAMPLE_RATE: bad,
      });
      expect(sentry?.tracesSampleRate).toBe(0.05);
      expect(issues.map((i) => i.key)).toEqual(['VITE_SENTRY_TRACES_SAMPLE_RATE']);
      expect(issues[0]?.reason).toBe('must be a number between 0 and 1');
    }
    const half = read({ VITE_SENTRY_DSN: DSN, VITE_SENTRY_TRACES_SAMPLE_RATE: '0.5' });
    expect(half.sentry?.tracesSampleRate).toBe(0.5);
    const zero = read({ VITE_SENTRY_DSN: DSN, VITE_SENTRY_TRACES_SAMPLE_RATE: '0' });
    expect(zero.sentry?.tracesSampleRate).toBe(0);
  });

  it('defaults the PostHog host', () => {
    expect(read({ VITE_POSTHOG_KEY: 'phc_x' }).posthog).toEqual({
      key: 'phc_x',
      host: 'https://us.i.posthog.com',
    });
    expect(
      read({ VITE_POSTHOG_KEY: 'phc_x', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com' }).posthog,
    ).toEqual({ key: 'phc_x', host: 'https://eu.i.posthog.com' });
  });

  it('turns PostHog off for a non-https host', () => {
    const result = read({ VITE_POSTHOG_KEY: 'phc_x', VITE_POSTHOG_HOST: 'http://x' });
    expect(result.posthog).toBeNull();
    expect(result.issues).toEqual([{ key: 'VITE_POSTHOG_HOST', reason: 'must be an https URL' }]);
  });

  it('ignores non-string values and blank keys', () => {
    expect(read({ VITE_SENTRY_DSN: true, VITE_POSTHOG_KEY: '   ' })).toEqual({
      sentry: null,
      posthog: null,
      issues: [],
    });
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
