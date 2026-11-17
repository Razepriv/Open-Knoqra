import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { auditEvent, type Tx, withTenant } from '@knoqra/db';
import { checkAiApiKey, DEFAULT_AI_MODEL } from '@knoqra/providers';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { canManage } from '../lib/roles';
import { isValidMasterKey } from '../lib/secret-envelope';
import { OTTO_MODES, ottoConnectionSummary, resolveOttoAccess } from '../otto/access';
import {
  authorizeUrl,
  chatgptSignInConfig,
  exchangeCode,
  PLAN_USAGE_SCOPE,
  pkceChallenge,
  randomToken,
} from '../otto/chatgpt';
import { deleteOttoCredential, saveOttoCredential } from '../otto/connection';
import { requestsToday } from './otto';

const FORBIDDEN = 'Only owners and admins can connect Otto.';
const NOT_CONFIGURED = 'Saved keys are not set up on this server.';
export const CHATGPT_CALLBACK_PATH = '/api/v1/otto/connection/chatgpt/callback';
const CHATGPT_COOKIE = 'knoqra_otto_chatgpt';
const CHATGPT_COOKIE_PATH = '/api/v1/otto/connection/chatgpt';
const CHATGPT_MAX_AGE_SECONDS = 600;
const MAX_PARAM_LENGTH = 2048;

export const OttoConnectionSchema = z
  .object({
    mode: z.enum(OTTO_MODES).openapi({
      description:
        'Where answers come from: own_key (the workspace OpenAI key), chatgpt (its ChatGPT plan), included (the plan includes Otto), instance (the server key), demo (no model: sample drafts), connect (nothing yet), upgrade (the plan does not include Otto).',
    }),
    connection: z
      .object({
        kind: z.enum(['api_key', 'chatgpt']),
        last4: z.string().nullable(),
        model: z.string(),
        updatedAt: z.iso.datetime(),
      })
      .nullable(),
    plan: z.string().nullable(),
    upgradePath: z.string().nullable(),
    dailyLimit: z.number().int().nullable(),
    usedToday: z.number().int(),
    canManage: z.boolean(),
    chatgptSignIn: z
      .boolean()
      .openapi({ description: 'Whether "Sign in with ChatGPT" is offered.' }),
    earlyAccess: z.boolean().openapi({
      description:
        "Whether Otto answers with the plan's early-access model (shown as Early access).",
    }),
  })
  .openapi('OttoConnection');

const SaveKeyBody = z
  .object({
    apiKey: z.string().trim().min(20).max(512).regex(/^\S+$/, 'The key has no spaces'),
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
      .optional(),
  })
  .openapi('SaveOttoKey');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/otto/connection',
  tags: ['otto'],
  summary: "How Otto reaches a model for this workspace, and today's use",
  security,
  responses: {
    200: { description: 'The connection status', content: json(okEnvelope(OttoConnectionSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const putKeyRoute = createRoute({
  method: 'put',
  path: '/api/v1/otto/connection/key',
  tags: ['otto'],
  summary: "Connect Otto with the workspace's own OpenAI API key. The key is never shown again.",
  security,
  request: { body: { required: true, content: json(SaveKeyBody) } },
  responses: {
    200: { description: 'Connected', content: json(okEnvelope(OttoConnectionSchema)) },
    400: errorResponse('Body failed validation, or OpenAI refused the key'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can connect Otto'),
    409: errorResponse('No active organization'),
    503: errorResponse('OpenAI could not be reached, or keys cannot be stored on this server'),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/api/v1/otto/connection',
  tags: ['otto'],
  summary: "Disconnect the workspace's own key or ChatGPT sign-in",
  security,
  responses: {
    200: { description: 'Disconnected', content: json(okEnvelope(OttoConnectionSchema)) },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can connect Otto'),
    409: errorResponse('No active organization'),
  },
});

const chatgptStartRoute = createRoute({
  method: 'post',
  path: '/api/v1/otto/connection/chatgpt',
  tags: ['otto'],
  summary: 'Start "Sign in with ChatGPT": the Desk opens the returned URL',
  security,
  responses: {
    200: {
      description: 'Where to send the browser',
      content: json(okEnvelope(z.object({ url: z.url() }).openapi('OttoChatGptStart'))),
    },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can connect Otto'),
    404: errorResponse('ChatGPT sign-in is not offered here'),
    409: errorResponse('No active organization'),
    503: errorResponse('Keys cannot be stored on this server'),
  },
});

function audit(tx: Tx, tenant: Tenant, action: string, metadata: Record<string, unknown>) {
  // Never a key, a token or ciphertext in `metadata`.
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'otto_connection',
    action,
    outcome: 'allowed',
    entityId: null,
    metadata,
  });
}

/** The Settings status, read in the workspace's tenant transaction. */
async function statusOf(
  tx: Tx,
  env: Env,
  tenant: Tenant,
): Promise<z.infer<typeof OttoConnectionSchema>> {
  const access = await resolveOttoAccess(tx, env, { open: false });
  const stored = await ottoConnectionSummary(tx);
  return {
    mode: access.mode,
    connection: stored
      ? {
          kind: stored.kind,
          last4: stored.last4,
          model: stored.model ?? DEFAULT_AI_MODEL,
          updatedAt: stored.updatedAt.toISOString(),
        }
      : null,
    plan: access.plan,
    upgradePath: access.ready ? null : access.upgradePath,
    dailyLimit: access.ready ? access.dailyLimit : null,
    usedToday: await requestsToday(tx),
    canManage: canManage(tenant.role),
    chatgptSignIn: chatgptSignInConfig(env) !== null,
    earlyAccess: access.ready ? access.earlyAccess : false,
  };
}

/** The public web origin (BETTER_AUTH_URL), which forwards /api/* to this Worker. */
const webOrigin = (env: Env) => new URL(env.BETTER_AUTH_URL).origin;

export function ottoConnectionRoutes(deps: { fetch?: typeof fetch } = {}) {
  const doFetch: typeof fetch = deps.fetch ?? ((...args) => fetch(...args));
  return new OpenAPIHono<AppEnv>()
    .openapi(getRoute, async (c) => {
      const { db, tenant } = c.var;
      c.header('Cache-Control', 'no-store');
      return ok(c, await withTenant(db, tenant.orgId, (tx) => statusOf(tx, c.env, tenant)), 200);
    })
    .openapi(putKeyRoute, async (c) => {
      const { db, tenant } = c.var;
      if (!canManage(tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      const masterKey = c.env.CREDENTIALS_MASTER_KEY;
      if (!isValidMasterKey(masterKey)) return fail(c, 503, 'not_configured', NOT_CONFIGURED);
      const body = c.req.valid('json');
      const check = await checkAiApiKey(body.apiKey, { fetch: doFetch });
      if (check === 'invalid') {
        return fail(
          c,
          400,
          'invalid_api_key',
          'OpenAI did not accept this key. Check it and try again.',
        );
      }
      if (check === 'unreachable') {
        return fail(
          c,
          503,
          'ai_unavailable',
          'We could not reach OpenAI to check the key. Try again.',
        );
      }
      const status = await withTenant(db, tenant.orgId, async (tx) => {
        const row = await saveOttoCredential(tx, {
          orgId: tenant.orgId,
          userId: tenant.userId,
          masterKeyBase64: masterKey,
          kind: 'api_key',
          secret: body.apiKey,
          model: body.model ?? null,
          expiresAt: null,
        });
        await audit(tx, tenant, 'otto.connection.update', {
          kind: 'api_key',
          last4: row.secretLast4,
        });
        return statusOf(tx, c.env, tenant);
      });
      return ok(c, status, 200);
    })
    .openapi(deleteRoute, async (c) => {
      const { db, tenant } = c.var;
      if (!canManage(tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      const status = await withTenant(db, tenant.orgId, async (tx) => {
        if (await deleteOttoCredential(tx)) await audit(tx, tenant, 'otto.connection.delete', {});
        return statusOf(tx, c.env, tenant);
      });
      return ok(c, status, 200);
    })
    .openapi(chatgptStartRoute, async (c) => {
      const config = chatgptSignInConfig(c.env);
      if (!config) return fail(c, 404, 'not_found', 'ChatGPT sign-in is not offered here.');
      if (!canManage(c.var.tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      if (!isValidMasterKey(c.env.CREDENTIALS_MASTER_KEY)) {
        return fail(c, 503, 'not_configured', NOT_CONFIGURED);
      }
      const state = randomToken();
      const verifier = randomToken();
      setCookie(c, CHATGPT_COOKIE, `${state}.${verifier}`, {
        path: CHATGPT_COOKIE_PATH,
        httpOnly: true,
        secure: new URL(c.env.BETTER_AUTH_URL).protocol === 'https:',
        sameSite: 'Lax',
        maxAge: CHATGPT_MAX_AGE_SECONDS,
      });
      const url = authorizeUrl(config, {
        redirectUri: `${webOrigin(c.env)}${CHATGPT_CALLBACK_PATH}`,
        state,
        nonce: randomToken(),
        challenge: await pkceChallenge(verifier),
      });
      return ok(c, { url }, 200);
    })
    .get(CHATGPT_CALLBACK_PATH, async (c) => {
      // OpenAI sends the browser back here. Every outcome returns to Settings → Otto.
      const back = (result: 'connected' | 'cancelled' | 'failed') =>
        c.redirect(`${webOrigin(c.env)}/settings?otto=${result}#otto`, 302);
      const config = chatgptSignInConfig(c.env);
      if (!config)
        return c.json({ data: null, error: { code: 'not_found', message: 'Not found' } }, 404);
      const { db, tenant } = c.var;
      const cookie = getCookie(c, CHATGPT_COOKIE) ?? '';
      deleteCookie(c, CHATGPT_COOKIE, { path: CHATGPT_COOKIE_PATH });
      const [expected, verifier] = cookie.split('.');
      const state = c.req.query('state') ?? '';
      const code = c.req.query('code') ?? '';
      const masterKey = c.env.CREDENTIALS_MASTER_KEY;
      if (!expected || !verifier || state.length > MAX_PARAM_LENGTH || !sameText(state, expected)) {
        return back('failed');
      }
      if (c.req.query('error') || !code || code.length > MAX_PARAM_LENGTH) return back('cancelled');
      if (!canManage(tenant.role) || !isValidMasterKey(masterKey)) return back('failed');
      const tokens = await exchangeCode(doFetch, config, {
        code,
        verifier,
        redirectUri: `${webOrigin(c.env)}${CHATGPT_CALLBACK_PATH}`,
      });
      if (!tokens?.scopes.includes(PLAN_USAGE_SCOPE)) {
        logger.warn('otto.chatgpt_signin_failed', { reason: tokens ? 'scope' : 'exchange' });
        return back('failed');
      }
      await withTenant(db, tenant.orgId, async (tx) => {
        await saveOttoCredential(tx, {
          orgId: tenant.orgId,
          userId: tenant.userId,
          masterKeyBase64: masterKey,
          kind: 'chatgpt',
          secret: JSON.stringify({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          }),
          model: null,
          expiresAt: tokens.expiresAt,
        });
        await audit(tx, tenant, 'otto.connection.update', { kind: 'chatgpt' });
      });
      return back('connected');
    });
}

/** Compares two strings in time that depends on their length only. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
