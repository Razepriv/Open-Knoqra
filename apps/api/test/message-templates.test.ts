import { auditEvent, channelConnection, messageTemplate, withTenant } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, get, post, signUp, signUpTeammate, uniqueEmail, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Template = {
  id: string;
  name: string;
  channel: string;
  body: string;
  placeholders: string[];
  approvalStatus: string;
  archivedAt: string | null;
  createdAt: string;
  whatsappTemplateName: string | null;
  whatsappLanguage: string | null;
};

let cookieA: string;
let cookieB: string;
let cookieC: string;
let orgB: string;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

const create = (cookie: string, body: unknown) => post('/api/v1/messaging/templates', cookie, body);

async function created(cookie: string, body: unknown): Promise<Template> {
  const json = (await (await create(cookie, body)).json()) as Envelope<Template>;
  if (!json.data) throw new Error(`create failed: ${JSON.stringify(json.error)}`);
  return json.data;
}

async function list(cookie: string, query = ''): Promise<Template[]> {
  const r = await get(`/api/v1/messaging/templates${query}`, cookie);
  const json = (await r.json()) as Envelope<{ items: Template[] }>;
  return json.data?.items ?? [];
}

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('tpl-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('tpl-b'), 'Owner B');
  cookieC = await signUp(uniqueEmail('tpl-c'), 'Owner C');
  orgB = await orgOf(cookieB);
});

describe('message templates', () => {
  it('creates, lists and archives a template', async () => {
    const r = await create(cookieA, {
      name: 'Welcome',
      channel: 'sms',
      body: 'Hi {{first_name}}, from {{company}}',
    });
    expect(r.status).toBe(201);
    const t = ((await r.json()) as Envelope<Template>).data;
    expect(t).toMatchObject({
      name: 'Welcome',
      channel: 'sms',
      placeholders: ['first_name', 'company'],
      approvalStatus: 'approved',
      archivedAt: null,
    });
    expect(await list(cookieA)).toHaveLength(1);

    const a = await post(`/api/v1/messaging/templates/${t?.id}/archive`, cookieA, {});
    expect(a.status).toBe(200);
    expect(((await a.json()) as Envelope<Template>).data?.archivedAt).not.toBeNull();
    expect(await list(cookieA)).toHaveLength(0);
    expect(await list(cookieA, '?includeArchived=true')).toHaveLength(1);
    // the name is free again after archiving
    expect((await create(cookieA, { name: 'Welcome', channel: 'sms', body: 'x' })).status).toBe(
      201,
    );
  });

  it('lists by name and filters by channel', async () => {
    await created(cookieC, { name: 'Zeta', channel: 'sms', body: 'z' });
    await created(cookieC, { name: 'Alpha', channel: 'whatsapp', body: 'a' });
    expect((await list(cookieC)).map((t) => t.name)).toEqual(['Alpha', 'Zeta']);
    expect((await list(cookieC, '?channel=sms')).map((t) => t.name)).toEqual(['Zeta']);
  });

  it('rejects an unknown placeholder with 400', async () => {
    const r = await create(cookieA, { name: 'Bad', channel: 'sms', body: 'Call {{phone}}' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'Unknown placeholder {{phone}}. Use {{first_name}}, {{name}} or {{company}}.',
    });
  });

  it('rejects a malformed placeholder such as {{First_Name}} with 400', async () => {
    const r = await create(cookieA, { name: 'Caps', channel: 'sms', body: 'Hi {{First_Name}}' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'Unknown placeholder {{First_Name}}. Use {{first_name}}, {{name}} or {{company}}.',
    });
  });

  it('rejects a duplicate name with 409 duplicate_template, but allows the other channel', async () => {
    expect((await create(cookieB, { name: 'Promo', channel: 'sms', body: 'a' })).status).toBe(201);
    const dup = await create(cookieB, { name: 'promo', channel: 'sms', body: 'b' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as Envelope<unknown>).error).toEqual({
      code: 'duplicate_template',
      message: 'A template with this name already exists.',
    });
    expect((await create(cookieB, { name: 'Promo', channel: 'whatsapp', body: 'a' })).status).toBe(
      201,
    );
  });

  it('sets WhatsApp approval from the org sender', async () => {
    const cookie = await signUp(uniqueEmail('tpl-wa'), 'Owner WA');
    const pending = await created(cookie, { name: 'First', channel: 'whatsapp', body: 'a' });
    expect(pending.approvalStatus).toBe('pending');
    const sandbox = await api('/api/v1/messaging/sandbox', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ sms: 'approved', whatsapp: 'approved' }),
    });
    expect(sandbox.status).toBe(200);
    const approved = await created(cookie, { name: 'Second', channel: 'whatsapp', body: 'a' });
    expect(approved.approvalStatus).toBe('approved');
  });

  it('404s and audits archiving another org template or a malformed id', async () => {
    const t = await created(cookieA, { name: 'Private', channel: 'sms', body: 'a' });
    const r = await post(`/api/v1/messaging/templates/${t.id}/archive`, cookieB, {});
    expect(r.status).toBe(404);
    const bad = await post('/api/v1/messaging/templates/nope/archive', cookieB, {});
    expect(bad.status).toBe(404);
    const audits = await withAppDb((db) =>
      withTenant(db, orgB, (tx) => tx.select().from(auditEvent)),
    );
    expect(
      audits.filter((a) => a.action === 'template.archive' && a.outcome === 'not_found'),
    ).toHaveLength(2);
    expect(audits.some((a) => a.action === 'template.create' && a.outcome === 'allowed')).toBe(
      true,
    );
    expect((await list(cookieA)).some((x) => x.id === t.id)).toBe(true);
  });

  it('stores the Meta template fields and returns them', async () => {
    const cookie = await signUp(uniqueEmail('tpl-meta'), 'Owner Meta');
    const t = await created(cookie, {
      name: 'Table ready',
      channel: 'whatsapp',
      body: 'Hi {{first_name}}',
      whatsappTemplateName: 'table_ready',
      whatsappLanguage: 'en_US',
    });
    expect(t).toMatchObject({ whatsappTemplateName: 'table_ready', whatsappLanguage: 'en_US' });
    expect((await list(cookie)).find((x) => x.id === t.id)).toMatchObject({
      whatsappTemplateName: 'table_ready',
      whatsappLanguage: 'en_US',
    });
    const plain = await created(cookie, { name: 'Plain', channel: 'sms', body: 'a' });
    expect(plain).toMatchObject({ whatsappTemplateName: null, whatsappLanguage: null });
  });

  it('rejects malformed Meta fields, a lone field, and Meta fields on SMS with 400', async () => {
    const base = { channel: 'whatsapp', body: 'a' };
    for (const meta of [
      { whatsappTemplateName: 'Table Ready', whatsappLanguage: 'en_US' },
      { whatsappTemplateName: 'x'.repeat(513), whatsappLanguage: 'en_US' },
      { whatsappTemplateName: '', whatsappLanguage: 'en_US' },
      { whatsappTemplateName: 'table_ready', whatsappLanguage: 'en-us' },
      { whatsappTemplateName: 'table_ready', whatsappLanguage: 'english' },
    ]) {
      const r = await create(cookieC, { name: `Bad ${crypto.randomUUID()}`, ...base, ...meta });
      expect(r.status, JSON.stringify(meta)).toBe(400);
      expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('validation_error');
    }
    const lone = await create(cookieC, {
      name: 'Lone',
      ...base,
      whatsappTemplateName: 'table_ready',
    });
    expect(lone.status).toBe(400);
    expect(((await lone.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'Live WhatsApp templates need the Meta template name and language.',
    });
    const sms = await create(cookieC, {
      name: 'Sms meta',
      channel: 'sms',
      body: 'a',
      whatsappTemplateName: 'table_ready',
      whatsappLanguage: 'en_US',
    });
    expect(sms.status).toBe(400);
    expect(((await sms.json()) as Envelope<unknown>).error?.code).toBe('validation_error');
  });

  it('requires the Meta fields for WhatsApp when the sender is telnyx', async () => {
    const cookie = await signUp(uniqueEmail('tpl-telnyx'), 'Owner Telnyx');
    const orgId = await orgOf(cookie);
    await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        tx.insert(channelConnection).values({
          organizationId: orgId,
          channel: 'whatsapp',
          provider: 'telnyx',
          address: '+12025550198',
          registrationStatus: 'approved',
        }),
      ),
    );
    const missing = await create(cookie, { name: 'No meta', channel: 'whatsapp', body: 'a' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'Live WhatsApp templates need the Meta template name and language.',
    });
    const ok = await created(cookie, {
      name: 'With meta',
      channel: 'whatsapp',
      body: 'a',
      whatsappTemplateName: 'with_meta',
      whatsappLanguage: 'es',
    });
    expect(ok).toMatchObject({ approvalStatus: 'pending', whatsappLanguage: 'es' });
    // SMS templates through the same org need nothing from Meta.
    expect((await create(cookie, { name: 'Sms', channel: 'sms', body: 'a' })).status).toBe(201);
  });

  it('rejects NUL in the body with 400', async () => {
    const r = await create(cookieA, { name: 'Nul', channel: 'sms', body: 'a\u0000b' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/v1/messaging/templates/{id}/approve', () => {
  let cookie: string;
  let orgId: string;

  /** A WhatsApp template under a telnyx sender: created pending, as Meta has not approved it. */
  async function pendingTemplate(meta: boolean): Promise<string> {
    const name = `tpl_${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        tx
          .insert(messageTemplate)
          .values({
            organizationId: orgId,
            name,
            channel: 'whatsapp',
            body: 'Hi {{first_name}}',
            approvalStatus: 'pending',
            ...(meta ? { whatsappTemplateName: name, whatsappLanguage: 'en_US' } : {}),
          })
          .returning(),
      ),
    );
    if (!row) throw new Error('template insert failed');
    return row.id;
  }

  const approve = (as: string, id: string) =>
    post(`/api/v1/messaging/templates/${id}/approve`, as, {});

  const approveAudits = (outcome: string) =>
    withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, 'template.approve'),
              eq(auditEvent.outcome, outcome as 'allowed'),
            ),
          ),
      ),
    );

  beforeAll(async () => {
    cookie = await signUp(uniqueEmail('tpl-approve'), 'Owner Approve');
    orgId = await orgOf(cookie);
  });

  it('answers 403 for a member', async () => {
    const id = await pendingTemplate(true);
    const mate = await signUpTeammate(orgId);
    const r = await approve(mate.cookie, id);
    expect(r.status).toBe(403);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('forbidden');
    expect(await approveAudits('denied')).toHaveLength(1);
  });

  it('answers 422 for a WhatsApp template without the Meta fields, or an SMS template', async () => {
    const r = await approve(cookie, await pendingTemplate(false));
    expect(r.status).toBe(422);
    expect(((await r.json()) as Envelope<unknown>).error?.message).toBe(
      'Live WhatsApp templates need the Meta template name and language.',
    );
    const sms = await created(cookie, { name: 'Sms approve', channel: 'sms', body: 'x' });
    expect((await approve(cookie, sms.id)).status).toBe(422);
  });

  it('marks a pending template approved and audits it', async () => {
    const id = await pendingTemplate(true);
    const r = await approve(cookie, id);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Template>).data).toMatchObject({
      id,
      approvalStatus: 'approved',
    });
    expect((await list(cookie, '?channel=whatsapp')).find((t) => t.id === id)?.approvalStatus).toBe(
      'approved',
    );
    const audits = await approveAudits('allowed');
    expect(audits.map((a) => a.entityId)).toContain(id);
    // Approving again is a no-op that still answers the template.
    expect((await approve(cookie, id)).status).toBe(200);
  });

  it("answers 404 for another workspace's template", async () => {
    const id = await pendingTemplate(true);
    expect((await approve(cookieB, id)).status).toBe(404);
    expect((await approve(cookie, 'garbage')).status).toBe(404);
  });
});
