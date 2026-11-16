/// <reference types="vite/client" />

/** Build-time settings for the Desk. All optional: a missing key turns that integration off. */
interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
  /** Self-host builds: where "Get a license key" points. Default: KNOQRA's cloud issuer. */
  readonly VITE_LICENSE_ISSUER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
