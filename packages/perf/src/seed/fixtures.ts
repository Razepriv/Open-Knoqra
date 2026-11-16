// Plans an organization's data and builds the fixtures file later perf tools read.
import { encodeCursor, encodeTimelineCursor } from '@knoqra/api/cursor';
import {
  type ContactRow,
  type ContactSet,
  type Counts,
  FIXED_PHONE_BLOCK,
  generateContacts,
  scaledCounts,
} from './generate';
import { OTHER_ORG_SHARE, type Phase1Plan, phase1Counts, planPhase1 } from './phase1';
import { encodePhase1, type Phase1Raw } from './phase1-fixtures';
import { mulberry32, type Rand } from './random';
import { COMPANY_WORDS, FIRST_NAMES, LAST_NAMES } from './words';

export const PASSWORD = 'perf-local-only-password';
export const OWNER_A_EMAIL = 'perf-owner-a@example.test';
export const OWNER_B_EMAIL = 'perf-owner-b@example.test';
/** Organization ids are pinned (the sign-up hook's random ids are remapped) so fixtures reproduce. */
export const ORG_A_ID = 'PerfSeedOrgA0000000000000000000';
export const ORG_B_ID = 'PerfSeedOrgB0000000000000000000';

export interface OrgPlan {
  orgId: string;
  /** Continues after the contacts: consent, timeline and dismissals draw from it in that order. */
  rand: Rand;
  contacts: ContactSet;
  heavyId: string;
  timelineTotal: number;
}

export interface SeedPlan {
  seed: number;
  scale: number;
  counts: Counts;
  orgA: OrgPlan;
  orgB: OrgPlan;
  /** Phase 1 tables (calls, messaging, numbers, money, tasks): org B gets OTHER_ORG_SHARE. */
  phase1A: Phase1Plan;
  phase1B: Phase1Plan;
}

export interface ImportRow {
  displayName: string;
  phone: string;
  email: string | null;
  company: string | null;
}

export interface Fixtures {
  database: string;
  seed: number;
  ownerA: { email: string; password: string; orgId: string };
  ownerB: { email: string; password: string; orgId: string };
  ids: {
    first: string;
    middle: string;
    heavy: string;
    archived: string;
    merged: string;
    withDuplicates: string;
    withEmail: string;
    heavyConversation: string;
    message: string;
  };
  search: {
    name: string;
    company: string;
    email: string;
    digits: string;
    rare: string;
    conversationName: string;
    conversationDigits: string;
  };
  cursors: {
    contactsDeep: string;
    timelineDeep: string;
    callsDeep: string;
    conversationsDeep: string;
    threadDeep: string;
    tasksOpenDeep: string;
    tasksDoneDeep: string;
    ledgerDeep: string;
    reconciliationsDeep: string;
  };
  /** An inclusive UTC day range for the usage summary and the filtered usage ledger. */
  usage: { from: string; to: string };
  importRows: ImportRow[];
}

export interface DeepCursors {
  database: string;
  contactsDeep: { name: string; id: string };
  timelineDeep: { occurredAt: string; id: string };
  phase1: Phase1Raw;
}

/** Deep-cursor offsets at full scale: the contacts list and the heavy contact's timeline. */
export const CONTACTS_DEEP_OFFSET = 50_000;
export const TIMELINE_DEEP_OFFSET = 25_000;

/** Scales a full-size offset by `scale`, clamped to the last of `available` rows. */
export function deepOffset(fullOffset: number, scale: number, available: number): number {
  return Math.max(0, Math.min(Math.round(fullOffset * scale), available - 1));
}

export function planOrg(
  seed: number,
  orgId: string,
  contactCount: number,
  timelineTotal: number,
): OrgPlan {
  const rand = mulberry32(seed);
  const contacts = generateContacts(rand, orgId, contactCount);
  const active = contacts.kinds.active;
  // The heavy contact is a plain active one about a quarter of the way in.
  const heavyIndex = active.find((i) => i >= Math.floor(contactCount / 4)) ?? (active[0] as number);
  const heavyId = (contacts.rows[heavyIndex] as ContactRow).id;
  return { orgId, rand, contacts, heavyId, timelineTotal };
}

export function planSeed(seed: number, scale: number): SeedPlan {
  const counts = scaledCounts(scale);
  const orgA = planOrg(seed, ORG_A_ID, counts.contacts, counts.timeline);
  const orgB = planOrg(
    seed + 1_000_003,
    ORG_B_ID,
    counts.otherOrgContacts,
    counts.otherOrgTimeline,
  );
  return {
    seed,
    scale,
    counts,
    orgA,
    orgB,
    phase1A: planPhase1(seed, orgA.contacts, orgA.heavyId, phase1Counts(scale)),
    phase1B: planPhase1(
      seed + 1_000_003,
      orgB.contacts,
      orgB.heavyId,
      phase1Counts(scale * OTHER_ORG_SHARE),
    ),
  };
}

const spacedPhone = (digits: string) =>
  `+1 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;

/** 100 rows matching existing contacts 0-99 and 100 new ones, all `+1 NPA 555 01xx`. */
export function buildImportRows(rows: readonly ContactRow[]): ImportRow[] {
  const existing = rows.slice(0, FIXED_PHONE_BLOCK).map((r) => ({
    displayName: r.display_name,
    phone: spacedPhone(r.phone_e164),
    email: r.email,
    company: r.company,
  }));
  const fresh = Array.from({ length: 100 }, (_, i) => ({
    displayName: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 7) % LAST_NAMES.length]}`,
    phone: `+1 213 555 0${100 + i}`,
    email: `import.${i}@example.test`,
    company: `${COMPANY_WORDS[i % COMPANY_WORDS.length]} Imports`,
  }));
  return [...existing, ...fresh];
}

function firstOf(rows: readonly ContactRow[], indices: readonly number[], at = 0): string {
  return (rows[indices[at] as number] as ContactRow).id;
}

/** Pure: everything except the two database-derived cursors comes from the plan. */
export function buildFixtures(plan: SeedPlan, cursors: DeepCursors): Fixtures {
  const { rows, dupPairs, kinds } = plan.orgA.contacts;
  const withEmailIdx = kinds.active.find((i) => (rows[i] as ContactRow).email !== null) as number;
  const middleIdx = kinds.active.find(
    (i) => i >= rows.length / 2 && (rows[i] as ContactRow).email !== null,
  ) as number;
  const mid = rows[middleIdx] as ContactRow;
  const withEmail = rows[withEmailIdx] as ContactRow;
  const [first = '', last = ''] = withEmail.display_name.toLowerCase().split(' ');
  const middleName = mid.display_name.split(' ');
  const phase1 = encodePhase1(cursors.phase1);
  return {
    database: cursors.database,
    seed: plan.seed,
    ownerA: { email: OWNER_A_EMAIL, password: PASSWORD, orgId: ORG_A_ID },
    ownerB: { email: OWNER_B_EMAIL, password: PASSWORD, orgId: ORG_B_ID },
    ids: {
      first: (rows[0] as ContactRow).id,
      middle: mid.id,
      heavy: plan.orgA.heavyId,
      archived: firstOf(rows, kinds.archived),
      merged: firstOf(rows, kinds.merged),
      withDuplicates: dupPairs[0]?.[0] ?? mid.id,
      withEmail: withEmail.id,
      ...phase1.ids,
    },
    search: {
      // Broad enough to hit many rows, selective enough to stay a bounded page.
      name: (middleName[1] ?? 'adams').toLowerCase(),
      company: (mid.company ?? 'northwind northwind').split(' ')[0]?.toLowerCase() ?? 'northwind',
      email: `${first}.${last}.`,
      digits: String(middleIdx),
      rare: (withEmail.email as string).split('@')[0] as string,
      ...phase1.search,
    },
    cursors: {
      contactsDeep: encodeCursor(cursors.contactsDeep),
      timelineDeep: encodeTimelineCursor(cursors.timelineDeep),
      ...phase1.cursors,
    },
    usage: phase1.usage,
    importRows: buildImportRows(rows),
  };
}
