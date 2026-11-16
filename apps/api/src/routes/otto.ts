import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
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
import {
  CONTACT_ID_PATTERN,
  findContact,
  refuseAccess,
  rejectMalformedContactId,
  writableAccess,
} from '../lib/contact-access';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';
import { completeWithCitations } from '../otto/complete';
import { aiProviderFor } from '../otto/provider';
import { contactSources, digestSources, type OttoSource } from '../otto/sources';

export const OTTO_DAILY_LIMIT = 50;
const MAX_INSTRUCTION_LENGTH = 300;
const HOUR_MS = 3_600_000;
const DEFAULT_SINCE_MS = 24 * HOUR_MS;
const MAX_SINCE_MS = 7 * 24 * HOUR_MS;
const CAUGHT_UP = "You're all caught up.";

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
    409: errorResponse('No active organization'),
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
    409: errorResponse('No active organization'),
    429: errorResponse("Otto has reached today's limit"),
    503: errorResponse('Otto is unavailable'),
  },
});

const todayStartUtc = sql`date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`;

/**
 * Per user per organization (Phase 1 organizations are personal). The advisory lock serializes a
 * user's concurrent Otto requests for the rest of the transaction, so the count below cannot be
 * raced past the limit: the usage row is only inserted after the provider returns.
 */
async function quotaReached(tx: Tx, userId: string): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`otto:${userId}`}, 0))`);
  const [row] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.service, 'ai'),
        eq(usageEvent.userId, userId),
        sql`${usageEvent.occurredAt} >= ${todayStartUtc}`,
      ),
    );
  return (row?.used ?? 0) >= OTTO_DAILY_LIMIT;
}

interface RunInput {
  kind: OttoDraftKind;
  contactId: string | null;
  channel: 'sms' | 'whatsapp' | null;
  instruction: string | null;
  prompt: string;
  sources: OttoSource[];
}

type RunResult =
  | { status: 'ok'; row: OttoDraftRow }
  | { status: 'quota_exceeded' }
  | { status: 'ai_unavailable' };

/** Calls the provider and stores the draft, the usage event and the audit row in `tx`. */
async function runOtto(
  tx: Tx,
  tenant: Tenant,
  ai: ReturnType<typeof aiProviderFor>,
  input: RunInput,
): Promise<RunResult> {
  const { kind, sources } = input;
  let text = CAUGHT_UP;
  let citations: OttoCitation[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  const callsProvider = !(kind === 'digest' && sources.length === 0);
  if (callsProvider) {
    // The provider call stays inside the transaction (the lock above must span it). When a real,
    // slow provider lands, split here: reserve quota, commit, call, then record the result.
    if (await quotaReached(tx, tenant.userId)) return { status: 'quota_exceeded' };
    const result = await completeWithCitations(ai.provider, {
      purpose: kind,
      prompt: input.prompt,
      sources: sources.map((s) => ({ kind: s.kind, ref: s.ref, text: s.text })),
    });
    if (!result.ok) return { status: 'ai_unavailable' };
    text = result.value.text;
    usage = result.value.usage;
    const byRef = new Map(sources.map((s) => [s.ref, s]));
    citations = result.value.citations.flatMap((ref) => {
      const s = byRef.get(ref);
      return s ? [{ ref, kind: s.kind, label: s.label }] : [];
    });
  }
  const [row] = await tx
    .insert(ottoDraft)
    .values({
      organizationId: tenant.orgId,
      userId: tenant.userId,
      kind,
      contactId: input.contactId,
      channel: input.channel,
      instruction: input.instruction,
      text,
      citations,
      provider: ai.name,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    .returning();
  if (!row) throw new Error('otto draft insert returned no row');
  if (callsProvider) {
    await tx.insert(usageEvent).values({
      organizationId: tenant.orgId,
      userId: tenant.userId,
      service: 'ai',
      quantity: usage.inputTokens + usage.outputTokens,
      unit: 'tokens',
      costMicros: 0,
      provider: ai.name,
      refType: 'otto_draft',
      refId: row.id,
      idempotencyKey: `otto:${row.id}`,
    });
  }
  // Never put text, prompts or the instruction in `metadata`: they are PII.
  await tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'otto_draft',
    action: `otto.${kind}`,
    outcome: 'allowed',
    entityId: row.id,
    metadata: { kind, ...usage },
  });
  return { status: 'ok', row };
}

function failedRun(c: Parameters<typeof fail>[0], result: Exclude<RunResult, { status: 'ok' }>) {
  if (result.status === 'quota_exceeded') {
    return fail(
      c,
      429,
      'quota_exceeded',
      `Otto has reached today's limit of ${OTTO_DAILY_LIMIT} requests.`,
    );
  }
  return fail(c, 503, 'ai_unavailable', 'Otto is unavailable right now.');
}

function draftPrompt(name: string, channel: string | null, instruction: string | null): string {
  const lines = [`Contact: ${name}`];
  if (channel) lines.push(`Channel: ${channel}`);
  if (instruction) lines.push(`Instruction: ${instruction}`);
  return lines.join('\n');
}

export const otto = new OpenAPIHono<AppEnv>()
  .openapi(draftRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    if (!CONTACT_ID_PATTERN.test(body.contactId)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.read');
    }
    const ai = aiProviderFor(c.env);
    const channel = body.kind === 'draft' ? (body.channel ?? 'sms') : null;
    const instruction = body.instruction || null;
    const outcome = await withTenant(db, tenant.orgId, async (tx) => {
      const access = writableAccess(await findContact(tx, body.contactId, false));
      if (access.kind !== 'ok') return { refused: access.kind, run: undefined } as const;
      const sources = await contactSources(tx, body.contactId, tenant.userId);
      const run = await runOtto(tx, tenant, ai, {
        kind: body.kind,
        contactId: body.contactId,
        channel,
        instruction,
        prompt: draftPrompt(access.row.displayName, channel, instruction),
        sources,
      });
      return { refused: undefined, run } as const;
    });
    if (outcome.refused) {
      return refuseAccess(c, db, tenant, 'contact.read', body.contactId, outcome.refused);
    }
    if (!outcome.run) throw new Error('otto run missing');
    if (outcome.run.status !== 'ok') return failedRun(c, outcome.run);
    return ok(c, toOttoDraftJson(outcome.run.row), 201);
  })
  .openapi(digestRoute, async (c) => {
    const { db, tenant } = c.var;
    const ai = aiProviderFor(c.env);
    const run = await withTenant(db, tenant.orgId, async (tx) => {
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
      return runOtto(tx, tenant, ai, {
        kind: 'digest',
        contactId: null,
        channel: null,
        instruction: null,
        prompt: `Digest since ${since.toISOString()}`,
        sources,
      });
    });
    if (run.status !== 'ok') return failedRun(c, run);
    return ok(c, toOttoDraftJson(run.row), 201);
  });
