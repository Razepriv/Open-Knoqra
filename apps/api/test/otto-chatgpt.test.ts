import { env } from 'cloudflare:workers';
import { withTenant } from '@knoqra/db';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { resolveOttoAccess } from '../src/otto/access';
import {
  authorizeUrl,
  chatgptSignInConfig,
  exchangeCode,
  needsRefresh,
  pkceChallenge,
  refreshTokens,
} from '../src/otto/chatgpt';
import { loadOttoCredential, openOttoSecret, saveOttoCredential } from '../src/otto/connection';
import { get, signUp, uniqueEmail, withAppDb } from './helpers';

const FLAG_ON = { OTTO_CHATGPT_SIGNIN: 'on', OPENAI_SIWC_CLIENT_ID: 'oaiapp_test' };
const config = { clientId: 'oaiapp_test', clientSecret: null };

function tokenEndpoint(answer: Response) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    return answer.clone();
  }) as unknown as typeof fetch;
  return { calls, fakeFetch };
}

describe('Sign in with ChatGPT settings', () => {
  it('stays off without the flag or the client id', () => {
    expect(chatgptSignInConfig({})).toBeNull();
    expect(chatgptSignInConfig({ OTTO_CHATGPT_SIGNIN: 'on' })).toBeNull();
    expect(chatgptSignInConfig({ OPENAI_SIWC_CLIENT_ID: 'oaiapp_test' })).toBeNull();
    expect(chatgptSignInConfig(FLAG_ON)).toEqual(config);
  });

  it('asks for plan usage with PKCE S256 and the API resource', async () => {
    // RFC 7636 appendix B.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    const url = new URL(
      authorizeUrl(config, {
        redirectUri: 'https://app.example.test/api/v1/otto/connection/chatgpt/callback',
        state: 's',
        nonce: 'n',
        challenge: 'c',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'oaiapp_test',
      response_type: 'code',
      redirect_uri: 'https://app.example.test/api/v1/otto/connection/chatgpt/callback',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: 's',
      nonce: 'n',
      code_challenge_method: 'S256',
      code_challenge: 'c',
    });
  });

  it('exchanges a code and refreshes, and treats any refusal as null', async () => {
    const now = new Date('2026-11-17T10:00:00Z');
    const ok = tokenEndpoint(
      Response.json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'openid offline_access chatgpt.tokens.use.direct',
      }),
    );
    const tokens = await exchangeCode(
      ok.fakeFetch,
      config,
      { code: 'code-1', verifier: 'v', redirectUri: 'https://app.example.test/cb' },
      now,
    );
    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: new Date('2026-11-17T11:00:00Z'),
      scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'],
    });
    expect(ok.calls[0]?.url).toBe('https://auth.openai.com/api/accounts/oauth/token');
    expect(Object.fromEntries(ok.calls[0]?.body ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'v',
      redirect_uri: 'https://app.example.test/cb',
      client_id: 'oaiapp_test',
      resource: 'https://api.openai.com/v1',
    });
    await refreshTokens(ok.fakeFetch, config, 'rt-1', now);
    expect(ok.calls[1]?.body.get('grant_type')).toBe('refresh_token');
    expect(ok.calls[1]?.body.get('refresh_token')).toBe('rt-1');

    const refused = tokenEndpoint(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    expect(await refreshTokens(refused.fakeFetch, config, 'rt-old', now)).toBeNull();
    expect(needsRefresh(new Date('2026-11-17T10:00:30Z'), now)).toBe(true);
    expect(needsRefresh(new Date('2026-11-17T10:30:00Z'), now)).toBe(false);
    expect(needsRefresh(null, now)).toBe(false);
  });
});

describe('a ChatGPT connection', () => {
  async function connectedOrg(expiresAt: Date) {
    const cookie = await signUp(uniqueEmail('otto-chatgpt'));
    const me = (await (await get('/api/v1/me', cookie)).json()) as {
      data: { organization: { id: string }; user: { id: string } };
    };
    const orgId = me.data.organization.id;
    await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        saveOttoCredential(tx, {
          orgId,
          userId: me.data.user.id,
          masterKeyBase64: (env as unknown as Env).CREDENTIALS_MASTER_KEY as string,
          kind: 'chatgpt',
          secret: JSON.stringify({ accessToken: 'at-old', refreshToken: 'rt-old' }),
          model: null,
          expiresAt,
        }),
      ),
    );
    return orgId;
  }

  it('is used only while the flag is on, and refreshes an expiring token', async () => {
    const now = new Date();
    const orgId = await connectedOrg(new Date(now.getTime() + 10_000));
    const bindings = { ...(env as unknown as Env), ...FLAG_ON };
    const fresh = tokenEndpoint(
      Response.json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
    );
    const access = await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        resolveOttoAccess(tx, bindings, { fetch: fresh.fakeFetch, now }),
      ),
    );
    expect(access).toMatchObject({
      ready: true,
      mode: 'chatgpt',
      connection: { kind: 'chatgpt', accessToken: 'at-new', model: 'gpt-6-luna' },
    });
    const stored = await withAppDb((db) =>
      withTenant(db, orgId, async (tx) => {
        const row = await loadOttoCredential(tx);
        if (!row) throw new Error('no row');
        return {
          expiresAt: row.expiresAt,
          secret: JSON.parse(await openOttoSecret(row, bindings.CREDENTIALS_MASTER_KEY as string)),
        };
      }),
    );
    expect(stored.secret).toEqual({ accessToken: 'at-new', refreshToken: 'rt-new' });
    expect(stored.expiresAt?.getTime()).toBeGreaterThan(now.getTime() + 3_000_000);

    // Flag off: the stored sign-in is ignored and the instance model answers.
    const off = await withAppDb((db) =>
      withTenant(db, orgId, (tx) => resolveOttoAccess(tx, env as unknown as Env)),
    );
    expect(off).toMatchObject({ ready: true, mode: 'demo' });
  });

  it('asks to connect again when the refresh is refused', async () => {
    const now = new Date();
    const orgId = await connectedOrg(new Date(now.getTime() - 1000));
    const refused = tokenEndpoint(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const access = await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        resolveOttoAccess(
          tx,
          { ...(env as unknown as Env), ...FLAG_ON },
          {
            fetch: refused.fakeFetch,
            now,
          },
        ),
      ),
    );
    expect(access).toEqual({ ready: false, mode: 'connect', plan: null, upgradePath: null });
  });
});
