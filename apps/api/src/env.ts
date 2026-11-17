// Type-only: the classes import `cloudflare:workers`, which app.ts (loaded by Node scripts) must not.
import type { OrgRealtime } from './do/org-realtime';
import type { UserCallLock } from './do/user-call-lock';
import type { ApiExtension } from './extensions';

export type AppEnvironment = 'development' | 'test' | 'staging' | 'production';

/** Worker bindings (wrangler.jsonc vars, secrets, Hyperdrive, queue and Durable Object bindings). */
export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** Optional override of the Hyperdrive connection (local dev, tests). Always the app role. */
  DATABASE_URL?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** Staging and development only. Absent (or APP_ENV=production) means `/webhooks/fake` is a 404. */
  FAKE_WEBHOOK_SECRET?: string;
  /** Staging and production secret: Resend API key. Without it (and EMAIL_FROM) no mail is sent. */
  RESEND_API_KEY?: string;
  /** Sender address for outgoing mail, for example `KNOQRA <no-reply@example.com>`. */
  EMAIL_FROM?: string;
  /** Optional reply-to address for outgoing mail, for example a support inbox. */
  EMAIL_REPLY_TO?: string;
  /**
   * The sender's postal address, one line, shown in every email footer. Marketing mail (the
   * newsletter) is not sent without it (CAN-SPAM).
   */
  EMAIL_POSTAL_ADDRESS?: string;
  /**
   * Optional RSS 2.0 feed whose three newest posts appear in the welcome email, for example
   * `https://example.com/rss.xml`. Unset: no blog section.
   */
  BLOG_FEED_URL?: string;
  /**
   * The instance's own model for Otto (otto/provider.ts), used by workspaces that have not
   * connected their own OpenAI key in Settings: `openai` is an OpenAI-compatible API with
   * AI_API_KEY, `mock` the deterministic mock, `none` no instance model (each workspace connects
   * its own). Unset means the mock in development and tests and `none` elsewhere. `chatgpt` (an
   * older value) means `none`: ChatGPT sign-in is per workspace (OTTO_CHATGPT_SIGNIN). Anything
   * else is not configured.
   */
  AI_PROVIDER?: string;
  /** Secret: the API key for `AI_PROVIDER=openai`. */
  AI_API_KEY?: string;
  /** Optional model name for `AI_PROVIDER=openai` (default in @knoqra/providers). */
  AI_MODEL?: string;
  /** Optional OpenAI-compatible base URL, for example `https://api.example.com/v1` (default OpenAI). */
  AI_BASE_URL?: string;
  /**
   * Feature flag: `on` offers "Sign in with ChatGPT" in Settings → Otto, so a workspace can use
   * its own ChatGPT plan. OpenAI gives the client id to approved partners only (otto/chatgpt.ts);
   * without OPENAI_SIWC_CLIENT_ID the flag does nothing.
   */
  OTTO_CHATGPT_SIGNIN?: string;
  /** Var: the OAuth client id OpenAI issued for "Sign in with ChatGPT" (`oaiapp_...`). Public. */
  OPENAI_SIWC_CLIENT_ID?: string;
  /** Secret, optional: the client secret, if OpenAI issued one with the client id. */
  OPENAI_SIWC_CLIENT_SECRET?: string;
  /**
   * Retired: live sending now follows each workspace's own registration status, read from its
   * provider (US texting registration for SMS, Meta's approval for WhatsApp). Ignored if set.
   */
  SMS_10DLC_APPROVED?: string;
  /** Retired, like SMS_10DLC_APPROVED: WhatsApp approval is read per workspace. Ignored if set. */
  WHATSAPP_META_APPROVED?: string;
  /**
   * R2 bucket for message attachments (WhatsApp images, voice notes, files). Optional: without it
   * uploads answer 503 and inbound files show as unavailable.
   */
  MEDIA?: R2Bucket;
  /** Base64 Ed25519 public key for verifying Telnyx webhooks. Absent means `/webhooks/telnyx` is a 404. */
  TELNYX_PUBLIC_KEY?: string;
  /**
   * Whether real providers run calls. `connectors` (or `telnyx`, its older name) uses each
   * workspace's connected provider; `fake` or unset uses the fake provider outside production.
   */
  PROVIDER?: 'fake' | 'telnyx' | 'connectors';
  /**
   * Comma list of the providers a workspace may connect (`telnyx`, `plivo`). Unset: `telnyx` in
   * production, every provider elsewhere. It gates connecting only: a stored connection keeps working.
   */
  CONNECTORS?: string;
  /**
   * The API Worker's public origin, for example `https://api.example.com`. Used to show each
   * connection's webhook URLs; unset, the Desk shows the paths only.
   */
  API_PUBLIC_ORIGIN?: string;
  /** Worker secret: base64 of 32 random bytes. Wraps per-secret data keys. Absent means the Telnyx connection API answers 503. */
  CREDENTIALS_MASTER_KEY?: string;
  /** Sentry DSN (https, with public key and numeric project id). Absent or invalid: Sentry is off. */
  SENTRY_DSN?: string;
  /** Release identifier attached to Sentry events, for example a git SHA. */
  SENTRY_RELEASE?: string;
  /** Trace sampling rate in [0, 1]. Default 0.05; anything else falls back to it. */
  SENTRY_TRACES_SAMPLE_RATE?: string;
  /** PostHog project key. Absent: server-side analytics is off. */
  POSTHOG_KEY?: string;
  /** PostHog ingestion host (https). Default `https://us.i.posthog.com`. */
  POSTHOG_HOST?: string;
  PROVIDER_EVENTS: Queue<{ rawEventId: string }>;
  /** One realtime fan-out object per organization, keyed `idFromName(orgId)`. */
  ORG_REALTIME: DurableObjectNamespace<OrgRealtime>;
  /** One active-call lock per user, keyed `idFromName(userId)`. */
  USER_CALL_LOCK: DurableObjectNamespace<UserCallLock>;
  /**
   * Workers Rate Limiting bindings (lib/rate-limit.ts). Declared only in the staging and production
   * env blocks of wrangler.jsonc, so local dev and tests run without them (no limit).
   */
  RL_AUTH?: RateLimit;
  RL_DIAL?: RateLimit;
  RL_VOICE_TOKEN?: RateLimit;
  RL_MESSAGE_SEND?: RateLimit;
  APP_ENV: AppEnvironment;
  /**
   * `cloud` for KNOQRA's hosted service and local development (no license check) or `selfhost`
   * (license check on). Unset or anything else means `selfhost`. See docs/licensing.md.
   */
  KNOQRA_EDITION?: string;
  /** Self-host, optional: the license key, instead of entering it in the Desk. */
  KNOQRA_LICENSE_KEY?: string;
  /**
   * Not a binding: the extensions this Worker was built with (extensions.ts), attached by
   * `createWorker` and `createApp` so routes, queue handlers and cron jobs reach the same hooks.
   */
  EXTENSIONS?: readonly ApiExtension[];
}

/**
 * The runtime Postgres connection string. It must point at the non-superuser `knoqra_app` role:
 * superusers and BYPASSRLS roles ignore row-level security.
 */
export function connectionString(env: Env): string {
  return env.DATABASE_URL ?? env.HYPERDRIVE.connectionString;
}
