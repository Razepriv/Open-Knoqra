import { extendCheckAt } from '@knoqra/core';
import type { Env } from '../env';
import type { CallJson } from '../lib/call-json';
import { logger } from '../lib/logger';
import { reportError } from '../observability/report';
import type { CallMeterMessage } from '../queue/messages';

/** Cloudflare Queues' longest delay for one message. */
const MAX_DELAY_SECONDS = 12 * 60 * 60;

/**
 * Sends a meter step to the provider-events queue, delayed until `at`. Best effort: a failure is
 * logged and reported, never thrown, because the stale-call sweep's meter backstop finds any live
 * call whose step never arrived.
 */
export async function scheduleMeterStep(
  env: Pick<Env, 'PROVIDER_EVENTS'>,
  message: CallMeterMessage,
  at: Date,
  now: Date = new Date(),
): Promise<boolean> {
  const delaySeconds = Math.min(
    MAX_DELAY_SECONDS,
    Math.max(0, Math.ceil((at.getTime() - now.getTime()) / 1000)),
  );
  try {
    await env.PROVIDER_EVENTS.send(message, delaySeconds > 0 ? { delaySeconds } : undefined);
    return true;
  } catch (error) {
    logger.error('call_meter.schedule_failed', {
      orgId: message.orgId,
      callId: message.callId,
      step: message.step,
      error,
    });
    reportError(error, { where: 'call_meter' });
    return false;
  }
}

/**
 * Plans the first extension when a call that holds minutes is answered: a minute before its first
 * block runs out. Calls without a hold (an inbound call nobody answered in KNOQRA) are not metered.
 */
export async function startCallMeter(
  env: Pick<Env, 'PROVIDER_EVENTS'>,
  orgId: string,
  json: CallJson,
  now: Date = new Date(),
): Promise<void> {
  if (json.state !== 'connected' || json.answeredAt === null || json.paidUntil === null) return;
  const answeredAt = new Date(json.answeredAt);
  const paidMinutes = Math.round((Date.parse(json.paidUntil) - answeredAt.getTime()) / 60_000);
  if (paidMinutes <= 0) return;
  await scheduleMeterStep(
    env,
    { kind: 'call.meter', step: 'extend', orgId, callId: json.id, paidMinutes },
    extendCheckAt(answeredAt, paidMinutes),
    now,
  );
}
