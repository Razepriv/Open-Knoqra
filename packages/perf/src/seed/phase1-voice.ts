// M2 calls and voicemails. Every call is terminal: the owner has no live call, the common case the
// Desk polls `/calls/active` in.
import { BATCH_SIZE, type ContactRow, microIso, WINDOW_END_MS } from './generate';
import { msBetween, type OrgContext, WINDOW_START_MS } from './phase1';
import { hexId, int, pick, type Rand, weighted } from './random';
import { TIMELINE_BODIES } from './words';

export interface CallRow {
  id: string;
  organization_id: string;
  user_id: string;
  contact_id: string | null;
  direction: 'outbound' | 'inbound';
  state: string;
  from_e164: string;
  to_e164: string;
  provider: string;
  provider_call_id: string | null;
  client_state: string;
  cost_micros: number | null;
  outcome: string | null;
  answered_at: string | null;
  ended_at: string | null;
  hangup_cause: string | null;
  billable_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export interface VoicemailRow {
  id: string;
  organization_id: string;
  call_id: string;
  contact_id: string | null;
  from_e164: string;
  duration_seconds: number;
  transcript: string | null;
  recording_key: string | null;
  listened_at: string | null;
  created_at: string;
}

export interface CallBatch {
  calls: CallRow[];
  voicemails: VoicemailRow[];
}

const STATES = ['completed', 'no_answer', 'busy', 'failed', 'canceled'] as const;
const STATE_WEIGHTS = [0.6, 0.15, 0.08, 0.07, 0.1];
const HANGUP: Record<string, string> = {
  completed: 'normal',
  no_answer: 'no_answer',
  busy: 'busy',
  failed: 'failed',
  canceled: 'canceled',
};
const OUTCOMES = ['connected', 'follow_up', 'rescheduled', 'wrong_number'] as const;

function callRow(
  rand: Rand,
  ctx: OrgContext,
  contacts: readonly ContactRow[],
  orgNumbers: readonly string[],
  voicemail: boolean,
): CallRow {
  const id = hexId(rand, 'cl');
  const contact = rand() < 0.9 ? pick(rand, contacts) : null;
  const direction = voicemail || rand() < 0.3 ? 'inbound' : 'outbound';
  const state = voicemail ? 'no_answer' : (STATES[weighted(rand, STATE_WEIGHTS)] as string);
  const ours = pick(rand, orgNumbers);
  const theirs = contact?.phone_e164 ?? `+1201555${String(int(rand, 10_000)).padStart(4, '0')}`;
  const createdMs = msBetween(rand, WINDOW_START_MS, WINDOW_END_MS - 3_600_000);
  const answered = state === 'completed';
  const seconds = answered ? 5 + int(rand, 900) : null;
  const endMs = createdMs + 15_000 + (seconds ?? 0) * 1000;
  const created = microIso(createdMs, int(rand, 1000));
  const ended = microIso(endMs, int(rand, 1000));
  return {
    id,
    organization_id: ctx.orgId,
    user_id: ctx.ownerId,
    contact_id: contact?.id ?? null,
    direction,
    state,
    from_e164: direction === 'outbound' ? ours : theirs,
    to_e164: direction === 'outbound' ? theirs : ours,
    provider: 'fake',
    provider_call_id: `fake-call-${id.slice(3)}`,
    client_state: `cs-${id.slice(3)}`,
    cost_micros: answered ? (seconds as number) * 200 : null,
    outcome: answered && rand() < 0.5 ? pick(rand, OUTCOMES) : null,
    answered_at: answered ? microIso(createdMs + 15_000, 0) : null,
    ended_at: ended,
    hangup_cause: HANGUP[state] ?? null,
    billable_seconds: seconds,
    created_at: created,
    updated_at: ended,
  };
}

function voicemailRow(rand: Rand, call: CallRow): VoicemailRow {
  const createdMs = Date.parse(call.ended_at as string) + 1000;
  return {
    id: hexId(rand, 'vm'),
    organization_id: call.organization_id,
    call_id: call.id,
    contact_id: call.contact_id,
    from_e164: call.from_e164,
    duration_seconds: 5 + int(rand, 120),
    transcript: rand() < 0.8 ? pick(rand, TIMELINE_BODIES) : null,
    recording_key: `recordings/${call.id}.wav`,
    listened_at: rand() < 0.5 ? new Date(createdMs + 3_600_000).toISOString() : null,
    created_at: new Date(createdMs).toISOString(),
  };
}

/**
 * Exactly `total` calls, `voicemails` of them inbound unanswered calls with a voicemail (positions
 * by selection sampling). Each batch carries its voicemails, loaded after its calls.
 */
export function* generateCalls(
  rand: Rand,
  ctx: OrgContext,
  total: number,
  voicemails: number,
  contacts: readonly ContactRow[],
  orgNumbers: readonly string[],
): Generator<CallBatch> {
  let left = voicemails;
  let batch: CallBatch = { calls: [], voicemails: [] };
  for (let i = 0; i < total; i++) {
    const withVoicemail = left > 0 && rand() < left / (total - i);
    if (withVoicemail) left--;
    const call = callRow(rand, ctx, contacts, orgNumbers, withVoicemail);
    batch.calls.push(call);
    if (withVoicemail) batch.voicemails.push(voicemailRow(rand, call));
    if (batch.calls.length === BATCH_SIZE) {
      yield batch;
      batch = { calls: [], voicemails: [] };
    }
  }
  if (batch.calls.length > 0) yield batch;
}
