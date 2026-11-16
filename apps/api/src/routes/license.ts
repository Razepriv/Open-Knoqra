import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { LICENSE_MAX_LENGTH, verifyLicense } from '@knoqra/core';
import { auditEvent, instanceLicense, withTenant } from '@knoqra/db';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { canManage } from '../lib/roles';
import { editionOf } from '../license/edition';
import { LICENSE_REASON_MESSAGES, type LicenseChecker } from '../license/status';

export const LICENSE_PATH = '/api/v1/license';
/** Answered even while a self-hosted instance is unlicensed: the Desk needs them for the setup screen. */
const UNGATED_PATHS = new Set([LICENSE_PATH, '/api/v1/me']);

const LicenseStatusSchema = z
  .object({
    edition: z.enum(['cloud', 'selfhost']),
    required: z.boolean(),
    licensed: z.boolean(),
    source: z.enum(['env', 'stored']).nullable(),
    license: z
      .object({
        login: z.string(),
        githubId: z.string(),
        issuedAt: z.string(),
        edition: z.literal('selfhost'),
      })
      .nullable(),
    reason: z
      .enum([
        'missing',
        'no_public_key',
        'malformed',
        'bad_signature',
        'wrong_edition',
        'future_date',
      ])
      .nullable(),
    /** The reason in words, for the setup screen. */
    message: z.string().nullable(),
  })
  .openapi('LicenseStatus');

const EnterLicenseBody = z
  .object({ key: z.string().trim().min(1).max(LICENSE_MAX_LENGTH) })
  .openapi('EnterLicense');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const getRoute = createRoute({
  method: 'get',
  path: LICENSE_PATH,
  tags: ['license'],
  summary: "This instance's edition and, when self-hosted, whether its license key is valid",
  security,
  responses: {
    200: { description: 'License status', content: json(okEnvelope(LicenseStatusSchema)) },
    401: errorResponse('No valid session'),
  },
});

const putRoute = createRoute({
  method: 'put',
  path: LICENSE_PATH,
  tags: ['license'],
  summary: 'Enter the license key of a self-hosted instance',
  security,
  request: { body: { required: true, content: json(EnterLicenseBody) } },
  responses: {
    200: { description: 'License status', content: json(okEnvelope(LicenseStatusSchema)) },
    400: errorResponse('Not a valid license key'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can enter the key'),
    404: errorResponse('Cloud instances take no license key'),
  },
});

/**
 * The self-host license gate: until a valid key is set, every `/api/v1/*` route except
 * `/api/v1/me` and `/api/v1/license` answers 403 `license_required`. Never runs on cloud.
 * Registered after the tenant middleware, so the caller is already signed in.
 */
export function licenseGate(checker: LicenseChecker) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (editionOf(c.env) === 'cloud' || UNGATED_PATHS.has(c.req.path)) return next();
    const status = await checker.status(c.env, c.var.db);
    if (!status.licensed) {
      return fail(c, 403, 'license_required', 'Enter a license key to use this KNOQRA instance.');
    }
    await next();
  });
}

export function licenseRoutes(checker: LicenseChecker) {
  const statusJson = async (c: Context<AppEnv>) => {
    const status = await checker.status(c.env, c.var.db);
    return { ...status, message: status.reason ? LICENSE_REASON_MESSAGES[status.reason] : null };
  };

  return new OpenAPIHono<AppEnv>()
    .openapi(getRoute, async (c) => ok(c, await statusJson(c), 200))
    .openapi(putRoute, async (c) => {
      const { db, tenant } = c.var;
      if (editionOf(c.env) === 'cloud') {
        return fail(c, 404, 'not_found', 'KNOQRA Cloud needs no license key.');
      }
      if (!canManage(tenant.role)) {
        return fail(c, 403, 'forbidden', 'Only owners and admins can enter the license key.');
      }
      const { key } = c.req.valid('json');
      const check = await verifyLicense(key, checker.publicKey);
      if (!check.ok) {
        return fail(c, 400, 'license_invalid', LICENSE_REASON_MESSAGES[check.reason]);
      }
      await db
        .insert(instanceLicense)
        .values({ id: 1, licenseKey: key, updatedBy: tenant.userId })
        .onConflictDoUpdate({
          target: instanceLicense.id,
          set: { licenseKey: key, updatedBy: tenant.userId, updatedAt: new Date() },
        });
      await withTenant(db, tenant.orgId, (tx) =>
        tx.insert(auditEvent).values({
          organizationId: tenant.orgId,
          actorUserId: tenant.userId,
          entityType: 'license',
          action: 'license.update',
          outcome: 'allowed',
          entityId: null,
          metadata: { githubId: check.license.sub, issuedAt: check.license.iat },
        }),
      );
      checker.forget();
      return ok(c, await statusJson(c), 200);
    });
}
