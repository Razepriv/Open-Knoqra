/**
 * Source map upload settings for `vite build`. Only the deploy job sets all three keys; locally
 * this is null, so there are no maps, no Sentry plugin and no upload. Read from the Node env
 * (never `VITE_*`), so the auth token can never reach the bundle.
 */
export interface SentryUploadConfig {
  org: string;
  project: string;
  authToken: string;
  /** The same release name the Desk reports at runtime (`VITE_SENTRY_RELEASE`). */
  release?: string;
}

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

export function sentryUploadConfig(env: NodeJS.ProcessEnv): SentryUploadConfig | null {
  const authToken = value(env, 'SENTRY_AUTH_TOKEN');
  const org = value(env, 'SENTRY_ORG');
  const project = value(env, 'SENTRY_PROJECT');
  if (!authToken || !org || !project) return null;
  const release = value(env, 'VITE_SENTRY_RELEASE');
  return { org, project, authToken, ...(release ? { release } : {}) };
}
