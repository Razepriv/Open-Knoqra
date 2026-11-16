import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { organization, user, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { loadPrefs, Prefs } from '../lib/prefs';
import { safeText } from '../lib/schemas';
import { insertUserAudit } from '../lib/user-audit';

const Me = z
  .object({
    user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    organization: z.object({ id: z.string(), name: z.string(), role: z.string() }),
    prefs: Prefs,
  })
  .openapi('Me');

const UpdateProfile = z.object({ name: safeText({ min: 1, max: 120 }) }).openapi('UpdateProfile');

const route = createRoute({
  method: 'get',
  path: '/api/v1/me',
  tags: ['account'],
  summary: 'The signed-in user and their active organization',
  security: [{ session: [] }],
  responses: {
    200: {
      description: 'Current user',
      content: { 'application/json': { schema: okEnvelope(Me) } },
    },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization the user belongs to'),
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/api/v1/me',
  tags: ['account'],
  summary: "Update the signed-in user's display name",
  security: [{ session: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: UpdateProfile } } },
  },
  responses: {
    200: {
      description: 'Updated user',
      content: { 'application/json': { schema: okEnvelope(Me) } },
    },
    400: errorResponse('Invalid name'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization the user belongs to'),
  },
});

export const me = new OpenAPIHono<AppEnv>()
  .openapi(route, async (c) => {
    const { tenant, session } = c.var;
    const [org] = await c.var.db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, tenant.orgId))
      .limit(1);
    // The membership was just verified, and member.organization_id cascades on delete.
    if (!org) return fail(c, 409, 'no_active_org', 'Select an organization you belong to.');
    const { id, name, email } = session.user;
    const prefs = await loadPrefs(c.var.db, id);
    return ok(
      c,
      { user: { id, name, email }, organization: { ...org, role: tenant.role }, prefs },
      200,
    );
  })
  .openapi(patchRoute, async (c) => {
    const { db, tenant } = c.var;
    const { name } = c.req.valid('json');
    // The row is always the session user's own.
    const [updated] = await withTenant(db, tenant.orgId, async (tx) => {
      const rows = await tx
        .update(user)
        .set({ name, updatedAt: new Date() })
        .where(eq(user.id, tenant.userId))
        .returning({ id: user.id, name: user.name, email: user.email });
      await insertUserAudit(tx, tenant, 'user.profile.update', ['name']);
      return rows;
    });
    if (!updated) return fail(c, 401, 'unauthenticated', 'Sign in to continue.');
    const [org] = await db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, tenant.orgId))
      .limit(1);
    if (!org) return fail(c, 409, 'no_active_org', 'Select an organization you belong to.');
    const prefs = await loadPrefs(db, tenant.userId);
    return ok(c, { user: updated, organization: { ...org, role: tenant.role }, prefs }, 200);
  });
