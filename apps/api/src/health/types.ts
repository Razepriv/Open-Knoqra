import type { Database } from '@knoqra/db';
import type { Env } from '../env';

/** `off` means "not configured" and never lowers the overall status. */
export const CHECK_STATUSES = ['ok', 'degraded', 'down', 'off'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const OVERALL_STATUSES = ['ok', 'degraded', 'down'] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];

/** Member roles that may read the deep health report (endpoint and Settings section). */
export const SYSTEM_STATUS_ROLES: readonly string[] = ['owner', 'admin'];

/** Coarse values only: booleans, counts, ISO timestamps. Never a secret or tenant data. */
export type CheckData = Record<string, string | number | boolean | null>;

export interface HealthContext {
  env: Env;
  db: Database;
  now: Date;
}

export interface CheckOutcome {
  status: CheckStatus;
  detail: string;
  data?: CheckData;
}

export interface HealthCheck {
  id: string;
  label: string;
  /** A critical check that is `down` makes the whole report `down`. */
  critical: boolean;
  run(ctx: HealthContext): Promise<CheckOutcome>;
}

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
  data: CheckData | null;
}
