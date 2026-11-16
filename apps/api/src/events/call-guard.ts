import { EMERGENCY_CALL_MESSAGE, emergencyCode, normalizePhone } from '@knoqra/core';
import {
  auditEvent,
  call,
  callRoute,
  type Database,
  member,
  notification,
  type ProviderCredentialRow,
  providerEventRaw,
  providerNumberRoute,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { ProviderApiError, type TelnyxOutboundStart, telnyxOutboundStart } from '@knoqra/providers';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { buildProvider, openConnectionSecret } from '../connectors/registry';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { isValidMasterKey } from '../lib/secret-envelope';
import { loadConnection } from '../lib/voice-provider';
import { reportError } from '../observability/report';

/**
 * The server-side backstop for calls the browser places itself. The Desk dials through the Telnyx
 * WebRTC SDK with the workspace's own credential, after `POST /calls` has authorized the call and
 * issued its client state. Anyone holding that login token can skip the API and dial anything,
 * 911 included: Telnyx always connects emergency calls (and charges for those without a
 * registered address), and a call made outside the API is never billed.
 *
 * So when Telnyx reports an outgoing call starting (`call.initiated`), this guard hangs it up at
 * once if it dials an emergency or special short code, or if it carries no client state of a call
 * the API created. Inbound calls are never touched: the guard reads only events Telnyx itself marks
 * `outgoing`. The hang-up uses the workspace's own Telnyx key, and the block is recorded once (an
 * audit row and an in-app notification to each owner), with no call row and no charge.
 */

const TELNYX = 'telnyx';

/** How long after `POST /calls` a call that arrives without its client state may still match it. */
const PENDING_MATCH_SECONDS = 120;

/** Telnyx's error code for a hang-up of a call that has already ended. */
const CALL_ALREADY_ENDED = '90018';

/** The fewest digits a number written without its country code may have and still match. */
const MIN_MATCH_DIGITS = 7;

export type BlockReason = 'emergency' | 'unauthorized';

export interface GuardContext {
  env: Env;
  db: Database;
  rawEventId: string;
  /** The workspace whose own key verified the delivery (a per-connection URL), else null. */
  connectorOrgId: string | null;
  /** For tests: no network in tests. */
  fetch?: typeof fetch;
}

/**
 * `pass`: not the guard's to stop; handle the event as usual. `blocked`: hung up (or already
 * ended) and recorded; the raw event is final. `refused`: Telnyx permanently refused the hang-up;
 * logged and reported, and the raw event is marked ignored so it is not retried.
 */
export type GuardOutcome =
  | { kind: 'pass' }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'refused'; reason: string };

const PASS: GuardOutcome = { kind: 'pass' };

/**
 * The queue path: runs on every stored provider event before it is normalized. Throws when the
 * hang-up failed in a way worth retrying (network, 5xx, 408, 429), so the queue retries it.
 */
export async function guardOutboundCall(
  ctx: GuardContext,
  provider: string,
  body: unknown,
): Promise<GuardOutcome> {
  if (provider !== TELNYX) return PASS;
  const start = telnyxOutboundStart(body);
  if (start === null) return PASS;
  const code = emergencyCode(start.to);
  if (code === null && start.clientState !== null) {
    if (await authorizedByClientState(ctx.db, start)) return PASS;
  }
  if (code === null && start.clientState === null && (await boundCall(ctx.db, start))) return PASS;
  return block(ctx, start, code);
}

/**
 * The webhook fast path, for emergency calls only: run right after the event is stored and queued,
 * so a 911 call is cut without waiting for the queue's batch window. Never throws; whatever it
 * cannot do, the queue path does.
 */
export async function hangUpEmergencyNow(ctx: GuardContext, body: unknown): Promise<void> {
  try {
    const start = telnyxOutboundStart(body);
    if (start === null) return;
    const code = emergencyCode(start.to);
    if (code === null) return;
    const outcome = await block(ctx, start, code);
    logger.info('call_guard.fast_path', { rawEventId: ctx.rawEventId, outcome: outcome.kind });
  } catch (error) {
    logger.warn('call_guard.fast_path_failed', { rawEventId: ctx.rawEventId, error });
  }
}

async function block(
  ctx: GuardContext,
  start: TelnyxOutboundStart,
  code: string | null,
): Promise<GuardOutcome> {
  const why: BlockReason = code === null ? 'unauthorized' : 'emergency';
  const target = await resolveWorkspace(ctx, start);
  if (target === null) {
    // Without the workspace there is no Telnyx key to hang up with. The event goes on to the call
    // handler, which parks it as unknown_call.
    const error = new Error('call_guard.no_workspace');
    logger.error('call_guard.no_workspace', { rawEventId: ctx.rawEventId, reason: why });
    reportError(error, { where: 'call_guard' });
    return PASS;
  }
  if (
    why === 'unauthorized' &&
    start.clientState === null &&
    (await withTenant(ctx.db, target.orgId, (tx) => pendingCallMatches(tx, start)))
  ) {
    // A call the API authorized moments ago to this number: its later events carry the client
    // state and bind it. Not ours to stop.
    return PASS;
  }
  const hangup = await hangUp(ctx, target.connection, start.callControlId);
  if (hangup.kind === 'refused') {
    logger.error('call_guard.hangup_refused', {
      rawEventId: ctx.rawEventId,
      orgId: target.orgId,
      reason: why,
      status: hangup.status,
      code: hangup.code,
    });
    reportError(new Error(`call_guard.hangup_refused ${hangup.status}`), { where: 'call_guard' });
    return { kind: 'refused', reason: `hangup_refused_${hangup.status}` };
  }
  const recorded = await recordBlocked(ctx, target.orgId, start, why, code, hangup.kind);
  logger.warn('call_guard.blocked', {
    rawEventId: ctx.rawEventId,
    orgId: target.orgId,
    reason: why,
    hangup: hangup.kind,
    recorded,
  });
  return { kind: 'blocked', reason: why };
}

/** The dialed part of a number or SIP/tel URI, as digits only. */
function destinationDigits(value: string): string {
  const dialed = /^(?:sips?|tel):([^@;]*)/i.exec(value.trim())?.[1] ?? value;
  return dialed.replace(/\D/g, '');
}

/** Same number, allowing a country code on one side only (`+12025550123` and `2025550123`). */
export function sameDestination(a: string, b: string): boolean {
  const x = destinationDigits(a);
  const y = destinationDigits(b);
  if (x === '' || y === '') return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= MIN_MATCH_DIGITS && long.endsWith(short);
}

/**
 * The client state belongs to an outbound Telnyx call the API created, to this destination, not
 * yet bound to another Telnyx call. A state lifted from an inbound call, reused for a second dial,
 * or reused for another number does not authorize this one.
 */
async function authorizedByClientState(db: Database, start: TelnyxOutboundStart): Promise<boolean> {
  const clientState = start.clientState;
  if (clientState === null) return false;
  const [route] = await db
    .select({
      orgId: callRoute.organizationId,
      callId: callRoute.callId,
      provider: callRoute.provider,
    })
    .from(callRoute)
    .where(eq(callRoute.clientState, clientState))
    .limit(1);
  if (!route || route.provider !== TELNYX) return false;
  const row = await withTenant(db, route.orgId, async (tx) => {
    const [found] = await tx
      .select({
        direction: call.direction,
        providerCallId: call.providerCallId,
        toE164: call.toE164,
      })
      .from(call)
      .where(eq(call.id, route.callId))
      .limit(1);
    return found;
  });
  return (
    row !== undefined &&
    row.direction === 'outbound' &&
    (row.providerCallId === null || row.providerCallId === start.callControlId) &&
    sameDestination(row.toE164, start.to)
  );
}

/** An earlier event of this very call (with its client state) already bound it to a call. */
async function boundCall(db: Database, start: TelnyxOutboundStart): Promise<boolean> {
  const [route] = await db
    .select({ callId: callRoute.callId })
    .from(callRoute)
    .where(and(eq(callRoute.provider, TELNYX), eq(callRoute.providerCallId, start.callControlId)))
    .limit(1);
  return route !== undefined;
}

/**
 * Whether the workspace has an outbound call the API authorized in the last two minutes, to this
 * number, still waiting for its first provider event. Telnyx may leave the client state off a
 * WebRTC call's `call.initiated` (only a live account can show it); such a call is the API's own.
 */
async function pendingCallMatches(tx: Tx, start: TelnyxOutboundStart): Promise<boolean> {
  const pending = await tx
    .select({ toE164: call.toE164 })
    .from(call)
    .where(
      and(
        eq(call.direction, 'outbound'),
        eq(call.provider, TELNYX),
        isNull(call.providerCallId),
        inArray(call.state, ['queued', 'initiating']),
        gte(call.createdAt, sql`now() - make_interval(secs => ${PENDING_MATCH_SECONDS})`),
      ),
    )
    .limit(20);
  return pending.some((row) => sameDestination(row.toE164, start.to));
}

interface Workspace {
  orgId: string;
  connection: ProviderCredentialRow;
}

/**
 * The workspace whose Telnyx account placed the call: the one whose key verified the delivery
 * (per-connection URL), else the owner of the `from` number. Its connection must be Telnyx and,
 * when Telnyx reports the connection id, the same connection: a spoofed caller id never makes the
 * guard act for, or notify, another workspace.
 */
async function resolveWorkspace(
  ctx: GuardContext,
  start: TelnyxOutboundStart,
): Promise<Workspace | null> {
  const orgId = ctx.connectorOrgId ?? (await orgOfNumber(ctx.db, start.from));
  if (orgId === null) return null;
  const connection = await withTenant(ctx.db, orgId, (tx) => loadConnection(tx));
  if (connection === null || connection.provider !== TELNYX) return null;
  if (
    start.connectionId !== null &&
    connection.connectionId !== null &&
    connection.connectionId !== start.connectionId
  ) {
    return null;
  }
  return { orgId, connection };
}

async function orgOfNumber(db: Database, from: string | null): Promise<string | null> {
  if (from === null) return null;
  const phone = normalizePhone(/^(?:sips?|tel):([^@;]*)/i.exec(from.trim())?.[1] ?? from);
  if (!phone.ok) return null;
  const [route] = await db
    .select({ orgId: providerNumberRoute.organizationId })
    .from(providerNumberRoute)
    .where(and(eq(providerNumberRoute.provider, TELNYX), eq(providerNumberRoute.e164, phone.value)))
    .limit(1);
  return route?.orgId ?? null;
}

type Hangup =
  | { kind: 'hung_up' }
  | { kind: 'already_ended' }
  | { kind: 'refused'; status: number; code: string };

/**
 * Hangs the call up with the workspace's own Telnyx key. A call that already ended counts as done.
 * A 4xx other than 408 and 429 will not succeed on retry, so it is returned as refused; anything
 * else (network, 5xx, 408, 429, an unopenable key) throws so the queue retries.
 */
async function hangUp(
  ctx: GuardContext,
  connection: ProviderCredentialRow,
  callControlId: string,
): Promise<Hangup> {
  const masterKey = ctx.env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKey)) throw new Error('call_guard.no_master_key');
  const secret = await openConnectionSecret(connection, masterKey);
  const built = buildProvider(connection, secret, {
    env: ctx.env,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  if (built.kind !== 'telnyx') throw new Error('call_guard.not_telnyx');
  try {
    await built.provider.endCall(callControlId);
    return { kind: 'hung_up' };
  } catch (error) {
    if (!(error instanceof ProviderApiError)) throw error;
    if (error.status === 422 && error.code === CALL_ALREADY_ENDED) return { kind: 'already_ended' };
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { kind: 'refused', status: error.status, code: error.code };
    }
    throw error;
  }
}

/** Notification copy; no phone number other than the emergency short code itself. */
export function blockedNotice(
  reason: BlockReason,
  code: string | null,
): { title: string; body: string } {
  if (reason === 'emergency') {
    return {
      title: `A call to ${code ?? 'an emergency number'} was blocked: KNOQRA can't place emergency calls.`,
      body: EMERGENCY_CALL_MESSAGE,
    };
  }
  return {
    title: 'A call that did not start in KNOQRA was ended.',
    body: 'Calls on this workspace’s Telnyx connection are placed from the KNOQRA dialer.',
  };
}

/**
 * Records the block once, in one tenant transaction: marks the raw event processed, then writes
 * the audit row and a notification to each owner. The raw-event update is the gate: when the
 * webhook fast path and the queue both get here, only the first writes. Returns whether it wrote.
 */
async function recordBlocked(
  ctx: GuardContext,
  orgId: string,
  start: TelnyxOutboundStart,
  reason: BlockReason,
  code: string | null,
  hangup: 'hung_up' | 'already_ended',
): Promise<boolean> {
  return withTenant(ctx.db, orgId, async (tx) => {
    const claimed = await tx
      .update(providerEventRaw)
      .set({ status: 'processed', processedAt: new Date(), parkReason: null })
      .where(
        and(
          eq(providerEventRaw.id, ctx.rawEventId),
          inArray(providerEventRaw.status, ['pending', 'parked']),
        ),
      )
      .returning({ id: providerEventRaw.id });
    if (claimed.length === 0) return false;
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: null,
      action: 'call.blocked',
      entityType: 'call',
      entityId: null,
      outcome: 'denied',
      // Ids and enums only: the emergency short code, never the caller's or callee's number.
      metadata: {
        reason,
        ...(code === null ? {} : { code }),
        provider: TELNYX,
        providerCallId: start.callControlId,
        rawEventId: ctx.rawEventId,
        hangup,
      },
    });
    const owners = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(
        and(
          eq(member.organizationId, orgId),
          sql`'owner' = any(string_to_array(replace(${member.role}, ' ', ''), ','))`,
        ),
      );
    if (owners.length > 0) {
      const notice = blockedNotice(reason, code);
      await tx
        .insert(notification)
        .values(
          owners.map((owner) => ({
            organizationId: orgId,
            userId: owner.userId,
            kind: 'system' as const,
            title: notice.title,
            body: notice.body,
            refType: 'call_blocked',
            refId: null,
            dedupeKey: `call_blocked:${TELNYX}:${start.callControlId}`,
          })),
        )
        .onConflictDoNothing({
          target: [notification.organizationId, notification.userId, notification.dedupeKey],
        });
    }
    return true;
  });
}
