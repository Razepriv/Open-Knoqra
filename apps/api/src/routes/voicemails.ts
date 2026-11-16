import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { contact, type Tx, type VoicemailRow, voicemail, withTenant } from '@knoqra/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { auditCallAlone, insertCallAudit } from '../lib/call-audit';
import { CallContactSchema } from '../lib/call-json';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';

const VOICEMAIL_ID_PATTERN = /^vm_[0-9a-f]{32}$/;
const LIST_LIMIT = 100;

const VoicemailSchema = z
  .object({
    id: z.string().openapi({ example: 'vm_0123456789abcdef0123456789abcdef' }),
    callId: z.string(),
    contact: CallContactSchema.nullable(),
    fromE164: z.string(),
    durationSeconds: z.number().int(),
    transcript: z.string().nullable(),
    listenedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Voicemail');
type VoicemailJson = z.infer<typeof VoicemailSchema>;

const VoicemailListSchema = z.object({ items: z.array(VoicemailSchema) }).openapi('VoicemailList');

const VoicemailIdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const noSession = errorResponse('No valid session');

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/voicemails',
  tags: ['voicemails'],
  summary: 'Voicemails in the active organization, newest first',
  security,
  responses: {
    200: { description: 'Voicemails', content: json(okEnvelope(VoicemailListSchema)) },
    401: noSession,
    409: errorResponse('No active organization'),
  },
});

const listenedRoute = createRoute({
  method: 'post',
  path: '/api/v1/voicemails/{id}/listened',
  tags: ['voicemails'],
  summary: 'Mark a voicemail as listened to (idempotent)',
  security,
  request: { params: VoicemailIdParam },
  responses: {
    200: { description: 'Voicemail', content: json(okEnvelope(VoicemailSchema)) },
    401: noSession,
    404: errorResponse('No such voicemail in the active organization'),
    409: errorResponse('No active organization'),
  },
});

interface Joined {
  row: VoicemailRow;
  contactId: string | null;
  contactName: string | null;
}

function toJson({ row, contactId, contactName }: Joined): VoicemailJson {
  return {
    id: row.id,
    callId: row.callId,
    contact:
      contactId !== null && contactName !== null
        ? { id: contactId, displayName: contactName }
        : null,
    fromE164: row.fromE164,
    durationSeconds: row.durationSeconds,
    transcript: row.transcript,
    listenedAt: row.listenedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Voicemails joined to their contact on the tenant-composite key (RLS-scoped `tx`). */
function selectVoicemails(tx: Tx) {
  return tx
    .select({ row: voicemail, contactId: contact.id, contactName: contact.displayName })
    .from(voicemail)
    .leftJoin(
      contact,
      and(
        eq(contact.organizationId, voicemail.organizationId),
        eq(contact.id, voicemail.contactId),
      ),
    );
}

export const voicemails = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const rows = await withTenant(db, tenant.orgId, (tx) =>
      selectVoicemails(tx).orderBy(desc(voicemail.createdAt), desc(voicemail.id)).limit(LIST_LIMIT),
    );
    return ok(c, { items: rows.map(toJson) }, 200);
  })
  .openapi(listenedRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    const notFound = async () => {
      await auditCallAlone(
        db,
        tenant,
        VOICEMAIL_ID_PATTERN.test(id)
          ? { action: 'voicemail.listened', outcome: 'not_found', entityId: id }
          : {
              action: 'voicemail.listened',
              outcome: 'not_found',
              metadata: { reason: 'malformed_id' },
            },
      );
      return fail(c, 404, 'not_found', 'Voicemail not found.');
    };
    if (!VOICEMAIL_ID_PATTERN.test(id)) return notFound();
    const found = await withTenant(db, tenant.orgId, async (tx) => {
      // Idempotent: only the first listen sets the time; later ones keep it.
      await tx
        .update(voicemail)
        .set({ listenedAt: new Date() })
        .where(and(eq(voicemail.id, id), isNull(voicemail.listenedAt)));
      const [joined] = await selectVoicemails(tx).where(eq(voicemail.id, id)).limit(1);
      if (!joined) return null;
      await insertCallAudit(tx, tenant, {
        action: 'voicemail.listened',
        outcome: 'allowed',
        entityId: id,
      });
      return joined;
    });
    if (!found) return notFound();
    return ok(c, toJson(found), 200);
  });
