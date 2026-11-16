import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { isValidTimeZone, normalizePhone } from '@knoqra/core';
import {
  type Contact,
  contact,
  type Database,
  type Tx,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import { and, asc, eq, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import {
  auditContactAlone,
  CONTACT_ID_PATTERN,
  ContactIdParam,
  findContact,
  insertContactAudit,
  rejectMalformedContactId,
} from '../lib/contact-access';
import {
  blankToNull,
  CONTACT_UNIQUE_PHONE,
  isUniqueViolation,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normalizeTags,
} from '../lib/contact-fields';
import type { AppEnv, Tenant } from '../lib/context';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { isSafeText, SAFE_TEXT_MESSAGE, safeText } from '../lib/schemas';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MIN_PHONE_DIGITS = 3;
const MAX_CURSOR_LENGTH = 1024;
const CLEAR_HINT = 'Send an empty string or null to clear.';

export const ContactSchema = z
  .object({
    id: z.string().openapi({ example: 'ct_0123456789abcdef0123456789abcdef' }),
    organizationId: z.string(),
    displayName: z.string(),
    company: z.string().nullable(),
    phoneE164: z.string().openapi({ example: '+12025550123' }),
    timezone: z.string().nullable(),
    source: z.string(),
    email: z.string().nullable(),
    jobTitle: z.string().nullable(),
    tags: z.array(z.string()),
    sourceDetail: z.string().nullable(),
    archivedAt: z.iso.datetime().nullable(),
    mergedIntoId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Contact');
export type ContactJson = z.infer<typeof ContactSchema>;

/** A valid email, or blank/whitespace which means "no email" (stored as null). */
const EmailField = z.union([
  z.email().trim().max(254).refine(isSafeText, SAFE_TEXT_MESSAGE),
  safeText({ max: 0 }),
]);
const BlankableText = safeText({ max: 120 });
const TimezoneField = safeText({ max: 64 })
  .refine(isValidTimeZone, 'Must be an IANA time zone')
  .openapi({ example: 'America/New_York' });
const TagsField = z.array(safeText({ min: 1, max: MAX_TAG_LENGTH })).max(MAX_TAGS);

const CreateContactBody = z
  .object({
    displayName: safeText({ min: 1, max: 120 }),
    phone: safeText({ max: 64 }).openapi({ example: '(202) 555-0123' }),
    company: BlankableText.optional(),
    email: EmailField.optional(),
    jobTitle: BlankableText.optional(),
    timezone: TimezoneField.optional(),
    tags: TagsField.optional(),
  })
  .openapi('CreateContact');

const UpdateContactBody = z
  .object({
    displayName: safeText({ min: 1, max: 120 }),
    phone: safeText({ max: 64 }),
    company: BlankableText.nullable().openapi({ description: CLEAR_HINT }),
    email: EmailField.nullable().openapi({ description: CLEAR_HINT }),
    jobTitle: BlankableText.nullable().openapi({ description: CLEAR_HINT }),
    timezone: TimezoneField.nullable(),
    tags: TagsField,
  })
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'At least one field is required',
  })
  .openapi('UpdateContact');

const ListQuery = z.object({
  q: safeText({ max: 100 })
    .optional()
    .openapi({ description: 'Matches name, company, email or phone digits.' }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  archived: z.enum(['true', 'false']).default('false'),
});

const ContactPageSchema = z
  .object({ items: z.array(ContactSchema), nextCursor: z.string().nullable() })
  .openapi('ContactPage');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/contacts',
  tags: ['contacts'],
  summary: "A page of the active organization's contacts, ordered by display name",
  security,
  request: { query: ListQuery },
  responses: {
    200: { description: 'Contacts', content: json(okEnvelope(ContactPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const createContactRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts',
  tags: ['contacts'],
  summary: 'Create a contact in the active organization',
  security,
  request: { body: { required: true, content: json(CreateContactBody) } },
  responses: {
    201: { description: 'Created', content: json(okEnvelope(ContactSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    409: errorResponse('A contact with this phone already exists, or no active organization'),
    422: errorResponse('The phone number could not be parsed'),
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/contacts/{id}',
  tags: ['contacts'],
  summary: 'One contact of the active organization',
  security,
  request: { params: ContactIdParam },
  responses: {
    200: { description: 'Contact', content: json(okEnvelope(ContactSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/api/v1/contacts/{id}',
  tags: ['contacts'],
  summary: 'Edit a contact of the active organization',
  security,
  request: { params: ContactIdParam, body: { required: true, content: json(UpdateContactBody) } },
  responses: {
    200: { description: 'Updated contact', content: json(okEnvelope(ContactSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('A contact with this phone already exists, or no active organization'),
    422: errorResponse('The phone could not be parsed, or the contact is merged'),
  },
});

const archiveRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/{id}/archive',
  tags: ['contacts'],
  summary: 'Archive a contact (idempotent)',
  security,
  request: { params: ContactIdParam },
  responses: {
    200: { description: 'Archived contact', content: json(okEnvelope(ContactSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const restoreRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/{id}/restore',
  tags: ['contacts'],
  summary: 'Restore an archived contact (idempotent)',
  security,
  request: { params: ContactIdParam },
  responses: {
    200: { description: 'Restored contact', content: json(okEnvelope(ContactSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('Merged contacts cannot be restored'),
  },
});

export function toContactJson(row: Contact): ContactJson {
  return {
    id: row.id,
    organizationId: row.organizationId,
    displayName: row.displayName,
    company: row.company,
    phoneE164: row.phoneE164,
    timezone: row.timezone,
    source: row.source,
    email: row.email,
    jobTitle: row.jobTitle,
    tags: row.tags,
    sourceDetail: row.sourceDetail,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    mergedIntoId: row.mergedIntoId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Backslash-escapes LIKE metacharacters so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchCondition(q: string): SQL | undefined {
  if (q.length === 0) return undefined;
  const pattern = `%${escapeLike(q)}%`;
  const digits = q.replace(/\D/g, '');
  // search_text is the pre-lowered name, company and email joined by U+001F (ruling R2): one LIKE
  // instead of three ILIKEs, with the same matches. LIKE keeps backslash as its escape character.
  return or(
    sql`${contact.searchText} like lower(${pattern})`,
    digits.length >= MIN_PHONE_DIGITS ? sql`${contact.phoneE164} like ${`%${digits}%`}` : undefined,
  );
}

function archivedCondition(archived: boolean): SQL | undefined {
  return archived
    ? or(isNotNull(contact.archivedAt), isNotNull(contact.mergedIntoId))
    : and(isNull(contact.archivedAt), isNull(contact.mergedIntoId));
}

const DUPLICATE_MESSAGE = 'A contact with this phone number already exists.';

/**
 * Explains a duplicate-phone conflict; the holder lookup is RLS-scoped to the caller's tenant.
 * Only an unmerged contact can hold a number (the phone index is partial), so merged rows are
 * skipped.
 */
async function duplicateMessage(
  db: Database,
  tenant: Tenant,
  phoneE164: string | undefined,
): Promise<string> {
  if (phoneE164 === undefined) return DUPLICATE_MESSAGE;
  const [holder] = await withTenant(db, tenant.orgId, (tx) =>
    tx
      .select({ archivedAt: contact.archivedAt })
      .from(contact)
      .where(and(eq(contact.phoneE164, phoneE164), isNull(contact.mergedIntoId)))
      .limit(1),
  );
  if (holder?.archivedAt) return 'This number belongs to an archived contact. Restore it instead.';
  return DUPLICATE_MESSAGE;
}

type MutationResult = { kind: 'ok'; row: Contact } | { kind: 'not_found' } | { kind: 'merged' };

async function recordChange(
  tx: Tx,
  tenant: Tenant,
  row: Contact,
  action: 'contact.update' | 'contact.archive' | 'contact.restore',
  title: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await insertContactAudit(tx, tenant, { action, outcome: 'allowed', entityId: row.id, metadata });
  await tx.insert(timelineEvent).values({
    organizationId: tenant.orgId,
    contactId: row.id,
    kind: 'system',
    title,
    actorUserId: tenant.userId,
    source: 'app',
  });
}

type ContactChanges = Partial<typeof contact.$inferInsert>;

function diffChanges(
  row: Contact,
  body: z.infer<typeof UpdateContactBody>,
  phoneE164: string | undefined,
): { set: ContactChanges; fields: string[] } {
  const set: ContactChanges = {};
  const fields: string[] = [];
  const track = (field: string, key: keyof ContactChanges, next: unknown, prev: unknown) => {
    if (next === undefined || next === prev) return;
    Object.assign(set, { [key]: next });
    fields.push(field);
  };
  track('displayName', 'displayName', body.displayName, row.displayName);
  track('phone', 'phoneE164', phoneE164, row.phoneE164);
  track('company', 'company', blankToNull(body.company), row.company);
  track('email', 'email', blankToNull(body.email), row.email);
  track('jobTitle', 'jobTitle', blankToNull(body.jobTitle), row.jobTitle);
  track('timezone', 'timezone', body.timezone, row.timezone);
  const tags = body.tags === undefined ? undefined : normalizeTags(body.tags);
  if (tags !== undefined && tags.join('\u0000') !== row.tags.join('\u0000')) {
    set.tags = tags;
    fields.push('tags');
  }
  return { set, fields };
}

export const contacts = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let cursor: { name: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const where = and(
      archivedCondition(query.archived === 'true'),
      searchCondition(query.q ?? ''),
      // sort_name is the stored lower(display_name): a plain column, so under RLS the row
      // comparison is an index condition on contact_active_sort_idx (migration 0012).
      cursor
        ? sql`(${contact.sortName}, ${contact.id}) > (${cursor.name}, ${cursor.id})`
        : undefined,
    );
    // Ruling S1: with q set, under RLS and rare matches, an ordered walk of
    // contact_active_sort_idx filters and heap-fetches every row. `|| ''` yields the same text
    // in the same collation as sort_name but can't be served from the index, so the planner
    // takes the bounded scan plus a top-N sort. Without q the plain column keeps pages on the index.
    const order =
      query.q !== undefined && query.q !== ''
        ? [asc(sql`${contact.sortName} || ''`), asc(sql`${contact.id}`)]
        : [asc(contact.sortName), asc(contact.id)];
    const rows = await withTenant(db, tenant.orgId, (tx) =>
      tx
        .select({ row: contact, key: contact.sortName })
        .from(contact)
        .where(where)
        .orderBy(...order)
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last ? encodeCursor({ name: last.key, id: last.row.id }) : null;
    return ok(c, { items: page.map((r) => toContactJson(r.row)), nextCursor }, 200);
  })
  .openapi(createContactRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    const phone = normalizePhone(body.phone);
    if (!phone.ok) {
      await auditContactAlone(db, tenant, {
        action: 'contact.create',
        outcome: 'denied',
        metadata: { reason: 'invalid_phone' },
      });
      return fail(c, 422, 'invalid_phone', 'The phone number could not be understood.');
    }
    try {
      const row = await withTenant(db, tenant.orgId, async (tx) => {
        const [created] = await tx
          .insert(contact)
          .values({
            organizationId: tenant.orgId,
            displayName: body.displayName,
            company: blankToNull(body.company) ?? null,
            phoneE164: phone.value,
            timezone: body.timezone ?? null,
            email: blankToNull(body.email) ?? null,
            jobTitle: blankToNull(body.jobTitle) ?? null,
            tags: normalizeTags(body.tags ?? []),
          })
          .returning();
        if (!created) throw new Error('contact insert returned no row');
        await insertContactAudit(tx, tenant, {
          action: 'contact.create',
          outcome: 'allowed',
          entityId: created.id,
        });
        return created;
      });
      return ok(c, toContactJson(row), 201);
    } catch (error) {
      if (!isUniqueViolation(error, CONTACT_UNIQUE_PHONE)) throw error;
      await auditContactAlone(db, tenant, {
        action: 'contact.create',
        outcome: 'denied',
        metadata: { reason: 'duplicate_contact' },
      });
      return fail(c, 409, 'duplicate_contact', await duplicateMessage(db, tenant, phone.value));
    }
  })
  .openapi(getRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id))
      return rejectMalformedContactId(c, db, tenant, 'contact.read');
    // RLS scopes the lookup: another tenant's contact is indistinguishable from a missing one.
    const [row] = await withTenant(db, tenant.orgId, (tx) =>
      tx.select().from(contact).where(eq(contact.id, id)).limit(1),
    );
    if (!row) {
      await auditContactAlone(db, tenant, {
        action: 'contact.read',
        outcome: 'not_found',
        entityId: id,
      });
      return fail(c, 404, 'not_found', 'Contact not found.');
    }
    return ok(c, toContactJson(row), 200);
  })
  .openapi(updateRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id))
      return rejectMalformedContactId(c, db, tenant, 'contact.update');
    const body = c.req.valid('json');
    let phoneE164: string | undefined;
    if (body.phone !== undefined) {
      const phone = normalizePhone(body.phone);
      if (!phone.ok) {
        await auditContactAlone(db, tenant, {
          action: 'contact.update',
          outcome: 'denied',
          entityId: id,
          metadata: { reason: 'invalid_phone' },
        });
        return fail(c, 422, 'invalid_phone', 'The phone number could not be understood.');
      }
      phoneE164 = phone.value;
    }
    try {
      const result = await withTenant(db, tenant.orgId, async (tx): Promise<MutationResult> => {
        const row = await findContact(tx, id, true);
        if (!row) return { kind: 'not_found' };
        if (row.mergedIntoId) return { kind: 'merged' };
        const { set, fields } = diffChanges(row, body, phoneE164);
        if (fields.length === 0) return { kind: 'ok', row };
        const [updated] = await tx.update(contact).set(set).where(eq(contact.id, id)).returning();
        if (!updated) throw new Error('contact update returned no row');
        // Field names only: values would put PII into the audit log.
        await recordChange(tx, tenant, updated, 'contact.update', 'Contact details updated', {
          fields,
        });
        return { kind: 'ok', row: updated };
      });
      if (result.kind === 'merged') {
        await auditContactAlone(db, tenant, {
          action: 'contact.update',
          outcome: 'denied',
          entityId: id,
          metadata: { reason: 'merged' },
        });
        return fail(c, 422, 'validation_error', 'Merged contacts cannot be edited');
      }
      if (result.kind !== 'ok') {
        await auditContactAlone(db, tenant, {
          action: 'contact.update',
          outcome: 'not_found',
          entityId: id,
        });
        return fail(c, 404, 'not_found', 'Contact not found.');
      }
      return ok(c, toContactJson(result.row), 200);
    } catch (error) {
      if (!isUniqueViolation(error, CONTACT_UNIQUE_PHONE)) throw error;
      await auditContactAlone(db, tenant, {
        action: 'contact.update',
        outcome: 'denied',
        entityId: id,
        metadata: { reason: 'duplicate_contact' },
      });
      return fail(c, 409, 'duplicate_contact', await duplicateMessage(db, tenant, phoneE164));
    }
  })
  .openapi(archiveRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id))
      return rejectMalformedContactId(c, db, tenant, 'contact.archive');
    const result = await withTenant(db, tenant.orgId, async (tx): Promise<MutationResult> => {
      const row = await findContact(tx, id, true);
      if (!row) return { kind: 'not_found' };
      if (row.archivedAt) return { kind: 'ok', row };
      const [updated] = await tx
        .update(contact)
        .set({ archivedAt: new Date() })
        .where(eq(contact.id, id))
        .returning();
      if (!updated) throw new Error('contact archive returned no row');
      await recordChange(tx, tenant, updated, 'contact.archive', 'Contact archived');
      return { kind: 'ok', row: updated };
    });
    if (result.kind !== 'ok') {
      await auditContactAlone(db, tenant, {
        action: 'contact.archive',
        outcome: 'not_found',
        entityId: id,
      });
      return fail(c, 404, 'not_found', 'Contact not found.');
    }
    return ok(c, toContactJson(result.row), 200);
  })
  .openapi(restoreRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id))
      return rejectMalformedContactId(c, db, tenant, 'contact.restore');
    const result = await withTenant(db, tenant.orgId, async (tx): Promise<MutationResult> => {
      const row = await findContact(tx, id, true);
      if (!row) return { kind: 'not_found' };
      if (row.mergedIntoId) return { kind: 'merged' };
      if (!row.archivedAt) return { kind: 'ok', row };
      const [updated] = await tx
        .update(contact)
        .set({ archivedAt: null })
        .where(eq(contact.id, id))
        .returning();
      if (!updated) throw new Error('contact restore returned no row');
      await recordChange(tx, tenant, updated, 'contact.restore', 'Contact restored');
      return { kind: 'ok', row: updated };
    });
    if (result.kind === 'merged') {
      await auditContactAlone(db, tenant, {
        action: 'contact.restore',
        outcome: 'denied',
        entityId: id,
        metadata: { reason: 'merged' },
      });
      return fail(c, 422, 'validation_error', 'Merged contacts cannot be restored');
    }
    if (result.kind !== 'ok') {
      await auditContactAlone(db, tenant, {
        action: 'contact.restore',
        outcome: 'not_found',
        entityId: id,
      });
      return fail(c, 404, 'not_found', 'Contact not found.');
    }
    return ok(c, toContactJson(result.row), 200);
  });
