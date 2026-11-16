import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { messageStatusEvent, withTenant } from '@knoqra/db';
import { asc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';
import { auditMessagingAlone } from '../messaging/audit';
import { type MessageDetailJson, MessageDetailSchema, MessageSchema } from '../messaging/json';
import { setReaction } from '../messaging/reactions';
import { loadMessageJson, sendMessage } from '../messaging/send';

const MAX_BODY_LENGTH = 1600;
const MESSAGE_ID_PATTERN = /^mg_[0-9a-f]{32}$/;

const IdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const SendBody = z
  .object({
    clientMessageId: z.uuid(),
    body: safeText({ min: 1, max: MAX_BODY_LENGTH }).optional(),
    templateId: z.string().min(1).max(64).optional(),
    /** A draft file uploaded to this conversation (WhatsApp); `body` becomes its caption. */
    attachmentId: z.string().min(1).max(64).optional(),
    /** A message of this conversation to quote (an inbound WhatsApp message). */
    replyToMessageId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (v) =>
      v.templateId === undefined
        ? v.body !== undefined || v.attachmentId !== undefined
        : v.body === undefined && v.attachmentId === undefined && v.replyToMessageId === undefined,
    { message: 'Send a body or a file (optionally quoting a message), or a templateId alone.' },
  )
  .openapi('SendMessage');

const ReactionBody = z
  .object({ emoji: z.string().max(32).openapi({ description: 'One emoji; empty removes yours.' }) })
  .openapi('SetReaction');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const sendRoute = createRoute({
  method: 'post',
  path: '/api/v1/conversations/{id}/messages',
  tags: ['conversations'],
  summary: 'Send a free-text or template message (idempotent on clientMessageId)',
  security,
  request: { params: IdParam, body: { required: true, content: json(SendBody) } },
  responses: {
    200: { description: 'Replay of an earlier send', content: json(okEnvelope(MessageSchema)) },
    201: { description: 'Queued (or failed) message', content: json(okEnvelope(MessageSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    402: errorResponse('Not enough credit, or the message would pass the monthly spend cap'),
    404: errorResponse('No such conversation or template in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('Sending is blocked, paused, needs a template, or the template is unusable'),
    429: errorResponse('Too many requests'),
  },
});

const reactionRoute = createRoute({
  method: 'put',
  path: '/api/v1/messages/{id}/reaction',
  tags: ['conversations'],
  summary: "Set or remove the workspace's reaction to an inbound WhatsApp message",
  security,
  request: { params: IdParam, body: { required: true, content: json(ReactionBody) } },
  responses: {
    200: {
      description: 'The message with its reactions',
      content: json(okEnvelope(MessageSchema)),
    },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such message in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('Not a reactable message, too old, or sending is not allowed now'),
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/api/v1/messages/{id}',
  tags: ['conversations'],
  summary: 'One message with its delivery history, oldest first',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Message', content: json(okEnvelope(MessageDetailSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such message in the active organization'),
    409: errorResponse('No active organization'),
  },
});

async function messageNotFound(c: Context<AppEnv>, id: string | null) {
  const { db, tenant } = c.var;
  await auditMessagingAlone(db, tenant, {
    action: 'message.read',
    entityType: 'message',
    outcome: 'not_found',
    entityId: id,
    metadata: id === null ? { reason: 'malformed_id' } : {},
  });
  return fail(c, 404, 'not_found', 'Message not found.');
}

export const messages = new OpenAPIHono<AppEnv>()
  .openapi(sendRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    const { clientMessageId, body, templateId, attachmentId, replyToMessageId } =
      c.req.valid('json');
    const result = await sendMessage(
      {
        db,
        env: c.env,
        tenant,
        // The provider send runs after the response: the message is stored and answered first.
        background: (task) => c.executionCtx.waitUntil(task),
        requestUrl: c.req.url,
      },
      id,
      templateId === undefined
        ? {
            clientMessageId,
            ...(body !== undefined ? { body } : {}),
            ...(attachmentId !== undefined ? { attachmentId } : {}),
            ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
          }
        : { clientMessageId, templateId },
    );
    if (result.kind === 'error') return fail(c, result.status, result.code, result.message);
    return ok(c, result.message, result.kind === 'created' ? 201 : 200);
  })
  .openapi(reactionRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    const { emoji } = c.req.valid('json');
    const result = await setReaction(
      { db, env: c.env, tenant, background: (task) => c.executionCtx.waitUntil(task) },
      id,
      emoji.trim(),
    );
    if (result.kind === 'error') return fail(c, result.status, result.code, result.message);
    return ok(c, result.message, 200);
  })
  .openapi(detailRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!MESSAGE_ID_PATTERN.test(id)) return messageNotFound(c, null);
    const detail = await withTenant(db, tenant.orgId, async (tx) => {
      const found = await loadMessageJson(tx, c.env, id);
      if (!found) return undefined;
      const history = await tx
        .select()
        .from(messageStatusEvent)
        .where(eq(messageStatusEvent.messageId, id))
        .orderBy(
          asc(messageStatusEvent.occurredAt),
          asc(messageStatusEvent.createdAt),
          asc(messageStatusEvent.id),
        );
      const statusHistory = history.map((e) => ({
        status: e.status,
        applied: e.applied,
        occurredAt: e.occurredAt.toISOString(),
        errorCode: e.errorCode,
      }));
      return { ...found, statusHistory } satisfies MessageDetailJson;
    });
    if (!detail) return messageNotFound(c, id);
    return ok(c, detail, 200);
  });
