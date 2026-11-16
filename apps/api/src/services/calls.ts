import type { z } from '@hono/zod-openapi';
import {
  type ChannelDecision,
  callHoldMicros,
  callReserveMicros,
  currentPermissions,
  evaluateChannel,
  isEmergencyNumber,
  isTerminal,
  normalizePhone,
  type SpendDecision,
} from '@knoqra/core';
import {
  type CallRow,
  call,
  callRoute,
  contact,
  type Database,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { eq, type SQL } from 'drizzle-orm';
import type { Env } from '../env';
import { insertCallAudit } from '../lib/call-audit';
import { callJsonById, toCallJson } from '../lib/call-json';
import { acquireCallLock, releaseCallLock } from '../lib/call-lock';
import { CONTACT_ID_PATTERN } from '../lib/contact-access';
import type { Tenant } from '../lib/context';
import { latestPermissionEvents } from '../lib/permissions';
import { platformFeeRate, quoteFor } from '../lib/pricing';
import {
  grantsStarterCredit,
  loadVoiceChoice,
  type VoiceProviderChoice,
} from '../lib/voice-provider';
import type { CreateBody, DialJson } from '../routes/calls-schemas';
import { ensureWallet, reserve } from './ledger';
import { providerSpendDecision } from './provider-spend';

/**
 * Call authorization and answering: consent, the one-call lock, the spend reserve and the call
 * row. The HTTP layer (`routes/calls.ts`) maps the results and refusals to responses.
 */

const reserveKey = (callId: string) => `call:${callId}:reserve`;

const BLOCKED_MESSAGES: Partial<Record<ChannelDecision['reason'], string>> = {
  do_not_contact: 'Do not contact. Policy, not a task.',
  revoked: 'Call consent was revoked.',
  opted_out: 'This contact opted out of calls.',
};

const NEEDS_REVIEW_MESSAGE = 'Call consent is unknown. Confirm you may call this number.';

export type CallTarget =
  | {
      kind: 'ok';
      toE164: string;
      contact: { id: string; displayName: string } | null;
      decision: ChannelDecision;
    }
  | { kind: 'none' }
  | { kind: 'invalid_phone' }
  | { kind: 'emergency' }
  | { kind: 'contact_not_found' };

/**
 * The number to dial and the manual-call consent for it. A contact id wins over `to`; a bare number
 * is matched to a contact by phone_e164. `lock` takes FOR SHARE on the contact, so a concurrent
 * consent change (writers hold FOR UPDATE) commits either before this check or after the call.
 */
export async function resolveTarget(
  tx: Tx,
  input: { to?: string; contactId?: string },
  lock: boolean,
): Promise<CallTarget> {
  let where: SQL;
  let toE164: string | null = null;
  if (input.contactId !== undefined) {
    if (!CONTACT_ID_PATTERN.test(input.contactId)) return { kind: 'contact_not_found' };
    where = eq(contact.id, input.contactId);
  } else if (input.to !== undefined) {
    if (isEmergencyNumber(input.to)) return { kind: 'emergency' };
    const phone = normalizePhone(input.to);
    if (!phone.ok) return { kind: 'invalid_phone' };
    toE164 = phone.value;
    where = eq(contact.phoneE164, phone.value);
  } else {
    return { kind: 'none' };
  }
  const query = tx
    .select({ id: contact.id, displayName: contact.displayName, phoneE164: contact.phoneE164 })
    .from(contact)
    .where(where)
    .limit(1);
  const [found] = await (lock ? query.for('share') : query);
  if (!found) {
    if (toE164 === null) return { kind: 'contact_not_found' };
    return {
      kind: 'ok',
      toE164,
      contact: null,
      decision: evaluateChannel('manual_call', undefined),
    };
  }
  const status = currentPermissions(await latestPermissionEvents(tx, found.id)).manual_call;
  return {
    kind: 'ok',
    toE164: found.phoneE164,
    contact: { id: found.id, displayName: found.displayName },
    decision: evaluateChannel('manual_call', status),
  };
}

type ConsentRefusal = { status: 422; code: 'call_blocked' } | { status: 409; code: 'needs_review' };

export function consentRefusal(
  decision: ChannelDecision,
  reviewConfirmed: boolean,
): (ConsentRefusal & { message: string }) | null {
  if (decision.outcome === 'blocked') {
    return {
      status: 422,
      code: 'call_blocked',
      message: BLOCKED_MESSAGES[decision.reason] ?? 'Consent does not allow this call.',
    };
  }
  if (decision.outcome === 'needs_review' && !reviewConfirmed) {
    return { status: 409, code: 'needs_review', message: NEEDS_REVIEW_MESSAGE };
  }
  return null;
}

export function dialOf(row: CallRow): DialJson {
  return {
    provider: row.provider === 'telnyx' || row.provider === 'plivo' ? row.provider : 'fake',
    to: row.toE164,
    from: row.fromE164,
    clientState: row.clientState,
  };
}

/** 32 random hex characters: the provider echoes it back on every webhook of the call. */
function newClientState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const warningsOf = (decision: SpendDecision): SpendDecision[] =>
  decision.outcome === 'warn' ? [decision] : [];

/**
 * Claims the user's call slot for `callId`. When it is held by a call that has already ended (a
 * missed release), frees it with a compare-and-release on that holder and retries once; a holder
 * this tenant cannot see (another organization) counts as active.
 */
export async function claimCallLock(env: Env, db: Database, tenant: Tenant, callId: string) {
  const first = await acquireCallLock(env, tenant.userId, callId);
  if (first.ok) return true;
  const [held] = await withTenant(db, tenant.orgId, (tx) =>
    tx.select({ state: call.state }).from(call).where(eq(call.id, first.heldBy)).limit(1),
  );
  if (!held || !isTerminal(held.state)) return false;
  await releaseCallLock(env, tenant.userId, first.heldBy);
  return (await acquireCallLock(env, tenant.userId, callId)).ok;
}

/** A refusal raised inside the authorization transaction, so everything it wrote rolls back. */
export class CallRefused extends Error {
  constructor(
    readonly refusal:
      | {
          kind: 'consent';
          status: 422 | 409;
          code: 'call_blocked' | 'needs_review';
          message: string;
        }
      | { kind: 'target'; target: Exclude<CallTarget, { kind: 'ok' }> }
      | { kind: 'spend'; decision: SpendDecision }
      | { kind: 'rate' }
      | { kind: 'state'; alreadyMine: boolean },
  ) {
    super('call refused');
    this.name = 'CallRefused';
  }
}

export function lockedCall(tx: Tx, id: string) {
  return tx.select().from(call).where(eq(call.id, id)).limit(1).for('update');
}

interface CreateInput {
  tenant: Tenant;
  env: Env;
  body: z.infer<typeof CreateBody>;
  choice: Exclude<VoiceProviderChoice, { kind: 'none' }>;
  fromE164: string;
  callId: string;
}

/** Step 5: re-check consent under the contact lock, reserve, insert the call and its route. */
export async function authorizeCall(tx: Tx, input: CreateInput) {
  const { tenant, env, body, choice, callId } = input;
  const reviewConfirmed = body.reviewConfirmed === true;
  const target = await resolveTarget(tx, body, true);
  if (target.kind !== 'ok') throw new CallRefused({ kind: 'target', target });
  const refusal = consentRefusal(target.decision, reviewConfirmed);
  if (refusal) throw new CallRefused({ kind: 'consent', ...refusal });
  // The price is fixed now, from the destination and the caller id, and kept on the call.
  const quote = quoteFor(env, target.toE164, input.fromE164);
  if (quote === null) throw new CallRefused({ kind: 'rate' });
  await ensureWallet(tx, tenant.orgId, { starterCredit: grantsStarterCredit(env, choice) });
  const reserved = await reserve(tx, {
    orgId: tenant.orgId,
    amountMicros: callHoldMicros(quote.priceMicrosPerMinute, platformFeeRate(env)),
    idempotencyKey: reserveKey(callId),
    refType: 'call',
    refId: callId,
    actorUserId: tenant.userId,
  });
  if ('refused' in reserved) throw new CallRefused({ kind: 'spend', decision: reserved.refused });
  const providerDecision = await providerSpendDecision(tx, new Date());
  if (providerDecision.outcome === 'stop') {
    // Throwing rolls the transaction back, so the reserve above is not kept.
    throw new CallRefused({ kind: 'spend', decision: providerDecision });
  }
  const [row] = await tx
    .insert(call)
    .values({
      id: callId,
      organizationId: tenant.orgId,
      userId: tenant.userId,
      contactId: target.contact?.id ?? null,
      direction: 'outbound',
      state: 'queued',
      fromE164: input.fromE164,
      toE164: target.toE164,
      provider: choice.kind,
      clientState: newClientState(),
      idempotencyKey: body.idempotencyKey,
      reservationId: reserved.entry.id,
      reviewConfirmed,
      priceMicrosPerMinute: quote.priceMicrosPerMinute,
      providerCostMicrosPerMinute: quote.costMicrosPerMinute,
      rateCountry: quote.destination?.country ?? null,
      rateNumberType: quote.destination?.numberType ?? null,
    })
    .returning();
  if (!row) throw new Error('call insert returned no row');
  await tx.insert(callRoute).values({
    clientState: row.clientState,
    organizationId: tenant.orgId,
    callId,
    provider: row.provider,
  });
  // Never the numbers: they are PII.
  await insertCallAudit(tx, tenant, {
    action: 'call.create',
    outcome: 'allowed',
    entityId: callId,
    metadata: {
      reviewConfirmed,
      provider: row.provider,
      consent: target.decision.reason,
      spend: reserved.decision.reason,
      contactId: row.contactId,
    },
  });
  return {
    row,
    json: toCallJson({ row, contact: target.contact }),
    warnings: [...warningsOf(reserved.decision), ...warningsOf(providerDecision)],
  };
}

export function isAnswerable(row: CallRow): boolean {
  return row.direction === 'inbound' && row.state === 'ringing' && row.reservationId === null;
}

/** Re-checks under the row lock, reserves and assigns the call to the answering user. */
export async function answerCall(tx: Tx, env: Env, tenant: Tenant, id: string) {
  const [row] = await lockedCall(tx, id);
  if (!row || !isAnswerable(row)) {
    const alreadyMine = row?.userId === tenant.userId && row.reservationId !== null;
    throw new CallRefused({ kind: 'state', alreadyMine });
  }
  const choice = await loadVoiceChoice(tx, env);
  await ensureWallet(tx, tenant.orgId, { starterCredit: grantsStarterCredit(env, choice) });
  const reserved = await reserve(tx, {
    orgId: tenant.orgId,
    amountMicros: callReserveMicros(platformFeeRate(env)),
    idempotencyKey: reserveKey(id),
    refType: 'call',
    refId: id,
    actorUserId: tenant.userId,
  });
  if ('refused' in reserved) throw new CallRefused({ kind: 'spend', decision: reserved.refused });
  const providerDecision = await providerSpendDecision(tx, new Date());
  if (providerDecision.outcome === 'stop') {
    throw new CallRefused({ kind: 'spend', decision: providerDecision });
  }
  const [updated] = await tx
    .update(call)
    .set({ userId: tenant.userId, reservationId: reserved.entry.id })
    .where(eq(call.id, id))
    .returning();
  if (!updated) throw new Error('call update returned no row');
  await insertCallAudit(tx, tenant, {
    action: 'call.answer',
    outcome: 'allowed',
    entityId: id,
    metadata: { spend: reserved.decision.reason },
  });
  return { row: updated, json: await callJsonById(tx, id) };
}
