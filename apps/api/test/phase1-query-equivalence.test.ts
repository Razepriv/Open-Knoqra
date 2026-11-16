import { contact, type Tx, task, timelineEvent, withTenant } from '@knoqra/db';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTaskCursor, decodeTimelineCursor } from '../src/lib/cursor';
import { ensureConversation, insertMessage } from '../src/messaging/store';
import { get, signUp, uniqueEmail, withAppDb } from './helpers';

/**
 * Equivalence oracles for the M6c Task 10 query changes. Each expected result comes from the
 * query as it was before the change, verbatim in SQL here, run as knoqra_app under RLS. The
 * routes must return exactly the same rows, page by page, however they compute them now:
 *  - the open task list: keyset and order on coalesce(due_at, 'infinity'), now the stored due_key;
 *  - the inbox search: display_name ILIKE, now the stored sort_name LIKE lower(pattern);
 *  - the conversation thread: one keyset over the UNION ALL, now pushed into each branch.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Page<T> = { items: T[]; nextCursor: string | null };

interface Org {
  cookie: string;
  orgId: string;
  userId: string;
}

async function setupOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Oracle ${label}`);
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!body.data) throw new Error('no me');
  return { cookie, orgId: body.data.organization.id, userId: body.data.user.id };
}

const tenant = <T>(org: Org, fn: (tx: Tx) => Promise<T>) =>
  withAppDb((db) => withTenant(db, org.orgId, fn));

async function page<T>(org: Org, path: string): Promise<Page<T>> {
  const r = await get(path, org.cookie);
  const json = (await r.json()) as Envelope<Page<T>>;
  if (r.status !== 200 || !json.data) throw new Error(`${path}: ${r.status}`);
  return json.data;
}

/** Walks every page of a route, returning each page's ids and the cursor that led to it. */
async function walk<T>(
  org: Org,
  base: string,
  idOf: (item: T) => string,
): Promise<{ cursor: string | null; ids: string[] }[]> {
  const pages: { cursor: string | null; ids: string[] }[] = [];
  let cursor: string | null = null;
  do {
    const sep = base.includes('?') ? '&' : '?';
    const path: string = cursor ? `${base}${sep}cursor=${encodeURIComponent(cursor)}` : base;
    const p: Page<T> = await page<T>(org, path);
    pages.push({ cursor, ids: p.items.map(idOf) });
    cursor = p.nextCursor;
  } while (cursor && pages.length < 100);
  return pages;
}

describe('open task list: due_key against coalesce(due_at, infinity)', () => {
  let org: Org;
  let contactId: string;

  beforeAll(async () => {
    org = await setupOrg('task-oracle');
    await tenant(org, async (tx) => {
      const [c] = await tx
        .insert(contact)
        .values({ organizationId: org.orgId, displayName: 'Due Oracle', phoneE164: '+12025550150' })
        .returning();
      if (!c) throw new Error('contact insert failed');
      contactId = c.id;
      const due = (iso: string | null) => (iso === null ? null : new Date(iso));
      // One statement: every row shares created_at, so ties fall to id. Null and equal due dates,
      // past and future, with and without the contact, and done tasks that must never appear.
      const dues = [
        null,
        '2026-01-01T00:00:00.000Z',
        null,
        '2026-01-01T00:00:00.000Z',
        '2025-06-01T12:00:00.000Z',
        '2027-03-01T00:00:00.000Z',
        null,
        '2026-01-01T00:00:00.000Z',
        '2025-06-01T12:00:00.000Z',
      ];
      await tx.insert(task).values(
        dues.map((d, i) => ({
          organizationId: org.orgId,
          ownerUserId: org.userId,
          contactId: i % 2 === 0 ? contactId : null,
          title: `Oracle ${i}`,
          dueAt: due(d),
        })),
      );
      await tx.insert(task).values([
        {
          organizationId: org.orgId,
          ownerUserId: org.userId,
          title: 'Later null',
          dueAt: null,
        },
        {
          organizationId: org.orgId,
          ownerUserId: org.userId,
          contactId,
          title: 'Done',
          dueAt: new Date('2025-01-01T00:00:00.000Z'),
          status: 'done',
          completedAt: new Date('2025-01-02T00:00:00.000Z'),
        },
      ]);
    });
  });

  /** The pre-M6c list query: order and keyset over the coalesce expression. */
  function oracle(
    filterContact: string | null,
    after: { due: string; createdAt: string; id: string } | null,
    limit: number,
  ): Promise<string[]> {
    return tenant(org, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        select task.id from task left join contact on contact.id = task.contact_id
        where task.owner_user_id = ${org.userId} and task.status = 'open'
          ${filterContact ? sql`and task.contact_id = ${filterContact}` : sql``}
          ${
            after
              ? sql`and (coalesce(task.due_at, 'infinity'::timestamptz), task.created_at, task.id) > (${after.due}::timestamptz, ${after.createdAt}::timestamptz, ${after.id})`
              : sql``
          }
        order by coalesce(task.due_at, 'infinity'::timestamptz) asc, task.created_at asc, task.id asc
        limit ${limit}`);
      return result.rows.map((r) => r.id);
    });
  }

  for (const withContact of [false, true]) {
    it(`pages exactly as the coalesce keyset did${withContact ? ' for one contact' : ''}`, async () => {
      const filter = withContact ? contactId : null;
      const base = `/api/v1/tasks?status=open&limit=2${filter ? `&contactId=${filter}` : ''}`;
      const pages = await walk<{ id: string }>(org, base, (t) => t.id);
      for (const p of pages) {
        let after: { due: string; createdAt: string; id: string } | null = null;
        if (p.cursor) {
          const decoded = decodeTaskCursor(p.cursor);
          if (!decoded.ok || decoded.value.status !== 'open') throw new Error('bad cursor');
          after = decoded.value;
        }
        expect(p.ids).toEqual(await oracle(filter, after, 2));
      }
      expect(pages.flatMap((p) => p.ids)).toEqual(await oracle(filter, null, 1000));
      expect(pages.length).toBeGreaterThan(2);
    });
  }
});

describe('inbox search: sort_name LIKE lower(pattern) against display_name ILIKE', () => {
  let org: Org;
  const names = [
    'Smith',
    'Élodie Durand',
    'ÉLODIE Martin',
    '100% Real',
    'under_score',
    'Back\\slash',
    'İstanbul Office',
    'ǅemal Group',
    'Straße Kunde',
    'MiXeD CaSe',
  ];

  beforeAll(async () => {
    org = await setupOrg('inbox-oracle');
    await tenant(org, async (tx) => {
      for (const [i, displayName] of names.entries()) {
        const [c] = await tx
          .insert(contact)
          .values({
            organizationId: org.orgId,
            displayName,
            phoneE164: `+1202555${String(160 + i).padStart(4, '0')}`,
          })
          .returning();
        if (!c) throw new Error('contact insert failed');
        await ensureConversation(tx, org.orgId, c.id, i % 3 === 0 ? 'whatsapp' : 'sms');
      }
    });
  });

  /** Independent copy of the route's LIKE escaping: backslash before \, % and _. */
  const escapeLike = (v: string) => v.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  /** The pre-M6c search predicate, verbatim. */
  function oracle(q: string): Promise<string[]> {
    const digits = q.replace(/\D/g, '');
    return tenant(org, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        select conversation.id from conversation
        inner join contact on contact.id = conversation.contact_id
        where (contact.display_name ilike ${`%${escapeLike(q)}%`}
          ${digits.length >= 3 ? sql`or contact.phone_e164 like ${`%${digits}%`}` : sql``})
        order by conversation.last_activity_at desc, conversation.id desc`);
      return result.rows.map((r) => r.id);
    });
  }

  const queries = [
    'smith',
    'élodie',
    'ÉLODIE',
    'durand',
    '100%',
    '%',
    '_',
    'under_score',
    '\\',
    'back\\slash',
    'istanbul',
    'İSTANBUL',
    'ǆemal',
    'STRASSE',
    'straße',
    'mixed case',
    '0163',
    '555',
    'zz-no-match',
  ];

  for (const q of queries) {
    it(`q=${JSON.stringify(q)} returns the same conversations`, async () => {
      const got = await page<{ id: string }>(
        org,
        `/api/v1/conversations?limit=200&q=${encodeURIComponent(q)}`,
      );
      expect(got.items.map((c) => c.id)).toEqual(await oracle(q));
    });
  }
});

describe('conversation thread: per-branch keyset against the outer UNION ALL keyset', () => {
  let org: Org;
  let conversationId: string;

  beforeAll(async () => {
    org = await setupOrg('thread-oracle');
    conversationId = await tenant(org, async (tx) => {
      const [c] = await tx
        .insert(contact)
        .values({
          organizationId: org.orgId,
          displayName: 'Thread Oracle',
          phoneE164: '+12025550170',
        })
        .returning();
      if (!c) throw new Error('contact insert failed');
      const conv = await ensureConversation(tx, org.orgId, c.id, 'sms');
      // Messages and notes interleave, with exact timestamp ties inside and across branches.
      const at = (minute: number) => new Date(Date.UTC(2026, 5, 1, 12, minute, 0, 0));
      for (const [i, minute] of [0, 1, 1, 3, 5, 5, 5, 8, 9, 12, 12].entries()) {
        await insertMessage(tx, {
          orgId: org.orgId,
          conversation: conv,
          direction: i % 2 === 0 ? 'inbound' : 'outbound',
          body: `Message ${i}`,
          status: i % 2 === 0 ? 'received' : 'sent',
          provider: 'fake',
          providerMessageId: `oracle-${conv.id}-${i}`,
          occurredAt: at(minute),
        });
      }
      for (const [i, minute] of [1, 2, 5, 5, 7, 12, 13].entries()) {
        await tx.insert(timelineEvent).values({
          organizationId: org.orgId,
          contactId: c.id,
          kind: 'note',
          title: 'Note',
          body: `Note ${i}`,
          actorUserId: org.userId,
          source: 'inbox',
          refType: 'conversation',
          refId: conv.id,
          occurredAt: at(minute),
        });
      }
      // A note of the same contact without the conversation ref, and a non-note ref: never shown.
      await tx.insert(timelineEvent).values([
        {
          organizationId: org.orgId,
          contactId: c.id,
          kind: 'note',
          title: 'Note',
          body: 'Unlinked',
          occurredAt: at(6),
        },
        {
          organizationId: org.orgId,
          contactId: c.id,
          kind: 'system',
          title: 'System',
          refType: 'conversation',
          refId: conv.id,
          occurredAt: at(6),
        },
      ]);
      return conv.id;
    });
  });

  /** The pre-M6c thread query, verbatim apart from the selected columns. */
  function oracle(
    after: { occurredAt: string; id: string } | null,
    limit: number,
  ): Promise<string[]> {
    return tenant(org, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        select x.id from (
          select 'message'::text as kind, m.id, m.occurred_at
          from message m
          left join message_template t on t.id = m.template_id and t.organization_id = m.organization_id
          where m.conversation_id = ${conversationId}
          union all
          select 'note'::text, te.id, te.occurred_at
          from timeline_event te
          left join "user" u on u.id = te.actor_user_id
          where te.kind = 'note' and te.ref_type = 'conversation' and te.ref_id = ${conversationId}
        ) x
        ${after ? sql`where (x.occurred_at, x.id) < (${after.occurredAt}::timestamptz, ${after.id})` : sql``}
        order by x.occurred_at desc, x.id desc
        limit ${limit}`);
      return result.rows.map((r) => r.id);
    });
  }

  type Item = { kind: 'message'; message: { id: string } } | { kind: 'note'; note: { id: string } };
  const idOf = (i: Item) => (i.kind === 'message' ? i.message.id : i.note.id);

  for (const limit of [1, 2, 3, 50]) {
    it(`pages with limit=${limit} exactly as the outer keyset did`, async () => {
      const pages = await walk<Item>(
        org,
        `/api/v1/conversations/${conversationId}/items?limit=${limit}`,
        idOf,
      );
      for (const p of pages) {
        let after: { occurredAt: string; id: string } | null = null;
        if (p.cursor) {
          const decoded = decodeTimelineCursor(p.cursor);
          if (!decoded.ok) throw new Error('bad cursor');
          after = decoded.value;
        }
        expect(p.ids).toEqual(await oracle(after, limit));
      }
      const all = pages.flatMap((p) => p.ids);
      expect(all).toEqual(await oracle(null, 1000));
      expect(all).toHaveLength(18);
    });
  }
});
