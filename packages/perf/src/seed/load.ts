// Bulk loader: one owner-role connection, one transaction per organization, 10,000-row
// `INSERT ... SELECT FROM unnest(...)` batches. RLS is forced, so app.org_id is set first.
import pg from 'pg';
import { out } from '../out';
import type { OrgPlan, SeedPlan } from './fixtures';
import {
  batches,
  type ContactRow,
  generateConsent,
  generateDismissals,
  generateTimeline,
} from './generate';
import { type Column, insertBatch, loadStream } from './insert';
import { type OrgContext, type Phase1Plan, STREAMS } from './phase1';
import { loadPhase1, type Phase1LoadCounts } from './phase1-load';
import { attachConversationRefs } from './phase1-messaging';
import { streamRand } from './random';
import { ANALYZE_SQL } from './reset';

const CONTACT_COLUMNS: Column[] = [
  { name: 'id', type: 'text' },
  { name: 'organization_id', type: 'text' },
  { name: 'display_name', type: 'text' },
  { name: 'company', type: 'text' },
  { name: 'phone_e164', type: 'text' },
  { name: 'source', type: 'text' },
  { name: 'email', type: 'text' },
  { name: 'job_title', type: 'text' },
  { name: 'tags', type: 'text', expr: `coalesce(string_to_array(nullif(t.tags, ''), ','), '{}')` },
  { name: 'timezone', type: 'text' },
  { name: 'archived_at', type: 'timestamptz' },
  { name: 'created_at', type: 'timestamptz' },
  { name: 'updated_at', type: 'timestamptz' },
];

const CONSENT_COLUMNS: Column[] = [
  { name: 'id', type: 'text' },
  { name: 'organization_id', type: 'text' },
  { name: 'contact_id', type: 'text' },
  { name: 'channel', type: 'text' },
  { name: 'status', type: 'text' },
  { name: 'source', type: 'text' },
  { name: 'evidence', type: 'text' },
  { name: 'created_at', type: 'timestamptz' },
];

const TIMELINE_COLUMNS: Column[] = [
  { name: 'id', type: 'text' },
  { name: 'organization_id', type: 'text' },
  { name: 'contact_id', type: 'text' },
  { name: 'kind', type: 'text' },
  { name: 'title', type: 'text' },
  { name: 'body', type: 'text' },
  { name: 'occurred_at', type: 'timestamptz' },
  { name: 'created_at', type: 'timestamptz' },
  // Conversation notes (Phase 1): null on every other event.
  { name: 'actor_user_id', type: 'text' },
  { name: 'source', type: 'text' },
  { name: 'ref_type', type: 'text' },
  { name: 'ref_id', type: 'text' },
];

const DISMISSAL_COLUMNS: Column[] = [
  { name: 'id', type: 'text' },
  { name: 'organization_id', type: 'text' },
  { name: 'contact_a_id', type: 'text' },
  { name: 'contact_b_id', type: 'text' },
  { name: 'created_at', type: 'timestamptz' },
];

async function loadContacts(client: pg.Client, rows: readonly ContactRow[]): Promise<void> {
  let done = 0;
  for (const batch of batches(rows)) {
    await insertBatch(client, 'contact', CONTACT_COLUMNS, batch);
    done += batch.length;
    out(`  contacts ${done}/${rows.length}`);
  }
  const merged = rows.filter((r) => r.merged_into_id !== null);
  for (const batch of batches(merged)) {
    await client.query(
      `UPDATE contact c SET merged_into_id = t.m
         FROM unnest($1::text[], $2::text[]) AS t(id, m) WHERE c.id = t.id`,
      [batch.map((r) => r.id), batch.map((r) => r.merged_into_id)],
    );
  }
}

export interface OrgLoadCounts {
  contacts: number;
  consent: number;
  timeline: number;
  dismissals: number;
  phase1: Phase1LoadCounts;
}

/** Each SMS conversation's contact, for the conversation notes on the timeline. */
function smsByContact(phase1: Phase1Plan): Map<string, string> {
  return new Map(
    phase1.conversations.filter((c) => c.channel === 'sms').map((c) => [c.contactId, c.id]),
  );
}

async function loadOrg(
  client: pg.Client,
  plan: OrgPlan,
  load: { heavyTimeline: number; dismissals: number; phase1: Phase1Plan; ctx: OrgContext },
): Promise<OrgLoadCounts> {
  const { orgId, rand, contacts } = plan;
  const { heavyTimeline, dismissals, phase1, ctx } = load;
  await client.query('BEGIN');
  try {
    await client.query(`select set_config('app.org_id', $1, true)`, [orgId]);
    await loadContacts(client, contacts.rows);
    const consent = await loadStream(
      client,
      'consent',
      'contact_permission_event',
      CONSENT_COLUMNS,
      generateConsent(rand, orgId, contacts.rows),
      null,
    );
    const timeline = await loadStream(
      client,
      'timeline',
      'timeline_event',
      TIMELINE_COLUMNS,
      attachConversationRefs(
        generateTimeline(
          rand,
          orgId,
          contacts.rows,
          plan.timelineTotal,
          plan.heavyId,
          heavyTimeline,
        ),
        smsByContact(phase1),
        ctx.ownerId,
        streamRand(phase1.seed, STREAMS.notes),
        phase1.counts.noteRefRatio,
      ),
      plan.timelineTotal,
    );
    const dismissed = await loadStream(
      client,
      'dismissals',
      'contact_duplicate_dismissal',
      DISMISSAL_COLUMNS,
      generateDismissals(rand, orgId, contacts.dupPairs, dismissals),
      Math.min(dismissals, contacts.dupPairs.length),
    );
    const phase1Loaded = await loadPhase1(client, ctx, phase1);
    await client.query('COMMIT');
    return {
      contacts: contacts.rows.length,
      consent,
      timeline,
      dismissals: dismissed,
      phase1: phase1Loaded,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export interface LoadResult {
  orgA: OrgLoadCounts;
  orgB: OrgLoadCounts;
  seconds: number;
}

/** Loads both organizations, then ANALYZEs. Org B has a small timeline and no heavy contact. */
export async function bulkLoad(
  adminUrl: string,
  plan: SeedPlan,
  owners: { a: string; b: string },
): Promise<LoadResult> {
  const started = Date.now();
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    out('loading organization A');
    const orgA = await loadOrg(client, plan.orgA, {
      heavyTimeline: plan.counts.heavyTimeline,
      dismissals: plan.counts.dismissals,
      phase1: plan.phase1A,
      ctx: { orgId: plan.orgA.orgId, ownerId: owners.a, orgIndex: 0 },
    });
    out('loading organization B');
    const orgB = await loadOrg(client, plan.orgB, {
      heavyTimeline: 0,
      dismissals: 0,
      phase1: plan.phase1B,
      ctx: { orgId: plan.orgB.orgId, ownerId: owners.b, orgIndex: 1 },
    });
    out('analyzing');
    await client.query(ANALYZE_SQL);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    out(`bulk load finished in ${seconds}s`);
    return { orgA, orgB, seconds };
  } finally {
    await client.end();
  }
}
