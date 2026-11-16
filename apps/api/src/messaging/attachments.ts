import {
  type AttachmentKind,
  MAX_ATTACHMENT_BYTES,
  MEDIA_LIMITS,
  parseWaveform,
} from '@knoqra/core';
import {
  type MessageAttachment,
  message,
  messageAttachment,
  messageReaction,
  type Tx,
} from '@knoqra/db';
import type { MessagingProvider } from '@knoqra/providers';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import type { AttachmentJson, MessageExtras, ReactionJson, ReplyPreviewJson } from './json';
import { DESK_LINK_SECONDS, signedMediaUrl } from './media-url';

/** Object storage keys: one folder per organization. */
export const storageKey = (orgId: string, attachmentId: string): string =>
  `org/${orgId}/${attachmentId}`;

const REPLY_PREVIEW_CHARS = 160;

/** An attachment can be fetched when stored, or when its inbound file can still be downloaded. */
const fetchable = (row: MessageAttachment): boolean =>
  row.status === 'stored' ||
  (row.status === 'pending' &&
    row.direction === 'inbound' &&
    (row.sourceUrl !== null || row.providerMediaId !== null));

/** An attachment row as JSON, with a fresh Desk link when the file can be fetched. */
export async function attachmentJson(
  env: Env,
  row: MessageAttachment,
  nowMs = Date.now(),
): Promise<AttachmentJson> {
  const link = fetchable(row)
    ? await signedMediaUrl(env, {
        attachmentId: row.id,
        orgId: row.organizationId,
        seconds: DESK_LINK_SECONDS,
        nowMs,
      })
    : null;
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    fileName: row.fileName,
    status: row.status,
    durationMs: row.durationMs,
    waveform: parseWaveform(row.waveform),
    url: link?.url ?? null,
    urlExpiresAt: link ? link.expiresAt.toISOString() : null,
  };
}

/**
 * Files, reactions and quoted messages for a set of messages, in three queries. `replyToIds` maps a
 * message id to the id it replies to.
 */
export async function loadMessageExtras(
  tx: Tx,
  env: Env,
  messageIds: readonly string[],
  replyToIds: ReadonlyMap<string, string>,
): Promise<Map<string, MessageExtras>> {
  const extras = new Map<string, MessageExtras>();
  if (messageIds.length === 0) return extras;
  for (const id of messageIds) extras.set(id, { attachments: [], reactions: [], replyTo: null });

  const files = await tx
    .select()
    .from(messageAttachment)
    .where(inArray(messageAttachment.messageId, [...messageIds]))
    .orderBy(messageAttachment.createdAt, messageAttachment.id);
  const nowMs = Date.now();
  for (const file of files) {
    if (file.messageId)
      extras.get(file.messageId)?.attachments.push(await attachmentJson(env, file, nowMs));
  }

  const reactions = await tx
    .select()
    .from(messageReaction)
    .where(inArray(messageReaction.messageId, [...messageIds]))
    .orderBy(messageReaction.direction);
  for (const r of reactions) {
    const json: ReactionJson = { emoji: r.emoji, direction: r.direction, status: r.status };
    extras.get(r.messageId)?.reactions.push(json);
  }

  const targets = [...new Set(replyToIds.values())];
  if (targets.length > 0) {
    const quoted = await tx
      .select({ id: message.id, direction: message.direction, body: message.body })
      .from(message)
      .where(inArray(message.id, targets));
    const kinds = await firstAttachmentKinds(tx, targets);
    const previews = new Map<string, ReplyPreviewJson>(
      quoted.map((q) => [
        q.id,
        {
          id: q.id,
          direction: q.direction,
          body: Array.from(q.body).slice(0, REPLY_PREVIEW_CHARS).join(''),
          attachmentKind: kinds.get(q.id) ?? null,
        },
      ]),
    );
    for (const [id, target] of replyToIds) {
      const entry = extras.get(id);
      if (entry) entry.replyTo = previews.get(target) ?? null;
    }
  }
  return extras;
}

/** The kind of each message's first file. */
export async function firstAttachmentKinds(
  tx: Tx,
  messageIds: readonly string[],
): Promise<Map<string, AttachmentKind>> {
  if (messageIds.length === 0) return new Map();
  const rows = await tx
    .select({ messageId: messageAttachment.messageId, kind: messageAttachment.kind })
    .from(messageAttachment)
    .where(inArray(messageAttachment.messageId, [...messageIds]))
    .orderBy(messageAttachment.createdAt, messageAttachment.id);
  const kinds = new Map<string, AttachmentKind>();
  for (const row of rows)
    if (row.messageId && !kinds.has(row.messageId)) kinds.set(row.messageId, row.kind);
  return kinds;
}

/** The largest file of a kind, used to stop a download early. */
export const maxBytesFor = (kind: AttachmentKind): number =>
  Math.min(MEDIA_LIMITS[kind].maxBytes, MAX_ATTACHMENT_BYTES);

/**
 * Downloads an inbound attachment from the provider into object storage and marks it stored (or
 * failed, when the provider no longer has it). Runs outside any transaction for the download; the
 * row update is the caller's `record` step. Never throws for a provider failure; returns the new
 * status. Logs carry ids and codes only.
 */
export async function downloadInbound(
  env: Env,
  row: MessageAttachment,
  businessNumber: string,
  provider: MessagingProvider | null,
): Promise<
  { status: 'stored'; size: number; contentType: string } | { status: 'failed' | 'pending' }
> {
  const bucket = env.MEDIA;
  if (!bucket || !provider?.fetchWhatsAppMedia) return { status: 'pending' };
  try {
    const fetched = await provider.fetchWhatsAppMedia({
      businessNumber,
      ...(row.sourceUrl ? { url: row.sourceUrl } : {}),
      ...(row.providerMediaId ? { mediaId: row.providerMediaId } : {}),
      maxBytes: maxBytesFor(row.kind),
    });
    const key = storageKey(row.organizationId, row.id);
    const contentType = row.mimeType || fetched.contentType;
    // A known length streams straight through; otherwise the bytes are read (bounded) first.
    const body =
      fetched.size !== null
        ? fetched.body.pipeThrough(new FixedLengthStream(fetched.size))
        : await readBounded(fetched.body, maxBytesFor(row.kind));
    const stored = await bucket.put(key, body, { httpMetadata: { contentType } });
    return { status: 'stored', size: stored?.size ?? fetched.size ?? 0, contentType };
  } catch (error) {
    const status = (error as { status?: number }).status;
    logger.warn('messaging.media_download_failed', {
      attachmentId: row.id,
      orgId: row.organizationId,
      status,
      code: (error as { code?: string }).code,
    });
    // Gone at the provider (expired id, deleted file): it will never come.
    return { status: status === 404 || status === 410 || status === 413 ? 'failed' : 'pending' };
  }
}

/** Reads a stream up to `max` bytes; more is an error (status 413). */
async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) throw Object.assign(new Error('media too large'), { status: 413 });
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Records a download's outcome on the attachment row (a pending row only, so it lands once). */
export async function recordDownload(
  tx: Tx,
  row: Pick<MessageAttachment, 'id' | 'organizationId'>,
  outcome: Awaited<ReturnType<typeof downloadInbound>>,
): Promise<void> {
  if (outcome.status === 'pending') return;
  await tx
    .update(messageAttachment)
    .set(
      outcome.status === 'stored'
        ? {
            status: 'stored',
            storageKey: storageKey(row.organizationId, row.id),
            sizeBytes: outcome.size,
          }
        : { status: 'failed' },
    )
    .where(and(eq(messageAttachment.id, row.id), eq(messageAttachment.status, 'pending')));
}
