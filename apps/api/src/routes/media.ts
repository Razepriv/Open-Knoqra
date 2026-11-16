import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  attachmentFileName,
  baseMimeType,
  classifyUpload,
  MAX_ATTACHMENT_BYTES,
  parseWaveform,
} from '@knoqra/core';
import { conversation, type MessageAttachment, messageAttachment, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import {
  attachmentJson,
  downloadInbound,
  recordDownload,
  storageKey,
} from '../messaging/attachments';
import { auditMessagingAlone } from '../messaging/audit';
import { AttachmentSchema } from '../messaging/json';
import { MEDIA_PATH, verifyMediaUrl } from '../messaging/media-url';
import { senderFor, telnyxMessagingClient } from '../messaging/senders';

const CONVERSATION_ID_PATTERN = /^cv_[0-9a-f]{32}$/;
const ATTACHMENT_ID_PATTERN = /^ma_[0-9a-f]{32}$/;

/** Types the browser may show in place. Anything else is downloaded, never rendered. */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/aac',
  'audio/amr',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'video/mp4',
  'video/3gpp',
]);

const UPLOAD_REFUSALS = {
  empty: 'The file is empty.',
  unsupported_type:
    "WhatsApp can't send this type of file. Send a JPEG or PNG image, an MP4 video, an audio file (AAC, AMR, MP3, M4A, OGG/Opus) or a document (PDF, Word, Excel, PowerPoint, text).",
  too_large:
    'This file is larger than WhatsApp allows (images 5 MB, audio and video 16 MB, documents 100 MB).',
} as const;

const IdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const UploadQuery = z.object({
  /** The file's name, shown on a document card. */
  name: z.string().max(255).optional(),
  /** `true` sends the file as a voice note (OGG/Opus only). */
  voice: z.enum(['true', 'false']).optional(),
  /** A recording's length, from the browser. */
  durationMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
  /** Up to 48 comma-separated bars from 0 to 100. */
  waveform: z.string().max(400).optional(),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const uploadRoute = createRoute({
  method: 'post',
  path: '/api/v1/conversations/{id}/attachments',
  tags: ['conversations'],
  summary:
    'Upload a file to send on a WhatsApp conversation (raw body, Content-Type and Content-Length required); send it by naming its id in attachmentId',
  security,
  request: {
    params: IdParam,
    query: UploadQuery,
    body: {
      required: true,
      content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
    },
  },
  responses: {
    201: { description: 'Stored draft file', content: json(okEnvelope(AttachmentSchema)) },
    400: errorResponse('Invalid query'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such conversation in the active organization'),
    409: errorResponse('No active organization'),
    411: errorResponse('Content-Length is required'),
    413: errorResponse('Larger than WhatsApp allows'),
    422: errorResponse('Not a WhatsApp conversation, or a type WhatsApp cannot send'),
    503: errorResponse('File storage is not set up on this server'),
  },
});

const attachmentRoute = createRoute({
  method: 'get',
  path: '/api/v1/attachments/{id}',
  tags: ['conversations'],
  summary: 'One attachment with a fresh signed link',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Attachment', content: json(okEnvelope(AttachmentSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such attachment in the active organization'),
    409: errorResponse('No active organization'),
  },
});

/** The session routes: upload and link refresh. */
export function mediaRoutes() {
  return new OpenAPIHono<AppEnv>()
    .openapi(uploadRoute, async (c) => {
      const { db, tenant } = c.var;
      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const bucket = c.env.MEDIA;
      if (!bucket) {
        return fail(c, 503, 'not_configured', "File storage isn't set up on this server.");
      }
      if (!CONVERSATION_ID_PATTERN.test(id))
        return fail(c, 404, 'not_found', 'Conversation not found.');
      const length = Number(c.req.header('content-length'));
      if (!Number.isInteger(length) || length < 0) {
        return fail(c, 411 as 400, 'validation_error', 'Send the file with its Content-Length.');
      }
      if (length > MAX_ATTACHMENT_BYTES) {
        return fail(c, 413, 'payload_too_large', UPLOAD_REFUSALS.too_large);
      }
      const mime = c.req.header('content-type') ?? '';
      const kind = classifyUpload(mime, length, { voice: query.voice === 'true' });
      if (!kind.ok) {
        const status = kind.error === 'too_large' ? 413 : 422;
        return fail(
          c,
          status,
          kind.error === 'too_large' ? 'payload_too_large' : 'validation_error',
          UPLOAD_REFUSALS[kind.error],
        );
      }
      const conv = await withTenant(db, tenant.orgId, async (tx) => {
        const [row] = await tx
          .select({ id: conversation.id, channel: conversation.channel })
          .from(conversation)
          .where(eq(conversation.id, id))
          .limit(1);
        return row;
      });
      if (!conv) return fail(c, 404, 'not_found', 'Conversation not found.');
      if (conv.channel !== 'whatsapp') {
        return fail(c, 422, 'validation_error', 'Files can be sent on WhatsApp only.');
      }
      const body = c.req.raw.body;
      if (!body) return fail(c, 422, 'validation_error', UPLOAD_REFUSALS.empty);

      const waveform = query.waveform && parseWaveform(query.waveform) ? query.waveform : null;
      const contentType = baseMimeType(mime) === 'audio/ogg' ? 'audio/ogg' : baseMimeType(mime);
      const row = await withTenant(db, tenant.orgId, async (tx) => {
        const [created] = await tx
          .insert(messageAttachment)
          .values({
            organizationId: tenant.orgId,
            conversationId: conv.id,
            direction: 'outbound',
            kind: kind.value,
            mimeType: contentType,
            sizeBytes: length,
            fileName: attachmentFileName(query.name ?? null, kind.value, contentType),
            status: 'pending',
            durationMs: query.durationMs ?? null,
            waveform,
            uploadedBy: tenant.userId,
          })
          .returning();
        return created;
      });
      if (!row) throw new Error('attachment insert returned no row');
      try {
        await bucket.put(
          storageKey(tenant.orgId, row.id),
          body.pipeThrough(new FixedLengthStream(length)),
          {
            httpMetadata: { contentType },
          },
        );
      } catch (error) {
        logger.warn('messaging.upload_failed', {
          attachmentId: row.id,
          orgId: tenant.orgId,
          error,
        });
        await withTenant(db, tenant.orgId, (tx) =>
          tx
            .update(messageAttachment)
            .set({ status: 'failed' })
            .where(eq(messageAttachment.id, row.id)),
        );
        return fail(c, 422, 'validation_error', 'The file did not arrive whole. Try again.');
      }
      const stored = await withTenant(db, tenant.orgId, async (tx) => {
        const [updated] = await tx
          .update(messageAttachment)
          .set({ status: 'stored', storageKey: storageKey(tenant.orgId, row.id) })
          .where(eq(messageAttachment.id, row.id))
          .returning();
        return updated;
      });
      if (!stored) throw new Error('attachment vanished after upload');
      // Ids, kind and size only: never the file name (it can carry personal details).
      await auditMessagingAlone(db, tenant, {
        action: 'attachment.upload',
        entityType: 'message_attachment',
        outcome: 'allowed',
        entityId: stored.id,
        metadata: { conversationId: conv.id, kind: stored.kind, sizeBytes: length },
      });
      return ok(c, await attachmentJson(c.env, stored), 201);
    })
    .openapi(attachmentRoute, async (c) => {
      const { db, tenant } = c.var;
      const { id } = c.req.valid('param');
      if (!ATTACHMENT_ID_PATTERN.test(id)) return fail(c, 404, 'not_found', 'File not found.');
      const row = await withTenant(db, tenant.orgId, async (tx) => {
        const [found] = await tx
          .select()
          .from(messageAttachment)
          .where(eq(messageAttachment.id, id))
          .limit(1);
        return found;
      });
      if (!row) return fail(c, 404, 'not_found', 'File not found.');
      return ok(c, await attachmentJson(c.env, row), 200);
    });
}

export const media = mediaRoutes();

/** A file name for Content-Disposition: ASCII fallback plus the UTF-8 form. */
function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** `bytes=start-end` (one range) against a known size, or null for none or an unsupported one. */
export function parseRange(
  header: string | undefined,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || size <= 0) return null;
  const [, a, b] = match;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

export interface MediaFileDeps {
  /** Tests only: the fetch the provider client uses for an on-demand download. */
  fetch?: typeof fetch;
}

/**
 * `GET /api/media/{id}?o=&e=&s=`: the file behind a signed link, with no session (an `<img>` and the
 * provider can both fetch it). The signature binds the attachment, its organization and the expiry
 * (messaging/media-url.ts). An inbound file not yet downloaded is fetched from the provider first.
 * Safe types are shown inline; everything else is a download, with `nosniff` and a sandboxing CSP.
 * Any refusal is a bare 404, so a link reveals nothing about what exists.
 */
export function mediaFileRoutes(deps: MediaFileDeps = {}) {
  return new Hono<AppEnv>().get(`${MEDIA_PATH}/:id`, async (c) => {
    const notFound = () => c.body('Not found', 404, { 'cache-control': 'no-store' });
    const id = c.req.param('id');
    if (!ATTACHMENT_ID_PATTERN.test(id)) return notFound();
    const check = await verifyMediaUrl(c.env, {
      attachmentId: id,
      o: c.req.query('o'),
      e: c.req.query('e'),
      s: c.req.query('s'),
    });
    const bucket = c.env.MEDIA;
    if (!check.ok || !bucket) return notFound();
    const { db } = c.var;
    let row = await withTenant(db, check.orgId, async (tx) => {
      const [found] = await tx
        .select()
        .from(messageAttachment)
        .where(eq(messageAttachment.id, id))
        .limit(1);
      return found;
    });
    if (!row) return notFound();
    if (row.status === 'pending' && row.direction === 'inbound') {
      row = (await downloadNow(c.env, db, row, deps.fetch)) ?? row;
    }
    if (row.status !== 'stored' || !row.storageKey) return notFound();

    const head = await bucket.head(row.storageKey);
    if (!head) return notFound();
    const range = parseRange(c.req.header('range'), head.size);
    const object = await bucket.get(row.storageKey, range ? { range } : {});
    if (!object || !('body' in object)) return notFound();

    const base = baseMimeType(row.mimeType);
    const inline = INLINE_TYPES.has(base);
    const remaining = Math.max(0, check.expires - Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      'content-type': inline ? row.mimeType : 'application/octet-stream',
      'content-disposition': disposition(inline ? 'inline' : 'attachment', row.fileName ?? 'file'),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': `private, max-age=${Math.min(remaining, 3600)}`,
      'accept-ranges': 'bytes',
    };
    if (range) {
      headers['content-range'] =
        `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
      headers['content-length'] = String(range.length);
      return new Response(object.body, { status: 206, headers });
    }
    headers['content-length'] = String(head.size);
    return new Response(object.body, { status: 200, headers });
  });
}

/** Downloads an inbound file from the provider now, for a link opened before the consumer did it. */
async function downloadNow(
  env: AppEnv['Bindings'],
  db: AppEnv['Variables']['db'],
  row: MessageAttachment,
  fetchImpl: typeof fetch | undefined,
): Promise<MessageAttachment | undefined> {
  // The business number the file was sent to: the workspace's WhatsApp sender.
  const { client, businessNumber } = await withTenant(db, row.organizationId, async (tx) => {
    const sender = await senderFor(tx, env, 'whatsapp');
    return {
      client: await telnyxMessagingClient(tx, env, fetchImpl),
      businessNumber: sender?.address ?? '',
    };
  });
  const outcome = await downloadInbound(env, row, businessNumber, client);
  if (outcome.status === 'pending') return undefined;
  return withTenant(db, row.organizationId, async (tx) => {
    await recordDownload(tx, row, outcome);
    const [updated] = await tx
      .select()
      .from(messageAttachment)
      .where(eq(messageAttachment.id, row.id))
      .limit(1);
    return updated;
  });
}

export const mediaFile = mediaFileRoutes();
