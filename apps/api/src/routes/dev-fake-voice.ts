import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { HANGUP_CAUSES, normalizePhone } from '@knoqra/core';
import { type CallRow, call, withTenant } from '@knoqra/db';
import { buildFakeCallEvent, FakeProvider, type ProviderEventType } from '@knoqra/providers';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../env';
import { CALL_ID_PATTERN } from '../lib/call-json';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';
import { loadVoiceChoice } from '../lib/voice-provider';
import { ingestWebhook } from './webhooks';

/**
 * Development driver for the fake voice provider. Each request builds a fake webhook, signs it with
 * FAKE_WEBHOOK_SECRET and runs it through `ingestWebhook` with the real queue binding, so it walks
 * the whole pipeline. 404 in production and whenever the workspace is not on the fake provider.
 */

/** The number inbound fake calls ring, the same one fake outbound calls come from. */
const FAKE_INBOUND_TO = '+12025550100';
const FAKE_VOICEMAIL_TRANSCRIPT = "Hi, it's about Thursday's review. Call me back.";
const FAKE_VOICEMAIL_SECONDS = 22;
const MAX_SECONDS = 24 * 60 * 60;

const EVENT_TYPES = {
  initiated: 'call.initiated',
  ringing: 'call.ringing',
  answered: 'call.answered',
  completed: 'call.completed',
  failed: 'call.failed',
  voicemail: 'call.voicemail',
} as const satisfies Record<string, ProviderEventType>;
type DevEvent = keyof typeof EVENT_TYPES;

const EventBody = z
  .object({
    event: z.enum(Object.keys(EVENT_TYPES) as [DevEvent, ...DevEvent[]]),
    hangupCause: z.enum(HANGUP_CAUSES).optional(),
    billableSeconds: z.number().int().min(0).max(MAX_SECONDS).optional(),
    transcript: safeText({ max: 2000 }).optional(),
    durationSeconds: z.number().int().min(0).max(MAX_SECONDS).optional(),
  })
  .openapi('FakeVoiceEvent');

const InboundBody = z
  .object({
    from: safeText({ min: 1, max: 64 }).openapi({ example: '+12025550142' }),
    scenario: z.enum(['ring', 'voicemail']),
  })
  .openapi('FakeVoiceInbound');

const AcceptedSchema = z.object({ accepted: z.literal(true) }).openapi('FakeVoiceAccepted');
const InboundSchema = z.object({ providerCallId: z.string() }).openapi('FakeVoiceInboundAccepted');

const CallIdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const unavailable = 'Not production, and the workspace uses the fake provider';

const eventRoute = createRoute({
  method: 'post',
  path: '/api/v1/dev/fake-voice/calls/{id}/events',
  tags: ['dev'],
  summary: 'Development only: send a fake provider event for one of your calls',
  security,
  request: { params: CallIdParam, body: { required: true, content: json(EventBody) } },
  responses: {
    202: {
      description: 'Queued for the event pipeline',
      content: json(okEnvelope(AcceptedSchema)),
    },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse(`No such call, or unavailable (${unavailable})`),
    409: errorResponse('No active organization'),
  },
});

const inboundRoute = createRoute({
  method: 'post',
  path: '/api/v1/dev/fake-voice/inbound',
  tags: ['dev'],
  summary: 'Development only: ring the workspace with a fake inbound call',
  security,
  request: { body: { required: true, content: json(InboundBody) } },
  responses: {
    202: { description: 'Queued for the event pipeline', content: json(okEnvelope(InboundSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse(`Unavailable (${unavailable})`),
    409: errorResponse('No active organization'),
    422: errorResponse('The caller number is not a valid phone number'),
  },
});

/** The dev driver exists only outside production and with the fake webhook secret configured. */
const driverAvailable = (env: Env): boolean =>
  env.APP_ENV !== 'production' && Boolean(env.FAKE_WEBHOOK_SECRET);

/**
 * Runs before route validation, so a production deployment answers every `/api/v1/dev/*` request
 * with a plain 404 and never reveals the request schema.
 */
const devGate = createMiddleware<AppEnv>(async (c, next) => {
  if (!driverAvailable(c.env)) return fail(c, 404, 'not_found', 'No such route.');
  await next();
});

/** The fake provider signer, or null when this workspace is not on the fake provider. */
async function fakeSigner(c: Context<AppEnv>): Promise<FakeProvider | null> {
  const { db, tenant } = c.var;
  if (!driverAvailable(c.env) || !c.env.FAKE_WEBHOOK_SECRET) return null;
  const choice = await withTenant(db, tenant.orgId, (tx) => loadVoiceChoice(tx, c.env));
  if (choice.kind !== 'fake') return null;
  return new FakeProvider({ webhookSecret: c.env.FAKE_WEBHOOK_SECRET });
}

/** Signs `body` and ingests it exactly as POST /webhooks/fake would. */
async function send(env: Env, signer: FakeProvider, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const headers = new Headers({ 'x-fake-signature': await signer.signWebhook(bytes) });
  const result = await ingestWebhook(env, signer, headers, bytes);
  if (result.status !== 200) throw new Error(`fake event rejected at ingest (${result.status})`);
}

function eventPayload(row: CallRow, body: z.infer<typeof EventBody>): Record<string, unknown> {
  return {
    client_state: row.clientState,
    direction: row.direction,
    from: row.fromE164,
    to: row.toE164,
    ...(body.hangupCause === undefined ? {} : { hangup_cause: body.hangupCause }),
    ...(body.billableSeconds === undefined ? {} : { billable_seconds: body.billableSeconds }),
    ...(body.transcript === undefined ? {} : { transcript: body.transcript }),
    ...(body.durationSeconds === undefined ? {} : { duration_seconds: body.durationSeconds }),
  };
}

const notFound = (c: Context<AppEnv>) => fail(c, 404, 'not_found', 'Not found.');

export const devFakeVoice = new OpenAPIHono<AppEnv>();
devFakeVoice.use('/api/v1/dev/*', devGate);
devFakeVoice
  .openapi(eventRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const signer = await fakeSigner(c);
    if (!signer || !CALL_ID_PATTERN.test(id)) return notFound(c);
    const [row] = await withTenant(db, tenant.orgId, (tx) =>
      tx.select().from(call).where(eq(call.id, id)).limit(1),
    );
    if (row?.provider !== 'fake') return notFound(c);
    const event = buildFakeCallEvent({
      type: EVENT_TYPES[body.event],
      // A call the browser dialed has no provider id yet; derive a stable one from the call.
      providerCallId: row.providerCallId ?? `fake_call_${row.id.slice(3)}`,
      payload: eventPayload(row, body),
    });
    await send(c.env, signer, event.body);
    return ok(c, { accepted: true as const }, 202);
  })
  .openapi(inboundRoute, async (c) => {
    const { tenant } = c.var;
    const body = c.req.valid('json');
    const signer = await fakeSigner(c);
    if (!signer) return notFound(c);
    const from = normalizePhone(body.from);
    if (!from.ok) return fail(c, 422, 'invalid_phone', 'Enter a valid phone number.');
    const providerCallId = `fake_in_${crypto.randomUUID().replaceAll('-', '')}`;
    const payload = {
      direction: 'inbound',
      from: from.value,
      to: FAKE_INBOUND_TO,
      org_id: tenant.orgId,
    };
    const ring = buildFakeCallEvent({ type: 'call.initiated', providerCallId, payload });
    await send(c.env, signer, ring.body);
    if (body.scenario === 'voicemail') {
      const left = buildFakeCallEvent({
        type: 'call.voicemail',
        providerCallId,
        // Strictly after the ring, so the timeline orders them correctly.
        occurredAt: new Date(Date.now() + 1000).toISOString(),
        payload: {
          ...payload,
          duration_seconds: FAKE_VOICEMAIL_SECONDS,
          transcript: FAKE_VOICEMAIL_TRANSCRIPT,
        },
      });
      await send(c.env, signer, left.body);
    }
    return ok(c, { providerCallId }, 202);
  });
