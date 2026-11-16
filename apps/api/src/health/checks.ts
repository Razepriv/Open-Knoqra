import { cronRun, EXPECTED_MIGRATIONS, migrationStatus, providerEventRaw } from '@knoqra/db';
import { and, count, inArray, isNull, min, sql } from 'drizzle-orm';
import { realProvidersOn } from '../connectors/registry';
import type { CronJob } from '../cron/jobs';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { type ConfigIssue, readObservabilityConfig } from '../observability/config';
import type { CheckData, CheckOutcome, HealthCheck, HealthContext } from './types';

/** The oldest unprocessed provider event may wait this long before the queue reads as behind. */
export const QUEUE_LAG_LIMIT_SECONDS = 300;

/**
 * Statuses the pipeline still works on. `dead_lettered` rows also keep `processed_at` null, but
 * they are final: counting them would read the queue as behind forever.
 */
const BACKLOG_STATUSES = ['pending', 'parked'] as const;

export const databaseCheck: HealthCheck = {
  id: 'database',
  label: 'Database',
  critical: true,
  async run({ db }) {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', detail: 'Reachable' };
    } catch (error) {
      logger.warn('health.db_unreachable', { error });
      return { status: 'down', detail: 'Unreachable' };
    }
  },
};

export const migrationsCheck: HealthCheck = {
  id: 'migrations',
  label: 'Migrations',
  critical: false,
  async run({ db }) {
    let status: { applied: number; expected: number };
    try {
      status = await migrationStatus(db);
    } catch (error) {
      // Most likely knoqra_migration_status() is missing: rls.sql has not run on this database.
      logger.warn('health.migration_status_failed', { error });
      return {
        status: 'down',
        detail: 'Could not read migration status',
        data: { applied: null, expected: EXPECTED_MIGRATIONS },
      };
    }
    const { applied, expected } = status;
    const data = { applied, expected };
    if (applied === expected) return { status: 'ok', detail: `Up to date (${applied})`, data };
    if (applied < expected) {
      return { status: 'degraded', detail: `${expected - applied} pending`, data };
    }
    return { status: 'degraded', detail: 'Database is ahead of this release', data };
  },
};

/** Lag of the provider-event pipeline: rows stored by the webhook but not yet processed. */
export const queueCheck: HealthCheck = {
  id: 'queue',
  label: 'Webhook queue',
  critical: false,
  async run({ env, db, now }) {
    if (!env.PROVIDER_EVENTS) return { status: 'down', detail: 'Queue binding missing' };
    // Served by the partial index on received_at where processed_at is null.
    const [backlog] = await db
      .select({ pending: count(), oldest: min(providerEventRaw.receivedAt) })
      .from(providerEventRaw)
      .where(
        and(
          isNull(providerEventRaw.processedAt),
          inArray(providerEventRaw.status, [...BACKLOG_STATUSES]),
        ),
      );
    const pending = Number(backlog?.pending ?? 0);
    const oldest = backlog?.oldest ? new Date(backlog.oldest) : null;
    const oldestPendingSeconds =
      pending > 0 && oldest
        ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000))
        : null;
    // No "last processed" time: max(processed_at) has no index and would scan the whole table on
    // the single pooled connection.
    const data: CheckData = { pending, oldestPendingSeconds };

    if (oldestPendingSeconds === null) return { status: 'ok', detail: 'Idle', data };
    if (oldestPendingSeconds <= QUEUE_LAG_LIMIT_SECONDS) {
      return { status: 'ok', detail: `${pending} pending, oldest ${oldestPendingSeconds}s`, data };
    }
    const behindMinutes = Math.floor(oldestPendingSeconds / 60);
    return { status: 'degraded', detail: `Processing is behind by ${behindMinutes} min`, data };
  },
};

export interface DurableObjectProbe {
  /** The binding name in wrangler.jsonc. */
  binding: string;
  /** Shown in the detail, for example "Realtime binding missing". */
  label: string;
}

function isNamespace(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { idFromName?: unknown }).idFromName === 'function'
  );
}

/** Each probe's binding must be a Durable Object namespace. Nothing is instantiated. */
export function durableObjectsCheck(probes: readonly DurableObjectProbe[]): HealthCheck {
  return {
    id: 'durable_objects',
    label: 'Durable Objects',
    critical: false,
    async run({ env }) {
      if (probes.length === 0) return { status: 'off', detail: 'None configured yet' };
      const bindings = env as unknown as Record<string, unknown>;
      const missing = probes.find((probe) => !isNamespace(bindings[probe.binding]));
      if (missing) return { status: 'down', detail: `${missing.label} binding missing` };
      return { status: 'ok', detail: `${probes.length} bound` };
    },
  };
}

interface CronRow {
  lastStartedAt: Date;
  lastFinishedAt: Date | null;
  lastStatus: string;
}

/** A job mid-run has no finish time yet, so its start counts as its latest run. */
function lastRunAt(row: CronRow | undefined): Date | null {
  if (!row) return null;
  return row.lastFinishedAt ?? (row.lastStatus === 'running' ? row.lastStartedAt : null);
}

function cronProblem(job: CronJob, row: CronRow | undefined, now: Date): string | null {
  const last = lastRunAt(row);
  const limitMs = 2 * job.maxIntervalMinutes * 60_000;
  if (!last || now.getTime() - last.getTime() > limitMs) return `${job.name} missed its schedule`;
  if (row?.lastStatus === 'error') return `${job.name} failed on its last run`;
  return null;
}

/** Reads `cron_run` for every registered job. Late or failed jobs make the check degraded. */
export function cronCheck(jobs: readonly CronJob[]): HealthCheck {
  return {
    id: 'cron',
    label: 'Scheduled jobs',
    critical: false,
    async run({ db, now }: HealthContext): Promise<CheckOutcome> {
      if (jobs.length === 0) return { status: 'off', detail: 'No scheduled jobs yet' };
      const rows = await db
        .select({
          name: cronRun.name,
          lastStartedAt: cronRun.lastStartedAt,
          lastFinishedAt: cronRun.lastFinishedAt,
          lastStatus: cronRun.lastStatus,
        })
        .from(cronRun)
        .where(
          inArray(
            cronRun.name,
            jobs.map((job) => job.name),
          ),
        );
      const byName = new Map(rows.map((row) => [row.name, row]));
      const data: CheckData = Object.fromEntries(
        jobs.map((job) => [
          `${job.name}LastRunAt`,
          lastRunAt(byName.get(job.name))?.toISOString() ?? null,
        ]),
      );
      for (const job of jobs) {
        const problem = cronProblem(job, byName.get(job.name), now);
        if (problem) return { status: 'degraded', detail: problem, data };
      }
      const noun = jobs.length === 1 ? 'job' : 'jobs';
      return { status: 'ok', detail: `${jobs.length} ${noun} on schedule`, data };
    },
  };
}

/**
 * Whether this deployment can run Telnyx: real providers on (PROVIDER=connectors, or telnyx), the
 * platform webhook key and the master key that opens each workspace's sealed provider secret.
 * Platform-level only: whether a given workspace has saved a connection is tenant data and stays
 * out of the health report.
 */
export function telnyxConfigured(
  env: Pick<Env, 'PROVIDER' | 'TELNYX_PUBLIC_KEY' | 'CREDENTIALS_MASTER_KEY'>,
): boolean {
  return (
    realProvidersOn(env) && Boolean(env.TELNYX_PUBLIC_KEY) && Boolean(env.CREDENTIALS_MASTER_KEY)
  );
}

export const providerCheck: HealthCheck = {
  id: 'provider',
  label: 'Provider',
  critical: false,
  async run({ env }) {
    // Mirrors webhooks.ts: the fake provider is live outside production when its secret is set.
    const data = { fakeProvider: Boolean(env.FAKE_WEBHOOK_SECRET) && env.APP_ENV !== 'production' };
    if (telnyxConfigured(env)) return { status: 'ok', detail: 'Connected', data };
    return { status: 'off', detail: 'Not connected', data };
  },
};

/** Same rule as emailSenderFor: Resend needs both RESEND_API_KEY and EMAIL_FROM. */
export const emailCheck: HealthCheck = {
  id: 'email',
  label: 'Email',
  critical: false,
  async run({ env }) {
    if (env.RESEND_API_KEY && env.EMAIL_FROM) return { status: 'ok', detail: 'Resend configured' };
    if (env.APP_ENV === 'development') {
      return { status: 'off', detail: 'Development: mail goes to the log' };
    }
    const missing = [
      env.RESEND_API_KEY ? null : 'RESEND_API_KEY',
      env.EMAIL_FROM ? null : 'EMAIL_FROM',
    ].filter((key): key is string => key !== null);
    const verb = missing.length === 1 ? 'is' : 'are';
    return { status: 'off', detail: `${missing.join(' and ')} ${verb} not set` };
  },
};

/** Key name plus the fixed reason from the config reader. Never the value. */
function issueDetail(issue: ConfigIssue): string {
  return `${issue.key}: ${issue.reason}`;
}

export const sentryCheck: HealthCheck = {
  id: 'sentry',
  label: 'Sentry',
  critical: false,
  async run({ env }) {
    const config = readObservabilityConfig(env);
    if (config.sentry) {
      const { release } = config.sentry;
      return { status: 'ok', detail: release ? `On (release ${release})` : 'On' };
    }
    const issue = config.issues.find((candidate) => candidate.key === 'SENTRY_DSN');
    return { status: 'off', detail: issue ? issueDetail(issue) : 'SENTRY_DSN is not set' };
  },
};

export const posthogCheck: HealthCheck = {
  id: 'posthog',
  label: 'PostHog',
  critical: false,
  async run({ env }) {
    const config = readObservabilityConfig(env);
    if (config.posthog) return { status: 'ok', detail: 'On' };
    const issue = config.issues.find((candidate) => candidate.key.startsWith('POSTHOG_'));
    return { status: 'off', detail: issue ? issueDetail(issue) : 'POSTHOG_KEY is not set' };
  },
};
