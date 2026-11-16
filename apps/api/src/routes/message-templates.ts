import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { MESSAGING_CHANNELS, templatePlaceholders } from '@knoqra/core';
import { type MessageTemplate, messageTemplate, withTenant } from '@knoqra/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { canManage } from '../lib/roles';
import { safeText } from '../lib/schemas';
import { auditMessagingAlone, insertMessagingAudit } from '../messaging/audit';
import { META_FIELDS_REQUIRED } from '../messaging/send';
import { senderFor } from '../messaging/senders';

const TEMPLATE_ID_PATTERN = /^mt_[0-9a-f]{32}$/;
const UNIQUE_VIOLATION = '23505';
/** Meta template names are lowercase letters, digits and underscores. */
const META_NAME_PATTERN = /^[a-z0-9_]+$/;
/** Meta language codes: `en`, `en_US`, `fil`. */
const META_LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const META_FIELDS_WHATSAPP_ONLY = 'Meta template fields are for WhatsApp templates only.';

const TemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    channel: z.enum(MESSAGING_CHANNELS),
    body: z.string(),
    placeholders: z.array(z.string()),
    approvalStatus: z.enum(['pending', 'approved', 'rejected']),
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    whatsappTemplateName: z.string().nullable(),
    whatsappLanguage: z.string().nullable(),
  })
  .openapi('MessageTemplate');
type TemplateJson = z.infer<typeof TemplateSchema>;

const TemplateListSchema = z.object({ items: z.array(TemplateSchema) }).openapi('MessageTemplates');
const CreateBody = z
  .object({
    name: safeText({ min: 1, max: 60 }),
    channel: z.enum(MESSAGING_CHANNELS),
    body: safeText({ min: 1, max: 1024 }),
    /** The approved Meta template's name. Required with the language for a live (Telnyx) sender. */
    whatsappTemplateName: z.string().min(1).max(512).regex(META_NAME_PATTERN).optional(),
    /** The Meta template's language code, such as `en_US`. */
    whatsappLanguage: z.string().max(6).regex(META_LANGUAGE_PATTERN).optional(),
  })
  .openapi('CreateMessageTemplate');
type CreateInput = z.infer<typeof CreateBody>;
const ListQuery = z.object({
  channel: z.enum(MESSAGING_CHANNELS).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
const IdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/messaging/templates',
  tags: ['messaging'],
  summary: 'Message templates, by name',
  security,
  request: { query: ListQuery },
  responses: {
    200: { description: 'Templates', content: json(okEnvelope(TemplateListSchema)) },
    400: errorResponse('Invalid query'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const createTemplateRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/templates',
  tags: ['messaging'],
  summary: 'Create a message template',
  security,
  request: { body: { required: true, content: json(CreateBody) } },
  responses: {
    201: { description: 'Created', content: json(okEnvelope(TemplateSchema)) },
    400: errorResponse('Invalid body or unknown placeholder'),
    401: errorResponse('No valid session'),
    409: errorResponse('A template with this name already exists'),
  },
});

const archiveRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/templates/{id}/archive',
  tags: ['messaging'],
  summary: 'Archive a message template',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Archived', content: json(okEnvelope(TemplateSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such template in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const approveRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/templates/{id}/approve',
  tags: ['messaging'],
  summary: 'Record that Meta approved a WhatsApp template (owners and admins)',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Approved', content: json(okEnvelope(TemplateSchema)) },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can approve templates'),
    404: errorResponse('No such template in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('Not a WhatsApp template with its Meta name and language'),
  },
});

const APPROVE_FORBIDDEN = 'Only owners and admins can approve templates.';
const APPROVE_WHATSAPP_ONLY = 'Only WhatsApp templates are approved by Meta.';
const APPROVE_ARCHIVED = 'This template is archived.';

type ApproveOutcome =
  | { kind: 'approved'; row: MessageTemplate }
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: string; message: string };

/** Why this template cannot be marked approved in Meta, or null. */
function approveProblem(row: MessageTemplate): { reason: string; message: string } | null {
  if (row.archivedAt) return { reason: 'archived', message: APPROVE_ARCHIVED };
  if (row.channel !== 'whatsapp') return { reason: 'not_whatsapp', message: APPROVE_WHATSAPP_ONLY };
  if (!row.whatsappTemplateName || !row.whatsappLanguage) {
    return { reason: 'meta_missing', message: META_FIELDS_REQUIRED };
  }
  return null;
}

function toJson(row: MessageTemplate): TemplateJson {
  const parsed = templatePlaceholders(row.body);
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    body: row.body,
    placeholders: parsed.ok ? parsed.value : [],
    approvalStatus: row.approvalStatus,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    whatsappTemplateName: row.whatsappTemplateName,
    whatsappLanguage: row.whatsappLanguage,
  };
}

/**
 * Why the Meta fields are not acceptable for this template, or null. They belong to WhatsApp, come
 * as a pair, and a live (Telnyx) WhatsApp sender needs them: it sends templates by Meta name.
 */
function metaFieldsProblem(input: CreateInput, senderProvider: string | undefined): string | null {
  const hasName = input.whatsappTemplateName !== undefined;
  const hasLanguage = input.whatsappLanguage !== undefined;
  if (input.channel !== 'whatsapp') {
    return hasName || hasLanguage ? META_FIELDS_WHATSAPP_ONLY : null;
  }
  if (hasName !== hasLanguage) return META_FIELDS_REQUIRED;
  if (senderProvider === 'telnyx' && !hasName) return META_FIELDS_REQUIRED;
  return null;
}

const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string; cause?: { code?: string } } | null) ?? null;
  return code?.code === UNIQUE_VIOLATION || code?.cause?.code === UNIQUE_VIOLATION;
};

async function templateNotFound(
  c: Context<AppEnv>,
  id: string | null,
  reason?: string,
  action: 'template.archive' | 'template.approve' = 'template.archive',
) {
  const { db, tenant } = c.var;
  await auditMessagingAlone(db, tenant, {
    action,
    entityType: 'message_template',
    outcome: 'not_found',
    entityId: id,
    ...(reason ? { metadata: { reason } } : {}),
  });
  return fail(c, 404, 'not_found', 'Template not found.');
}

export const messageTemplates = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const { channel, includeArchived } = c.req.valid('query');
    const rows = await withTenant(db, tenant.orgId, (tx) =>
      tx
        .select()
        .from(messageTemplate)
        .where(
          and(
            channel ? eq(messageTemplate.channel, channel) : undefined,
            includeArchived ? undefined : isNull(messageTemplate.archivedAt),
          ),
        )
        .orderBy(asc(sql`lower(${messageTemplate.name})`), asc(messageTemplate.id)),
    );
    return ok(c, { items: rows.map(toJson) }, 200);
  })
  .openapi(createTemplateRoute, async (c) => {
    const { db, tenant } = c.var;
    const input = c.req.valid('json');
    const placeholders = templatePlaceholders(input.body);
    if (!placeholders.ok) {
      const first = placeholders.error.unknown[0];
      return fail(
        c,
        400,
        'validation_error',
        `Unknown placeholder {{${first}}}. Use {{first_name}}, {{name}} or {{company}}.`,
      );
    }
    try {
      const result = await withTenant(db, tenant.orgId, async (tx) => {
        let approvalStatus: 'approved' | 'pending' = 'approved';
        const sender = input.channel === 'whatsapp' ? await senderFor(tx, c.env, 'whatsapp') : null;
        const problem = metaFieldsProblem(input, sender?.provider);
        if (problem) return { kind: 'invalid', message: problem } as const;
        if (input.channel === 'whatsapp') {
          // Live templates stay pending until an owner marks them approved in Meta.
          approvalStatus = sender?.provider === 'fake' ? 'approved' : 'pending';
        }
        const [created] = await tx
          .insert(messageTemplate)
          .values({
            organizationId: tenant.orgId,
            name: input.name,
            channel: input.channel,
            body: input.body,
            approvalStatus,
            createdBy: tenant.userId,
            whatsappTemplateName: input.whatsappTemplateName ?? null,
            whatsappLanguage: input.whatsappLanguage ?? null,
          })
          .returning();
        if (!created) throw new Error('template insert returned no row');
        await insertMessagingAudit(tx, tenant, {
          action: 'template.create',
          entityType: 'message_template',
          outcome: 'allowed',
          entityId: created.id,
          metadata: { channel: input.channel, approvalStatus },
        });
        return { kind: 'created', row: created } as const;
      });
      if (result.kind === 'invalid') return fail(c, 400, 'validation_error', result.message);
      return ok(c, toJson(result.row), 201);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await auditMessagingAlone(db, tenant, {
        action: 'template.create',
        entityType: 'message_template',
        outcome: 'denied',
        metadata: { reason: 'duplicate_name', channel: input.channel },
      });
      return fail(c, 409, 'duplicate_template', 'A template with this name already exists.');
    }
  })
  .openapi(archiveRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!TEMPLATE_ID_PATTERN.test(id)) return templateNotFound(c, null, 'malformed_id');
    const row = await withTenant(db, tenant.orgId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(messageTemplate)
        .where(eq(messageTemplate.id, id))
        .for('update')
        .limit(1);
      if (!existing) return undefined;
      const [updated] = existing.archivedAt
        ? [existing]
        : await tx
            .update(messageTemplate)
            .set({ archivedAt: sql`clock_timestamp()` })
            .where(eq(messageTemplate.id, id))
            .returning();
      if (!updated) throw new Error('template update returned no row');
      await insertMessagingAudit(tx, tenant, {
        action: 'template.archive',
        entityType: 'message_template',
        outcome: 'allowed',
        entityId: id,
      });
      return updated;
    });
    if (!row) return templateNotFound(c, id);
    return ok(c, toJson(row), 200);
  })
  .openapi(approveRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!canManage(tenant.role)) {
      await auditMessagingAlone(db, tenant, {
        action: 'template.approve',
        entityType: 'message_template',
        outcome: 'denied',
        entityId: TEMPLATE_ID_PATTERN.test(id) ? id : null,
        metadata: { reason: 'role' },
      });
      return fail(c, 403, 'forbidden', APPROVE_FORBIDDEN);
    }
    if (!TEMPLATE_ID_PATTERN.test(id)) {
      return templateNotFound(c, null, 'malformed_id', 'template.approve');
    }
    const result = await withTenant(db, tenant.orgId, async (tx): Promise<ApproveOutcome> => {
      const [existing] = await tx
        .select()
        .from(messageTemplate)
        .where(eq(messageTemplate.id, id))
        .for('update')
        .limit(1);
      if (!existing) return { kind: 'not_found' };
      const problem = approveProblem(existing);
      if (problem) {
        await insertMessagingAudit(tx, tenant, {
          action: 'template.approve',
          entityType: 'message_template',
          outcome: 'denied',
          entityId: id,
          metadata: { reason: problem.reason },
        });
        return { kind: 'refused', ...problem };
      }
      const [updated] =
        existing.approvalStatus === 'approved'
          ? [existing]
          : await tx
              .update(messageTemplate)
              .set({ approvalStatus: 'approved' })
              .where(eq(messageTemplate.id, id))
              .returning();
      if (!updated) throw new Error('template update returned no row');
      await insertMessagingAudit(tx, tenant, {
        action: 'template.approve',
        entityType: 'message_template',
        outcome: 'allowed',
        entityId: id,
        metadata: { previous: existing.approvalStatus },
      });
      return { kind: 'approved', row: updated };
    });
    if (result.kind === 'not_found') return templateNotFound(c, id, undefined, 'template.approve');
    if (result.kind === 'refused') return fail(c, 422, 'validation_error', result.message);
    return ok(c, toJson(result.row), 200);
  });
