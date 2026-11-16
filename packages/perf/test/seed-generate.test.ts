import { decodeCursor, decodeTimelineCursor } from '@knoqra/api/cursor';
import { normalizePhone } from '@knoqra/core';
import { describe, expect, it } from 'vitest';
import { buildFixtures, planOrg, planSeed } from '../src/seed/fixtures';
import {
  type ContactRow,
  generateConsent,
  generateDismissals,
  generateTimeline,
  SCALE,
  scaledCounts,
} from '../src/seed/generate';
import { hexId, mulberry32 } from '../src/seed/random';
import { SAMPLE_PHASE1_RAW } from './phase1-raw';

const SCALE_FACTOR = 0.01;
const counts = scaledCounts(SCALE_FACTOR);
const ORG = 'PerfSeedOrgA0000000000000000000';

function firstBatch<T>(gen: Generator<T[]>): T[] {
  const next = gen.next();
  if (next.done) throw new Error('generator yielded nothing');
  return next.value;
}

describe('random', () => {
  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 50 }, () => a());
    expect(seqA).toEqual(Array.from({ length: 50 }, () => b()));
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });

  it('hexId is prefix, underscore, 32 lowercase hex characters', () => {
    const rand = mulberry32(1);
    for (const prefix of ['ct', 'te', 'cp', 'dd'] as const) {
      expect(hexId(rand, prefix)).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
    }
  });
});

describe('scaledCounts', () => {
  it('defaults match the pinned volumes', () => {
    expect(SCALE).toEqual({
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
    });
    expect(scaledCounts(1).contacts).toBe(100_000);
    expect(counts.contacts).toBe(1_000);
    expect(counts.timeline).toBe(10_000);
    expect(counts.heavyTimeline).toBe(500);
  });
});

describe('contacts', () => {
  const plan = planOrg(42, ORG, counts.contacts, counts.timeline);
  const rows = plan.contacts.rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const active = rows.filter((r) => r.archived_at === null && r.merged_into_id === null);

  it('has the pinned count and ratios', () => {
    expect(rows).toHaveLength(1_000);
    const archived = rows.filter((r) => r.archived_at !== null && r.merged_into_id === null);
    const merged = rows.filter((r) => r.merged_into_id !== null);
    expect(Math.abs(archived.length - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(merged.length - 10)).toBeLessThanOrEqual(1);
    for (const m of merged) {
      expect(m.archived_at).not.toBeNull();
      const target = byId.get(m.merged_into_id as string);
      expect(target?.organization_id).toBe(ORG);
      expect(target?.archived_at).toBeNull();
      expect(target?.merged_into_id).toBeNull();
    }
  });

  it('keeps active phones unique and in the +1 NPA 555 XXXX shape', () => {
    const phones = active.map((r) => r.phone_e164);
    expect(new Set(phones).size).toBe(phones.length);
    for (const r of rows) expect(r.phone_e164).toMatch(/^\+1\d{3}555\d{4}$/);
    expect(rows[0]?.phone_e164).toBe('+12025550100');
    expect(rows[99]?.phone_e164).toBe('+12025550199');
  });

  it('uses synthetic emails and deterministic timestamps', () => {
    for (const r of rows) {
      if (r.email !== null) expect(r.email).toMatch(/@example\.test$/);
      expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(r.updated_at).toBe(r.created_at);
    }
    expect(rows.filter((r) => r.email !== null).length).toBeGreaterThan(600);
  });

  it('plants duplicates: same normalized name, half with the email in another case', () => {
    expect(plan.contacts.dupPairs.length).toBe(20);
    let caseDiffers = 0;
    for (const [aId, bId] of plan.contacts.dupPairs) {
      const a = byId.get(aId) as ContactRow;
      const b = byId.get(bId) as ContactRow;
      expect(a.display_name).toBe(b.display_name);
      if (
        a.email &&
        b.email &&
        a.email !== b.email &&
        a.email.toLowerCase() === b.email.toLowerCase()
      ) {
        caseDiffers++;
      }
    }
    expect(caseDiffers).toBe(10);
  });

  it('is deterministic for a seed and different for another', () => {
    const again = planOrg(42, ORG, counts.contacts, counts.timeline);
    expect(again.contacts.rows.slice(0, 50)).toEqual(rows.slice(0, 50));
    expect(again.contacts.rows).toEqual(rows);
    const other = planOrg(7, ORG, counts.contacts, counts.timeline);
    expect(other.contacts.rows[0]?.id).not.toBe(rows[0]?.id);
  });
});

describe('timeline, consent and dismissals', () => {
  const plan = planOrg(42, ORG, counts.contacts, counts.timeline);

  it('emits exactly the requested total with the heavy contact heavy', () => {
    const gen = generateTimeline(
      plan.rand,
      ORG,
      plan.contacts.rows,
      counts.timeline,
      plan.heavyId,
      counts.heavyTimeline,
    );
    let total = 0;
    let heavy = 0;
    const ids = new Set<string>();
    const lo = Date.UTC(2026, 10, 1) - 730 * 86_400_000;
    const hi = Date.UTC(2026, 10, 1);
    for (const batch of gen) {
      expect(batch.length).toBeLessThanOrEqual(10_000);
      for (const e of batch) {
        total++;
        if (e.contact_id === plan.heavyId) heavy++;
        ids.add(e.id);
        expect(e.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        const t = Date.parse(e.occurred_at);
        expect(t).toBeGreaterThanOrEqual(lo);
        expect(t).toBeLessThan(hi);
        expect(['note', 'consent', 'system', 'call', 'message']).toContain(e.kind);
      }
    }
    expect(total).toBe(10_000);
    expect(heavy).toBe(500);
    expect(ids.size).toBe(total);
  });

  it('generates consent rows with valid ids', () => {
    const rows = [...generateConsent(plan.rand, ORG, plan.contacts.rows)].flat();
    expect(rows.length).toBeGreaterThan(1_300);
    expect(rows.length).toBeLessThan(1_700);
    for (const r of rows) expect(r.id).toMatch(/^cp_[0-9a-f]{32}$/);
  });

  it('orders every dismissal pair a < b by bytes', () => {
    const rows = [
      ...generateDismissals(plan.rand, ORG, plan.contacts.dupPairs, counts.dismissals),
    ].flat();
    expect(rows).toHaveLength(counts.dismissals);
    for (const r of rows) expect(r.contact_a_id < r.contact_b_id).toBe(true);
    expect(new Set(rows.map((r) => `${r.contact_a_id}${r.contact_b_id}`)).size).toBe(rows.length);
  });

  it('first batches are identical across runs with the same seed', () => {
    const run = () => {
      const p = planOrg(42, ORG, counts.contacts, counts.timeline);
      return firstBatch(
        generateTimeline(p.rand, ORG, p.contacts.rows, counts.timeline, p.heavyId, 500),
      );
    };
    expect(run()).toEqual(run());
  });
});

describe('fixtures', () => {
  const build = () => {
    const seedPlan = planSeed(42, SCALE_FACTOR);
    return buildFixtures(seedPlan, {
      database: 'x_perf',
      contactsDeep: { name: 'avery adams', id: seedPlan.orgA.contacts.rows[5]?.id as string },
      timelineDeep: {
        occurredAt: '2026-01-02T03:04:05.123456Z',
        id: 'te_00000000000000000000000000000001',
      },
      phase1: SAMPLE_PHASE1_RAW,
    });
  };

  it('is deep-equal across two builds', () => {
    expect(build()).toEqual(build());
  });

  it('has the pinned shape', () => {
    const f = build();
    expect(f.seed).toBe(42);
    expect(f.ownerA.email).toBe('perf-owner-a@example.test');
    expect(f.ownerB.email).toBe('perf-owner-b@example.test');
    expect(f.ownerA.password).toBe('perf-local-only-password');
    expect(f.ownerA.orgId).not.toBe(f.ownerB.orgId);
    for (const key of [
      'first',
      'middle',
      'heavy',
      'archived',
      'merged',
      'withDuplicates',
      'withEmail',
    ] as const) {
      expect(f.ids[key]).toMatch(/^ct_[0-9a-f]{32}$/);
    }
    for (const key of ['name', 'company', 'email', 'digits', 'rare'] as const) {
      expect(f.search[key].length).toBeGreaterThan(0);
    }
  });

  it('writes cursors the API decodes', () => {
    const f = build();
    const c = decodeCursor(f.cursors.contactsDeep);
    expect(c.ok && c.value.name).toBe('avery adams');
    const t = decodeTimelineCursor(f.cursors.timelineDeep);
    expect(t.ok && t.value.occurredAt).toBe('2026-01-02T03:04:05.123456Z');
  });

  it('has 200 import rows: 100 existing and 100 new, all valid phones', () => {
    const f = build();
    expect(f.importRows).toHaveLength(200);
    const existing = f.importRows.filter((r) => r.phone.startsWith('+1 202 555 01'));
    const fresh = f.importRows.filter((r) => r.phone.startsWith('+1 213 555 01'));
    expect(existing).toHaveLength(100);
    expect(fresh).toHaveLength(100);
    for (const r of f.importRows) expect(normalizePhone(r.phone).ok).toBe(true);
    expect(normalizePhone(existing[0]?.phone as string)).toEqual({
      ok: true,
      value: '+12025550100',
    });
  });
});
