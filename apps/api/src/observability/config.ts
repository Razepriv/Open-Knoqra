import type { AppEnvironment, Env } from '../env';
import { logger } from '../lib/logger';

export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export interface ConfigIssue {
  key: string;
  reason: string;
}

export interface ObservabilityConfig {
  sentry: {
    dsn: string;
    release: string | null;
    environment: AppEnvironment;
    tracesSampleRate: number;
  } | null;
  posthog: { key: string; host: string } | null;
  /** Names the offending keys only, never their values. */
  issues: ConfigIssue[];
}

/** An https URL with a username (the public key) and a numeric last path segment (project id). */
export function isValidSentryDsn(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const projectId = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return url.protocol === 'https:' && url.username !== '' && /^\d+$/.test(projectId);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function parseSampleRate(raw: string | undefined, issues: ConfigIssue[]): number {
  if (raw === undefined) return DEFAULT_TRACES_SAMPLE_RATE;
  const rate = raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 1) return rate;
  issues.push({ key: 'SENTRY_TRACES_SAMPLE_RATE', reason: 'must be a number between 0 and 1' });
  return DEFAULT_TRACES_SAMPLE_RATE;
}

function readSentry(env: Env, issues: ConfigIssue[]): ObservabilityConfig['sentry'] {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  if (!isValidSentryDsn(dsn)) {
    issues.push({ key: 'SENTRY_DSN', reason: 'not a valid DSN' });
    return null;
  }
  return {
    dsn,
    release: env.SENTRY_RELEASE?.trim() || null,
    environment: env.APP_ENV,
    tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, issues),
  };
}

function readPosthog(env: Env, issues: ConfigIssue[]): ObservabilityConfig['posthog'] {
  const key = env.POSTHOG_KEY?.trim();
  if (!key) return null;
  const host = env.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  if (!isHttpsUrl(host)) {
    issues.push({ key: 'POSTHOG_HOST', reason: 'must be an https URL' });
    return null;
  }
  return { key, host };
}

const cache = new WeakMap<Env, ObservabilityConfig>();
const reported = new Set<string>();

/**
 * Reads the optional Sentry and PostHog settings. A missing or invalid key turns that integration
 * off. Memoized per env object; each invalid key is logged once per isolate, by name only.
 */
export function readObservabilityConfig(env: Env): ObservabilityConfig {
  const cached = cache.get(env);
  if (cached) return cached;
  const issues: ConfigIssue[] = [];
  const config: ObservabilityConfig = {
    sentry: readSentry(env, issues),
    posthog: readPosthog(env, issues),
    issues,
  };
  cache.set(env, config);
  for (const issue of issues) {
    if (reported.has(issue.key)) continue;
    reported.add(issue.key);
    logger.warn('config.invalid', { key: issue.key, reason: issue.reason });
  }
  return config;
}
