import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { newId } from '@knoqra/core';
import {
  auditEvent,
  type OttoCitation,
  type OttoDraftKind,
  type OttoDraftRow,
  ottoDraft,
  type Tx,
  usageEvent,
  withTenant,
} from '@knoqra/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  CONTACT_ID_PATTERN,
  findContact,
  refuseAccess,
  rejectMalformedContactId,
  writableAccess,
} from '../lib/contact-access';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { safeText } from '../lib/schemas';
import { type OttoAccess, resolveOttoAccess } from '../otto/access';
import { completeWithCitations, type OttoFailure } from '../otto/complete';
import { aiProviderFor } from '../otto/provider';
import { contactSources, digestSources, type OttoSource } from '../otto/sources';

const MAX_INSTRUCTION_LENGTH = 300;
const HOUR_MS = 3_600_000;
const DEFAULT_SINCE_MS = 24 * HOUR_MS;
const MAX_SINCE_MS = 7 * 24 * HOUR_MS;
const CAUGHT_UP = "You're all caught up.";
/** A model call that takes longer than this is cut off and answered as unavailable. */
const MODEL_TIMEOUT_MS = 90_000;

export const OttoDraftSchema = z
  .object({
    id: z.string().openapi({ example: 'od_0123456789abcdef0123456789abcdef' }),
    kind: z.enum(['draft', 'brief', 'digest']),
    contactId: z.string().nullable(),
    channel: z.enum(['sms', 'whatsapp']).nullable(),
    text: z.string(),
    citations: z.array(
      z.object({
        ref: z.string(),
        kind: z.enum(['contact', 'timeline', 'task', 'notification']),
        label: z.string(),
      }),
    ),
    usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }),
    createdAt: z.iso.datetime(),
  })
  .openapi('OttoDraft');
export type OttoDraftJson = z.infer<typeof OttoDraftSchema>;

const CreateOttoDraftBody = z
  .object({
    kind: z.enum(['draft', 'brief']),
    contactId: z.string().min(1).max(64),
    channel: z.enum(['sms', 'whatsapp']).optional(),
    instruction: safeText({ max: MAX_INSTRUCTION_LENGTH }).optional(),
  })
  .openapi('CreateOttoDraft');

const DigestBody = z.object({}).openapi('CreateOttoDigest');

export function toOttoDraftJson(row: OttoDraftRow): OttoDraftJson {
  return {
    id: row.id,
    kind: row.kind,
    contactId: row.contactId,
    channel: row.channel,
    text: row.text,
    citations: row.citations,
    usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
    createdAt: row.createdAt.toISOString(),
  };
}

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const draftRoute = createRoute({
  method: 'post',
  path: '/api/v1/otto/drafts',
  tags: ['otto'],
  summary: 'Ask Otto for a message draft or a brief about a contact. Nothing is ever sent.',
  security,
  request: { body: { required: true, content: json(CreateOttoDraftBody) } },
  responses: {
    201: {
      description: 'Otto output with its sources',
      content: json(okEnvelope(OttoDraftSchema)),
    },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    402: errorResponse('Otto is not included in this plan: upgrade or connect your own key'),
    409: errorResponse('No active organization, or Otto is not connected to a model'),
    422: errorResponse('The contact is archived or merged'),
    429: errorResponse("Otto has reached today's limit"),
    503: errorResponse('Otto is unavailable'),
  },
});

const digestRoute = createRoute({
  method: 'post',
  path: '/api/v1/otto/digest',
  tags: ['otto'],
  summary: 'Ask Otto what happened since the last digest',
  security,
  request: { body: { required: true, content: json(DigestBody) } },
  responses: {
    201: {
      description: 'Otto digest with its sources',
      content: json(okEnvelope(OttoDraftSchema)),
    },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    402: errorResponse('Otto is not included in this plan: upgrade or connect your own key'),
    409: errorResponse('No active organization, or Otto is not connected to a model'),
    429: errorResponse("Otto has reached today's limit"),
    503: errorResponse('Otto is unavailable'),
  },
});

const STREAM_DESCRIPTION =
  'Server-sent events: `delta` events with `{ text }` pieces, then `done` with the stored OttoDraft, or `error` with `{ code, message }`.';
const sse = { 'text/event-stream': { schema: z.string() } };

const draftStreamRoute = createRoute({
  ...draftRoute,
  path: '/api/v1/otto/drafts/stream',
  summary: 'Like POST /api/v1/otto/drafts, with the text streamed as Otto writes it',
  responses: { ...draftRoute.responses, 200: { description: STREAM_DESCRIPTION, content: sse } },
});

const digestStreamRoute = createRoute({
  ...digestRoute,
  path: '/api/v1/otto/digest/stream',
  summary: 'Like POST /api/v1/otto/digest, with the text streamed as Otto writes it',
  responses: { ...digestRoute.responses, 200: { description: STREAM_DESCRIPTION, content: sse } },
});

const todayStartUtc = sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;

/**
 * Per workspace. The advisory lock serializes the workspace's concurrent Otto requests until the
 * reservation below commits, so the count cannot be raced past the limit.
 */
async function quotaReached(tx: Tx, orgId: string, limit: number): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`otto:${orgId}`}, 0))`);
  const [row] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(usageEvent)
    .where(and(eq(usageEvent.service, 'ai'), sql`${usageEvent.occurredAt} >= ${todayStartUtc}`));
  return (row?.used ?? 0) >= limit;
}

/** The workspace's Otto requests so far today (UTC), for Settings. */
export async function requestsToday(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(usageEvent)
    .where(and(eq(usageEvent.service, 'ai'), sql`${usageEvent.occurredAt} >= ${todayStartUtc}`));
  return row?.used ?? 0;
}

interface RunInput {
  kind: OttoDraftKind;
  contactId: string | null;
  channel: 'sms' | 'whatsapp' | null;
  instruction: string | null;
  prompt: string;
  sources: OttoSource[];
}

type ReadyAccess = Extract<OttoAccess, { ready: true }>;

/** A request that passed every check and holds a reserved slot of today's limit. */
interface PendingRun {
  access: ReadyAccess;
  draftId: string;
  input: RunInput;
}

type Started =
  | { status: 'run'; pending: PendingRun }
  | { status: 'done'; row: OttoDraftRow }
  | { status: 'quota_exceeded'; limit: number }
  | { status: 'not_connected'; access: Extract<OttoAccess, { ready: false }> };

async function storeDraft(
  tx: Tx,
  tenant: Tenant,
  draft: {
    id?: string;
    input: RunInput;
    provider: string;
    text: string;
    citations: OttoCitation[];
    usage: { inputTokens: number; outputTokens: number };
  },
): Promise<OttoDraftRow> {
  const { kind } = draft.input;
  const [row] = await tx
    .insert(ottoDraft)
    .values({
      ...(draft.id ? { id: draft.id } : {}),
      organizationId: tenant.orgId,
      userId: tenant.userId,
      kind,
      contactId: draft.input.contactId,
      channel: draft.input.channel,
      instruction: draft.input.instruction,
      text: draft.text,
      citations: draft.citations,
      provider: draft.provider,
      inputTokens: draft.usage.inputTokens,
      outputTokens: draft.usage.outputTokens,
    })
    .returning();
  if (!row) throw new Error('otto draft insert returned no row');
  // Never put text, prompts or the instruction in `metadata`: they are PII.
  await tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'otto_draft',
    action: `otto.${kind}`,
    outcome: 'allowed',
    entityId: row.id,
    metadata: { kind, provider: draft.provider, ...draft.usage },
  });
  return row;
}

/**
 * The first half of a request, inside the tenant transaction: who answers, today's limit, and a
 * reserved slot (one `ai` usage row per request, written before the model is called so it counts
 * even while the answer is still streaming). The model is called after this commits, so no
 * transaction stays open while it writes.
 */
async function startRun(
  tx: Tx,
  tenant: Tenant,
  env: AppEnv['Bindings'],
  input: RunInput,
): Promise<Started> {
  const access = await resolveOttoAccess(tx, env);
  if (!access.ready) return { status: 'not_connected', access };
  if (input.kind === 'digest' && input.sources.length === 0) {
    const row = await storeDraft(tx, tenant, {
      input,
      provider: access.providerName,
      text: CAUGHT_UP,
      citations: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    return { status: 'done', row };
  }
  if (await quotaReached(tx, tenant.orgId, access.dailyLimit)) {
    return { status: 'quota_exceeded', limit: access.dailyLimit };
  }
  const draftId = newId('od');
  await tx.insert(usageEvent).values({
    organizationId: tenant.orgId,
    userId: tenant.userId,
    service: 'ai',
    quantity: 1,
    unit: 'request',
    costMicros: 0,
    provider: access.providerName,
    refType: 'otto_draft',
    refId: draftId,
    idempotencyKey: `otto:${draftId}`,
  });
  return { status: 'run', pending: { access, draftId, input } };
}

/**
 * Calls the model with only the sources gathered for this request, then stores the draft in a
 * second transaction. A failed call keeps its reserved slot: it was a request.
 */
/** What the user is told when the model call fails. Never the provider's own words. */
interface RunFailure {
  code: 'ai_busy' | 'ai_unavailable';
  message: string;
}
const UNAVAILABLE: RunFailure = {
  code: 'ai_unavailable',
  message: 'Otto is unavailable right now.',
};
export const BUSY_MESSAGE = 'Otto is busy right now. Try again in a minute.';
export const BUSY_EARLY_ACCESS_MESSAGE =
  'Otto is busy right now (early access). Try again in a minute.';

/**
 * A busy shared model (the plan's or the server's) says "busy", not "broken". On a workspace's
 * own key a 429 may mean its OpenAI account is out of credit, so it stays "unavailable". A model
 * with no endpoint that passes the privacy filters is logged loudly for the owner to fix.
 */
export function userFailure(access: ReadyAccess, failure: OttoFailure): RunFailure {
  if (failure === 'ai_no_private_endpoint') {
    const model = access.connection.kind === 'mock' ? null : access.connection.model;
    logger.error('otto.no_private_endpoint', {
      model,
      fix: 'No endpoint of this model neither trains on nor keeps prompts. Set OTTO_PLATFORM_MODEL to another model (docs/pro/otto.md).',
    });
    return UNAVAILABLE;
  }
  const shared = access.mode === 'included' || access.mode === 'instance';
  if (failure === 'ai_busy' && shared) {
    return {
      code: 'ai_busy',
      message: access.earlyAccess ? BUSY_EARLY_ACCESS_MESSAGE : BUSY_MESSAGE,
    };
  }
  return UNAVAILABLE;
}

async function finishRun(
  c: Ctx,
  pending: PendingRun,
  onText?: (delta: string) => void,
): Promise<{ row: OttoDraftRow } | { failure: RunFailure }> {
  const { access, input } = pending;
  const result = await completeWithCitations(
    aiProviderFor(access.connection),
    {
      purpose: input.kind,
      prompt: input.prompt,
      sources: input.sources.map((s) => ({ kind: s.kind, ref: s.ref, text: s.text })),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    },
    onText,
  );
  if (!result.ok) return { failure: userFailure(access, result.error) };
  const byRef = new Map(input.sources.map((s) => [s.ref, s]));
  const citations = result.value.citations.flatMap((ref) => {
    const s = byRef.get(ref);
    return s ? [{ ref, kind: s.kind, label: s.label }] : [];
  });
  const { db, tenant } = c.var;
  const row = await withTenant(db, tenant.orgId, (tx) =>
    storeDraft(tx, tenant, {
      id: pending.draftId,
      input,
      provider: access.providerName,
      text: result.value.text,
      citations,
      usage: result.value.usage,
    }),
  );
  return { row };
}

// biome-ignore lint/suspicious/noExplicitAny: shared by routes whose input types differ.
type Ctx = Context<AppEnv, string, any>;

function refusedStart(c: Ctx, started: Exclude<Started, { status: 'run' | 'done' }>) {
  if (started.status === 'quota_exceeded') {
    return fail(
      c,
      429,
      'quota_exceeded',
      `Otto has reached today's limit of ${started.limit} requests.`,
    );
  }
  if (started.access.mode === 'upgrade') {
    return fail(
      c,
      402,
      'otto_upgrade_required',
      'Your plan does not include Otto. Upgrade, or connect your own OpenAI key in Settings.',
    );
  }
  return fail(c, 409, 'otto_not_connected', 'Connect Otto to OpenAI in Settings first.');
}

/** What a draft or digest request needs before the model is called: an answer, or a pending run. */
type Prepared = { response: Response } | { row: OttoDraftRow } | { pending: PendingRun };

async function prepareDraft(c: Ctx, body: z.infer<typeof CreateOttoDraftBody>): Promise<Prepared> {
  const { db, tenant } = c.var;
  if (!CONTACT_ID_PATTERN.test(body.contactId)) {
    return { response: await rejectMalformedContactId(c, db, tenant, 'contact.read') };
  }
  const channel = body.kind === 'draft' ? (body.channel ?? 'sms') : null;
  const instruction = body.instruction || null;
  const outcome = await withTenant(db, tenant.orgId, async (tx) => {
    const access = writableAccess(await findContact(tx, body.contactId, false));
    if (access.kind !== 'ok') return { refused: access.kind, started: undefined } as const;
    // Only this contact's records go to the model: what the user asked Otto about.
    const sources = await contactSources(tx, body.contactId, tenant.userId);
    const started = await startRun(tx, tenant, c.env, {
      kind: body.kind,
      contactId: body.contactId,
      channel,
      instruction,
      prompt: draftPrompt(access.row.displayName, channel, instruction),
      sources,
    });
    return { refused: undefined, started } as const;
  });
  if (outcome.refused) {
    return {
      response: await refuseAccess(c, db, tenant, 'contact.read', body.contactId, outcome.refused),
    };
  }
  return fromStarted(c, outcome.started);
}

async function prepareDigest(c: Ctx): Promise<Prepared> {
  const { db, tenant } = c.var;
  const started = await withTenant(db, tenant.orgId, async (tx) => {
    const now = Date.now();
    const [last] = await tx
      .select({ createdAt: ottoDraft.createdAt })
      .from(ottoDraft)
      .where(and(eq(ottoDraft.userId, tenant.userId), eq(ottoDraft.kind, 'digest')))
      .orderBy(desc(ottoDraft.createdAt))
      .limit(1);
    const since = new Date(
      last ? Math.max(last.createdAt.getTime(), now - MAX_SINCE_MS) : now - DEFAULT_SINCE_MS,
    );
    const sources = await digestSources(tx, { userId: tenant.userId }, since);
    return startRun(tx, tenant, c.env, {
      kind: 'digest',
      contactId: null,
      channel: null,
      instruction: null,
      prompt: `Digest since ${since.toISOString()}`,
      sources,
    });
  });
  return fromStarted(c, started);
}

function fromStarted(c: Ctx, started: Started | undefined): Prepared {
  if (!started) throw new Error('otto run missing');
  if (started.status === 'run') return { pending: started.pending };
  if (started.status === 'done') return { row: started.row };
  return { response: refusedStart(c, started) };
}

/** The JSON answer: the whole draft at once. */
async function answerJson(c: Ctx, prepared: Prepared) {
  if ('response' in prepared) return prepared.response;
  const done = 'row' in prepared ? prepared : await finishRun(c, prepared.pending);
  if ('failure' in done) return fail(c, 503, done.failure.code, done.failure.message);
  return ok(c, toOttoDraftJson(done.row), 201);
}

/**
 * The streamed answer, as server-sent events: `delta` events carry `{ text }` pieces as the model
 * writes them, then one `done` event carries the stored draft (an `OttoDraft`), or one `error`
 * event carries `{ code, message }`. Checks that fail before the model is called answer with the
 * same JSON errors as the JSON route.
 */
function answerStream(c: Ctx, prepared: Prepared) {
  if ('response' in prepared) return prepared.response;
  c.header('Cache-Control', 'no-store');
  return streamSSE(
    c,
    async (stream) => {
      let done: { row: OttoDraftRow } | { failure: RunFailure };
      if ('row' in prepared) {
        done = prepared;
      } else {
        let writes = Promise.resolve();
        done = await finishRun(c, prepared.pending, (text) => {
          writes = writes.then(() =>
            stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) }),
          );
        });
        await writes;
      }
      if ('failure' in done) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify(done.failure) });
        return;
      }
      const { row } = done;
      await stream.writeSSE({ event: 'done', data: JSON.stringify(toOttoDraftJson(row)) });
    },
    async (error, stream) => {
      // The status line is already sent, so a failure becomes an `error` event. No content logged.
      logger.error('otto.stream_failed', { name: error.name });
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ code: 'internal_error', message: 'Otto could not finish.' }),
      });
    },
  );
}

function draftPrompt(name: string, channel: string | null, instruction: string | null): string {
  const lines = [`Contact: ${name}`];
  if (channel) lines.push(`Channel: ${channel}`);
  if (instruction) lines.push(`Instruction: ${instruction}`);
  return lines.join('\n');
}

/**
 * The answers come from helpers shared by the JSON and streaming routes, so they are plain
 * Responses; their shapes are the route definitions above.
 */
const asDeclared = (response: Response) => response as never;

export const otto = new OpenAPIHono<AppEnv>()
  .openapi(draftRoute, async (c) =>
    asDeclared(await answerJson(c, await prepareDraft(c, c.req.valid('json')))),
  )
  .openapi(digestRoute, async (c) => asDeclared(await answerJson(c, await prepareDigest(c))))
  .openapi(draftStreamRoute, async (c) =>
    asDeclared(answerStream(c, await prepareDraft(c, c.req.valid('json')))),
  )
  .openapi(digestStreamRoute, async (c) => asDeclared(answerStream(c, await prepareDigest(c))));
