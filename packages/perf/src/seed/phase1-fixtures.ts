// Phase 1 fixture values, all read back by SQL from the seeded database (as the M1 deep cursors
// are), then encoded with the routes' own cursor encoders.
import {
  encodeConversationCursor,
  encodeTaskCursor,
  encodeTimelineCursor,
} from '@knoqra/api/cursor';
import type pg from 'pg';

/** Deep-cursor offsets at full scale, scaled down with `--scale`. */
export const PHASE1_DEEP_OFFSETS = {
  calls: 100_000,
  conversations: 30_000,
  thread: 15_000,
  tasksOpen: 6_000,
  tasksDone: 4_000,
  ledger: 150_000,
  reconciliations: 150,
} as const;

type At = { occurredAt: string; id: string };

export interface Phase1Raw {
  ids: { heavyConversation: string; message: string };
  search: { conversationName: string; conversationDigits: string };
  usage: { from: string; to: string };
  calls: At;
  conversations: At;
  thread: At;
  tasksOpen: { due: string; createdAt: string; id: string };
  tasksDone: { completedAt: string; id: string };
  ledger: At;
  reconciliations: At;
}

export interface Phase1Fixtures {
  ids: { heavyConversation: string; message: string };
  search: { conversationName: string; conversationDigits: string };
  cursors: {
    callsDeep: string;
    conversationsDeep: string;
    threadDeep: string;
    tasksOpenDeep: string;
    tasksDoneDeep: string;
    ledgerDeep: string;
    reconciliationsDeep: string;
  };
  usage: { from: string; to: string };
}

/** Pure: encodes the raw values with each route's cursor module. */
export function encodePhase1(raw: Phase1Raw): Phase1Fixtures {
  return {
    ids: raw.ids,
    search: raw.search,
    usage: raw.usage,
    cursors: {
      callsDeep: encodeTimelineCursor(raw.calls),
      conversationsDeep: encodeConversationCursor({
        lastActivityAt: raw.conversations.occurredAt,
        id: raw.conversations.id,
      }),
      threadDeep: encodeTimelineCursor(raw.thread),
      tasksOpenDeep: encodeTaskCursor({ status: 'open', ...raw.tasksOpen }),
      tasksDoneDeep: encodeTaskCursor({ status: 'done', ...raw.tasksDone }),
      ledgerDeep: encodeTimelineCursor(raw.ledger),
      reconciliationsDeep: encodeTimelineCursor(raw.reconciliations),
    },
  };
}

const KEY = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const key = (column: string) => `to_char(${column} at time zone 'UTC', ${KEY})`;

/** Row `offset` (scaled, clamped to the last row) of `from ... order by ...`. */
async function rowAt<T extends Record<string, string>>(
  client: pg.Client,
  label: string,
  select: string,
  from: string,
  order: string,
  params: unknown[],
  fullOffset: number,
  scale: number,
): Promise<T> {
  const counted = await client.query<{ n: string }>(`select count(*)::text as n ${from}`, params);
  const n = Number(counted.rows[0]?.n ?? 0);
  if (n === 0) throw new Error(`no rows for the ${label} fixture`);
  const offset = Math.max(0, Math.min(Math.round(fullOffset * scale), n - 1));
  const { rows } = await client.query<T>(
    `select ${select} ${from} order by ${order} offset ${offset} limit 1`,
    params,
  );
  return rows[0] as T;
}

async function one<T extends Record<string, string>>(
  client: pg.Client,
  label: string,
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<T>(text, params);
  const row = rows[0];
  if (!row) throw new Error(`no rows for the ${label} fixture`);
  return row;
}

const THREAD_FROM = `from (
    select m.id, m.occurred_at from message m
     where m.organization_id = $2 and m.conversation_id = $1
    union all
    select te.id, te.occurred_at from timeline_event te
     where te.organization_id = $2 and te.kind = 'note' and te.ref_type = 'conversation'
       and te.ref_id = $1
  ) x`;

/**
 * Reads every Phase 1 fixture for organization `orgId`. The seed's owner connection is the
 * database owner, which bypasses RLS, so every query names the organization explicitly instead of
 * relying on app.org_id.
 */
export async function queryPhase1(
  client: pg.Client,
  orgId: string,
  ownerEmail: string,
  scale: number,
): Promise<Phase1Raw> {
  const o = PHASE1_DEEP_OFFSETS;
  const { id: ownerId } = await one<{ id: string }>(
    client,
    'owner',
    'select id from "user" where email = $1',
    [ownerEmail],
  );
  const { id: heavyConversation } = await one<{ id: string }>(
    client,
    'heavy conversation',
    `select conversation_id as id from message where organization_id = $1
      group by 1 order by count(*) desc, 1 limit 1`,
    [orgId],
  );
  const message = await one<{ id: string }>(
    client,
    'message',
    `select id from message where organization_id = $2 and conversation_id = $1 and status = 'read'
      order by occurred_at desc, id desc limit 1`,
    [heavyConversation, orgId],
  );
  const contact = await one<{ name: string; digits: string }>(
    client,
    'conversation search',
    `select lower(split_part(c.display_name, ' ', 2)) as name, substring(c.phone_e164 from 6) as digits
       from conversation v join contact c on c.id = v.contact_id and c.organization_id = $2
      where v.organization_id = $2 and v.id = $1`,
    [heavyConversation, orgId],
  );
  const usage = await one<{ from: string; to: string }>(
    client,
    'usage range',
    `select to_char(max(created_at) at time zone 'UTC' - interval '30 days', 'YYYY-MM-DD') as "from",
            to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD') as "to"
       from ledger_entry where organization_id = $1`,
    [orgId],
  );
  const at = (column: string) => `${key(column)} as "occurredAt", id`;
  const calls = await rowAt<At>(
    client,
    'calls',
    at('created_at'),
    'from call where organization_id = $1',
    'created_at desc, id desc',
    [orgId],
    o.calls,
    scale,
  );
  const conversations = await rowAt<At>(
    client,
    'conversations',
    at('last_activity_at'),
    'from conversation where organization_id = $1',
    'last_activity_at desc, id desc',
    [orgId],
    o.conversations,
    scale,
  );
  const thread = await rowAt<At>(
    client,
    'thread',
    at('occurred_at'),
    THREAD_FROM,
    'occurred_at desc, id desc',
    [heavyConversation, orgId],
    o.thread,
    scale,
  );
  const tasksOpen = await rowAt<{ due: string; createdAt: string; id: string }>(
    client,
    'open tasks',
    `case when due_at is null then 'infinity' else ${key('due_at')} end as due, ${key('created_at')} as "createdAt", id`,
    `from task where organization_id = $2 and owner_user_id = $1 and status = 'open'`,
    `coalesce(due_at, 'infinity'::timestamptz), created_at, id`,
    [ownerId, orgId],
    o.tasksOpen,
    scale,
  );
  const tasksDone = await rowAt<{ completedAt: string; id: string }>(
    client,
    'done tasks',
    `${key('completed_at')} as "completedAt", id`,
    `from task where organization_id = $2 and owner_user_id = $1 and status = 'done'`,
    'completed_at desc, id desc',
    [ownerId, orgId],
    o.tasksDone,
    scale,
  );
  const ledger = await rowAt<At>(
    client,
    'ledger',
    at('created_at'),
    'from ledger_entry where organization_id = $1',
    'created_at desc, id desc',
    [orgId],
    o.ledger,
    scale,
  );
  const reconciliations = await rowAt<At>(
    client,
    'reconciliations',
    at('created_at'),
    'from reconciliation_report where organization_id = $1',
    'created_at desc, id desc',
    [orgId],
    o.reconciliations,
    scale,
  );
  return {
    ids: { heavyConversation, message: message.id },
    search: { conversationName: contact.name, conversationDigits: contact.digits },
    usage,
    calls,
    conversations,
    thread,
    tasksOpen,
    tasksDone,
    ledger,
    reconciliations,
  };
}
