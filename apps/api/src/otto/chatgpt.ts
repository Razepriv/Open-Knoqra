import { base64UrlEncode } from '@knoqra/core';
import type { Env } from '../env';

/**
 * "Sign in with ChatGPT" (SIWC) for Otto: a workspace authorizes KNOQRA to use its own ChatGPT
 * plan, and Otto calls OpenAI's Responses API with the access token.
 *
 * Status on 2026-11-17: OpenAI issues SIWC client ids to "a select group of commercial partners"
 * only, with a waitlist (https://developers.openai.com/siwc/request-client-id). The flow below
 * follows OpenAI's published parameters (authorization code with PKCE S256, the plan usage scopes
 * and the `resource`, https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and
 * stays off until the owner has an approved client id (`OPENAI_SIWC_CLIENT_ID`) and turns on
 * `OTTO_CHATGPT_SIGNIN`. The identity claims are not used (KNOQRA's own session says who the user
 * is), so the ID token is not kept.
 */

export const SIWC_ISSUER = 'https://auth.openai.com';
/** Identity plus ChatGPT plan usage. */
export const SIWC_SCOPES =
  'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** The scope that lets the token spend the user's plan; without it the sign-in is useless here. */
export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';
export const SIWC_RESOURCE = 'https://api.openai.com/v1';
/** Access tokens last an hour; refresh this long before they expire. */
const REFRESH_EARLY_MS = 60_000;

export interface SiwcConfig {
  clientId: string;
  clientSecret: string | null;
}

/** The sign-in's settings, or null while the flag is off or no client id is set. */
export function chatgptSignInConfig(
  env: Pick<Env, 'OTTO_CHATGPT_SIGNIN' | 'OPENAI_SIWC_CLIENT_ID' | 'OPENAI_SIWC_CLIENT_SECRET'>,
): SiwcConfig | null {
  if (env.OTTO_CHATGPT_SIGNIN?.trim().toLowerCase() !== 'on') return null;
  const clientId = env.OPENAI_SIWC_CLIENT_ID?.trim();
  if (!clientId) return null;
  return { clientId, clientSecret: env.OPENAI_SIWC_CLIENT_SECRET?.trim() || null };
}

export const randomToken = (): string =>
  base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

/** The PKCE S256 challenge of `verifier`: base64url of its SHA-256, without padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function authorizeUrl(
  config: SiwcConfig,
  attempt: { redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const url = new URL(`${SIWC_ISSUER}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: attempt.redirectUri,
    scope: SIWC_SCOPES,
    resource: SIWC_RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: 'S256',
    code_challenge: attempt.challenge,
  }).toString();
  return url.toString();
}

export interface ChatGptTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** Posts a grant to the token endpoint. Null for any refusal: the caller asks to sign in again. */
async function tokenRequest(
  doFetch: typeof fetch,
  config: SiwcConfig,
  grant: Record<string, string>,
  now: Date,
): Promise<ChatGptTokenSet | null> {
  const body = new URLSearchParams({
    ...grant,
    client_id: config.clientId,
    resource: SIWC_RESOURCE,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
  });
  let response: Response;
  try {
    response = await doFetch(`${SIWC_ISSUER}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (typeof json.access_token !== 'string' || json.access_token === '') return null;
  const seconds = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    expiresAt: new Date(now.getTime() + seconds * 1000),
    scopes: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : [],
  };
}

export function exchangeCode(
  doFetch: typeof fetch,
  config: SiwcConfig,
  input: { code: string; verifier: string; redirectUri: string },
  now = new Date(),
): Promise<ChatGptTokenSet | null> {
  return tokenRequest(
    doFetch,
    config,
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
    now,
  );
}

/** A fresh token set. Refresh tokens rotate: store the new one. */
export function refreshTokens(
  doFetch: typeof fetch,
  config: SiwcConfig,
  refreshToken: string,
  now = new Date(),
): Promise<ChatGptTokenSet | null> {
  return tokenRequest(
    doFetch,
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    now,
  );
}

export const needsRefresh = (expiresAt: Date | null, now = new Date()): boolean =>
  expiresAt !== null && expiresAt.getTime() - REFRESH_EARLY_MS <= now.getTime();
