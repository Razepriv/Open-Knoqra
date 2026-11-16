// M3/M3b messaging: channel connections, templates, conversations, messages with their delivery
// event chains, and conversation notes on the M1 timeline.
import { BATCH_SIZE, microIso, type TimelineRow, WINDOW_END_MS } from './generate';
import { type ConversationPlan, msBetween, type OrgContext, pad, WINDOW_START_MS } from './phase1';
import { hexId, int, mulberry32, pick, type Rand, weighted } from './random';
import { COMPANY_WORDS, TIMELINE_BODIES } from './words';

export interface ConnectionRow {
  id: string;
  organization_id: string;
  channel: 'sms' | 'whatsapp';
  provider: 'fake';
  address: string;
  registration_status: 'approved';
  created_at: string;
  updated_at: string;
}

export interface TemplateRow {
  id: string;
  organization_id: string;
  name: string;
  channel: 'sms' | 'whatsapp';
  body: string;
  approval_status: 'approved' | 'pending';
  archived_at: string | null;
  created_by: string;
  created_at: string;
  whatsapp_template_name: string | null;
  whatsapp_language: string | null;
}

export interface ConversationRow {
  id: string;
  organization_id: string;
  contact_id: string;
  channel: 'sms' | 'whatsapp';
  last_activity_at: string;
  last_inbound_at: string | null;
  last_message_preview: string;
  last_message_direction: 'inbound' | 'outbound';
  last_message_status: string;
  unread_count: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string;
  channel: 'sms' | 'whatsapp';
  direction: 'inbound' | 'outbound';
  body: string;
  template_id: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  provider: 'fake';
  provider_message_id: string | null;
  client_message_id: string | null;
  author_user_id: string | null;
  occurred_at: string;
  status_updated_at: string;
  created_at: string;
}

export interface StatusEventRow {
  id: string;
  organization_id: string;
  message_id: string;
  status: string;
  applied: boolean;
  occurred_at: string;
  error_code: string | null;
  created_at: string;
}

export interface MessageBatch {
  messages: MessageRow[];
  events: StatusEventRow[];
}

const OUTBOUND_FINAL = ['delivered', 'read', 'sent', 'failed', 'queued'] as const;
const OUTBOUND_WEIGHTS = [0.6, 0.15, 0.1, 0.1, 0.05];
/** The forward chain an outbound message passes through to reach its final status. */
const CHAIN: Record<string, readonly string[]> = {
  queued: ['queued'],
  sent: ['queued', 'sent'],
  delivered: ['queued', 'sent', 'delivered'],
  read: ['queued', 'sent', 'delivered', 'read'],
  failed: ['queued', 'failed'],
};

/** The SMS and WhatsApp senders, both on the fake provider, from the organization's first number. */
export function generateConnections(ctx: OrgContext, address: string): ConnectionRow[] {
  const rand = mulberry32(ctx.orgIndex + 17);
  const created = new Date(WINDOW_START_MS).toISOString();
  return (['sms', 'whatsapp'] as const).map((channel) => ({
    id: hexId(rand, 'cc'),
    organization_id: ctx.orgId,
    channel,
    provider: 'fake',
    address,
    registration_status: 'approved',
    created_at: created,
    updated_at: created,
  }));
}

/** About 60% SMS; every tenth archived; names unique per channel (they carry their index). */
export function generateTemplates(rand: Rand, ctx: OrgContext, n: number): TemplateRow[] {
  return Array.from({ length: n }, (_, i) => {
    const channel = i % 5 < 3 ? ('sms' as const) : ('whatsapp' as const);
    const createdMs = msBetween(rand, WINDOW_START_MS, WINDOW_START_MS + 86_400_000 * 60);
    return {
      id: hexId(rand, 'mt'),
      organization_id: ctx.orgId,
      name: `${COMPANY_WORDS[i % COMPANY_WORDS.length]} template ${pad(i, 3)}`,
      channel,
      body: pick(rand, TIMELINE_BODIES),
      approval_status: rand() < 0.9 ? 'approved' : 'pending',
      archived_at: i % 10 === 9 ? new Date(createdMs + 86_400_000).toISOString() : null,
      created_by: ctx.ownerId,
      created_at: new Date(createdMs).toISOString(),
      whatsapp_template_name: channel === 'whatsapp' ? `perf_template_${pad(i, 3)}` : null,
      whatsapp_language: channel === 'whatsapp' ? 'en' : null,
    };
  });
}

/** Template ids usable on each channel (active only). */
export function templatesByChannel(templates: readonly TemplateRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of templates) {
    if (t.archived_at !== null) continue;
    out.set(t.channel, [...(out.get(t.channel) ?? []), t.id]);
  }
  return out;
}

/**
 * Message and event ids embed the conversation id and the message's index in it: per-conversation
 * PRNG streams can overlap (mulberry32 is counter based), so random ids could repeat across them.
 */
export function messageIds(convId: string, index: number, events: number): [string, string[]] {
  const stem = convId.slice(3, 25);
  const k = index.toString(16).padStart(8, '0');
  return [
    `mg_${stem}${k.slice(-8)}00`,
    Array.from(
      { length: events },
      (_, j) => `ms_${stem}${k.slice(-8)}${j.toString(16).padStart(2, '0')}`,
    ),
  ];
}

function messageWithEvents(
  rand: Rand,
  ctx: OrgContext,
  conv: ConversationPlan,
  index: number,
  atMs: number,
  templates: readonly string[],
): MessageBatch {
  const inbound = rand() < 0.45;
  const status = inbound
    ? 'received'
    : (OUTBOUND_FINAL[weighted(rand, OUTBOUND_WEIGHTS)] as string);
  const chain = inbound ? ['received'] : (CHAIN[status] as readonly string[]);
  const [id, eventIds] = messageIds(conv.id, index, chain.length);
  const micros = int(rand, 1000);
  const events = chain.map((s, k) => ({
    id: eventIds[k] as string,
    organization_id: ctx.orgId,
    message_id: id,
    status: s,
    applied: true,
    occurred_at: microIso(atMs + k * 2000, micros),
    error_code: s === 'failed' ? 'carrier_rejected' : null,
    created_at: microIso(atMs + k * 2000, micros),
  }));
  const templateId =
    !inbound && templates.length > 0 && rand() < 0.1 ? pick(rand, templates) : null;
  const occurred = microIso(atMs, micros);
  const message: MessageRow = {
    id,
    organization_id: ctx.orgId,
    conversation_id: conv.id,
    contact_id: conv.contactId,
    channel: conv.channel,
    direction: inbound ? 'inbound' : 'outbound',
    body: pick(rand, TIMELINE_BODIES),
    template_id: templateId,
    status,
    error_code: status === 'failed' ? 'carrier_rejected' : null,
    error_message: status === 'failed' ? 'The carrier rejected the message.' : null,
    provider: 'fake',
    provider_message_id: status === 'queued' ? null : `fake-msg-${id.slice(3)}`,
    client_message_id: inbound ? null : `perf-client-${id.slice(3)}`,
    author_user_id: inbound ? null : ctx.ownerId,
    occurred_at: occurred,
    status_updated_at: (events.at(-1) as StatusEventRow).occurred_at,
    created_at: occurred,
  };
  return { messages: [message], events };
}

/**
 * One conversation's messages, oldest first, from the conversation's own PRNG: calling it twice
 * gives the same rows, so the conversation summary and the message stream never disagree.
 */
export function conversationMessages(
  ctx: OrgContext,
  conv: ConversationPlan,
  templates: ReadonlyMap<string, readonly string[]>,
): MessageBatch {
  const rand = mulberry32(conv.seed);
  const startMs = msBetween(rand, WINDOW_START_MS, WINDOW_END_MS - 86_400_000 * 30);
  const times = Array.from({ length: conv.messageCount }, () =>
    msBetween(rand, startMs, WINDOW_END_MS - 60_000),
  ).sort((a, b) => a - b);
  const usable = templates.get(conv.channel) ?? [];
  const messages: MessageRow[] = [];
  const events: StatusEventRow[] = [];
  for (const [index, at] of times.entries()) {
    const one = messageWithEvents(rand, ctx, conv, index, at, usable);
    messages.push(...one.messages);
    events.push(...one.events);
  }
  return { messages, events };
}

/** The inbox summary of a conversation: its latest message by (occurred_at, id). */
export function summarizeConversation(
  ctx: OrgContext,
  conv: ConversationPlan,
  messages: readonly MessageRow[],
  unread: boolean,
): ConversationRow {
  const latest = messages.reduce((a, b) =>
    b.occurred_at > a.occurred_at || (b.occurred_at === a.occurred_at && b.id > a.id) ? b : a,
  );
  const inbound = messages.filter((m) => m.direction === 'inbound').map((m) => m.occurred_at);
  // Messages come oldest first, so the last inbound one is the latest.
  const lastInbound = inbound.at(-1) ?? null;
  return {
    id: conv.id,
    organization_id: ctx.orgId,
    contact_id: conv.contactId,
    channel: conv.channel,
    last_activity_at: latest.occurred_at,
    last_inbound_at: lastInbound,
    last_message_preview: latest.body.slice(0, 140),
    last_message_direction: latest.direction,
    last_message_status: latest.status,
    unread_count: unread && latest.direction === 'inbound' ? 1 + (conv.seed % 4) : 0,
    created_at: (messages[0] as MessageRow).occurred_at,
    updated_at: latest.occurred_at,
  };
}

/** Conversation rows in batches; about a quarter of those whose last message is inbound are unread. */
export function* generateConversations(
  ctx: OrgContext,
  plans: readonly ConversationPlan[],
  templates: ReadonlyMap<string, readonly string[]>,
): Generator<ConversationRow[]> {
  let batch: ConversationRow[] = [];
  for (const conv of plans) {
    const { messages } = conversationMessages(ctx, conv, templates);
    batch.push(summarizeConversation(ctx, conv, messages, conv.seed % 4 === 0));
    if (batch.length === BATCH_SIZE) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** Every conversation's messages and events, in batches of about BATCH_SIZE messages. */
export function* generateMessages(
  ctx: OrgContext,
  plans: readonly ConversationPlan[],
  templates: ReadonlyMap<string, readonly string[]>,
): Generator<MessageBatch> {
  let batch: MessageBatch = { messages: [], events: [] };
  for (const conv of plans) {
    const one = conversationMessages(ctx, conv, templates);
    for (let i = 0; i < one.messages.length; i += BATCH_SIZE) {
      const part = one.messages.slice(i, i + BATCH_SIZE);
      const ids = new Set(part.map((m) => m.id));
      batch.messages.push(...part);
      batch.events.push(...one.events.filter((e) => ids.has(e.message_id)));
      if (batch.messages.length >= BATCH_SIZE) {
        yield batch;
        batch = { messages: [], events: [] };
      }
    }
  }
  if (batch.messages.length > 0) yield batch;
}

export type NoteRefRow = TimelineRow & {
  ref_type: string | null;
  ref_id: string | null;
  actor_user_id: string | null;
  source: string;
};

/**
 * Wraps the M1 timeline stream: a note of a contact with an SMS conversation references that
 * conversation with probability `ratio`, as an inbox note does. Draws from its own stream only.
 */
export function* attachConversationRefs(
  stream: Generator<TimelineRow[]>,
  smsByContact: ReadonlyMap<string, string>,
  ownerId: string,
  rand: Rand,
  ratio: number,
): Generator<NoteRefRow[]> {
  for (const batch of stream) {
    yield batch.map((row) => {
      const conv = row.kind === 'note' ? smsByContact.get(row.contact_id) : undefined;
      const linked = conv !== undefined && rand() < ratio;
      return {
        ...row,
        ref_type: linked ? 'conversation' : null,
        ref_id: linked ? (conv as string) : null,
        actor_user_id: linked ? ownerId : null,
        source: linked ? 'inbox' : 'app',
      };
    });
  }
}
