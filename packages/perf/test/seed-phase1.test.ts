import {
  decodeConversationCursor,
  decodeTaskCursor,
  decodeTimelineCursor,
} from '@knoqra/api/cursor';
import { CALL_OUTCOMES, MESSAGE_STATUSES, TERMINAL_CALL_STATES } from '@knoqra/core';
import { describe, expect, it } from 'vitest';
import { buildFixtures, planSeed } from '../src/seed/fixtures';
import { generateTimeline, WINDOW_END_MS } from '../src/seed/generate';
import { type OrgContext, PHASE1_SCALE, phase1Counts, STREAMS } from '../src/seed/phase1';
import {
  attachConversationRefs,
  conversationMessages,
  generateConversations,
  generateMessages,
  generateTemplates,
  templatesByChannel,
} from '../src/seed/phase1-messaging';
import {
  generateLedger,
  generateNumbers,
  generateOrders,
  generateReconciliations,
  generateWallet,
  type LedgerRow,
  STARTER_CREDIT,
} from '../src/seed/phase1-money';
import { generateCalls } from '../src/seed/phase1-voice';
import {
  FUTURE_START_MS,
  generateNotifications,
  generateTasks,
  overdueTasks,
} from '../src/seed/phase1-work';
import { streamRand } from '../src/seed/random';
import { SAMPLE_PHASE1_RAW } from './phase1-raw';

const SCALE = 0.01;
const plan = planSeed(42, SCALE);
const p1 = plan.phase1A;
const ctx: OrgContext = { orgId: plan.orgA.orgId, ownerId: 'user-a', orgIndex: 0 };
const activeIds = new Set(p1.active.map((c) => c.id));

describe('phase 1 counts', () => {
  it('pins the full-scale volumes', () => {
    expect(PHASE1_SCALE).toMatchObject({
      calls: 200_000,
      conversations: 60_000,
      conversationContacts: 50_000,
      messages: 600_000,
      tasks: 20_000,
      heavyTasks: 2_000,
      notifications: 5_000,
      templates: 50,
      ledger: 300_000,
      numberOrders: 200,
      numbers: 50,
    });
    expect(phase1Counts(1).heavyMessages).toBe(20_000);
  });

  it('scales every count and keeps each shape possible', () => {
    const c = phase1Counts(SCALE);
    expect(c).toMatchObject({ calls: 2_000, conversations: 600, messages: 6_000, ledger: 3_000 });
    expect(c.templates).toBeGreaterThanOrEqual(2);
    const tiny = phase1Counts(0.0001);
    expect(tiny.conversations).toBeLessThanOrEqual(2 * tiny.conversationContacts);
    expect(tiny.messages).toBeGreaterThanOrEqual(tiny.conversations);
    expect(tiny.heavyMessages + tiny.conversations - 1).toBeLessThanOrEqual(tiny.messages);
  });

  it('gives organization B about one percent', () => {
    expect(plan.phase1B.counts.calls).toBe(Math.max(1, Math.round(200_000 * SCALE * 0.01)));
  });
});

describe('conversations and messages', () => {
  const templates = generateTemplates(streamRand(42, STREAMS.templates), ctx, p1.counts.templates);
  const byChannel = templatesByChannel(templates);

  it('plans one conversation per contact and channel, heavy first, exact message total', () => {
    const convs = p1.conversations;
    expect(convs).toHaveLength(p1.counts.conversations);
    expect(new Set(convs.map((c) => `${c.contactId}:${c.channel}`)).size).toBe(convs.length);
    expect(convs[0]?.contactId).toBe(p1.heavyContactId);
    expect(convs[0]?.channel).toBe('sms');
    expect(convs[0]?.messageCount).toBe(p1.counts.heavyMessages);
    expect(convs.reduce((s, c) => s + c.messageCount, 0)).toBe(p1.counts.messages);
    for (const c of convs) {
      expect(activeIds.has(c.contactId)).toBe(true);
      expect(c.messageCount).toBeGreaterThanOrEqual(1);
      expect(c.id).toMatch(/^cv_[0-9a-f]{32}$/);
    }
  });

  it('keeps active template names unique per channel', () => {
    const active = templates.filter((t) => t.archived_at === null);
    const keys = active.map((t) => `${t.channel}:${t.name.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(byChannel.get('sms')?.length).toBeGreaterThan(0);
  });

  it('regenerates a conversation identically and chains its delivery events', () => {
    const conv = p1.conversations[1] as (typeof p1.conversations)[number];
    const a = conversationMessages(ctx, conv, byChannel);
    expect(conversationMessages(ctx, conv, byChannel)).toEqual(a);
    const byMessage = new Map<string, string[]>();
    for (const e of a.events)
      byMessage.set(e.message_id, [...(byMessage.get(e.message_id) ?? []), e.status]);
    for (const m of a.messages) {
      expect(MESSAGE_STATUSES).toContain(m.status);
      const chain = byMessage.get(m.id) ?? [];
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect(chain.at(-1)).toBe(m.status);
      if (m.direction === 'inbound') expect(m.status).toBe('received');
      if (m.template_id !== null) expect(byChannel.get(m.channel)).toContain(m.template_id);
    }
    const times = a.messages.map((m) => m.occurred_at);
    expect([...times].sort()).toEqual(times);
  });

  it('summarizes each conversation from its latest message and streams every message once', () => {
    const rows = [...generateConversations(ctx, p1.conversations, byChannel)].flat();
    expect(rows).toHaveLength(p1.conversations.length);
    const latest = new Map<string, string>();
    let total = 0;
    let events = 0;
    const ids = new Set<string>();
    const eventIds = new Set<string>();
    for (const batch of generateMessages(ctx, p1.conversations, byChannel)) {
      for (const m of batch.messages) {
        total++;
        ids.add(m.id);
        const prev = latest.get(m.conversation_id);
        if (!prev || m.occurred_at >= prev) latest.set(m.conversation_id, m.occurred_at);
      }
      const inBatch = new Set(batch.messages.map((m) => m.id));
      for (const e of batch.events) {
        expect(inBatch.has(e.message_id)).toBe(true);
        expect(e.id).toMatch(/^ms_[0-9a-f]{32}$/);
        eventIds.add(e.id);
        events++;
      }
    }
    expect(total).toBe(p1.counts.messages);
    expect(ids.size).toBe(total);
    expect(eventIds.size).toBe(events);
    for (const id of ids) expect(id).toMatch(/^mg_[0-9a-f]{32}$/);
    for (const r of rows) {
      expect(r.last_activity_at).toBe(latest.get(r.id));
      expect(r.unread_count).toBeGreaterThanOrEqual(0);
      if (r.unread_count > 0) expect(r.last_message_direction).toBe('inbound');
    }
  });

  it('links only notes, and only to the contact SMS conversation, from its own stream', () => {
    const sms = new Map(
      p1.conversations.filter((c) => c.channel === 'sms').map((c) => [c.contactId, c.id]),
    );
    const timeline = generateTimeline(
      plan.orgA.rand,
      ctx.orgId,
      plan.orgA.contacts.rows,
      1_000,
      plan.orgA.heavyId,
      100,
    );
    const rows = [
      ...attachConversationRefs(timeline, sms, 'user-a', streamRand(1, STREAMS.notes), 1),
    ].flat();
    const linked = rows.filter((r) => r.ref_type === 'conversation');
    expect(linked.length).toBeGreaterThan(0);
    for (const r of linked) {
      expect(r.kind).toBe('note');
      expect(r.ref_id).toBe(sms.get(r.contact_id));
      expect(r.actor_user_id).toBe('user-a');
    }
  });
});

describe('calls and voicemails', () => {
  const numbers = ['+12125559000'];
  const batches = [
    ...generateCalls(streamRand(42, STREAMS.calls), ctx, 2_000, 40, p1.active, numbers),
  ];
  const calls = batches.flatMap((b) => b.calls);
  const voicemails = batches.flatMap((b) => b.voicemails);

  it('emits exact counts of terminal calls and voicemails on unanswered inbound calls', () => {
    expect(calls).toHaveLength(2_000);
    expect(voicemails).toHaveLength(40);
    const byId = new Map(calls.map((c) => [c.id, c]));
    for (const c of calls) {
      expect(TERMINAL_CALL_STATES).toContain(c.state);
      if (c.outcome !== null) expect(CALL_OUTCOMES).toContain(c.outcome);
      if (c.contact_id !== null) expect(activeIds.has(c.contact_id)).toBe(true);
    }
    expect(new Set(calls.map((c) => c.client_state)).size).toBe(calls.length);
    expect(new Set(voicemails.map((v) => v.call_id)).size).toBe(voicemails.length);
    for (const v of voicemails) {
      const call = byId.get(v.call_id);
      expect(call?.direction).toBe('inbound');
      expect(call?.state).toBe('no_answer');
      expect(v.contact_id).toBe(call?.contact_id);
    }
  });

  it('is deterministic', () => {
    const again = [
      ...generateCalls(streamRand(42, STREAMS.calls), ctx, 2_000, 40, p1.active, numbers),
    ];
    expect(again).toEqual(batches);
  });
});

describe('tasks and notifications', () => {
  const heavy = p1.active.find((c) => c.id === p1.heavyContactId);
  if (!heavy) throw new Error('heavy contact is not active');
  const tasks = generateTasks(streamRand(42, STREAMS.tasks), ctx, 2_000, 200, heavy, p1.active);
  const notes = generateNotifications(streamRand(42, STREAMS.notifications), ctx, 500, 0.1, tasks);

  it('keeps the status and completion check and the heavy share', () => {
    expect(tasks).toHaveLength(2_000);
    expect(tasks.filter((t) => t.contact_id === heavy.id)).toHaveLength(200);
    for (const t of tasks) {
      expect((t.status === 'done') === (t.completed_at !== null)).toBe(true);
    }
    const open = tasks.filter((t) => t.status === 'open');
    expect(open.some((t) => t.due_at === null)).toBe(true);
    expect(open.some((t) => t.due_at !== null)).toBe(true);
  });

  it('pre-materializes every overdue reminder with the route dedupe key', () => {
    const keys = new Set(notes.map((n) => n.dedupe_key));
    expect(keys.size).toBe(notes.length);
    const overdue = overdueTasks(tasks, WINDOW_END_MS);
    expect(overdue.length).toBeGreaterThan(0);
    for (const t of overdue) {
      expect(t.remind_at).toBeNull();
      expect(keys.has(`due:${t.id}:${new Date(t.due_at as string).toISOString()}`)).toBe(true);
    }
    // Nothing else comes due before 2099: future due dates and reminders start then.
    expect(overdueTasks(tasks, Date.UTC(2090, 0, 1))).toEqual(overdue);
    expect(notes.filter((n) => n.read_at === null)).toHaveLength(Math.round(notes.length * 0.1));
  });

  it('keeps every future reminder far past any date the seed is used on', () => {
    expect(FUTURE_START_MS - 3_600_000).toBeGreaterThan(Date.UTC(2090, 0, 1));
    const reminders = tasks.filter((t) => t.remind_at !== null);
    expect(reminders.length).toBeGreaterThan(0);
    for (const t of reminders) {
      expect(Date.parse(t.remind_at as string)).toBeGreaterThan(Date.UTC(2090, 0, 1));
    }
  });
});

describe('money and numbers', () => {
  const wallet = generateWallet(ctx);
  const numbers = generateNumbers(streamRand(42, STREAMS.numbers), ctx, 50);
  const orders = generateOrders(streamRand(42, STREAMS.orders), ctx, wallet.id, 200, numbers);
  const recon = generateReconciliations(
    streamRand(42, STREAMS.reconciliations),
    ctx,
    wallet.id,
    300,
  );
  const ledger = [
    ...generateLedger(streamRand(42, STREAMS.ledger), ctx, wallet.id, 30_000, [
      ...orders.ledger,
      ...recon.ledger,
    ]),
  ].flat();

  it('emits the exact total, the starter credit and unique idempotency keys', () => {
    expect(ledger).toHaveLength(30_000);
    expect(ledger.filter((l) => l.idempotency_key === STARTER_CREDIT.key)).toHaveLength(1);
    expect(new Set(ledger.map((l) => l.idempotency_key)).size).toBe(ledger.length);
    expect(new Set(ledger.map((l) => l.id)).size).toBe(ledger.length);
  });

  it('respects ledger_entry_kind_signs and closes each reservation once, after it', () => {
    const position = new Map(ledger.map((l, i) => [l.id, i]));
    const closed = new Set<string>();
    const ok = (l: LedgerRow) => {
      const b = l.balance_delta_micros;
      const h = l.held_delta_micros;
      switch (l.kind) {
        case 'reserve':
          return b === 0 && h > 0 && l.reservation_id === null;
        case 'capture':
          return b <= 0 && h < 0 && l.reservation_id !== null;
        case 'release':
          return b === 0 && h < 0 && l.reservation_id !== null;
        case 'credit':
          return b > 0 && h === 0;
        default:
          return h === 0;
      }
    };
    ledger.forEach((l, i) => {
      expect(ok(l)).toBe(true);
      if (l.reservation_id !== null) {
        expect(position.get(l.reservation_id)).toBeLessThan(i);
        expect(closed.has(l.reservation_id)).toBe(false);
        closed.add(l.reservation_id);
      }
    });
  });

  it('keeps open orders on unique numbers, each held by a reservation in the ledger', () => {
    const ids = new Set(ledger.map((l) => l.id));
    const open = orders.orders.filter((o) => o.status !== 'failed');
    expect(new Set(open.map((o) => o.e164)).size).toBe(open.length);
    expect(new Set(orders.orders.map((o) => o.quote_id)).size).toBe(orders.orders.length);
    for (const o of orders.orders) expect(ids.has(o.reservation_id)).toBe(true);
    expect(orders.orders.filter((o) => o.status === 'completed')).toHaveLength(50);
  });

  it('points every adjusted report, and only those, at an adjust entry', () => {
    const adjusts = new Set(ledger.filter((l) => l.kind === 'adjust').map((l) => l.id));
    for (const r of recon.reports) {
      expect(r.status === 'adjusted').toBe(r.adjust_entry_id !== null);
      if (r.adjust_entry_id !== null) expect(adjusts.has(r.adjust_entry_id)).toBe(true);
    }
    expect(new Set(recon.reports.map((r) => r.period_date)).size).toBe(300);
  });
});

describe('phase 1 fixtures', () => {
  const fixtures = buildFixtures(plan, {
    database: 'x_perf',
    contactsDeep: { name: 'a', id: 'ct_a' },
    timelineDeep: { occurredAt: '2026-01-02T03:04:05.123456Z', id: 'te_a' },
    phase1: SAMPLE_PHASE1_RAW,
  });

  it('encodes cursors the routes decode', () => {
    const c = fixtures.cursors;
    expect(decodeTimelineCursor(c.callsDeep).ok).toBe(true);
    expect(decodeConversationCursor(c.conversationsDeep).ok).toBe(true);
    expect(decodeTimelineCursor(c.threadDeep).ok).toBe(true);
    expect(decodeTimelineCursor(c.ledgerDeep).ok).toBe(true);
    const open = decodeTaskCursor(c.tasksOpenDeep);
    expect(open.ok && open.value.status).toBe('open');
    const done = decodeTaskCursor(c.tasksDoneDeep);
    expect(done.ok && done.value.status).toBe('done');
  });
});
