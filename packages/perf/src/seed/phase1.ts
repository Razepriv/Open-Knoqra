// Phase 1 seed volumes and plan (M2 calls, M3/M3b messaging, M4/M4b numbers and usage, M5 tasks
// and notifications). Pure and deterministic: every generator draws from its own PRNG stream, so
// the M1 rows stay byte-identical and adding a generator never shifts another.
import type { ContactRow, ContactSet } from './generate';
import { WINDOW_END_MS, WINDOW_MS } from './generate';
import { hexId, int, type Rand, streamRand } from './random';

/** Organization A at full scale. Organization B gets OTHER_ORG_SHARE of each count. */
export const PHASE1_SCALE = {
  calls: 200_000,
  voicemailRatio: 0.02,
  conversationContacts: 50_000,
  conversations: 60_000,
  messages: 600_000,
  heavyMessages: 20_000,
  /** Share of note events of a contact with a conversation that reference that conversation. */
  noteRefRatio: 0.65,
  tasks: 20_000,
  heavyTasks: 2_000,
  notifications: 5_000,
  unreadRatio: 0.1,
  templates: 50,
  ledger: 300_000,
  numberOrders: 200,
  numbers: 50,
  usageEvents: 300,
  reconciliations: 300,
} as const;

export const OTHER_ORG_SHARE = 0.01;

export type Phase1Counts = { -readonly [K in keyof typeof PHASE1_SCALE]: number };

/** Salts for the per-generator PRNG streams. */
export const STREAMS = {
  conversations: 101,
  notes: 102,
  calls: 103,
  templates: 104,
  tasks: 105,
  notifications: 106,
  numbers: 107,
  orders: 108,
  ledger: 109,
  usage: 110,
  reconciliations: 111,
  messages: 112,
} as const;

/** Multiplies every count by `factor`; ratios stay; each count keeps the minimum its shape needs. */
export function phase1Counts(factor: number): Phase1Counts {
  const s = (n: number, min = 1) => Math.max(min, Math.round(n * factor));
  const conversationContacts = s(PHASE1_SCALE.conversationContacts);
  const conversations = Math.min(2 * conversationContacts, s(PHASE1_SCALE.conversations));
  const messages = s(PHASE1_SCALE.messages, conversations);
  const tasks = s(PHASE1_SCALE.tasks);
  return {
    ...PHASE1_SCALE,
    calls: s(PHASE1_SCALE.calls),
    conversationContacts,
    conversations,
    messages,
    // The heavy conversation leaves at least one message for every other conversation.
    heavyMessages: Math.max(
      1,
      Math.min(s(PHASE1_SCALE.heavyMessages), messages - (conversations - 1)),
    ),
    tasks,
    heavyTasks: Math.min(tasks, s(PHASE1_SCALE.heavyTasks)),
    notifications: s(PHASE1_SCALE.notifications),
    templates: s(PHASE1_SCALE.templates, 2),
    ledger: s(PHASE1_SCALE.ledger),
    numberOrders: s(PHASE1_SCALE.numberOrders),
    numbers: s(PHASE1_SCALE.numbers),
    usageEvents: s(PHASE1_SCALE.usageEvents),
    reconciliations: s(PHASE1_SCALE.reconciliations),
  };
}

/** What every Phase 1 generator needs about the organization it writes. */
export interface OrgContext {
  orgId: string;
  /** The owner user: author of calls, outbound messages, tasks and notifications. */
  ownerId: string;
  /** 0 for organization A, 1 for B: keeps fixed phone blocks apart. */
  orgIndex: number;
}

export interface ConversationPlan {
  id: string;
  contactId: string;
  channel: 'sms' | 'whatsapp';
  messageCount: number;
  /** Seed of this conversation's own PRNG: its messages are regenerated identically on demand. */
  seed: number;
}

export interface Phase1Plan {
  seed: number;
  counts: Phase1Counts;
  /** Active (not archived, not merged) contacts, in contact order. */
  active: ContactRow[];
  heavyContactId: string;
  /** Index 0 is the heavy conversation: the heavy contact's SMS thread. */
  conversations: ConversationPlan[];
}

export const pad = (n: number, width: number): string => String(n).padStart(width, '0');

export const WINDOW_START_MS = WINDOW_END_MS - WINDOW_MS;

/** A uniform instant in [fromMs, toMs) as milliseconds. */
export function msBetween(rand: Rand, fromMs: number, toMs: number): number {
  return fromMs + int(rand, Math.max(1, toMs - fromMs));
}

/** Fisher-Yates over a copy. */
export function shuffle<T>(rand: Rand, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rand, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** `n` random integers in [1, 2*mean-1], then nudged by one at a time until they sum to `total`. */
export function exactCounts(rand: Rand, n: number, total: number): number[] {
  if (n === 0) return [];
  const mean = total / n;
  const counts = Array.from(
    { length: n },
    () => 1 + int(rand, Math.max(1, Math.round(2 * mean - 1))),
  );
  let diff = total - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % n) {
    const c = counts[i] as number;
    if (diff > 0) {
      counts[i] = c + 1;
      diff--;
    } else if (c > 1) {
      counts[i] = c - 1;
      diff++;
    }
  }
  return counts;
}

/**
 * Picks the conversation contacts (the heavy contact first), gives every one an SMS thread and the
 * first ones a WhatsApp thread too, and spreads the message total with the heavy thread fixed.
 */
export function planConversations(
  rand: Rand,
  active: readonly ContactRow[],
  heavyContactId: string,
  counts: Phase1Counts,
): ConversationPlan[] {
  const others = shuffle(
    rand,
    active.filter((c) => c.id !== heavyContactId),
  ).slice(0, Math.max(0, Math.min(active.length, counts.conversationContacts) - 1));
  const contactIds = [heavyContactId, ...others.map((c) => c.id)];
  const whatsappN = Math.max(
    0,
    Math.min(contactIds.length, counts.conversations - contactIds.length),
  );
  const pairs: { contactId: string; channel: 'sms' | 'whatsapp' }[] = [
    ...contactIds.map((contactId) => ({ contactId, channel: 'sms' as const })),
    ...contactIds
      .slice(1, whatsappN + 1)
      .map((contactId) => ({ contactId, channel: 'whatsapp' as const })),
  ];
  const rest = exactCounts(rand, pairs.length - 1, counts.messages - counts.heavyMessages);
  return pairs.map((p, i) => ({
    id: hexId(rand, 'cv'),
    contactId: p.contactId,
    channel: p.channel,
    messageCount: i === 0 ? counts.heavyMessages : (rest[i - 1] as number),
    seed: int(rand, 4294967296),
  }));
}

/** Plans one organization's Phase 1 data from its M1 contacts. */
export function planPhase1(
  seed: number,
  contacts: ContactSet,
  heavyContactId: string,
  counts: Phase1Counts,
): Phase1Plan {
  const active = contacts.rows.filter((r) => r.archived_at === null && r.merged_into_id === null);
  return {
    seed,
    counts,
    active,
    heavyContactId,
    conversations: planConversations(
      streamRand(seed, STREAMS.conversations),
      active,
      heavyContactId,
      counts,
    ),
  };
}
