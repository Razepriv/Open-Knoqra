import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { normalizePhone } from '@knoqra/core';
import {
  type ProviderCredentialRow,
  providerBalanceSnapshot,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { PROVIDERS } from '@knoqra/providers';
import { desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  apiOrigin,
  CONNECTOR_FIELDS,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  offeredConnectors,
  PlivoConnectBody,
  TelnyxConnectBody,
  webhookPaths,
} from '../connectors/registry';
import {
  ConnectorConflictError,
  deleteConnection,
  NumberConflictError,
  saveConnection,
} from '../connectors/store';
import type { Env } from '../env';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { canManage } from '../lib/roles';
import { isValidMasterKey } from '../lib/secret-envelope';
import { auditVoiceAlone, insertVoiceAudit } from '../lib/voice-audit';
import { loadConnection } from '../lib/voice-provider';
import { connectorConflictMessage } from './voice';

/** Generic on purpose: it must not reveal that another customer holds the number. */
const NUMBER_CONFLICT = "This number can't be connected to this workspace.";
const FORBIDDEN = 'Only owners and admins can change connectors.';

const CapabilitiesSchema = z.object({
  voice: z.boolean(),
  numbers: z.boolean(),
  purchase: z.boolean(),
  balance: z.boolean(),
  usage: z.boolean(),
  messaging: z.boolean(),
});

const ProviderEnum = z.enum(CONNECTOR_PROVIDERS);

const ConnectorProviderSchema = z
  .object({
    id: ProviderEnum,
    label: z.string(),
    capabilities: CapabilitiesSchema,
    liveVerified: z.boolean(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        secret: z.boolean(),
        required: z.boolean(),
        hint: z.string(),
      }),
    ),
  })
  .openapi('ConnectorProvider');

const WebhookSchema = z.object({
  /** Full URL when the API's public origin is configured, else the path on the API domain. */
  events: z.string(),
  answer: z.string().nullable(),
  /** Whether `events` is a full URL (true) or a path (false). */
  absolute: z.boolean(),
  /** Telnyx: whether this connection has its own webhook public key (else the platform URL). */
  ownKey: z.boolean(),
});

const ConnectionSchema = z
  .object({
    provider: ProviderEnum,
    last4: z.string(),
    accountId: z.string().nullable(),
    connectionId: z.string().nullable(),
    callerIdE164: z.string().nullable(),
    webhook: WebhookSchema,
    check: z
      .object({
        status: z.enum(['ok', 'auth_failed', 'unavailable']),
        checkedAt: z.iso.datetime(),
      })
      .nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('ConnectorConnection');
type ConnectionJson = z.infer<typeof ConnectionSchema>;

const ConnectorsSchema = z
  .object({
    providers: z.array(ConnectorProviderSchema),
    connection: ConnectionSchema.nullable(),
  })
  .openapi('Connectors');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/connectors',
  tags: ['connectors'],
  summary: 'The providers this workspace can connect, and its connection with its status',
  description:
    'A workspace holds one connector. `check` is the latest credential check (the balance poll ' +
    'or Check now). Secrets never leave the server: only their last four characters. Never cached.',
  security,
  responses: {
    200: { description: 'Connectors', content: json(okEnvelope(ConnectorsSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const saveResponses = {
  200: { description: 'Saved connection', content: json(okEnvelope(ConnectionSchema)) },
  400: errorResponse('Invalid body'),
  401: errorResponse('No valid session'),
  403: errorResponse('Only owners and admins can change connectors'),
  404: errorResponse('This deployment does not offer the provider'),
  409: errorResponse(
    'Another provider is connected, the number belongs to another workspace, or no active organization',
  ),
  503: errorResponse('The server has no credentials master key'),
};

const putTelnyxRoute = createRoute({
  method: 'put',
  path: '/api/v1/connectors/telnyx',
  tags: ['connectors'],
  summary: 'Connect Telnyx: save the API key, connection id, caller id and webhook public key',
  security,
  request: { body: { required: true, content: json(TelnyxConnectBody) } },
  responses: saveResponses,
});

const putPlivoRoute = createRoute({
  method: 'put',
  path: '/api/v1/connectors/plivo',
  tags: ['connectors'],
  summary: 'Connect Plivo: save the Auth ID, auth token, application id and caller id',
  description: 'Built from Plivo’s docs; not yet run against a live Plivo account.',
  security,
  request: { body: { required: true, content: json(PlivoConnectBody) } },
  responses: saveResponses,
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/api/v1/connectors/{provider}',
  tags: ['connectors'],
  summary: 'Disconnect a provider: remove the stored connection, its number routes and senders',
  security,
  request: { params: z.object({ provider: ProviderEnum }) },
  responses: {
    204: { description: 'Removed (also when nothing was connected)' },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can change connectors'),
    409: errorResponse('No active organization'),
  },
});

async function latestCheck(tx: Tx, provider: ConnectorProvider) {
  const [row] = await tx
    .select({ status: providerBalanceSnapshot.status, at: providerBalanceSnapshot.capturedAt })
    .from(providerBalanceSnapshot)
    .where(eq(providerBalanceSnapshot.provider, provider))
    .orderBy(desc(providerBalanceSnapshot.capturedAt))
    .limit(1);
  return row ? { status: row.status, checkedAt: row.at.toISOString() } : null;
}

function webhookOf(env: Pick<Env, 'API_PUBLIC_ORIGIN'>, row: ProviderCredentialRow) {
  const paths = webhookPaths(row.provider, row.organizationId);
  const origin = apiOrigin(env);
  const full = (path: string | null) => (path === null ? null : `${origin ?? ''}${path}`);
  const ownKey = row.provider === 'plivo' || Boolean(row.webhookPublicKey);
  return {
    // A Telnyx connection without its own key keeps the platform URL (TELNYX_PUBLIC_KEY).
    events: full(ownKey ? paths.events : '/webhooks/telnyx') ?? '',
    answer: full(paths.answer),
    absolute: origin !== null,
    ownKey,
  };
}

async function toConnectionJson(
  tx: Tx,
  env: Pick<Env, 'API_PUBLIC_ORIGIN'>,
  row: ProviderCredentialRow,
): Promise<ConnectionJson> {
  return {
    provider: row.provider,
    last4: row.apiKeyLast4,
    accountId: row.accountId,
    connectionId: row.connectionId,
    callerIdE164: row.callerIdE164,
    webhook: webhookOf(env, row),
    check: await latestCheck(tx, row.provider),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type SaveFields = {
  secret: string;
  connectionId: string;
  accountId: string | null;
  callerIdE164: string;
  webhookPublicKey?: string | undefined;
};

// biome-ignore lint/suspicious/noExplicitAny: shared by two routes whose input types differ.
type Ctx = Context<AppEnv, string, any>;

/** The shared PUT: role, offer, master key and caller id checks, then the audited save. */
async function save(c: Ctx, provider: ConnectorProvider, fields: SaveFields) {
  const { db, tenant } = c.var;
  if (!canManage(tenant.role)) {
    await auditVoiceAlone(db, tenant, {
      action: 'voice.connection.update',
      outcome: 'denied',
      metadata: { reason: 'role', provider },
    });
    return fail(c, 403, 'forbidden', FORBIDDEN);
  }
  if (!offeredConnectors(c.env).includes(provider)) {
    return fail(c, 404, 'not_found', 'This provider is not offered here.');
  }
  const masterKeyBase64 = c.env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKeyBase64)) {
    return fail(
      c,
      503,
      'not_configured',
      'Provider credentials are not configured on this server.',
    );
  }
  const phone = normalizePhone(fields.callerIdE164);
  if (!phone.ok)
    return fail(c, 400, 'validation_error', 'callerIdE164: Enter a valid phone number');
  try {
    const row = await withTenant(db, tenant.orgId, async (tx) => {
      const saved = await saveConnection(tx, {
        tenant,
        masterKeyBase64,
        provider,
        ...fields,
        callerIdE164: phone.value,
        routeNumber: c.env.APP_ENV !== 'production',
      });
      await insertVoiceAudit(tx, tenant, {
        action: 'voice.connection.update',
        outcome: 'allowed',
        metadata: { provider, last4: saved.apiKeyLast4 },
      });
      return toConnectionJson(tx, c.env, saved);
    });
    return ok(c, row, 200);
  } catch (error) {
    return refuseSave(c, tenant, provider, error);
  }
}

async function refuseSave(c: Ctx, tenant: Tenant, provider: ConnectorProvider, error: unknown) {
  if (error instanceof NumberConflictError) {
    await auditVoiceAlone(c.var.db, tenant, {
      action: 'voice.connection.update',
      outcome: 'denied',
      metadata: { reason: 'number_conflict', provider },
    });
    return fail(c, 409, 'validation_error', NUMBER_CONFLICT);
  }
  if (error instanceof ConnectorConflictError) {
    await auditVoiceAlone(c.var.db, tenant, {
      action: 'voice.connection.update',
      outcome: 'denied',
      metadata: { reason: 'connector_conflict', provider, connected: error.connected },
    });
    return fail(c, 409, 'connector_conflict', connectorConflictMessage(error));
  }
  throw error;
}

export const connectors = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    c.header('Cache-Control', 'no-store');
    const offered = offeredConnectors(c.env);
    const connection = await withTenant(db, tenant.orgId, async (tx) => {
      const row = await loadConnection(tx);
      return row ? toConnectionJson(tx, c.env, row) : null;
    });
    // A stored connection to a provider no longer offered is still shown, so it can be removed.
    const ids = CONNECTOR_PROVIDERS.filter(
      (id) => offered.includes(id) || connection?.provider === id,
    );
    const providers = ids.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      capabilities: { ...PROVIDERS[id].capabilities },
      liveVerified: PROVIDERS[id].liveVerified,
      fields: CONNECTOR_FIELDS[id].map((f) => ({ ...f })),
    }));
    return ok(c, { providers, connection }, 200);
  })
  .openapi(putTelnyxRoute, (c) => {
    const body = c.req.valid('json');
    return save(c, 'telnyx', {
      secret: body.apiKey,
      connectionId: body.connectionId,
      accountId: null,
      callerIdE164: body.callerIdE164,
      webhookPublicKey: body.webhookPublicKey,
    });
  })
  .openapi(putPlivoRoute, (c) => {
    const body = c.req.valid('json');
    return save(c, 'plivo', {
      secret: body.authToken,
      connectionId: body.appId,
      accountId: body.authId,
      callerIdE164: body.callerIdE164,
    });
  })
  .openapi(deleteRoute, async (c) => {
    const { db, tenant } = c.var;
    const { provider } = c.req.valid('param');
    if (!canManage(tenant.role)) {
      await auditVoiceAlone(db, tenant, {
        action: 'voice.connection.delete',
        outcome: 'denied',
        metadata: { reason: 'role', provider },
      });
      return fail(c, 403, 'forbidden', FORBIDDEN);
    }
    await withTenant(db, tenant.orgId, async (tx) => {
      const removed = await deleteConnection(tx, tenant.orgId, provider);
      await insertVoiceAudit(tx, tenant, {
        action: 'voice.connection.delete',
        outcome: removed ? 'allowed' : 'not_found',
        metadata: { provider },
      });
    });
    return c.body(null, 204);
  });
