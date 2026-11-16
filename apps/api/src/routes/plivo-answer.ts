import { isTerminal } from '@knoqra/core';
import { call, callRoute, createDb, withTenant } from '@knoqra/db';
import { classifyPlivo, formFields, plivoXml, RECEIVED_AT_FIELD } from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { connectionString, type Env } from '../env';
import type { AppEnv } from '../lib/context';
import { fail } from '../lib/envelope';
import { logger } from '../lib/logger';
import {
  connectionAdapter,
  ingestWebhook,
  openWebhookConnection,
  WEBHOOK_MAX_BYTES,
  type WebhookConnection,
} from './webhooks';

const ANSWER_SUFFIX = '/answer';
const digits = (value: string): string => value.replace(/\D/g, '');

const XML_HEADERS = {
  'content-type': 'application/xml; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * What to tell Plivo for one answer request. A call the browser placed is dialed only when it is a
 * call KNOQRA authorized (found by its random client state, in this workspace, still live, to the
 * same destination), and only to the stored destination from the stored caller id: never to
 * anything the request names. A call to one of the workspace's numbers rings its browser endpoint.
 * Everything else hangs up.
 */
export async function answerFor(
  env: Env,
  orgId: string,
  found: WebhookConnection,
  fields: Record<string, string>,
  eventsUrl: string,
): Promise<string> {
  const classified = classifyPlivo({ ...fields, [RECEIVED_AT_FIELD]: new Date().toISOString() });
  if (classified.kind !== 'call' || classified.fact.type !== 'call.initiated') {
    return plivoXml.hangup();
  }
  const { fact } = classified;
  if (fact.direction === 'inbound') {
    const endpoint = found.connection.telephonyCredentialId;
    if (!endpoint) return plivoXml.hangup();
    return plivoXml.dial({
      callerId: null,
      target: { kind: 'user', sipUri: `sip:${endpoint}@phone.plivo.com` },
      callbackUrl: eventsUrl,
    });
  }
  if (fact.clientState === null) return plivoXml.hangup();
  const { db, close } = createDb(connectionString(env));
  try {
    // call_route has no RLS: filter by provider and organization ourselves.
    const [route] = await db
      .select({ callId: callRoute.callId })
      .from(callRoute)
      .where(
        and(
          eq(callRoute.clientState, fact.clientState),
          eq(callRoute.provider, 'plivo'),
          eq(callRoute.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!route) return plivoXml.hangup();
    const [row] = await withTenant(db, orgId, (tx) =>
      tx.select().from(call).where(eq(call.id, route.callId)).limit(1),
    );
    const authorized =
      row !== undefined &&
      row.direction === 'outbound' &&
      !isTerminal(row.state) &&
      digits(row.toE164) === digits(fact.to);
    if (!row || !authorized) {
      logger.warn('plivo.answer_refused', { orgId, callId: route.callId });
      return plivoXml.hangup();
    }
    return plivoXml.dial({
      callerId: row.fromE164,
      target: { kind: 'number', e164: row.toE164 },
      callbackUrl: eventsUrl,
    });
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
}

/**
 * Plivo's answer URL for a connection: `POST /webhooks/plivo/<organizationId>/answer`, set on the
 * Plivo application. Signed like every Plivo callback; the request is also stored as the call's
 * start event, then the answer is Plivo XML. Built from Plivo's docs; not run on a live account.
 */
export const plivoAnswer = new Hono<AppEnv>()
  .use(
    '/webhooks/plivo/*',
    bodyLimit({
      maxSize: WEBHOOK_MAX_BYTES,
      onError: (c) => fail(c, 413, 'payload_too_large', 'Request body is too large.'),
    }),
  )
  .post('/webhooks/plivo/:orgId/answer', async (c) => {
    const orgId = c.req.param('orgId');
    const url = c.req.url;
    const found = await openWebhookConnection(c.env, 'plivo', orgId);
    const adapter = connectionAdapter(found, url);
    if (!found || !adapter) return fail(c, 401, 'invalid_signature', 'Signature check failed.');

    const rawBody = new Uint8Array(await c.req.arrayBuffer());
    const result = await ingestWebhook(c.env, adapter, c.req.raw.headers, rawBody, {
      organizationId: orgId,
    });
    if (result.status === 401) return fail(c, 401, 'invalid_signature', 'Signature check failed.');
    const fields = formFields(rawBody);
    if (result.status === 400 || fields === null)
      return c.body(plivoXml.hangup(), 200, XML_HEADERS);

    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.slice(0, -ANSWER_SUFFIX.length);
    parsed.search = '';
    return c.body(
      await answerFor(c.env, orgId, found, fields, parsed.toString()),
      200,
      XML_HEADERS,
    );
  });
