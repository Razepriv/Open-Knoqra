import { logger } from '../lib/logger';
import type { CheckOutcome, CheckResult, HealthCheck, HealthContext, OverallStatus } from './types';

/** Each check's own budget. A check still running at this point counts as `down`. */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

const TIMED_OUT = Symbol('timed out');

async function runOne(
  check: HealthCheck,
  ctx: HealthContext,
  timeoutMs: number,
): Promise<CheckResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  let outcome: CheckOutcome;
  try {
    // Promise.resolve().then: a check that throws synchronously still lands in the catch.
    const raced = await Promise.race([Promise.resolve().then(() => check.run(ctx)), timeout]);
    if (raced === TIMED_OUT) {
      logger.warn('health.check_timed_out', { check: check.id, timeoutMs });
      outcome = { status: 'down', detail: `Timed out after ${timeoutMs / 1000} s` };
    } else {
      outcome = raced;
    }
  } catch (error) {
    logger.error('health.check_failed', { check: check.id, error });
    outcome = { status: 'down', detail: 'Check failed' };
  } finally {
    clearTimeout(timer);
  }
  return {
    id: check.id,
    label: check.label,
    status: outcome.status,
    detail: outcome.detail,
    durationMs: Math.max(0, Date.now() - started),
    data: outcome.data ?? null,
  };
}

/** Runs every check in parallel, each under its own timeout. Never throws; keeps the input order. */
export function runHealthChecks(
  checks: readonly HealthCheck[],
  ctx: HealthContext,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<CheckResult[]> {
  return Promise.all(checks.map((check) => runOne(check, ctx, timeoutMs)));
}

/**
 * `down` if a critical check is down; otherwise `degraded` if any check is degraded or down;
 * otherwise `ok`. `off` never lowers the status.
 */
export function overallStatus(
  results: readonly CheckResult[],
  checks: readonly HealthCheck[],
): OverallStatus {
  const critical = new Set(checks.filter((check) => check.critical).map((check) => check.id));
  if (results.some((r) => r.status === 'down' && critical.has(r.id))) return 'down';
  if (results.some((r) => r.status === 'down' || r.status === 'degraded')) return 'degraded';
  return 'ok';
}
