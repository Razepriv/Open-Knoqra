import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  type Contact,
  contact,
  contactDuplicateDismissal,
  contactPermissionEvent,
  type Tx,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import {
  type AnyColumn,
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import {
  auditContactAlone,
  CONTACT_ID_PATTERN,
  ContactIdParam,
  insertContactAudit,
  notFound,
  rejectMalformedContactId,
  writableAccess,
} from '../lib/contact-access';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { retryOnConflict } from '../lib/retry';
import { safeText } from '../lib/schemas';
import { moveConversationsOnMerge } from '../messaging/store';
import { consentToKeepOnMerge, recordKeptConsent } from './contact-permissions';
import { ContactSchema, toContactJson } from './contacts';

const MAX_SUGGESTIONS = 5;
const MAX_TAGS = 20;
const REASONS = ['same_name', 'same_email', 'same_name_and_company'] as const;

const SuggestionSchema = z
  .object({ contact: ContactSchema, reasons: z.array(z.enum(REASONS)) })
  .openapi('DuplicateSuggestion');
const SuggestionsSchema = z
  .object({ items: z.array(SuggestionSchema) })
  .openapi('DuplicateSuggestions');

const DismissParams = ContactIdParam.extend({
  otherId: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'otherId', in: 'path' } }),
});
const MergeBody = z
  .object({ sourceId: safeText({ min: 1, max: 64 }) })
  .openapi('MergeContact', { description: 'The contact to merge into the path contact.' });

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const suggestRoute = createRoute({
  method: 'get',
  path: '/api/v1/contacts/{id}/duplicates',
  tags: ['contacts'],
  summary: 'Up to five likely duplicates of a contact',
  security,
  request: { params: ContactIdParam },
  responses: {
    200: { description: 'Suggestions', content: json(okEnvelope(SuggestionsSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const dismissRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/{id}/duplicates/{otherId}/dismiss',
  tags: ['contacts'],
  summary: 'Mark two contacts as not duplicates (idempotent)',
  security,
  request: { params: DismissParams },
  responses: {
    204: { description: 'Dismissed' },
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('A contact cannot be dismissed against itself'),
  },
});

const mergeRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/{id}/merge',
  tags: ['contacts'],
  summary: 'Merge a source contact into this one',
  security,
  request: { params: ContactIdParam, body: { required: true, content: json(MergeBody) } },
  responses: {
    200: { description: 'The merged (target) contact', content: json(okEnvelope(ContactSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('Self merge, or a contact that is merged or archived'),
  },
});

/** Lower-cased name with runs of whitespace collapsed and the ends trimmed. */
const normalizedName = (value: SQL | AnyColumn | string) =>
  sql`lower(btrim(regexp_replace(${value}, '\\s+', ' ', 'g')))`;

type Reason = (typeof REASONS)[number];

async function suggestions(tx: Tx, subject: Contact) {
  // name_key and email_key are stored generated columns holding exactly normalizedName(display_name)
  // and lower(email), so these compare as index conditions under RLS (migration 0012).
  const sameName = sql<boolean>`${contact.nameKey} = ${normalizedName(subject.displayName)}`;
  // The is-not-null guard keeps this false, never null, for a contact without an email: the
  // ranking below adds the flags as ints, and a null would void the whole score.
  const sameEmail =
    subject.email === null
      ? sql<boolean>`false`
      : sql<boolean>`(${contact.emailKey} is not null and ${contact.emailKey} = lower(${subject.email}))`;
  const sameCompany =
    subject.company === null
      ? sql<boolean>`false`
      : sql<boolean>`(${contact.company} is not null and lower(${contact.company}) = lower(${subject.company}))`;
  const dismissed = sql`exists (select 1 from ${contactDuplicateDismissal} d
    where (d.contact_a_id = ${subject.id} and d.contact_b_id = ${contact.id})
       or (d.contact_a_id = ${contact.id} and d.contact_b_id = ${subject.id}))`;
  const rows = await tx
    .select({
      row: getTableColumns(contact),
      sameName,
      sameEmail,
      sameCompany,
    })
    .from(contact)
    .where(
      and(
        sql`${contact.id} <> ${subject.id}`,
        isNull(contact.archivedAt),
        isNull(contact.mergedIntoId),
        or(sameName, sameEmail),
        sql`not ${dismissed}`,
      ),
    )
    .orderBy(
      sql`((${sameName})::int + (${sameEmail})::int + ((${sameName} and ${sameCompany}))::int) desc`,
      asc(contact.sortName),
      sql`${contact.id} collate "C"`,
    )
    .limit(MAX_SUGGESTIONS);
  return rows.map((r) => {
    const reasons: Reason[] = [];
    if (r.sameName) reasons.push('same_name');
    if (r.sameEmail) reasons.push('same_email');
    if (r.sameName && r.sameCompany) reasons.push('same_name_and_company');
    return { contact: toContactJson(r.row), reasons };
  });
}

/**
 * Locks both rows in ascending id order (byte order), so opposite merges and dismisses cannot
 * deadlock each other. Import locks by phone instead, so the routes retry once on a deadlock.
 */
async function lockBoth(tx: Tx, targetId: string, sourceId: string) {
  const rows = await tx
    .select()
    .from(contact)
    // The comment tags this statement in pg_stat_activity so lock-wait tests can find it.
    .where(and(inArray(contact.id, [targetId, sourceId]), sql`/* knoqra:lock-pair */ true`))
    .orderBy(sql`${contact.id} collate "C"`)
    .for('update');
  return {
    target: rows.find((r) => r.id === targetId),
    source: rows.find((r) => r.id === sourceId),
  };
}

export type MergeOutcome =
  | { kind: 'merged'; target: Contact }
  | { kind: 'not_found'; id: string }
  | { kind: 'source_unmergeable' }
  | { kind: 'target_unmergeable' };

/**
 * Merges `sourceId` into `targetId` inside the caller's tenant transaction. Exported so tests can
 * hold a merge open while racing other writers against it.
 */
export async function mergeInto(
  tx: Tx,
  tenant: Tenant,
  targetId: string,
  sourceId: string,
): Promise<MergeOutcome> {
  const { target, source } = await lockBoth(tx, targetId, sourceId);
  // Re-check after locking: a concurrent merge may have retired either row while we waited.
  if (!target) return { kind: 'not_found', id: targetId };
  if (!source) return { kind: 'not_found', id: sourceId };
  if (writableAccess(source).kind !== 'ok') return { kind: 'source_unmergeable' };
  if (writableAccess(target).kind !== 'ok') return { kind: 'target_unmergeable' };

  // Read both contacts' consent before the histories combine: per channel the more restrictive
  // current status is kept, even when the other contact's grant is newer.
  const keptConsent = await consentToKeepOnMerge(tx, target.id, source.id);

  // History moves with the source. Only contact_id is updated (the one column knoqra_app may
  // change); nothing is deleted.
  await tx
    .update(timelineEvent)
    .set({ contactId: target.id })
    .where(eq(timelineEvent.contactId, source.id));
  await tx
    .update(contactPermissionEvent)
    .set({ contactId: target.id })
    .where(eq(contactPermissionEvent.contactId, source.id));
  // Inbox threads follow too: one thread per channel survives, holding both contacts' messages.
  const conversations = await moveConversationsOnMerge(tx, tenant.orgId, target.id, source.id);
  await tx
    .delete(contactDuplicateDismissal)
    .where(
      or(
        eq(contactDuplicateDismissal.contactAId, source.id),
        eq(contactDuplicateDismissal.contactBId, source.id),
      ),
    );

  const [merged] = await tx
    .update(contact)
    .set({
      company: target.company ?? source.company,
      email: target.email ?? source.email,
      jobTitle: target.jobTitle ?? source.jobTitle,
      timezone: target.timezone ?? source.timezone,
      tags: [...new Set([...target.tags, ...source.tags])].slice(0, MAX_TAGS),
    })
    .where(eq(contact.id, target.id))
    .returning();
  if (!merged) throw new Error('merge target update returned no row');
  await tx
    .update(contact)
    .set({ mergedIntoId: target.id, archivedAt: sql`now()` })
    .where(eq(contact.id, source.id));

  await tx.insert(timelineEvent).values({
    organizationId: tenant.orgId,
    contactId: target.id,
    kind: 'system',
    title: `Merged ${source.displayName} into this contact`,
    actorUserId: tenant.userId,
    source: 'app',
    refType: 'contact',
    refId: source.id,
    occurredAt: sql`clock_timestamp()`,
  });
  await recordKeptConsent(tx, tenant, target.id, source.id, keptConsent);
  await insertContactAudit(tx, tenant, {
    action: 'contact.merge',
    outcome: 'allowed',
    entityId: target.id,
    // Conversation ids only (never bodies or numbers), so a folded thread's notes can be traced.
    metadata: {
      sourceId: source.id,
      keptConsent: keptConsent.map((k) => k.channel),
      conversations,
    },
  });
  return { kind: 'merged', target: merged };
}

export const contactDuplicates = new OpenAPIHono<AppEnv>()
  .openapi(suggestRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.duplicates.read');
    }
    const items = await withTenant(db, tenant.orgId, async (tx) => {
      const [subject] = await tx.select().from(contact).where(eq(contact.id, id)).limit(1);
      if (!subject) return undefined;
      return writableAccess(subject).kind === 'ok' ? suggestions(tx, subject) : [];
    });
    if (!items) return notFound(c, db, tenant, 'contact.duplicates.read', id);
    return ok(c, { items }, 200);
  })
  .openapi(dismissRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id, otherId } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id) || !CONTACT_ID_PATTERN.test(otherId)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.duplicate.dismiss');
    }
    if (id === otherId) {
      await auditContactAlone(db, tenant, {
        action: 'contact.duplicate.dismiss',
        outcome: 'denied',
        entityId: id,
        metadata: { reason: 'self' },
      });
      return fail(c, 422, 'validation_error', 'A contact cannot be dismissed against itself');
    }
    const outcome = await retryOnConflict(() =>
      withTenant(db, tenant.orgId, async (tx) => {
        // Same lock order as merge. Dismiss refuses merged contacts, and merge removes any
        // dismissal that was committed first, so no dismissal ever names a merged source.
        const { target: subject, source: other } = await lockBoth(tx, id, otherId);
        if (!subject) return { kind: 'not_found', id } as const;
        if (!other) return { kind: 'not_found', id: otherId } as const;
        if (subject.mergedIntoId || other.mergedIntoId) return { kind: 'merged' } as const;
        // Ids are ASCII hex, so code-unit order equals the table's COLLATE "C" check.
        const [a, b] = id < otherId ? [id, otherId] : [otherId, id];
        await tx
          .insert(contactDuplicateDismissal)
          .values({
            organizationId: tenant.orgId,
            contactAId: a,
            contactBId: b,
            dismissedBy: tenant.userId,
          })
          .onConflictDoNothing();
        await insertContactAudit(tx, tenant, {
          action: 'contact.duplicate.dismiss',
          outcome: 'allowed',
          entityId: id,
          metadata: { otherId },
        });
        return { kind: 'ok' } as const;
      }),
    );
    if (outcome.kind === 'not_found') {
      return notFound(c, db, tenant, 'contact.duplicate.dismiss', outcome.id);
    }
    if (outcome.kind === 'merged') {
      await auditContactAlone(db, tenant, {
        action: 'contact.duplicate.dismiss',
        outcome: 'denied',
        entityId: id,
        metadata: { reason: 'merged', otherId },
      });
      return fail(c, 422, 'validation_error', 'This contact was already merged');
    }
    return c.body(null, 204);
  })
  .openapi(mergeRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.merge');
    }
    const { sourceId } = c.req.valid('json');
    if (!CONTACT_ID_PATTERN.test(sourceId)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.merge');
    }
    if (sourceId === id) {
      await auditContactAlone(db, tenant, {
        action: 'contact.merge',
        outcome: 'denied',
        entityId: id,
        metadata: { reason: 'self' },
      });
      return fail(c, 422, 'validation_error', 'A contact cannot be merged into itself');
    }
    const result = await retryOnConflict(() =>
      withTenant(db, tenant.orgId, (tx) => mergeInto(tx, tenant, id, sourceId)),
    );
    if (result.kind === 'merged') return ok(c, toContactJson(result.target), 200);
    if (result.kind === 'not_found') return notFound(c, db, tenant, 'contact.merge', result.id);
    const reason = result.kind === 'source_unmergeable' ? 'source' : 'target';
    await auditContactAlone(db, tenant, {
      action: 'contact.merge',
      outcome: 'denied',
      entityId: id,
      metadata: { reason: `${reason}_merged_or_archived`, sourceId },
    });
    return fail(
      c,
      422,
      'validation_error',
      result.kind === 'source_unmergeable'
        ? 'This contact was already merged or archived'
        : 'Restore this contact first',
    );
  });
