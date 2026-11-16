// Pure, deterministic row generators for the perf seed. No clock, no database: every value
// derives from the seeded PRNG and the fixed word lists.
import { CHANNELS, PERMISSION_STATUSES } from '@knoqra/core';
import { hexId, int, pick, type Rand, weighted } from './random';
import {
  COMPANY_SUFFIXES,
  COMPANY_WORDS,
  CONSENT_EVIDENCE,
  FIRST_NAMES,
  JOB_TITLES,
  LAST_NAMES,
  NPAS,
  TAGS,
  TIMELINE_BODIES,
  TIMELINE_TITLES,
  TIMEZONES,
} from './words';

export const SCALE = {
  contacts: 100_000,
  timeline: 1_000_000,
  heavyTimeline: 50_000,
  consentPerContact: 1.5,
  archivedRatio: 0.03,
  mergedRatio: 0.01,
  duplicateRatio: 0.02,
  dismissals: 500,
  otherOrgContacts: 1_000,
  otherOrgTimeline: 10_000,
} as const;

export type Counts = { -readonly [K in keyof typeof SCALE]: number };

export const BATCH_SIZE = 10_000;
/** Events are spread over the 730 days before this instant. No clock is involved. */
export const WINDOW_END_MS = Date.UTC(2026, 10, 1);
export const WINDOW_MS = 730 * 86_400_000;
/** Contacts are created across the year before this instant. */
const CONTACT_CREATED_START_MS = Date.UTC(2025, 10, 1);
const CONTACT_CREATED_SPAN_MS = 365 * 86_400_000;
/** Contacts below this index use the fixed +1 202 555 0100.. block. */
export const FIXED_PHONE_BLOCK = 100;

/** Multiplies every count by `scale` (0..1). Ratios stay as they are. */
export function scaledCounts(scale: number): Counts {
  const s = (n: number) => Math.max(1, Math.round(n * scale));
  return {
    ...SCALE,
    contacts: s(SCALE.contacts),
    timeline: s(SCALE.timeline),
    heavyTimeline: s(SCALE.heavyTimeline),
    dismissals: s(SCALE.dismissals),
    otherOrgContacts: s(SCALE.otherOrgContacts),
    otherOrgTimeline: s(SCALE.otherOrgTimeline),
  };
}

export interface ContactRow {
  id: string;
  organization_id: string;
  display_name: string;
  company: string | null;
  phone_e164: string;
  source: string;
  email: string | null;
  job_title: string | null;
  /** Comma-joined; the loader turns it into text[]. */
  tags: string;
  timezone: string | null;
  archived_at: string | null;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactSet {
  rows: ContactRow[];
  /** [source id, duplicate id]: same normalized name, both active. */
  dupPairs: [string, string][];
  /** Row index of each contact kind, for fixtures. */
  kinds: { archived: number[]; merged: number[]; active: number[] };
}

export interface ConsentRow {
  id: string;
  organization_id: string;
  contact_id: string;
  channel: string;
  status: string;
  source: string;
  evidence: string | null;
  created_at: string;
}

export interface TimelineRow {
  id: string;
  organization_id: string;
  contact_id: string;
  kind: string;
  title: string;
  body: string | null;
  occurred_at: string;
  created_at: string;
}

export interface DismissalRow {
  id: string;
  organization_id: string;
  contact_a_id: string;
  contact_b_id: string;
  created_at: string;
}

/** Fisher-Yates over a fresh array. */
function shuffled(rand: Rand, n: number, from = 0): number[] {
  const out = Array.from({ length: n - from }, (_, i) => i + from);
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rand, i + 1);
    [out[i], out[j]] = [out[j] as number, out[i] as number];
  }
  return out;
}

export function* batches<T>(items: readonly T[], size = BATCH_SIZE): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** `2026-01-02T03:04:05.123456Z`: millisecond instant plus a microsecond tail. */
export function microIso(ms: number, micros: number): string {
  return `${new Date(ms).toISOString().slice(0, -1)}${pad(micros, 3)}Z`;
}

function randomInstant(rand: Rand): string {
  const ms = WINDOW_END_MS - WINDOW_MS + int(rand, WINDOW_MS);
  return microIso(ms, int(rand, 1000));
}

function emailFor(first: string, last: string, index: number): string {
  return `${first}.${last}.${index}@example.test`.toLowerCase();
}

function uniquePhones(rand: Rand, n: number): string[] {
  const used = new Set<string>();
  for (let i = 0; i < Math.min(FIXED_PHONE_BLOCK, n); i++) used.add(`+1202555${pad(100 + i, 4)}`);
  const phones = [...used];
  while (phones.length < n) {
    const phone = `+1${pick(rand, NPAS)}555${pad(int(rand, 10_000), 4)}`;
    if (used.has(phone)) continue;
    used.add(phone);
    phones.push(phone);
  }
  return phones;
}

/**
 * Builds an organization's contacts. Merged rows carry archived_at and point at an active
 * contact; active phones are unique; duplicates repeat a source contact's normalized name.
 */
export function generateContacts(rand: Rand, orgId: string, n: number): ContactSet {
  const ids = Array.from({ length: n }, () => hexId(rand, 'ct'));
  const phones = uniquePhones(rand, n);
  const firstIdx = Array.from({ length: n }, () => int(rand, FIRST_NAMES.length));
  const lastIdx = Array.from({ length: n }, () => int(rand, LAST_NAMES.length));
  const hasEmail = Array.from({ length: n }, () => rand() < 0.7);

  const order = shuffled(rand, n, Math.min(FIXED_PHONE_BLOCK, n));
  const archivedN = Math.round(n * SCALE.archivedRatio);
  const mergedN = Math.round(n * SCALE.mergedRatio);
  const dupN = Math.round(n * SCALE.duplicateRatio);
  const archived = order.slice(0, archivedN);
  const merged = order.slice(archivedN, archivedN + mergedN);
  const dups = order.slice(archivedN + mergedN, archivedN + mergedN + dupN);
  const taken = new Set([...archived, ...merged, ...dups]);
  const plain = Array.from({ length: n }, (_, i) => i).filter((i) => !taken.has(i));
  const sources = plain.filter((i) => hasEmail[i]);
  const archivedSet = new Set(archived);
  const mergeTarget = new Map(merged.map((i) => [i, pick(rand, plain)]));
  const dupSource = new Map(dups.map((i) => [i, pick(rand, sources)]));
  const dupIndex = new Map(dups.map((d, k) => [d, k]));

  const rows: ContactRow[] = [];
  for (let i = 0; i < n; i++) {
    const src = dupSource.get(i);
    const nameIdx = src ?? i;
    const first = FIRST_NAMES[firstIdx[nameIdx] as number] as string;
    const last = LAST_NAMES[lastIdx[nameIdx] as number] as string;
    let email: string | null = hasEmail[i] ? emailFor(first, last, i) : null;
    if (src !== undefined) {
      const sourceEmail = emailFor(first, last, src);
      // Half the duplicates repeat the source email with a different local-part case.
      email =
        (dupIndex.get(i) as number) % 2 === 0
          ? sourceEmail.replace(/^[^@]+/, (local) => local.toUpperCase())
          : hasEmail[i]
            ? emailFor(first, last, i)
            : null;
    }
    const createdMs = CONTACT_CREATED_START_MS + Math.floor((i * CONTACT_CREATED_SPAN_MS) / n);
    const created = new Date(createdMs).toISOString();
    const isMerged = mergeTarget.has(i);
    const tagCount = rand() < 0.2 ? 1 + int(rand, 2) : 0;
    rows.push({
      id: ids[i] as string,
      organization_id: orgId,
      display_name: `${first} ${last}`,
      company: rand() < 0.8 ? `${pick(rand, COMPANY_WORDS)} ${pick(rand, COMPANY_SUFFIXES)}` : null,
      phone_e164: phones[i] as string,
      source: rand() < 0.7 ? 'manual' : 'import',
      email,
      job_title: rand() < 0.5 ? pick(rand, JOB_TITLES) : null,
      tags: Array.from({ length: tagCount }, () => pick(rand, TAGS)).join(','),
      timezone: rand() < 0.6 ? pick(rand, TIMEZONES) : null,
      archived_at: archivedSet.has(i) || isMerged ? created : null,
      merged_into_id: isMerged ? (ids[mergeTarget.get(i) as number] as string) : null,
      created_at: created,
      updated_at: created,
    });
  }
  return {
    rows,
    dupPairs: dups.map((d) => [ids[dupSource.get(d) as number] as string, ids[d] as string]),
    kinds: { archived, merged, active: plain },
  };
}

/** About `consentPerContact` permission events per contact: one, plus one for half of them. */
export function* generateConsent(
  rand: Rand,
  orgId: string,
  contacts: readonly ContactRow[],
): Generator<ConsentRow[]> {
  let batch: ConsentRow[] = [];
  for (const c of contacts) {
    const events = 1 + (rand() < SCALE.consentPerContact - 1 ? 1 : 0);
    for (let k = 0; k < events; k++) {
      batch.push({
        id: hexId(rand, 'cp'),
        organization_id: orgId,
        contact_id: c.id,
        channel: pick(rand, CHANNELS),
        status: PERMISSION_STATUSES[weighted(rand, [0.6, 0.1, 0.2, 0.1])] as string,
        source: pick(rand, ['manual', 'import', 'inbound_stop', 'system'] as const),
        evidence: rand() < 0.5 ? pick(rand, CONSENT_EVIDENCE) : null,
        created_at: randomInstant(rand),
      });
      if (batch.length === BATCH_SIZE) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) yield batch;
}

const KINDS = ['note', 'consent', 'system', 'call', 'message'] as const;
const KIND_WEIGHTS = [0.3, 0.1, 0.4, 0.15, 0.05];

/**
 * Exactly `total` events, `heavyCount` of them for the heavy contact (positions chosen by
 * selection sampling), the rest spread over every other contact.
 */
export function* generateTimeline(
  rand: Rand,
  orgId: string,
  contacts: readonly ContactRow[],
  total: number,
  heavyId: string,
  heavyCount: number,
): Generator<TimelineRow[]> {
  const others = contacts.filter((c) => c.id !== heavyId);
  if (others.length === 0 && heavyCount < total)
    throw new Error('no contacts besides the heavy one');
  let heavyLeft = heavyCount;
  let batch: TimelineRow[] = [];
  for (let i = 0; i < total; i++) {
    const heavy = heavyLeft > 0 && rand() < heavyLeft / (total - i);
    if (heavy) heavyLeft--;
    const kind = KINDS[weighted(rand, KIND_WEIGHTS)] as string;
    const at = randomInstant(rand);
    batch.push({
      id: hexId(rand, 'te'),
      organization_id: orgId,
      contact_id: heavy ? heavyId : (pick(rand, others) as ContactRow).id,
      kind,
      title: pick(rand, TIMELINE_TITLES[kind] as readonly string[]),
      body: rand() < 0.6 ? pick(rand, TIMELINE_BODIES) : null,
      occurred_at: at,
      created_at: at,
    });
    if (batch.length === BATCH_SIZE) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** "Not duplicates" pairs, ordered a < b by byte order (ids are lowercase hex). */
export function* generateDismissals(
  rand: Rand,
  orgId: string,
  dupPairs: readonly [string, string][],
  count: number,
): Generator<DismissalRow[]> {
  const chosen = shuffled(rand, dupPairs.length)
    .slice(0, count)
    .map((i) => dupPairs[i] as [string, string]);
  const rows = chosen.map(([x, y]) => {
    // String ids compare by byte order; Math.min/max would coerce them to numbers.
    const [a, b] = x < y ? [x, y] : [y, x];
    return {
      id: hexId(rand, 'dd'),
      organization_id: orgId,
      contact_a_id: a,
      contact_b_id: b,
      created_at: randomInstant(rand),
    };
  });
  yield* batches(rows);
}
