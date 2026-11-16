import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { isValidTimeZone, normalizePhone } from '@knoqra/core';
import { type Contact, contact, type Tx, timelineEvent, withTenant } from '@knoqra/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import { insertContactAudit } from '../lib/contact-access';
import { blankToNull, MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from '../lib/contact-fields';
import type { AppEnv, Tenant } from '../lib/context';
import { ERROR_CODES, type ErrorCode, errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { retryOnConflict } from '../lib/retry';
import { safeText } from '../lib/schemas';
import { captureForUser } from '../observability/posthog';

export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BODY_BYTES = 1024 * 1024;

const STATUSES = ['created', 'updated', 'skipped', 'rejected'] as const;
type Status = (typeof STATUSES)[number];

/** Documented shape of one row. Enforced per row in `validateRow`, so one bad cell never fails the batch. */
const ImportRow = z
  .object({
    displayName: safeText({ max: 120 }).optional(),
    phone: safeText({ max: 64 }).optional(),
    company: safeText({ max: 120 }).optional(),
    email: safeText({ max: 254 }).optional(),
    jobTitle: safeText({ max: 120 }).optional(),
    timezone: safeText({ max: 64 }).optional(),
    tags: z
      .array(safeText({ max: MAX_TAG_LENGTH }))
      .max(MAX_TAGS)
      .optional(),
  })
  .openapi('ImportRow');

const LooseRow = z.unknown().openapi({
  type: 'object',
  additionalProperties: true,
  description: 'A row; see ImportRow. Each row is validated on its own and rejected individually.',
});

const ImportRequest = z
  .object({
    fileName: safeText({ min: 1, max: 200 }),
    onDuplicate: z.enum(['skip', 'update']),
    rows: z.array(LooseRow).min(1).max(MAX_IMPORT_ROWS),
  })
  .openapi('ImportRequest');

const RowResultSchema = z.object({
  index: z.number().int().openapi({ description: '0-based position in the request rows.' }),
  status: z.enum(STATUSES),
  contactId: z.string().nullable(),
  error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).nullable(),
});
type RowResult = z.infer<typeof RowResultSchema>;

const ImportResult = z.object({ results: z.array(RowResultSchema) }).openapi('ImportResult');

const importRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/import',
  tags: ['contacts'],
  summary: 'Import up to 500 contacts, validating each row independently',
  security: [{ session: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: ImportRequest } } },
  },
  responses: {
    200: {
      description: 'Per-row results',
      content: { 'application/json': { schema: okEnvelope(ImportResult) } },
    },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
    413: errorResponse('More than 500 rows, or the body is larger than 1 MB'),
  },
});

const tooLarge = (c: Parameters<typeof fail>[0]) =>
  fail(c, 413, 'payload_too_large', 'Request body is too large.');

/** A row that passed validation; absent optional values are null. */
interface ValidRow {
  index: number;
  displayName: string;
  phoneE164: string;
  company: string | null;
  email: string | null;
  jobTitle: string | null;
  timezone: string | null;
  tags: string[];
}

type Validation = { ok: true; value: ValidRow } | { ok: false; code: ErrorCode; message: string };

const ROW_FIELD_LABELS: Record<string, string> = {
  displayName: 'Name',
  phone: 'Phone',
  company: 'Company',
  email: 'Email',
  jobTitle: 'Job title',
  timezone: 'Time zone',
};

const EMAIL_SCHEMA = z.email().max(254);

/** Cells that are null or empty count as absent. */
function withoutBlankCells(raw: Record<string, unknown>): Record<string, unknown> {
  const isBlank = (v: unknown) => v === null || (typeof v === 'string' && v.trim() === '');
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([, v]) => !isBlank(v))
      // Blank items inside the tag list are absent too.
      .map(([k, v]) => [k, k === 'tags' && Array.isArray(v) ? v.filter((t) => !isBlank(t)) : v]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field-named message for the first schema issue of a row. */
function rowIssueMessage(issue: z.core.$ZodIssue): string {
  const [field, position] = issue.path;
  if (field === 'tags') {
    if (position === undefined) {
      return issue.code === 'too_big' ? `Too many tags (max ${MAX_TAGS})` : 'Tags must be a list';
    }
    if (issue.code === 'too_big') return `Tag is too long (max ${MAX_TAG_LENGTH})`;
    return issue.code === 'invalid_type' ? 'Tag must be text' : 'Tag contains invalid characters';
  }
  const label = ROW_FIELD_LABELS[String(field)] ?? 'Row';
  if (issue.code === 'too_big') return `${label} is too long`;
  if (issue.code === 'invalid_type') return `${label} must be text`;
  return `${label} contains invalid characters`;
}

const reject = (code: ErrorCode, message: string): Validation => ({ ok: false, code, message });

function validateRow(raw: unknown, index: number): Validation {
  if (!isPlainObject(raw)) {
    return reject('validation_error', 'Row must be an object with named columns');
  }
  const parsed = ImportRow.safeParse(withoutBlankCells(raw));
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return reject('validation_error', issue ? rowIssueMessage(issue) : 'Row is not valid');
  }
  const row = parsed.data;
  const displayName = blankToNull(row.displayName);
  if (!displayName) return reject('validation_error', 'Name is required');
  const rawPhone = blankToNull(row.phone);
  if (!rawPhone) return reject('validation_error', 'Phone is required');
  const phone = normalizePhone(rawPhone);
  if (!phone.ok) return reject('invalid_phone', 'Enter a full number with country code');
  const email = blankToNull(row.email) ?? null;
  if (email !== null && !EMAIL_SCHEMA.safeParse(email).success) {
    return reject('validation_error', 'Email is not valid');
  }
  const timezone = blankToNull(row.timezone) ?? null;
  if (timezone !== null && !isValidTimeZone(timezone)) {
    return reject('validation_error', 'Time zone is not a valid IANA zone');
  }
  return {
    ok: true,
    value: {
      index,
      displayName,
      phoneE164: phone.value,
      company: blankToNull(row.company) ?? null,
      email,
      jobTitle: blankToNull(row.jobTitle) ?? null,
      timezone,
      tags: normalizeTags(row.tags ?? []),
    },
  };
}

interface Prepared {
  results: RowResult[];
  /** First occurrence of each phone, in request order. */
  candidates: ValidRow[];
  /** Later rows repeating a phone, with the index of the first occurrence. */
  duplicates: { index: number; firstIndex: number }[];
}

const outcome = (
  index: number,
  status: Status,
  contactId: string | null,
  error: { code: ErrorCode; message: string } | null,
): RowResult => ({ index, status, contactId, error });

function prepareRows(rows: readonly unknown[]): Prepared {
  const results: RowResult[] = [];
  const candidates: ValidRow[] = [];
  const duplicates: Prepared['duplicates'] = [];
  const firstByPhone = new Map<string, number>();
  rows.forEach((row, index) => {
    const checked = validateRow(row, index);
    if (!checked.ok) {
      results[index] = outcome(index, 'rejected', null, {
        code: checked.code,
        message: checked.message,
      });
      return;
    }
    const first = firstByPhone.get(checked.value.phoneE164);
    if (first !== undefined) {
      duplicates.push({ index, firstIndex: first });
      return;
    }
    firstByPhone.set(checked.value.phoneE164, index);
    candidates.push(checked.value);
  });
  return { results, candidates, duplicates };
}

const comparePhones = (a: ValidRow, b: ValidRow): number =>
  a.phoneE164 < b.phoneE164 ? -1 : a.phoneE164 > b.phoneE164 ? 1 : 0;

type ContactChanges = Partial<typeof contact.$inferInsert>;

/** Provided non-empty fields overwrite; tags are merged (deduped, capped). */
function changesFor(existing: Contact, row: ValidRow): ContactChanges {
  const set: ContactChanges = {};
  if (row.displayName !== existing.displayName) set.displayName = row.displayName;
  if (row.company !== null && row.company !== existing.company) set.company = row.company;
  if (row.email !== null && row.email !== existing.email) set.email = row.email;
  if (row.jobTitle !== null && row.jobTitle !== existing.jobTitle) set.jobTitle = row.jobTitle;
  if (row.timezone !== null && row.timezone !== existing.timezone) set.timezone = row.timezone;
  const tags = normalizeTags([...existing.tags, ...row.tags]).slice(0, MAX_TAGS);
  if (tags.join('\u0000') !== existing.tags.join('\u0000')) set.tags = tags;
  return set;
}

const ALREADY_THERE = { code: 'duplicate_contact', message: 'Already in your contacts' } as const;

interface BatchContext {
  tx: Tx;
  tenant: Tenant;
  fileName: string;
  onDuplicate: 'skip' | 'update';
}

interface Resolution {
  results: RowResult[];
  toCreate: ValidRow[];
  updated: { id: string; index: number }[];
}

/** Classifies candidates that already exist in the org and applies the `update` changes. */
async function resolveExisting(
  ctx: BatchContext,
  candidates: readonly ValidRow[],
): Promise<Resolution> {
  const { tx, tenant, onDuplicate } = ctx;
  // Lock and insert in phone byte order (what COLLATE "C" gives for E.164), so two imports
  // touching the same phones cannot deadlock each other. Merge and dismiss lock by id instead, so
  // an import can still deadlock with one of them: the route retries the transaction once.
  const ordered = [...candidates].sort(comparePhones);
  const phones = ordered.map((c) => c.phoneE164);
  // The explicit organization predicate backs up RLS. Merged contacts gave their numbers up
  // (the phone index is partial), so a row with such a number creates a new contact.
  const query = tx
    .select()
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, tenant.orgId),
        inArray(contact.phoneE164, phones),
        isNull(contact.mergedIntoId),
      ),
    )
    .orderBy(sql`${contact.phoneE164} collate "C"`);
  const existing = await (onDuplicate === 'update' ? query.for('update') : query);
  const byPhone = new Map(existing.map((row) => [row.phoneE164, row]));
  const resolution: Resolution = { results: [], toCreate: [], updated: [] };
  for (const row of ordered) {
    const found = byPhone.get(row.phoneE164);
    if (!found) {
      resolution.toCreate.push(row);
    } else if (onDuplicate === 'skip') {
      resolution.results.push(outcome(row.index, 'skipped', found.id, ALREADY_THERE));
    } else if (found.archivedAt) {
      resolution.results.push(
        outcome(row.index, 'rejected', found.id, {
          code: 'duplicate_contact',
          message: 'Belongs to an archived contact',
        }),
      );
    } else {
      const set = changesFor(found, row);
      if (Object.keys(set).length === 0) {
        resolution.results.push(
          outcome(row.index, 'skipped', found.id, {
            code: 'duplicate_contact',
            message: 'Already up to date',
          }),
        );
        continue;
      }
      await tx.update(contact).set(set).where(eq(contact.id, found.id));
      resolution.updated.push({ id: found.id, index: row.index });
      resolution.results.push(outcome(row.index, 'updated', found.id, null));
    }
  }
  return resolution;
}

/** One multi-row insert. A concurrent insert of the same phone is skipped, never an error. */
async function createContacts(
  ctx: BatchContext,
  rows: readonly ValidRow[],
): Promise<{ created: { id: string; index: number }[]; raced: ValidRow[] }> {
  if (rows.length === 0) return { created: [], raced: [] };
  const { tx, tenant, fileName } = ctx;
  const inserted = await tx
    .insert(contact)
    .values(
      rows.map((row) => ({
        organizationId: tenant.orgId,
        displayName: row.displayName,
        company: row.company,
        phoneE164: row.phoneE164,
        timezone: row.timezone,
        email: row.email,
        jobTitle: row.jobTitle,
        tags: row.tags,
        source: 'import',
        sourceDetail: fileName,
      })),
    )
    // The target names the partial phone index, so it carries the index predicate.
    .onConflictDoNothing({
      target: [contact.organizationId, contact.phoneE164],
      where: sql`merged_into_id is null`,
    })
    .returning({ id: contact.id, phoneE164: contact.phoneE164 });
  const idByPhone = new Map(inserted.map((r) => [r.phoneE164, r.id]));
  const created = rows.flatMap((row) => {
    const id = idByPhone.get(row.phoneE164);
    return id ? [{ id, index: row.index }] : [];
  });
  return { created, raced: rows.filter((row) => !idByPhone.has(row.phoneE164)) };
}

function timelineRows(
  ctx: BatchContext,
  items: readonly { id: string }[],
  title: string,
): (typeof timelineEvent.$inferInsert)[] {
  return items.map((item) => ({
    organizationId: ctx.tenant.orgId,
    contactId: item.id,
    kind: 'system' as const,
    title,
    actorUserId: ctx.tenant.userId,
    source: 'app',
  }));
}

async function runBatch(
  ctx: BatchContext,
  prepared: Prepared,
): Promise<{ results: RowResult[]; counts: Record<Status, number> }> {
  const { results } = prepared;
  const existing =
    prepared.candidates.length > 0
      ? await resolveExisting(ctx, prepared.candidates)
      : { results: [], toCreate: [], updated: [] };
  const { created, raced } = await createContacts(ctx, existing.toCreate);
  const events = [
    ...timelineRows(ctx, created, `Imported from ${ctx.fileName}`),
    ...timelineRows(ctx, existing.updated, `Updated from import ${ctx.fileName}`),
  ];
  if (events.length > 0) await ctx.tx.insert(timelineEvent).values(events);

  for (const r of existing.results) results[r.index] = r;
  for (const c of created) results[c.index] = outcome(c.index, 'created', c.id, null);
  for (const row of raced) {
    results[row.index] = outcome(row.index, 'skipped', null, ALREADY_THERE);
  }
  for (const dup of prepared.duplicates) {
    results[dup.index] = outcome(dup.index, 'skipped', results[dup.firstIndex]?.contactId ?? null, {
      code: 'duplicate_contact',
      message: `Duplicate of row ${dup.firstIndex + 1}`,
    });
  }
  const counts: Record<Status, number> = { created: 0, updated: 0, skipped: 0, rejected: 0 };
  for (const r of results) counts[r.status] += 1;
  return { results, counts };
}

const router = new OpenAPIHono<AppEnv>();
router.openAPIRegistry.register('ImportRow', ImportRow);
router.use(
  '/api/v1/contacts/import',
  bodyLimit({ maxSize: MAX_IMPORT_BODY_BYTES, onError: (c) => tooLarge(c) }),
  // The row cap answers 413 before schema validation can answer 400 (ruling M1-R2).
  async (c, next) => {
    if (c.req.method === 'POST') {
      const body: unknown = await c.req.json().catch(() => undefined);
      const rows = (body as { rows?: unknown } | undefined)?.rows;
      if (Array.isArray(rows) && rows.length > MAX_IMPORT_ROWS) return tooLarge(c);
    }
    await next();
  },
);

export const contactImport = router.openapi(importRoute, async (c) => {
  const { db, tenant } = c.var;
  const body = c.req.valid('json');
  const prepared = prepareRows(body.rows);
  // A deadlock with a concurrent merge or dismiss rolls the whole batch back, so it is retried
  // once from a fresh copy of the per-row results (runBatch fills them in).
  const { results, counts } = await retryOnConflict(() =>
    withTenant(db, tenant.orgId, async (tx) => {
      const batch = await runBatch(
        { tx, tenant, fileName: body.fileName, onDuplicate: body.onDuplicate },
        { ...prepared, results: [...prepared.results] },
      );
      // Counts and the file name only: contact values must not reach the audit log.
      await insertContactAudit(tx, tenant, {
        action: 'contact.import',
        outcome: 'allowed',
        metadata: { ...batch.counts, fileName: body.fileName },
      });
      return batch;
    }),
  );
  await captureForUser(c, 'contacts_import_batch', counts);
  return ok(c, { results }, 200);
});
