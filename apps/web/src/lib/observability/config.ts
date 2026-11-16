/**
 * The Desk's optional Sentry and PostHog settings, from the `VITE_*` build-time env.
 * The rules and reason strings mirror the Worker's apps/api/src/observability/config.ts
 * (the web cannot import from apps/api). A missing or invalid key turns that integration off;
 * an issue names the key, never its value.
 */

export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export type WebEnv = Record<string, string | boolean | undefined>;

export interface ConfigIssue {
  key: string;
  reason: string;
}

export interface WebObservabilityConfig {
  sentry: {
    dsn: string;
    release: string | null;
    environment: string;
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

/** The raw string value of a key; Vite's own flags (DEV, PROD, SSR) are booleans. */
function raw(env: WebEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' ? value : undefined;
}

/** A trimmed, non-empty value, or undefined. */
function text(env: WebEnv, key: string): string | undefined {
  return raw(env, key)?.trim() || undefined;
}

function parseSampleRate(value: string | undefined): { rate: number; issue?: ConfigIssue } {
  if (value === undefined) return { rate: DEFAULT_TRACES_SAMPLE_RATE };
  const rate = value.trim() === '' ? Number.NaN : Number(value);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 1) return { rate };
  return {
    rate: DEFAULT_TRACES_SAMPLE_RATE,
    issue: { key: 'VITE_SENTRY_TRACES_SAMPLE_RATE', reason: 'must be a number between 0 and 1' },
  };
}

function readSentry(env: WebEnv): Pick<WebObservabilityConfig, 'sentry' | 'issues'> {
  const dsn = text(env, 'VITE_SENTRY_DSN');
  if (!dsn) return { sentry: null, issues: [] };
  if (!isValidSentryDsn(dsn)) {
    return { sentry: null, issues: [{ key: 'VITE_SENTRY_DSN', reason: 'not a valid DSN' }] };
  }
  const { rate, issue } = parseSampleRate(raw(env, 'VITE_SENTRY_TRACES_SAMPLE_RATE'));
  return {
    sentry: {
      dsn,
      release: text(env, 'VITE_SENTRY_RELEASE') ?? null,
      environment: text(env, 'VITE_SENTRY_ENVIRONMENT') ?? text(env, 'MODE') ?? 'production',
      tracesSampleRate: rate,
    },
    issues: issue ? [issue] : [],
  };
}

function readPosthog(env: WebEnv): Pick<WebObservabilityConfig, 'posthog' | 'issues'> {
  const key = text(env, 'VITE_POSTHOG_KEY');
  if (!key) return { posthog: null, issues: [] };
  const host = text(env, 'VITE_POSTHOG_HOST') ?? DEFAULT_POSTHOG_HOST;
  if (!isHttpsUrl(host)) {
    return {
      posthog: null,
      issues: [{ key: 'VITE_POSTHOG_HOST', reason: 'must be an https URL' }],
    };
  }
  return { posthog: { key, host }, issues: [] };
}

/** Reads the Desk's observability settings. Pure: the caller passes the env. */
export function readWebObservabilityConfig(env: WebEnv): WebObservabilityConfig {
  const sentry = readSentry(env);
  const posthog = readPosthog(env);
  return {
    sentry: sentry.sentry,
    posthog: posthog.posthog,
    issues: [...sentry.issues, ...posthog.issues],
  };
}

/**
 * Read once from the build. Invalid keys are not logged here (the Desk has no logger); they are
 * shown by name on the System status page.
 */
export const webObservability: WebObservabilityConfig = readWebObservabilityConfig(import.meta.env);
