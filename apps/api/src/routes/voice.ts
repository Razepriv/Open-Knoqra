import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { normalizePhone } from '@knoqra/core';
import { type ProviderCredentialRow, type Tx, withTenant } from '@knoqra/db';
import { TelnyxConnectBody } from '../connectors/registry';
import {
  ConnectorConflictError,
  deleteConnection,
  NumberConflictError,
  saveConnection,
} from '../connectors/store';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { canManage } from '../lib/roles';
import { isValidMasterKey, SecretEnvelopeError } from '../lib/secret-envelope';
import { auditVoiceAlone, insertVoiceAudit } from '../lib/voice-audit';
import {
  issueFakeToken,
  issueVoiceToken,
  loadConnection,
  selectVoiceProvider,
  VoiceUpstreamError,
} from '../lib/voice-provider';

const PROVIDER = 'telnyx';
/** Generic on purpose: it must not reveal that another customer holds the number. */
const NUMBER_CONFLICT = "This number can't be connected to this workspace.";

const ConnectionSchema = z
  .object({
    provider: z.literal('telnyx'),
    apiKeyLast4: z.string(),
    connectionId: z.string().nullable(),
    callerIdE164: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('VoiceConnection');
type ConnectionJson = z.infer<typeof ConnectionSchema>;

const ConnectBody = TelnyxConnectBody.omit({ webhookPublicKey: true }).openapi(
  'PutVoiceConnection',
);

const VoiceTokenSchema = z
  .object({
    provider: z.enum(['fake', 'telnyx', 'plivo']),
    token: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .openapi('VoiceToken');

const VoiceStatusSchema = z
  .object({
    provider: z.enum(['fake', 'telnyx', 'plivo', 'none']),
    connected: z.boolean(),
    last4: z.string().nullable(),
  })
  .openapi('VoiceStatus');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const statusRoute = createRoute({
  method: 'get',
  path: '/api/v1/voice/status',
  tags: ['voice'],
  summary: 'Whether this workspace can place calls, and through which provider',
  description:
    '`provider` is the voice provider calls would use now (`none` when calling is not set up). ' +
    '`connected` says whether a connection (any provider) is stored, and `last4` holds the last ' +
    'four characters of its secret. Never cached.',
  security,
  responses: {
    200: { description: 'Voice status', content: json(okEnvelope(VoiceStatusSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/voice/connection',
  tags: ['voice'],
  summary:
    "The workspace's Telnyx connection, without its key (null when it uses another provider)",
  security,
  responses: {
    200: {
      description: 'The connection, or null when none is set up',
      content: json(okEnvelope(ConnectionSchema.nullable())),
    },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/api/v1/voice/connection',
  tags: ['voice'],
  summary: "Save the workspace's Telnyx API key, connection id and caller id",
  security,
  request: { body: { required: true, content: json(ConnectBody) } },
  responses: {
    200: { description: 'Saved connection', content: json(okEnvelope(ConnectionSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can change the connection'),
    409: errorResponse(
      "The number can't be connected to this workspace, another provider is connected, or no active organization",
    ),
    503: errorResponse('The server has no credentials master key'),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/api/v1/voice/connection',
  tags: ['voice'],
  summary: "Disconnect Telnyx: remove the workspace's stored connection",
  security,
  responses: {
    204: { description: 'Removed (also when nothing was set up)' },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can change the connection'),
    409: errorResponse('No active organization'),
  },
});

const tokenRoute = createRoute({
  method: 'post',
  path: '/api/v1/voice/token',
  tags: ['voice'],
  summary: 'A short-lived token for the browser or app voice client',
  security,
  responses: {
    200: { description: 'Voice token', content: json(okEnvelope(VoiceTokenSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No voice provider is set up, or no active organization'),
    429: errorResponse('Too many requests'),
    500: errorResponse('The stored credentials could not be opened'),
    502: errorResponse('The voice provider refused the request'),
    503: errorResponse('The server has no credentials master key'),
  },
});

function toConnectionJson(row: ProviderCredentialRow): ConnectionJson {
  return {
    provider: PROVIDER,
    apiKeyLast4: row.apiKeyLast4,
    connectionId: row.connectionId,
    callerIdE164: row.callerIdE164,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The workspace's Telnyx connection, or undefined (also when it is connected to another provider). */
async function findConnection(tx: Tx): Promise<ProviderCredentialRow | undefined> {
  const row = await loadConnection(tx);
  return row?.provider === PROVIDER ? row : undefined;
}

/** "Disconnect Plivo first": the workspace holds one connector at a time. */
export function connectorConflictMessage(error: ConnectorConflictError): string {
  const label = error.connected === 'plivo' ? 'Plivo' : 'Telnyx';
  return `This workspace is connected to ${label}. Disconnect ${label} first.`;
}

function refuseForbidden(
  c: Parameters<typeof fail>[0],
  db: Parameters<typeof auditVoiceAlone>[0],
  tenant: Tenant,
  action: 'voice.connection.update' | 'voice.connection.delete',
) {
  return auditVoiceAlone(db, tenant, {
    action,
    outcome: 'denied',
    metadata: { reason: 'role' },
  }).then(() => fail(c, 403, 'forbidden', 'Only owners and admins can change the connection.'));
}

export const voice = new OpenAPIHono<AppEnv>()
  .openapi(statusRoute, async (c) => {
    const { db, tenant } = c.var;
    c.header('Cache-Control', 'no-store');
    // Reads only the stored last four: nothing is decrypted here.
    const row = await withTenant(db, tenant.orgId, (tx) => loadConnection(tx));
    const choice = selectVoiceProvider(c.env, row);
    return ok(
      c,
      { provider: choice.kind, connected: row !== null, last4: row?.apiKeyLast4 ?? null },
      200,
    );
  })
  .openapi(getRoute, async (c) => {
    const { db, tenant } = c.var;
    const row = await withTenant(db, tenant.orgId, (tx) => findConnection(tx));
    return ok(c, row ? toConnectionJson(row) : null, 200);
  })
  .openapi(putRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) {
      return refuseForbidden(c, db, tenant, 'voice.connection.update');
    }
    const masterKeyBase64 = c.env.CREDENTIALS_MASTER_KEY;
    if (!isValidMasterKey(masterKeyBase64)) {
      return fail(c, 503, 'not_configured', 'Voice credentials are not configured on this server.');
    }
    const body = c.req.valid('json');
    const phone = normalizePhone(body.callerIdE164);
    if (!phone.ok) {
      return fail(c, 400, 'validation_error', 'callerIdE164: Enter a valid phone number');
    }
    try {
      const row = await withTenant(db, tenant.orgId, async (tx) => {
        const saved = await saveConnection(tx, {
          tenant,
          masterKeyBase64,
          provider: PROVIDER,
          secret: body.apiKey,
          connectionId: body.connectionId,
          accountId: null,
          callerIdE164: phone.value,
          routeNumber: c.env.APP_ENV !== 'production',
        });
        await insertVoiceAudit(tx, tenant, {
          action: 'voice.connection.update',
          outcome: 'allowed',
          metadata: { last4: saved.apiKeyLast4 },
        });
        return saved;
      });
      return ok(c, toConnectionJson(row), 200);
    } catch (error) {
      if (error instanceof NumberConflictError) {
        await auditVoiceAlone(db, tenant, {
          action: 'voice.connection.update',
          outcome: 'denied',
          metadata: { reason: 'number_conflict' },
        });
        return fail(c, 409, 'validation_error', NUMBER_CONFLICT);
      }
      if (error instanceof ConnectorConflictError) {
        await auditVoiceAlone(db, tenant, {
          action: 'voice.connection.update',
          outcome: 'denied',
          metadata: { reason: 'connector_conflict', provider: PROVIDER },
        });
        return fail(c, 409, 'connector_conflict', connectorConflictMessage(error));
      }
      throw error;
    }
  })
  .openapi(deleteRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) {
      return refuseForbidden(c, db, tenant, 'voice.connection.delete');
    }
    await withTenant(db, tenant.orgId, async (tx) => {
      const removed = await deleteConnection(tx, tenant.orgId, PROVIDER);
      await insertVoiceAudit(tx, tenant, {
        action: 'voice.connection.delete',
        outcome: removed ? 'allowed' : 'not_found',
        metadata: { provider: PROVIDER },
      });
    });
    return c.body(null, 204);
  })
  .openapi(tokenRoute, async (c) => {
    const { db, tenant } = c.var;
    c.header('Cache-Control', 'no-store');
    const connection = await withTenant(db, tenant.orgId, (tx) => loadConnection(tx));
    const choice = selectVoiceProvider(c.env, connection);
    if (choice.kind === 'none') {
      return fail(
        c,
        409,
        'voice_not_configured',
        'Voice calling is not set up for this workspace.',
      );
    }
    try {
      if (choice.kind === 'fake') {
        return ok(c, await issueFakeToken(tenant, c.env.FAKE_WEBHOOK_SECRET ?? ''), 200);
      }
      const masterKeyBase64 = c.env.CREDENTIALS_MASTER_KEY;
      if (!isValidMasterKey(masterKeyBase64)) {
        return fail(
          c,
          503,
          'not_configured',
          'Voice credentials are not configured on this server.',
        );
      }
      const token = await issueVoiceToken(db, c.env, tenant, choice.connection, masterKeyBase64);
      await auditVoiceAlone(db, tenant, {
        action: 'voice.token.create',
        outcome: 'allowed',
        metadata: { provider: token.provider },
      });
      return ok(c, token, 200);
    } catch (error) {
      if (error instanceof VoiceUpstreamError) {
        return fail(c, 502, 'internal_error', 'The voice provider refused the request.');
      }
      if (error instanceof SecretEnvelopeError) {
        // Code only: never anything derived from key material.
        logger.error('voice.token.unseal_failed', { orgId: tenant.orgId, code: error.code });
        return fail(c, 500, 'internal_error', 'Something went wrong.');
      }
      throw error;
    }
  });
