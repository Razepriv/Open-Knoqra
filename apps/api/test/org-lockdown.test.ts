import { organization } from 'better-auth/plugins';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_AUTH_PATHS,
  BLOCKED_ORGANIZATION_PATHS,
  ORGANIZATION_OPTIONS,
} from '../src/auth/auth';
import { api, BASE, get, signUp, uniqueEmail } from './helpers';

describe('organization endpoint lockdown', () => {
  it('lists the required blocked paths and keeps the Desk paths reachable', () => {
    for (const path of [
      '/organization/create',
      '/organization/update',
      '/organization/delete',
      '/organization/invite-member',
      '/organization/accept-invitation',
      '/organization/reject-invitation',
      '/organization/cancel-invitation',
      '/organization/get-invitation',
      '/organization/list-invitations',
      '/organization/list-user-invitations',
      '/organization/remove-member',
      '/organization/update-member-role',
      '/organization/leave',
    ]) {
      expect(BLOCKED_AUTH_PATHS).toContain(path);
    }
    expect(BLOCKED_AUTH_PATHS).toContain('/update-user');
    for (const path of [
      '/organization/set-active',
      '/organization/get-full-organization',
      '/organization/list',
    ]) {
      expect(BLOCKED_AUTH_PATHS).not.toContain(path);
    }
  });

  const ALLOWED = [
    '/organization/set-active',
    '/organization/get-full-organization',
    '/organization/list',
  ];

  function probe(path: string, method: 'GET' | 'POST', cookie: string): Promise<Response> {
    return api(`/api/auth${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', origin: BASE },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
  }

  it.each(
    [...BLOCKED_AUTH_PATHS].flatMap(
      (path) =>
        [
          [path, 'GET'],
          [path, 'POST'],
        ] as const,
    ),
  )('blocks %s via %s', async (path, method) => {
    const cookie = await signUp(uniqueEmail('lock'));
    const r = await probe(path, method, cookie);
    expect([403, 404]).toContain(r.status);
  });

  it('control: the probe sees a 200 on an allowed path', async () => {
    const cookie = await signUp(uniqueEmail('ctl'));
    const r = await probe('/organization/get-full-organization', 'GET', cookie);
    expect(r.status).toBe(200);
  });

  function pluginPaths(plugin: { endpoints: object }): string[] {
    return Object.values(plugin.endpoints)
      .map((e) => (e as { path?: string }).path)
      .filter((p): p is string => typeof p === 'string' && p.startsWith('/organization/'));
  }

  it('covers every organization plugin endpoint (drift guard)', () => {
    // Enables a superset of the production features on purpose, so every production route (and
    // any a Better Auth upgrade adds) stays covered.
    const registered = pluginPaths(
      organization({
        ...ORGANIZATION_OPTIONS,
        teams: { enabled: true },
        dynamicAccessControl: { enabled: true },
      }),
    );
    expect(new Set([...BLOCKED_ORGANIZATION_PATHS, ...ALLOWED])).toEqual(new Set(registered));
  });

  it('covers every route the production plugin options register', () => {
    const covered = new Set([...BLOCKED_ORGANIZATION_PATHS, ...ALLOWED]);
    for (const path of pluginPaths(organization({ ...ORGANIZATION_OPTIONS }))) {
      expect(covered.has(path)).toBe(true);
    }
  });

  it('still signs up and creates the personal workspace', async () => {
    const cookie = await signUp(uniqueEmail('ws'));
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(200);
  });

  it('keeps get-full-organization and list reachable for the signed-in user', async () => {
    const cookie = await signUp(uniqueEmail('desk'));
    const me = (await (await get('/api/v1/me', cookie)).json()) as {
      data: { organization: { id: string } };
    };
    const full = await get('/api/auth/organization/get-full-organization', cookie);
    expect(full.status).toBe(200);
    expect(((await full.json()) as { id: string }).id).toBe(me.data.organization.id);
    const list = await get('/api/auth/organization/list', cookie);
    expect(list.status).toBe(200);
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });
});
