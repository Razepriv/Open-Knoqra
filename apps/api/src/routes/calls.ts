import { OpenAPIHono, type z } from '@hono/zod-openapi';
import {
  applyCallSignal,
  callHoldMicros,
  callReserveMicros,
  EMERGENCY_CALL_MESSAGE,
  evaluateSpend,
  isTerminal,
  mergeSpendDecisions,
  newId,
  OUTCOME_LABELS,
  type SpendDecision,
  TERMINAL_CALL_STATES,
} from '@knoqra/core';
import {
  type CallRow,
  call,
  callEvent,
  contact,
  type Database,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { auditCallAlone, type CallAuditAction, insertCallAudit } from '../lib/call-audit';
import {
  CALL_ID_PATTERN,
  type CallSchema,
  callJsonById,
  findCallWithContact,
  fromJoined,
  toCallJson,
} from '../lib/call-json';
import { releaseCallLock } from '../lib/call-lock';
import type { AppEnv, Tenant } from '../lib/context';
import { decodeTimelineCursor, encodeTimelineCursor } from '../lib/cursor';
import { fail, ok } from '../lib/envelope';
import { callBillingOf, platformFeeRate, quoteFor, RATE_UNAVAILABLE_MESSAGE } from '../lib/pricing';
import { publish } from '../lib/realtime';
import { loadVoiceChoice, type VoiceProviderChoice } from '../lib/voice-provider';
import {
  answerCall,
  authorizeCall,
  CallRefused,
  type CallTarget,
  claimCallLock,
  consentRefusal,
  dialOf,
  isAnswerable,
  lockedCall,
  resolveTarget,
  warningsOf,
} from '../services/calls';
import { callSettleKey, settleReservation, walletSummary } from '../services/ledger';
import { providerSpendDecision } from '../services/provider-spend';
import {
  activeRoute,
  answerRoute,
  cancelRoute,
  createCallRoute,
  getCallRoute,
  listRoute,
  outcomeRoute,
  preflightRoute,
} from './calls-schemas';
import { openWallet } from './wallet';

/** Caller id the fake provider dials from. */
const FAKE_FROM_E164 = '+12025550100';

/** The caller id calls go out with: the connection's, or the fake provider's own. */
function callerIdOf(choice: VoiceProviderChoice): string | null {
  if (choice.kind === 'fake') return FAKE_FROM_E164;
  return choice.kind === 'none' ? null : choice.connection.callerIdE164;
}

const SPEND_MESSAGES: Record<SpendDecision['reason'], string> = {
  insufficient_funds: 'Not enough credit for this call.',
  provider_low: 'The provider balance is running low.',
  provider_exhausted: 'The provider balance is too low to place a call.',
  stop_cap: 'This call would pass the monthly spend cap.',
  warn_cap: 'This call is over the monthly warning cap.',
  ok: 'Spending is allowed.',
};

function targetFailure(c: Context, target: Exclude<CallTarget, { kind: 'ok' }>) {
  switch (target.kind) {
    case 'invalid_phone':
      return fail(c, 422, 'invalid_phone', 'Enter a valid phone number.');
    case 'emergency':
      return fail(c, 422, 'emergency_not_supported', EMERGENCY_CALL_MESSAGE);
    case 'contact_not_found':
      return fail(c, 404, 'not_found', 'Contact not found.');
    case 'none':
      return fail(c, 400, 'validation_error', 'Give a number or a contact to call.');
  }
}

/** 404 for a missing, foreign or malformed id, audited as M1 does. */
async function callNotFound(
  c: Context,
  db: Database,
  tenant: Tenant,
  action: CallAuditAction,
  id: string,
) {
  await auditCallAlone(
    db,
    tenant,
    CALL_ID_PATTERN.test(id)
      ? { action, outcome: 'not_found', entityId: id }
      : { action, outcome: 'not_found', metadata: { reason: 'malformed_id' } },
  );
  return fail(c, 404, 'not_found', 'Call not found.');
}

/**
 * A teammate's call (same workspace, another user): it exists, so it is a 409 `invalid_state`
 * audited as denied, never a `not_found`.
 */
function notOwnerAudit(action: 'call.cancel' | 'call.outcome', id: string) {
  return {
    action,
    outcome: 'denied',
    entityId: id,
    metadata: { reason: 'not_owner' },
  } as const;
}

/** Microsecond-precision ISO text of created_at, so a keyset cursor never rounds a row away. */
const createdKey = sql<string>`to_char(${call.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function refuseCreate(c: Context, db: Database, tenant: Tenant, error: CallRefused) {
  const { refusal } = error;
  const audit = (reason: string) =>
    auditCallAlone(db, tenant, { action: 'call.create', outcome: 'denied', metadata: { reason } });
  switch (refusal.kind) {
    case 'consent':
      await audit(refusal.code);
      return fail(c, refusal.status, refusal.code, refusal.message);
    case 'target':
      return targetFailure(c, refusal.target);
    case 'spend':
      await audit(refusal.decision.reason);
      return fail(c, 402, 'spend_blocked', SPEND_MESSAGES[refusal.decision.reason]);
    case 'rate':
      await audit('rate_unavailable');
      return fail(c, 422, 'rate_unavailable', RATE_UNAVAILABLE_MESSAGE);
    case 'state':
      return fail(c, 409, 'invalid_state', 'The call cannot be authorized now.');
  }
}

export const calls = new OpenAPIHono<AppEnv>()
  .openapi(preflightRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const target = await resolveTarget(tx, query, false);
      const choice = await loadVoiceChoice(tx, c.env);
      const summary = await walletSummary(
        tx,
        await openWallet(tx, c.env, tenant.orgId),
        new Date(),
        callBillingOf(c.env),
      );
      const providerDecision = await providerSpendDecision(tx, new Date());
      return { target, choice, summary, providerDecision };
    });
    const { target, choice, summary, providerDecision } = result;
    if (
      target.kind === 'invalid_phone' ||
      target.kind === 'emergency' ||
      target.kind === 'contact_not_found'
    ) {
      return targetFailure(c, target);
    }
    // The destination's price, as the call would be authorized now.
    const quote = target.kind === 'ok' ? quoteFor(c.env, target.toE164, callerIdOf(choice)) : null;
    if (target.kind === 'ok' && quote === null) {
      return fail(c, 422, 'rate_unavailable', RATE_UNAVAILABLE_MESSAGE);
    }
    const reserveMicros =
      quote === null
        ? callReserveMicros(platformFeeRate(c.env))
        : callHoldMicros(quote.priceMicrosPerMinute, platformFeeRate(c.env));
    const walletSpend = evaluateSpend({
      availableMicros: summary.availableMicros,
      periodSpendMicros: summary.periodSpendMicros,
      heldMicros: summary.heldMicros,
      requestMicros: reserveMicros,
      warnCapMicros: summary.warnCapMicros,
      stopCapMicros: summary.stopCapMicros,
    });
    const spend = mergeSpendDecisions(walletSpend, providerDecision);
    const found = target.kind === 'ok' ? target : null;
    return ok(
      c,
      {
        to: found?.toE164 ?? null,
        contact: found?.contact ?? null,
        decision: found?.decision ?? null,
        spend,
        reserveMicros,
        rate:
          quote?.destination == null
            ? null
            : { ...quote.destination, priceMicrosPerMinute: quote.priceMicrosPerMinute },
      },
      200,
    );
  })
  .openapi(createCallRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');

    // 1. Idempotent replay (the same key returns the same call and dial), else 2. consent and
    // 3. a voice provider: one transaction, so a dial pays for one round of BEGIN/COMMIT, not two.
    const first = await withTenant(db, tenant.orgId, async (tx) => {
      const found = await findCallWithContact(
        tx,
        and(eq(call.userId, tenant.userId), eq(call.idempotencyKey, body.idempotencyKey)),
      );
      if (found) {
        const summary = await walletSummary(
          tx,
          await openWallet(tx, c.env, tenant.orgId),
          new Date(),
          callBillingOf(c.env),
        );
        return { kind: 'replay' as const, found, summary };
      }
      return {
        kind: 'new' as const,
        target: await resolveTarget(tx, body, false),
        choice: await loadVoiceChoice(tx, c.env),
      };
    });
    if (first.kind === 'replay') {
      return ok(
        c,
        {
          call: toCallJson(first.found),
          dial: dialOf(first.found.row),
          warnings: warningsOf(first.summary.status),
        },
        200,
      );
    }
    const pre = first;
    if (pre.target.kind !== 'ok') return targetFailure(c, pre.target);
    const refusal = consentRefusal(pre.target.decision, body.reviewConfirmed === true);
    if (refusal) {
      await auditCallAlone(db, tenant, {
        action: 'call.create',
        outcome: 'denied',
        metadata: { reason: refusal.code, consent: pre.target.decision.reason },
      });
      return fail(c, refusal.status, refusal.code, refusal.message);
    }
    const { choice } = pre;
    const fromE164 = callerIdOf(choice);
    if (choice.kind === 'none' || !fromE164) {
      return fail(
        c,
        409,
        'voice_not_configured',
        'Voice calling is not set up for this workspace.',
      );
    }

    // 4. The one-call-per-user lock.
    const callId = newId('cl');
    if (!(await claimCallLock(c.env, db, tenant, callId))) {
      await auditCallAlone(db, tenant, {
        action: 'call.create',
        outcome: 'denied',
        metadata: { reason: 'call_in_progress' },
      });
      return fail(c, 409, 'call_in_progress', 'Another call is in progress.');
    }

    // 5. and 6. Reserve and insert in one transaction; any failure frees the lock.
    let created: Awaited<ReturnType<typeof authorizeCall>>;
    try {
      created = await withTenant(db, tenant.orgId, (tx) =>
        authorizeCall(tx, { tenant, env: c.env, body, choice, fromE164, callId }),
      );
    } catch (error) {
      await releaseCallLock(c.env, tenant.userId, callId);
      if (error instanceof CallRefused) return refuseCreate(c, db, tenant, error);
      throw error;
    }

    // 7. Tell every open client, after the response: the caller already has the call.
    c.executionCtx.waitUntil(
      publish(c.env, tenant.orgId, { type: 'call.updated', data: created.json }),
    );
    return ok(
      c,
      { call: created.json, dial: dialOf(created.row), warnings: created.warnings },
      201,
    );
  })
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let cursor: { occurredAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const rows = await withTenant(db, tenant.orgId, (tx) =>
      tx
        .select({
          row: call,
          contactId: contact.id,
          contactName: contact.displayName,
          key: createdKey,
        })
        .from(call)
        .leftJoin(
          contact,
          and(eq(contact.organizationId, call.organizationId), eq(contact.id, call.contactId)),
        )
        .where(
          and(
            query.direction === 'all' ? undefined : eq(call.direction, query.direction),
            cursor
              ? sql`(${call.createdAt}, ${call.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(desc(call.createdAt), desc(call.id))
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeTimelineCursor({ occurredAt: last.key, id: last.row.id })
        : null;
    return ok(c, { items: page.map((r) => toCallJson(fromJoined(r))), nextCursor }, 200);
  })
  .openapi(activeRoute, async (c) => {
    const { db, tenant } = c.var;
    const found = await withTenant(db, tenant.orgId, async (tx) => {
      const [joined] = await tx
        .select({ row: call, contactId: contact.id, contactName: contact.displayName })
        .from(call)
        .leftJoin(
          contact,
          and(eq(contact.organizationId, call.organizationId), eq(contact.id, call.contactId)),
        )
        .where(
          and(eq(call.userId, tenant.userId), notInArray(call.state, [...TERMINAL_CALL_STATES])),
        )
        .orderBy(desc(call.createdAt), desc(call.id))
        .limit(1);
      return joined ? fromJoined(joined) : undefined;
    });
    return ok(c, found ? toCallJson(found) : null, 200);
  })
  .openapi(getCallRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CALL_ID_PATTERN.test(id)) return callNotFound(c, db, tenant, 'call.read', id);
    const found = await withTenant(db, tenant.orgId, (tx) =>
      findCallWithContact(tx, eq(call.id, id)),
    );
    if (!found) return callNotFound(c, db, tenant, 'call.read', id);
    return ok(c, toCallJson(found), 200);
  })
  .openapi(cancelRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CALL_ID_PATTERN.test(id)) return callNotFound(c, db, tenant, 'call.cancel', id);
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const [row] = await lockedCall(tx, id);
      if (!row) return { kind: 'not_found' } as const;
      if (row.userId !== tenant.userId) {
        await insertCallAudit(tx, tenant, notOwnerAudit('call.cancel', id));
        return { kind: 'not_owner' } as const;
      }
      const { next, changed } = applyCallSignal(row.state, { type: 'cancel' });
      if (!changed) return { kind: 'invalid_state' } as const;
      await tx
        .update(call)
        .set({ state: next, endedAt: new Date(), hangupCause: 'canceled', costMicros: 0 })
        .where(eq(call.id, id));
      await tx.insert(callEvent).values({
        organizationId: tenant.orgId,
        callId: id,
        rawEventId: 'app:cancel',
        signal: 'cancel',
        stateBefore: row.state,
        stateAfter: next,
      });
      if (row.reservationId) {
        await settleReservation(tx, {
          orgId: tenant.orgId,
          reservationId: row.reservationId,
          costMicros: 0,
          idempotencyKey: callSettleKey(id),
          refType: 'call',
          refId: id,
        });
      }
      await insertCallAudit(tx, tenant, {
        action: 'call.cancel',
        outcome: 'allowed',
        entityId: id,
        metadata: { stateBefore: row.state },
      });
      return { kind: 'ok', json: await callJsonById(tx, id), userId: row.userId } as const;
    });
    if (result.kind === 'not_found') return callNotFound(c, db, tenant, 'call.cancel', id);
    if (result.kind === 'not_owner') {
      return fail(c, 409, 'invalid_state', 'Only the person on the call can cancel it.');
    }
    if (result.kind === 'invalid_state') {
      return fail(c, 409, 'invalid_state', 'Only a call that has not connected can be canceled.');
    }
    await releaseCallLock(c.env, result.userId, id);
    await publish(c.env, tenant.orgId, { type: 'call.updated', data: result.json });
    return ok(c, result.json, 200);
  })
  .openapi(answerRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CALL_ID_PATTERN.test(id)) return callNotFound(c, db, tenant, 'call.answer', id);
    const [current] = await withTenant(db, tenant.orgId, (tx) =>
      tx.select().from(call).where(eq(call.id, id)).limit(1),
    );
    if (!current) return callNotFound(c, db, tenant, 'call.answer', id);
    if (!isAnswerable(current)) {
      return fail(c, 409, 'invalid_state', 'Only a ringing inbound call can be answered.');
    }
    if (!(await claimCallLock(c.env, db, tenant, id))) {
      return fail(c, 409, 'call_in_progress', 'Another call is in progress.');
    }
    let answered: { row: CallRow; json: z.infer<typeof CallSchema> };
    try {
      answered = await withTenant(db, tenant.orgId, (tx) => answerCall(tx, c.env, tenant, id));
    } catch (error) {
      // A concurrent answer of the same call by the same user holds this very lock: keep it.
      const alreadyMine =
        error instanceof CallRefused && error.refusal.kind === 'state' && error.refusal.alreadyMine;
      if (!alreadyMine) await releaseCallLock(c.env, tenant.userId, id);
      if (error instanceof CallRefused) {
        if (error.refusal.kind === 'spend') {
          return fail(c, 402, 'spend_blocked', SPEND_MESSAGES[error.refusal.decision.reason]);
        }
        return fail(c, 409, 'invalid_state', 'Only a ringing inbound call can be answered.');
      }
      throw error;
    }
    await publish(c.env, tenant.orgId, { type: 'call.updated', data: answered.json });
    return ok(c, { call: answered.json, dial: dialOf(answered.row) }, 200);
  })
  .openapi(outcomeRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CALL_ID_PATTERN.test(id)) return callNotFound(c, db, tenant, 'call.outcome', id);
    const body = c.req.valid('json');
    const note = body.note === undefined || body.note === '' ? null : body.note;
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const [row] = await lockedCall(tx, id);
      if (!row) return { kind: 'not_found' } as const;
      if (row.userId !== tenant.userId) {
        await insertCallAudit(tx, tenant, notOwnerAudit('call.outcome', id));
        return { kind: 'not_owner' } as const;
      }
      if (!isTerminal(row.state)) return { kind: 'invalid_state' } as const;
      if (row.outcome !== null) return { kind: 'outcome_exists' } as const;
      await tx
        .update(call)
        .set({ outcome: body.outcome, outcomeNote: note, outcomeAt: new Date() })
        .where(eq(call.id, id));
      if (row.contactId) {
        await tx.insert(timelineEvent).values({
          organizationId: tenant.orgId,
          contactId: row.contactId,
          kind: 'call',
          title: `Outcome: ${OUTCOME_LABELS[body.outcome]}`,
          body: note,
          actorUserId: tenant.userId,
          source: 'app',
          refType: 'call',
          refId: id,
          occurredAt: sql`clock_timestamp()`,
        });
      }
      // Never the note: it is PII.
      await insertCallAudit(tx, tenant, {
        action: 'call.outcome',
        outcome: 'allowed',
        entityId: id,
        metadata: { outcome: body.outcome },
      });
      return { kind: 'ok', json: await callJsonById(tx, id) } as const;
    });
    if (result.kind === 'not_found') return callNotFound(c, db, tenant, 'call.outcome', id);
    if (result.kind === 'not_owner') {
      return fail(c, 409, 'invalid_state', 'Only the person on the call can record its outcome.');
    }
    if (result.kind === 'invalid_state') {
      return fail(c, 409, 'invalid_state', 'Record an outcome after the call ends.');
    }
    if (result.kind === 'outcome_exists') {
      return fail(c, 409, 'outcome_exists', 'This call already has an outcome.');
    }
    await publish(c.env, tenant.orgId, { type: 'call.updated', data: result.json });
    return ok(c, result.json, 200);
  });
