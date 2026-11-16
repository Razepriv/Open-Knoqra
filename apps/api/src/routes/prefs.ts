import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { userPrefs, withTenant } from '@knoqra/db';
import { announceNewsletterChange } from '../email/newsletter';
import type { AppEnv } from '../lib/context';
import { errorResponse, ok, okEnvelope } from '../lib/envelope';
import { loadPrefs, Prefs, UpdatePrefs } from '../lib/prefs';
import { insertUserAudit } from '../lib/user-audit';

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/me/prefs',
  tags: ['account'],
  summary: "The signed-in user's preferences (defaults when none are saved)",
  security: [{ session: [] }],
  responses: {
    200: {
      description: 'Preferences',
      content: { 'application/json': { schema: okEnvelope(Prefs) } },
    },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization the user belongs to'),
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/api/v1/me/prefs',
  tags: ['account'],
  summary: "Update the signed-in user's preferences (partial)",
  security: [{ session: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: UpdatePrefs } } },
  },
  responses: {
    200: {
      description: 'Updated preferences',
      content: { 'application/json': { schema: okEnvelope(Prefs) } },
    },
    400: errorResponse('Invalid preferences, such as an unknown time zone'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization the user belongs to'),
  },
});

export const prefs = new OpenAPIHono<AppEnv>()
  .openapi(getRoute, async (c) => ok(c, await loadPrefs(c.var.db, c.var.tenant.userId), 200))
  .openapi(patchRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    const changes = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    ) as typeof body;
    const fields = Object.keys(changes);
    if (fields.length === 0) return ok(c, await loadPrefs(db, tenant.userId), 200);

    // The key is always the session user: nothing in the request can name another user.
    const now = new Date();
    // The newsletter choice keeps its own timestamp: the consent record.
    const stamped =
      changes.newsletter === undefined ? changes : { ...changes, newsletterUpdatedAt: now };
    const { saved, newsletterBefore } = await withTenant(db, tenant.orgId, async (tx) => {
      const before = await loadPrefs(tx, tenant.userId);
      await tx
        .insert(userPrefs)
        .values({ userId: tenant.userId, ...stamped })
        .onConflictDoUpdate({
          target: userPrefs.userId,
          set: { ...stamped, updatedAt: now },
        });
      await insertUserAudit(tx, tenant, 'user.prefs.update', fields);
      return { saved: await loadPrefs(tx, tenant.userId), newsletterBefore: before.newsletter };
    });
    if (changes.newsletter !== undefined && changes.newsletter !== newsletterBefore) {
      const { user } = c.var.session;
      c.executionCtx.waitUntil(
        announceNewsletterChange(c.env, {
          userId: tenant.userId,
          email: user.email,
          name: user.name,
          subscribed: changes.newsletter,
          source: 'settings',
        }),
      );
    }
    return ok(c, saved, 200);
  });
