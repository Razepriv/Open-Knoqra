import { expo } from '@better-auth/expo';
import type { Database } from '@knoqra/db';
import * as schema from '@knoqra/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { organization, twoFactor } from 'better-auth/plugins';
import type { Env } from '../env';
import { type EmailSender, emailSenderFor } from '../lib/email';
import { safeText } from '../lib/schemas';
import { ensurePersonalWorkspace, initialOrganizationId } from './workspace';

/**
 * Organization-plugin endpoints that stay reachable: the Desk reads and switches the user's own
 * workspace. Everything else is blocked (M0: one personal workspace per user, no invitations,
 * no member or role management over the public auth API).
 */
const ALLOWED_ORG_PATHS = [
  '/organization/set-active',
  '/organization/get-full-organization',
  '/organization/list',
] as const;

const ORGANIZATION_PLUGIN_PATHS = [
  '/organization/accept-invitation',
  '/organization/add-team-member',
  '/organization/cancel-invitation',
  '/organization/check-slug',
  '/organization/create',
  '/organization/create-role',
  '/organization/create-team',
  '/organization/delete',
  '/organization/delete-role',
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/get-full-organization',
  '/organization/get-invitation',
  '/organization/get-organization',
  '/organization/get-role',
  '/organization/has-permission',
  '/organization/invite-member',
  '/organization/leave',
  '/organization/list',
  '/organization/list-invitations',
  '/organization/list-members',
  '/organization/list-roles',
  '/organization/list-team-members',
  '/organization/list-teams',
  '/organization/list-user-invitations',
  '/organization/list-user-teams',
  '/organization/reject-invitation',
  '/organization/remove-member',
  '/organization/remove-team',
  '/organization/remove-team-member',
  '/organization/set-active',
  '/organization/set-active-team',
  '/organization/update',
  '/organization/update-member-role',
  '/organization/update-role',
  '/organization/update-team',
] as const;

const allowedOrgPaths: readonly string[] = ALLOWED_ORG_PATHS;

/** Organization-plugin paths that are blocked. The drift test checks this list against the plugin. */
export const BLOCKED_ORGANIZATION_PATHS: readonly string[] = ORGANIZATION_PLUGIN_PATHS.filter(
  (path) => !allowedOrgPaths.includes(path),
);

/**
 * Core Better Auth paths that are blocked. `/update-user` accepts any `name`: the Desk changes
 * the display name through `PATCH /api/v1/me`, which validates it.
 */
const BLOCKED_USER_PATHS = ['/update-user'] as const;

/** Enforced through Better Auth's `disabledPaths` (answers 404 for any HTTP method). */
export const BLOCKED_AUTH_PATHS: readonly string[] = [
  ...BLOCKED_ORGANIZATION_PATHS,
  ...BLOCKED_USER_PATHS,
];

/** Same rule as `PATCH /api/v1/me`. */
const DisplayName = safeText({ min: 1, max: 120 });

/**
 * Validates a display name Better Auth is about to write, so its endpoints follow the API's text
 * rules: a NUL byte would otherwise reach Postgres (a 500) and a long name would break the `Me`
 * contract. Answers 400 and returns the trimmed name.
 */
function checkedDisplayName(name: unknown): string {
  const parsed = DisplayName.safeParse(name);
  if (!parsed.success) {
    throw new APIError('BAD_REQUEST', {
      message: 'Name must be 1 to 120 characters without control characters',
    });
  }
  return parsed.data;
}

/** Shared with the drift test so production routes stay covered by BLOCKED_ORGANIZATION_PATHS. */
export const ORGANIZATION_OPTIONS = { allowUserToCreateOrganization: false } as const;

/** Custom URL scheme registered by the KNOQRA mobile app (its sign-in origin). */
const MOBILE_APP_ORIGINS = ['knoqra://', 'knoqra://*'] as const;

/**
 * Expo Go and dev-client origins. Development only: `exp://` is a LAN address, so trusting it in a
 * deployed environment would let any local-network page act as a trusted origin. Better Auth
 * matches custom schemes by scheme (and authority when the pattern has one), `**` crosses
 * `/`, and an all-digit wildcard host only admits an IPv4 address.
 */
const EXPO_DEV_ORIGINS = ['exp://', 'exp://**', 'exp://192.168.*.*:*/**'] as const;

const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** True when the configured web origin is a local development address. */
function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTNAMES.includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Origins allowed to call the auth API: the web app, the mobile scheme, and Expo only in local
 * development. The top-level wrangler vars say APP_ENV=development, so a bare `wrangler deploy`
 * would otherwise trust exp://: it also requires BETTER_AUTH_URL to be a localhost address.
 */
export function trustedOriginsFor(env: Pick<Env, 'BETTER_AUTH_URL' | 'APP_ENV'>): string[] {
  const localDev = env.APP_ENV === 'development' && isLocalBaseUrl(env.BETTER_AUTH_URL);
  return [env.BETTER_AUTH_URL, ...MOBILE_APP_ORIGINS, ...(localDev ? EXPO_DEV_ORIGINS : [])];
}

/**
 * The `@better-auth/expo` plugin trusts `exp://` by itself when `process.env.NODE_ENV` is
 * `development`, bypassing `trustedOriginsFor`. That is only acceptable on a local base URL in a
 * non-deployed environment: staging and production, or any non-local `BETTER_AUTH_URL` (a bare
 * `wrangler deploy` ships APP_ENV=development), throw. `createAuth` runs per request, so a
 * misconfigured deploy fails every auth call with a 500 (fail closed) instead of trusting LAN
 * origins.
 */
export function assertSafeAuthConfig(
  env: Pick<Env, 'APP_ENV' | 'BETTER_AUTH_URL'>,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== 'development') return;
  const deployedEnv = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  if (deployedEnv || !isLocalBaseUrl(env.BETTER_AUTH_URL)) {
    throw new Error(
      `Auth misconfiguration: NODE_ENV=development with APP_ENV=${env.APP_ENV} and a non-local BETTER_AUTH_URL (or a deployed APP_ENV) makes @better-auth/expo trust exp:// origins. Build and run deployed environments with NODE_ENV=production.`,
    );
  }
}

export interface AuthDeps {
  email?: EmailSender;
  /**
   * Runs a promise after the response (the request's `executionCtx.waitUntil`). Reset mail goes
   * through it so the response time does not reveal whether the address has an account.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Better Auth for one request. Built per request because Worker bindings (secret, base URL,
 * database handle) are only available per request.
 */
export function createAuth(env: Env, db: Database, deps: AuthDeps = {}) {
  assertSafeAuthConfig(env, globalThis.process?.env?.NODE_ENV);
  const email = deps.email ?? emailSenderFor(env);
  const deployed = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
  return betterAuth({
    appName: 'KNOQRA',
    basePath: '/api/auth',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // First-party cookies: the web app proxies /api/* on its own origin.
    trustedOrigins: trustedOriginsFor(env),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        organization: schema.organization,
        member: schema.member,
        invitation: schema.invitation,
        twoFactor: schema.twoFactor,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // The mobile app mirrors this minimum in its sign-up form; change both together.
      minPasswordLength: 12,
      // A reset usually follows a lost or stolen password: sign out every other session with it.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await email.send(
          user.email,
          'Reset your KNOQRA password',
          `Someone asked to reset the password for this account. To choose a new one, open:\n\n${url}\n\nIf it was not you, ignore this email.`,
        );
      },
    },
    plugins: [
      // M0: one personal workspace per user, created server-side by the hooks below (direct
      // Drizzle inserts, which this option does not gate). Users cannot create more.
      organization({ ...ORGANIZATION_OPTIONS }),
      twoFactor({ issuer: 'KNOQRA' }),
      // Mobile sign-in: lets the Expo client send its app origin. Adds no organization paths.
      expo(),
    ],
    // The hooks query `db` directly. That is safe only while the Drizzle adapter runs without
    // real transactions (its default): with `transaction: true`, a hook running inside Better
    // Auth's transaction would wait forever for the request's single pooled connection.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({ data: { ...user, name: checkedDisplayName(user.name) } }),
          after: async (user) => {
            await ensurePersonalWorkspace(db, user);
          },
        },
        update: {
          // Only a write that sets the name is checked; other user updates pass through.
          before: async (user) =>
            user.name === undefined
              ? { data: user }
              : { data: { ...user, name: checkedDisplayName(user.name) } },
        },
      },
      session: {
        create: {
          // Also repairs a user left without any membership: the next sign-in recreates the
          // personal workspace instead of failing every request with no_active_org.
          before: async (newSession) => {
            const activeOrganizationId = await initialOrganizationId(db, newSession.userId);
            return { data: { ...newSession, activeOrganizationId } };
          },
        },
      },
    },
    // In-memory limiter: per isolate only. Off in dev and test so suites can sign up freely. Kept
    // as defence in depth: the durable limit is the RL_AUTH Rate Limiting binding (lib/rate-limit.ts).
    rateLimit: { enabled: deployed },
    disabledPaths: [...BLOCKED_AUTH_PATHS],
    advanced: {
      // Cloudflare overwrites cf-connecting-ip, so clients cannot spoof it; x-forwarded-for they
      // can, which would let them dodge the per-IP rate limits.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      ...(deps.waitUntil ? { backgroundTasks: { handler: deps.waitUntil } } : {}),
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
