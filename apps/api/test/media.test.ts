import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { conversation, messageAttachment } from '@knoqra/db';
import type { MessagingProvider } from '@knoqra/providers';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import type { AppEnv } from '../src/lib/context';
import { requestDb } from '../src/lib/db';
import { signedMediaUrl, verifyMediaUrl } from '../src/messaging/media-url';
import { sendMessage } from '../src/messaging/send';
import { insertMessage } from '../src/messaging/store';
import { mediaFileRoutes, parseRange } from '../src/routes/media';
import { api, get, saveTelnyxCredential, withAppDb } from './helpers';
import {
  consentedThread,
  data,
  type MessagingOrg,
  type MessagingThread,
  sandboxOrg,
  tenantOf,
  tenantTx,
} from './messaging-helpers';

type Attachment = {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number | null;
  fileName: string | null;
  status: string;
  url: string | null;
  waveform: number[] | null;
  durationMs: number | null;
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function upload(
  org: MessagingOrg,
  conversationId: string,
  bytes: Uint8Array,
  type: string,
  query = '',
) {
  return api(`/api/v1/conversations/${conversationId}/attachments${query}`, {
    method: 'POST',
    headers: {
      cookie: org.cookie,
      'content-type': type,
      'content-length': String(bytes.byteLength),
    },
    body: bytes,
  });
}

let org: MessagingOrg;
let other: MessagingOrg;
let wa: MessagingThread;
let sms: MessagingThread;

beforeAll(async () => {
  org = await sandboxOrg('media');
  other = await sandboxOrg('media-other');
  wa = await consentedThread(org, 'whatsapp');
  sms = await consentedThread(org, 'sms');
});

describe('signed media links', () => {
  it('verify only for the same attachment, organization and an unexpired time', async () => {
    const now = Date.now();
    const { url } = await signedMediaUrl(env, {
      attachmentId: 'ma_1',
      orgId: 'org_a',
      seconds: 60,
      nowMs: now,
    });
    const q = new URL(url, 'https://x.test').searchParams;
    const base = {
      o: q.get('o') ?? undefined,
      e: q.get('e') ?? undefined,
      s: q.get('s') ?? undefined,
    };
    expect(await verifyMediaUrl(env, { attachmentId: 'ma_1', ...base, nowMs: now })).toMatchObject({
      ok: true,
      orgId: 'org_a',
    });
    expect((await verifyMediaUrl(env, { attachmentId: 'ma_2', ...base, nowMs: now })).ok).toBe(
      false,
    );
    expect(
      (await verifyMediaUrl(env, { attachmentId: 'ma_1', ...base, o: 'org_b', nowMs: now })).ok,
    ).toBe(false);
    expect(
      (
        await verifyMediaUrl(env, {
          attachmentId: 'ma_1',
          ...base,
          e: String(Number(base.e) + 3600),
          nowMs: now,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifyMediaUrl(env, {
          attachmentId: 'ma_1',
          ...base,
          nowMs: Number(base.e) * 1000 + 1,
        })
      ).ok,
    ).toBe(false);
    expect(
      (await verifyMediaUrl(env, { attachmentId: 'ma_1', ...base, s: undefined, nowMs: now })).ok,
    ).toBe(false);
  });

  it('parses single byte ranges', () => {
    expect(parseRange('bytes=0-3', 10)).toEqual({ offset: 0, length: 4 });
    expect(parseRange('bytes=5-', 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange('bytes=-3', 10)).toEqual({ offset: 7, length: 3 });
    expect(parseRange('bytes=9-20', 10)).toEqual({ offset: 9, length: 1 });
    expect(parseRange('bytes=10-12', 10)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange(undefined, 10)).toBeNull();
  });
});

describe('POST /api/v1/conversations/{id}/attachments', () => {
  it('stores an image and serves it back through its signed link', async () => {
    const r = await upload(org, wa.conversationId, PNG, 'image/png', '?name=part.png');
    expect(r.status).toBe(201);
    const file = await data<Attachment>(r);
    expect(file).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
      fileName: 'part.png',
      status: 'stored',
    });
    expect(file.url).toMatch(/^\/api\/media\/ma_[0-9a-f]{32}\?/);

    const served = await api(file.url as string);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    const ranged = await api(file.url as string, { headers: { range: 'bytes=0-3' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-3/${PNG.byteLength}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(PNG.slice(0, 4));
  });

  it('keeps a voice note with its duration and waveform', async () => {
    const ogg = new TextEncoder().encode('OggS-fake-voice-note');
    const r = await upload(
      org,
      wa.conversationId,
      ogg,
      'audio/ogg; codecs=opus',
      '?voice=true&durationMs=3200&waveform=0,50,100',
    );
    expect(r.status).toBe(201);
    expect(await data<Attachment>(r)).toMatchObject({
      kind: 'voice',
      mimeType: 'audio/ogg',
      durationMs: 3200,
      waveform: [0, 50, 100],
    });
  });

  it('serves a document as a download, never inline', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4 <script>alert(1)</script>');
    const file = await data<Attachment>(
      await upload(org, wa.conversationId, pdf, 'application/pdf', '?name=quote.pdf'),
    );
    const served = await api(file.url as string);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toMatch(/^attachment; filename="quote.pdf"/);
    expect(served.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('refuses types and sizes WhatsApp does not take, and SMS conversations', async () => {
    expect((await upload(org, wa.conversationId, PNG, 'text/html')).status).toBe(422);
    expect((await upload(org, wa.conversationId, PNG, 'audio/ogg; codecs=vorbis')).status).toBe(
      422,
    );
    const big = await api(`/api/v1/conversations/${wa.conversationId}/attachments`, {
      method: 'POST',
      headers: {
        cookie: org.cookie,
        'content-type': 'image/png',
        'content-length': String(6 * 1024 * 1024),
      },
      body: new Uint8Array(6 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
    const onSms = await upload(org, sms.conversationId, PNG, 'image/png');
    expect(onSms.status).toBe(422);
  });

  it("answers 404 for another workspace's conversation", async () => {
    expect((await upload(other, wa.conversationId, PNG, 'image/png')).status).toBe(404);
  });
});

describe('GET /api/media/{id}', () => {
  it('answers a bare 404 for a tampered, foreign or expired link', async () => {
    const file = await data<Attachment>(await upload(org, wa.conversationId, PNG, 'image/png'));
    const url = new URL(file.url as string, 'https://x.test');
    const tampered = new URL(url);
    tampered.searchParams.set('s', `${url.searchParams.get('s')?.slice(0, -2)}AA`);
    expect((await api(`${tampered.pathname}${tampered.search}`)).status).toBe(404);
    const foreign = new URL(url);
    foreign.searchParams.set('o', other.orgId);
    expect((await api(`${foreign.pathname}${foreign.search}`)).status).toBe(404);
    const expired = await signedMediaUrl(env, {
      attachmentId: file.id,
      orgId: org.orgId,
      seconds: 60,
      nowMs: Date.now() - 3 * 3600_000,
    });
    expect((await api(expired.url)).status).toBe(404);
    expect((await api(`/api/media/${file.id}`)).status).toBe(404);
  });

  it('gives a fresh link through the session route, only to the owning workspace', async () => {
    const file = await data<Attachment>(await upload(org, wa.conversationId, PNG, 'image/png'));
    const fresh = await data<Attachment>(await get(`/api/v1/attachments/${file.id}`, org.cookie));
    expect(fresh.url).toMatch(/^\/api\/media\//);
    expect((await get(`/api/v1/attachments/${file.id}`, other.cookie)).status).toBe(404);
  });
});

describe('sending a file', () => {
  it('sends the stored file by a signed link on the public origin, with the caption', async () => {
    // An inbound message opens the WhatsApp window.
    await tenantTx(org, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, wa.conversationId));
      if (!conv) throw new Error('no conversation');
      await insertMessage(tx, {
        orgId: org.orgId,
        conversation: conv,
        direction: 'inbound',
        body: 'Send me a photo',
        status: 'received',
        provider: 'fake',
        providerMessageId: `pm_${crypto.randomUUID().replaceAll('-', '')}`,
        occurredAt: new Date(),
      });
    });
    const file = await data<Attachment>(await upload(org, wa.conversationId, PNG, 'image/png'));
    const seen: unknown[] = [];
    const provider: MessagingProvider = {
      sendSms: async () => ({ providerMessageId: 'x', state: 'queued' }),
      sendWhatsApp: async (input) => {
        seen.push(input);
        return {
          providerMessageId: `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`,
          state: 'queued',
        };
      },
    };
    const mediaEnv = { ...env, API_PUBLIC_ORIGIN: 'https://api.example.test' } as Env;
    const result = await withAppDb((db) =>
      sendMessage({ db, env: mediaEnv, tenant: tenantOf(org), provider }, wa.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'The new part',
        attachmentId: file.id,
      }),
    );
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.attachments).toMatchObject([{ id: file.id, kind: 'image' }]);
    expect(result.message.providerMessageId).toMatch(/^fake_msg_/);
    const sent = seen[0] as { body: string; media: { kind: string; link: string } };
    expect(sent.body).toBe('The new part');
    expect(sent.media.kind).toBe('image');
    expect(sent.media.link).toMatch(
      new RegExp(`^https://api\\.example\\.test/api/media/${file.id}\\?`),
    );
    const served = await api(new URL(sent.media.link).pathname + new URL(sent.media.link).search);
    expect(served.status).toBe(200);

    // A file is sent once: naming it again is refused.
    const again = await withAppDb((db) =>
      sendMessage({ db, env: mediaEnv, tenant: tenantOf(org), provider }, wa.conversationId, {
        clientMessageId: crypto.randomUUID(),
        attachmentId: file.id,
      }),
    );
    expect(again).toMatchObject({ kind: 'error', status: 422 });
  });
});

describe('inbound files', () => {
  it('downloads a pending inbound file from the provider when its link is first opened', async () => {
    const owner = await sandboxOrg('media-inbound');
    await saveTelnyxCredential(owner.orgId, null);
    const t = await consentedThread(owner, 'whatsapp');
    const attachmentId = await tenantTx(owner, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, t.conversationId));
      if (!conv) throw new Error('no conversation');
      const inbound = await insertMessage(tx, {
        orgId: owner.orgId,
        conversation: conv,
        direction: 'inbound',
        body: '',
        status: 'received',
        provider: 'fake',
        providerMessageId: `pm_${crypto.randomUUID().replaceAll('-', '')}`,
        occurredAt: new Date(),
        attachmentKind: 'image',
      });
      const [row] = await tx
        .insert(messageAttachment)
        .values({
          organizationId: owner.orgId,
          conversationId: conv.id,
          messageId: inbound.id,
          direction: 'inbound',
          kind: 'image',
          mimeType: 'image/png',
          status: 'pending',
          sourceUrl: 'https://media.example.test/hosted/1',
        })
        .returning();
      return row?.id as string;
    });
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) },
      });
    }) as typeof fetch;
    const app = new Hono<AppEnv>()
      .use('/api/media/*', requestDb)
      .route('/', mediaFileRoutes({ fetch: fetchImpl }));
    const { url } = await signedMediaUrl(env, { attachmentId, orgId: owner.orgId, seconds: 600 });
    const ctx = createExecutionContext();
    const served = await app.request(url, {}, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
    expect(fetched).toEqual(['https://media.example.test/hosted/1']);
    const [row] = await tenantTx(owner, (tx) =>
      tx.select().from(messageAttachment).where(eq(messageAttachment.id, attachmentId)),
    );
    expect(row).toMatchObject({ status: 'stored', sizeBytes: PNG.byteLength });
  });
});
