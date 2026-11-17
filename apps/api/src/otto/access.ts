import { type AiCredentialRow, aiCredential, type Tx } from '@knoqra/db';
import { type AiConnection, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from '@knoqra/providers';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { isValidMasterKey, SecretEnvelopeError } from '../lib/secret-envelope';
import { chatgptSignInConfig, needsRefresh, refreshTokens } from './chatgpt';
import {
  type ChatGptTokens,
  loadOttoCredential,
  openOttoSecret,
  saveOttoCredential,
} from './connection';
import { aiConnectionFor } from './provider';

/** Requests a workspace may make per UTC day on the instance's own model (or the mock). */
export const OTTO_DAILY_LIMIT = 50;
/**
 * Requests per UTC day on a workspace's own key or ChatGPT plan. The workspace pays OpenAI itself,
 * so this only stops runaway use; OpenAI's own limits apply as well.
 */
export const OWN_CONNECTION_DAILY_LIMIT = 500;

/**
 * What an edition decides for a workspace that has not connected its own model (the `ottoPlan`
 * extension slot): Otto is included with the edition's model, or the workspace must upgrade or
 * connect its own. `upgradePath` is a Desk path, for example `/settings#billing`.
 */
export type OttoPlanAccess =
  | {
      kind: 'included';
      plan: string;
      connection: AiConnection;
      dailyLimit: number;
      /** Shown as "Early access" in the Desk, with "busy" answers instead of errors. */
      earlyAccess?: boolean;
    }
  | { kind: 'upgrade'; plan: string | null; upgradePath: string };

/** Where the workspace's Otto answers come from. */
export const OTTO_MODES = [
  'own_key',
  'chatgpt',
  'included',
  'instance',
  'demo',
  'connect',
  'upgrade',
] as const;
export type OttoMode = (typeof OTTO_MODES)[number];

export type OttoAccess =
  | {
      ready: true;
      mode: Exclude<OttoMode, 'connect' | 'upgrade'>;
      /** Stored on drafts and usage rows: `openai`, `chatgpt`, `platform` or `mock`. */
      providerName: string;
      connection: AiConnection;
      dailyLimit: number;
      plan: string | null;
      /** The edition's included model is an early-access one (Cloud: a free model). */
      earlyAccess: boolean;
    }
  | { ready: false; mode: 'connect' | 'upgrade'; plan: string | null; upgradePath: string | null };

type AccessEnv = Env;

const connect = (plan: string | null = null): OttoAccess => ({
  ready: false,
  mode: 'connect',
  plan,
  upgradePath: null,
});

/** The workspace's own connection, opened, or null when it cannot be used. */
async function ownConnection(
  tx: Tx,
  env: AccessEnv,
  row: AiCredentialRow,
  deps: { fetch?: typeof fetch; now?: Date },
): Promise<AiConnection | null> {
  const masterKey = env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKey)) return null;
  let secret: string;
  try {
    secret = await openOttoSecret(row, masterKey);
  } catch (error) {
    if (!(error instanceof SecretEnvelopeError)) throw error;
    logger.warn('otto.credential_unreadable', { reason: error.code });
    return null;
  }
  const model = row.model ?? DEFAULT_AI_MODEL;
  if (row.kind === 'api_key') {
    return { kind: 'api_key', apiKey: secret, baseUrl: DEFAULT_AI_BASE_URL, model };
  }
  const config = chatgptSignInConfig(env);
  if (!config) return null;
  let tokens = JSON.parse(secret) as ChatGptTokens;
  const now = deps.now ?? new Date();
  if (needsRefresh(row.expiresAt, now)) {
    const fresh = tokens.refreshToken
      ? await refreshTokens(deps.fetch ?? fetch, config, tokens.refreshToken, now)
      : null;
    if (!fresh) {
      logger.warn('otto.chatgpt_refresh_failed', {});
      return null;
    }
    tokens = {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? tokens.refreshToken,
    };
    await saveOttoCredential(tx, {
      orgId: row.organizationId,
      userId: row.createdBy ?? '',
      masterKeyBase64: masterKey,
      kind: 'chatgpt',
      secret: JSON.stringify(tokens),
      model: row.model,
      expiresAt: fresh.expiresAt,
    });
  }
  return { kind: 'chatgpt', accessToken: tokens.accessToken, model };
}

/** The edition's answer for a workspace without its own connection, if any edition gives one. */
async function planAccess(tx: Tx, env: AccessEnv): Promise<OttoPlanAccess | undefined> {
  for (const extension of env.EXTENSIONS ?? []) {
    if (!extension.ottoPlan) continue;
    const answer = await extension.ottoPlan(tx, env);
    if (answer) return answer;
  }
  return undefined;
}

/**
 * Where Otto's answers come from for the workspace whose tenant transaction `tx` is, in order:
 * 1. the workspace's own connection (an OpenAI key, or a ChatGPT sign-in while the flag is on);
 * 2. the edition's plan (KNOQRA Cloud includes Otto on Pro and Max, and asks Starter to upgrade);
 * 3. the instance's `AI_PROVIDER` (a self-hosted server's own key, or the mock);
 * otherwise the workspace must connect its own.
 *
 * With `open: false` (the Settings status) a stored connection is reported without being opened.
 */
export async function resolveOttoAccess(
  tx: Tx,
  env: AccessEnv,
  opts: { open?: boolean; fetch?: typeof fetch; now?: Date } = {},
): Promise<OttoAccess> {
  const row = await loadOttoCredential(tx);
  if (row && (row.kind === 'api_key' || chatgptSignInConfig(env))) {
    const mode = row.kind === 'api_key' ? 'own_key' : 'chatgpt';
    const base = {
      ready: true,
      mode,
      dailyLimit: OWN_CONNECTION_DAILY_LIMIT,
      plan: null,
      earlyAccess: false,
    } as const;
    const providerName = row.kind === 'api_key' ? 'openai' : 'chatgpt';
    if (opts.open === false) {
      return { ...base, providerName, connection: { kind: 'mock' } };
    }
    const connection = await ownConnection(tx, env, row, opts);
    if (connection) return { ...base, providerName, connection };
    return connect();
  }
  const plan = await planAccess(tx, env);
  if (plan?.kind === 'included') {
    return {
      ready: true,
      mode: 'included',
      providerName: 'platform',
      connection: plan.connection,
      dailyLimit: plan.dailyLimit,
      plan: plan.plan,
      earlyAccess: plan.earlyAccess ?? false,
    };
  }
  if (plan?.kind === 'upgrade') {
    return { ready: false, mode: 'upgrade', plan: plan.plan, upgradePath: plan.upgradePath };
  }
  const instance = aiConnectionFor(env);
  if (!instance) return connect();
  return {
    ready: true,
    mode: instance.name === 'mock' ? 'demo' : 'instance',
    providerName: instance.name,
    connection: instance.connection,
    dailyLimit: OTTO_DAILY_LIMIT,
    plan: null,
    earlyAccess: false,
  };
}

/** The stored connection's public details for Settings: never the secret. */
export async function ottoConnectionSummary(tx: Tx) {
  const [row] = await tx
    .select({
      kind: aiCredential.kind,
      last4: aiCredential.secretLast4,
      model: aiCredential.model,
      updatedAt: aiCredential.updatedAt,
    })
    .from(aiCredential)
    .limit(1);
  return row ?? null;
}
