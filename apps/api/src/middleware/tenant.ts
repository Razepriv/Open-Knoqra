import { createMiddleware } from 'hono/factory';
import { membershipRole } from '../auth/workspace';
import type { AppEnv } from '../lib/context';
import { fail } from '../lib/envelope';

/**
 * Resolves the caller's tenant from the Better Auth session (requires `requestDb` and
 * `requestAuth`). The active organization is re-checked against `member` on every request, so a
 * removed member loses access immediately even while their session lives on.
 */
export function tenant() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const current = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
    if (!current) return fail(c, 401, 'unauthenticated', 'Sign in to continue.');

    const userId = current.user.id;
    const orgId = current.session.activeOrganizationId;
    const role = orgId ? await membershipRole(c.var.db, userId, orgId) : null;
    if (!orgId || !role) {
      return fail(c, 409, 'no_active_org', 'Select an organization you belong to.');
    }

    c.set('session', current);
    c.set('tenant', { orgId, userId, role });
    await next();
  });
}
