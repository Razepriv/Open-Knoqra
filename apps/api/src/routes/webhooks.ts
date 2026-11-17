import { emergencyCode } from '@knoqra/core';
import { createDb, type ProviderCredentialRow, providerEventRaw, withTenant } from '@knoqra/db';
import {
  FakeProvider,
  PlivoWebhookAdapter,
  TelnyxWebhookAdapter,
  telnyxOutboundStart,
  type WebhookAdapter,
} from '@knoqra/providers';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  type ConnectorProvider,
  isConnectorProvider,
  isWebhookOrgId,
  openConnectionSecret,
} from '../connectors/registry';
import { connectionString, type Env } from '../env';
import { hangUpEmergencyNow } from '../events/call-guard';
import type { AppEnv } from '../lib/context';
import { fail, ok } from '../lib/envelope';
import { logger } from '../lib/logger';
import { isValidMasterKey, SecretEnvelopeError } from '../lib/secret-envelope';
import { loadConnection } from '../lib/voice-provider';

/** An unprocessed row older than this is treated as orphaned (its enqueue failed), not in flight. */
export const ORPHAN_AFTER_SECONDS = 60;

const MAX_LOGGED_EVENT_TYPE = 100;

export type IngestResult =
  | { status: 200; duplicate: boolean }
  | { status: 200; ignored: true }
  | { status: 400; error: 'invalid_payload' }
  | { status: 401; error: 'invalid_signature' };

/**
 * Verify, store once, queue once. The order is the contract: verify, parse, insert on conflict do
 * nothing, then send only when this request's insert created the row.
 *
 * Failure recovery: if the insert succeeds but `send` throws, the error propagates (a 500, so the
 * provider retries). The retry loses the unique conflict and finds a row that is unprocessed. A
 * concurrent duplicate looks identical, so to keep concurrent deliveries at exactly one send we
 * re-send only when the row is also older than ORPHAN_AFTER_SECONDS. Younger rows are assumed to
 * be in flight. The response is still `duplicate: true` either way.
 */
export async function ingestWebhook(
  env: Env,
  adapter: WebhookAdapter,
  headers: Headers,
  rawBody: Uint8Array,
  opts: {
    /**
     * Set for a per-connection URL: the workspace whose own key verified the delivery. The event
     * is stored with it (the handlers apply it to that workspace only) and its external id is
     * namespaced by it, so no workspace can pre-empt another's event ids.
     */
    organizationId?: string;
    /**
     * Runs once the event is stored and queued, for a delivery that created its row (never for a
     * duplicate). Must not throw or block: the emergency fast path schedules its work and returns.
     */
    afterStore?: (stored: { rawEventId: string; body: unknown }) => void;
    /**
     * A verified event the core does not model, offered to the editions' extensions
     * (`ApiExtension.providerWebhook`, see `offerToExtensions`). Nothing is stored for it. May throw,
     * which answers 500 so the provider delivers it again.
     */
    unmodeled?: (delivery: { eventType: string; body: unknown }) => Promise<void>;
  } = {},
): Promise<IngestResult> {
  if (!(await adapter.verify(headers, rawBody))) return { status: 401, error: 'invalid_signature' };
  const parsed = adapter.parse(rawBody);
  if (!parsed.ok) return { status: 400, error: 'invalid_payload' };
  if (parsed.value.kind === 'ignored') {
    const { eventType, body } = parsed.value;
    logger.debug('webhook.ignored', {
      provider: adapter.provider,
      eventType: eventType.slice(0, MAX_LOGGED_EVENT_TYPE),
    });
    if (opts.unmodeled && body !== undefined) await opts.unmodeled({ eventType, body });
    return { status: 200, ignored: true };
  }
  const event = parsed.value.event;
  const organizationId = opts.organizationId ?? null;
  const externalEventId =
    organizationId === null ? event.externalEventId : `${organizationId}:${event.externalEventId}`;

  const { db, close } = createDb(connectionString(env));
  try {
    const inserted = await db
      .insert(providerEventRaw)
      .values({
        provider: event.provider,
        externalEventId,
        eventType: event.type,
        body: parsed.value.body,
        status: 'pending',
        organizationId,
      })
      .onConflictDoNothing({
        target: [providerEventRaw.provider, providerEventRaw.externalEventId],
      })
      .returning({ id: providerEventRaw.id });

    const created = inserted[0];
    if (created) {
      await env.PROVIDER_EVENTS.send({ rawEventId: created.id });
      opts.afterStore?.({ rawEventId: created.id, body: parsed.value.body });
      return { status: 200, duplicate: false };
    }

    const [existing] = await db
      .select({
        id: providerEventRaw.id,
        orphaned: sql<boolean>`${providerEventRaw.processedAt} is null and ${providerEventRaw.receivedAt} < now() - make_interval(secs => ${ORPHAN_AFTER_SECONDS})`,
      })
      .from(providerEventRaw)
      .where(
        and(
          eq(providerEventRaw.provider, event.provider),
          eq(providerEventRaw.externalEventId, externalEventId),
        ),
      );
    if (existing?.orphaned) {
      logger.warn('webhook.resend_orphaned', { provider: event.provider, rawEventId: existing.id });
      await env.PROVIDER_EVENTS.send({ rawEventId: existing.id });
    }
    return { status: 200, duplicate: true };
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
}

/**
 * The emergency fast path (`afterStore` for Telnyx deliveries). The queue delivers within its
 * one-second batch window plus a consumer start, so a 911 call would ring for a second or more
 * before the queue's guard cuts it. An outgoing `call.initiated` to an emergency number is hung up
 * from here instead, as soon as it is stored and queued, after the response in `waitUntil`. Every
 * other event returns at once. The queue's guard still runs: it finds the event already recorded,
 * or hangs up and records it itself when this path could not.
 */
export function emergencyFastPath(
  env: Env,
  connectorOrgId: string | null,
  deps: { waitUntil: (promise: Promise<unknown>) => void; fetch?: typeof fetch },
): (stored: { rawEventId: string; body: unknown }) => void {
  return ({ rawEventId, body }) => {
    const start = telnyxOutboundStart(body);
    if (start === null || emergencyCode(start.to) === null) return;
    const task = (async () => {
      const { db, close } = createDb(connectionString(env));
      try {
        await hangUpEmergencyNow(
          { env, db, rawEventId, connectorOrgId, ...(deps.fetch ? { fetch: deps.fetch } : {}) },
          body,
        );
      } finally {
        await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
      }
    })();
    try {
      deps.waitUntil(task);
    } catch {
      // No execution context: the task still runs, just unawaited.
    }
  };
}

/**
 * Offers a verified event the core does not model to each extension with a `providerWebhook`
 * hook, until one handles it. Undefined when no extension has one (the core alone drops it).
 */
export function offerToExtensions(
  env: Env,
  provider: string,
  connectorOrgId: string | null,
  waitUntil: (promise: Promise<unknown>) => void,
): ((delivery: { eventType: string; body: unknown }) => Promise<void>) | undefined {
  const handlers = (env.EXTENSIONS ?? []).flatMap((extension) =>
    extension.providerWebhook ? [extension.providerWebhook] : [],
  );
  if (handlers.length === 0) return undefined;
  return async ({ eventType, body }) => {
    for (const handle of handlers) {
      if (await handle(env, { provider, eventType, body, connectorOrgId, waitUntil })) return;
    }
  };
}

/** The request's `waitUntil`, for routes. */
const waitUntilOf =
  (c: { executionCtx: { waitUntil: (promise: Promise<unknown>) => void } }) =>
  (promise: Promise<unknown>): void =>
    c.executionCtx.waitUntil(promise);

/** Webhook bodies above this size are rejected with a 413 before they are read. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

/**
 * The fake provider exists for development, tests and staging only. In production, or when its
 * secret is not configured, it is simply unavailable (callers answer 404). Telnyx is available
 * whenever the platform webhook public key is configured.
 */
export function adapterFor(provider: string, env: Env): WebhookAdapter | null {
  if (provider === 'telnyx') {
    return env.TELNYX_PUBLIC_KEY
      ? new TelnyxWebhookAdapter({ publicKeyBase64: env.TELNYX_PUBLIC_KEY })
      : null;
  }
  if (provider !== 'fake') return null;
  if (env.APP_ENV === 'production' || !env.FAKE_WEBHOOK_SECRET) return null;
  return new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET });
}

export interface WebhookConnection {
  connection: ProviderCredentialRow;
  /** The opened secret: the Plivo auth token. Null for Telnyx, whose key is public. */
  secret: string | null;
}

/**
 * A workspace's connection for its own webhook URL, with what verifies its deliveries. Null when
 * the workspace has no connection to `provider`, or the secret cannot be opened.
 */
export async function openWebhookConnection(
  env: Env,
  provider: ConnectorProvider,
  orgId: string,
): Promise<WebhookConnection | null> {
  if (!isWebhookOrgId(orgId)) return null;
  const { db, close } = createDb(connectionString(env));
  try {
    const connection = await withTenant(db, orgId, (tx) => loadConnection(tx));
    if (connection?.provider !== provider) return null;
    if (provider === 'telnyx') return { connection, secret: null };
    const masterKeyBase64 = env.CREDENTIALS_MASTER_KEY;
    if (!isValidMasterKey(masterKeyBase64)) return null;
    try {
      return { connection, secret: await openConnectionSecret(connection, masterKeyBase64) };
    } catch (error) {
      if (!(error instanceof SecretEnvelopeError)) throw error;
      logger.warn('webhook.connection_unsealable', { provider, orgId });
      return null;
    }
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
}

/**
 * The adapter for a connection's own webhook URL, verified with that workspace's own key (the
 * Telnyx account's public key, or the Plivo auth token). Null when there is nothing to verify
 * with; the caller answers 401 either way, so the route does not reveal which workspaces exist.
 */
export function connectionAdapter(
  found: WebhookConnection | null,
  url: string,
): WebhookAdapter | null {
  if (found === null) return null;
  const { connection, secret } = found;
  if (connection.provider === 'telnyx') {
    return connection.webhookPublicKey
      ? new TelnyxWebhookAdapter({ publicKeyBase64: connection.webhookPublicKey })
      : null;
  }
  return secret === null ? null : new PlivoWebhookAdapter({ authToken: secret, url });
}

/** Provider-facing: not under /api, no tenant middleware, not in the OpenAPI document. */
export const webhooks = new Hono<AppEnv>()
  .use(
    '/webhooks/*',
    bodyLimit({
      maxSize: WEBHOOK_MAX_BYTES,
      onError: (c) => fail(c, 413, 'payload_too_large', 'Request body is too large.'),
    }),
  )
  .post('/webhooks/:provider', async (c) => {
    const adapter = adapterFor(c.req.param('provider'), c.env);
    if (!adapter) return fail(c, 404, 'not_found', 'Unknown provider.');

    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const unmodeled = offerToExtensions(c.env, adapter.provider, null, waitUntilOf(c));
    const result = await ingestWebhook(c.env, adapter, c.req.raw.headers, rawBody, {
      ...(adapter.provider === 'telnyx'
        ? { afterStore: emergencyFastPath(c.env, null, { waitUntil: waitUntilOf(c) }) }
        : {}),
      ...(unmodeled ? { unmodeled } : {}),
    });
    if (result.status === 401) return fail(c, 401, 'invalid_signature', 'Signature check failed.');
    if (result.status === 400) return fail(c, 400, 'invalid_payload', 'Unrecognized payload.');
    if ('ignored' in result) return ok(c, { received: true, ignored: true });
    return ok(c, { received: true, duplicate: result.duplicate });
  })
  .post('/webhooks/:provider/:orgId', async (c) => {
    const provider = c.req.param('provider');
    const orgId = c.req.param('orgId');
    if (!isConnectorProvider(provider)) return fail(c, 404, 'not_found', 'Unknown provider.');
    const adapter = connectionAdapter(
      await openWebhookConnection(c.env, provider, orgId),
      c.req.url,
    );
    if (!adapter) return fail(c, 401, 'invalid_signature', 'Signature check failed.');

    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const unmodeled = offerToExtensions(c.env, provider, orgId, waitUntilOf(c));
    const result = await ingestWebhook(c.env, adapter, c.req.raw.headers, rawBody, {
      organizationId: orgId,
      ...(provider === 'telnyx'
        ? { afterStore: emergencyFastPath(c.env, orgId, { waitUntil: waitUntilOf(c) }) }
        : {}),
      ...(unmodeled ? { unmodeled } : {}),
    });
    if (result.status === 401) return fail(c, 401, 'invalid_signature', 'Signature check failed.');
    if (result.status === 400) return fail(c, 400, 'invalid_payload', 'Unrecognized payload.');
    if ('ignored' in result) return ok(c, { received: true, ignored: true });
    return ok(c, { received: true, duplicate: result.duplicate });
  });
