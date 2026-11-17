import { callRoute, withTenant } from '@knoqra/db';
import type { NormalizedCallEvent } from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env';
import { releaseCallLock } from '../lib/call-lock';
import { isUniqueViolation } from '../lib/contact-fields';
import { logger } from '../lib/logger';
import { callBillingOf } from '../lib/pricing';
import { publish } from '../lib/realtime';
import { type Applied, applyToCall, parked } from './call-apply';
import { CALL_ROUTE_PROVIDER_ID_UNIQUE, createInboundCall, inboundOrg } from './call-inbound';
import { startCallMeter } from './call-meter-schedule';
import { FOREIGN_CONNECTION, mayApplyTo } from './connector-guard';
import type { EventHandler, HandlerContext, HandlerResult } from './registry';

export type { VoicemailJson } from './call-apply';

type Route = { kind: 'call'; orgId: string; callId: string } | { kind: 'inbound'; orgId: string };

/**
 * Applies one call event: resolve the route, then in one tenant transaction (the call row locked)
 * log the signal once, move the state forward, settle the reservation on the first terminal
 * transition, write voicemail and timeline rows, and mark the raw event processed. Side effects
 * that must not roll the transaction back (lock release, realtime) run afterwards.
 */
export const handleCallEvent: EventHandler<'call'> = async (ctx, event) => {
  const route = await resolveRoute(ctx, event);
  if (route === null) return { status: 'parked', reason: 'unknown_call' };
  if (!mayApplyTo(ctx, route.orgId)) {
    logger.warn('call.foreign_connection', {
      rawEventId: ctx.rawEventId,
      provider: event.provider,
    });
    return FOREIGN_CONNECTION;
  }
  try {
    return await applyRoute(ctx, event, route);
  } catch (error) {
    // Two first events of one new inbound call raced; the other created it. Re-resolve: the
    // provider call id now routes to the winner's call.
    if (route.kind !== 'inbound' || !isUniqueViolation(error, CALL_ROUTE_PROVIDER_ID_UNIQUE)) {
      throw error;
    }
    logger.debug('call.inbound_create_raced', { rawEventId: ctx.rawEventId });
    const winner = await resolveRoute(ctx, event);
    if (winner?.kind !== 'call') throw error;
    if (!mayApplyTo(ctx, winner.orgId)) return FOREIGN_CONNECTION;
    return applyRoute(ctx, event, winner);
  }
};

async function applyRoute(
  ctx: HandlerContext,
  event: NormalizedCallEvent,
  route: Route,
): Promise<HandlerResult> {
  const applied = await withTenant(ctx.db, route.orgId, async (tx): Promise<Applied> => {
    const callId =
      route.kind === 'call' ? route.callId : await createInboundCall(tx, route.orgId, event);
    if (callId === null) return parked('no_owner');
    return applyToCall(tx, ctx.rawEventId, event, callId, callBillingOf(ctx.env));
  });
  if (applied.kind === 'parked') return { status: 'parked', reason: applied.reason };
  if (applied.kind === 'replay') return { status: 'processed', after: async () => undefined };
  return { status: 'processed', after: () => fanOutApplied(ctx.env, route.orgId, applied) };
}

/**
 * Routing never trusts the payload's organization: a call resolves by its random client state,
 * then by the bound provider call id. Only a new inbound call resolves by organization (see
 * inboundOrg). Queue order is not guaranteed, so any inbound signal may be the first one seen and
 * creates the call; the monotonic state machine then turns a late ring into a no-op.
 */
async function resolveRoute(
  ctx: HandlerContext,
  event: NormalizedCallEvent,
): Promise<Route | null> {
  if (event.clientState !== null) {
    const [byState] = await ctx.db
      .select()
      .from(callRoute)
      .where(eq(callRoute.clientState, event.clientState))
      .limit(1);
    return byState && byState.provider === event.provider
      ? { kind: 'call', orgId: byState.organizationId, callId: byState.callId }
      : null;
  }
  const [byId] = await ctx.db
    .select()
    .from(callRoute)
    .where(
      and(
        eq(callRoute.provider, event.provider),
        eq(callRoute.providerCallId, event.providerCallId),
      ),
    )
    .limit(1);
  if (byId) return { kind: 'call', orgId: byId.organizationId, callId: byId.callId };
  if (event.direction !== 'inbound') return null;
  const orgId = await inboundOrg(ctx.db, ctx.env, event);
  return orgId === null ? null : { kind: 'inbound', orgId };
}

/**
 * Best effort, after commit: no step throws (each logs and swallows). Shared with the stale-call
 * sweep and the mid-call cut-off.
 */
export async function fanOutApplied(
  env: Env,
  orgId: string,
  applied: Extract<Applied, { kind: 'applied' }>,
): Promise<void> {
  if (applied.ended) await releaseCallLock(env, applied.userId, applied.callId);
  await publish(env, orgId, { type: 'call.updated', data: applied.call });
  if (applied.wallet) {
    await publish(env, orgId, { type: 'wallet.updated', data: applied.wallet });
  }
  if (applied.voicemail) {
    await publish(env, orgId, { type: 'voicemail.created', data: applied.voicemail });
  }
  // Answered: plan the first mid-call extension (events/call-meter.ts). Never throws.
  if (applied.transition?.to === 'connected') await startCallMeter(env, orgId, applied.call);
  await runAfterCallApplied(env, orgId, applied);
}

/** The editions' `afterCallApplied` hooks, one after another; an error is logged, never thrown. */
async function runAfterCallApplied(
  env: Env,
  orgId: string,
  applied: Extract<Applied, { kind: 'applied' }>,
): Promise<void> {
  for (const extension of env.EXTENSIONS ?? []) {
    if (!extension.afterCallApplied) continue;
    try {
      await extension.afterCallApplied(env, {
        orgId,
        call: applied.call,
        provider: applied.provider,
        providerCallId: applied.providerCallId,
        transition: applied.transition,
        ended: applied.ended,
      });
    } catch (error) {
      logger.error('call.after_applied_failed', {
        extension: extension.name,
        callId: applied.callId,
        error,
      });
    }
  }
}
