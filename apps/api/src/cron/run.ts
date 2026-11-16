import {
  type CronStatus,
  createDb,
  cronRun,
  type Database,
  type DbHandle,
  organization,
} from '@knoqra/db';
import { asc, gt } from 'drizzle-orm';
import { connectionString, type Env } from '../env';
import { configureLogging, logger } from '../lib/logger';
import { reportError } from '../observability/report';
import { CRON_JOBS, type CronJob } from './jobs';

interface RunRecord {
  lastStartedAt: Date;
  lastFinishedAt: Date | null;
  lastStatus: CronStatus;
  lastDurationMs: number | null;
}

const ORG_BATCH_SIZE = 100;

async function saveRun(db: Database, name: string, record: RunRecord): Promise<void> {
  await db
    .insert(cronRun)
    .values({ name, ...record })
    .onConflictDoUpdate({ target: cronRun.name, set: record });
}

/**
 * Marks the job running, runs it, then records ok or error with the duration. A job error wins
 * over a failure to record it, so the caller always sees the job's own error.
 */
async function runRecorded(
  db: Database,
  job: CronJob,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const startedAt = new Date();
  await saveRun(db, job.name, {
    lastStartedAt: startedAt,
    lastFinishedAt: null,
    lastStatus: 'running',
    lastDurationMs: null,
  });
  let failure: { error: unknown } | null = null;
  try {
    await job.run(env, ctx);
  } catch (error) {
    failure = { error };
  }
  const finishedAt = new Date();
  const finished = saveRun(db, job.name, {
    lastStartedAt: startedAt,
    lastFinishedAt: finishedAt,
    lastStatus: failure ? 'error' : 'ok',
    lastDurationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
  });
  if (!failure) return finished;
  await finished.catch((error: unknown) =>
    logger.warn('cron.record_failed', { name: job.name, error }),
  );
  throw failure.error;
}

/** The core's jobs, then those of the extensions the Worker was built with. */
export function cronJobsOf(env: Pick<Env, 'EXTENSIONS'>): readonly CronJob[] {
  const extra = (env.EXTENSIONS ?? []).flatMap((extension) => extension.cronJobs ?? []);
  return extra.length === 0 ? CRON_JOBS : [...CRON_JOBS, ...extra];
}

/**
 * The Worker's `scheduled` handler. Runs every job (core or extension) on the trigger's cron
 * expression, in order, and records each run in `cron_run` for the health check. A failure is
 * logged, reported and rethrown, so Cloudflare (and Sentry's cron monitor) mark the invocation
 * failed.
 */
export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  jobs: readonly CronJob[] = cronJobsOf(env),
): Promise<void> {
  configureLogging({ appEnv: env.APP_ENV });
  const matching = jobs.filter((candidate) => candidate.cron === controller.cron);
  if (matching.length === 0) {
    logger.warn('cron.unknown', { cron: controller.cron });
    return;
  }
  let handle: DbHandle | null = null;
  let firstError: { error: unknown } | null = null;
  try {
    // Inside the guard: a missing or broken connection setting is a failed run too.
    handle = createDb(connectionString(env));
    for (const job of matching) {
      const started = Date.now();
      try {
        await runRecorded(handle.db, job, env, ctx);
        logger.info('cron.completed', { name: job.name, durationMs: Date.now() - started });
      } catch (error) {
        // One job's failure must not skip the others on the same expression.
        logger.error('cron.failed', { name: job.name, error });
        reportError(error, { where: 'cron' });
        firstError ??= { error };
      }
    }
  } catch (error) {
    logger.error('cron.failed', { name: matching[0]?.name, error });
    reportError(error, { where: 'cron' });
    throw error;
  } finally {
    await handle?.close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
  if (firstError) throw firstError.error;
}

/**
 * Runs `fn` for every organization, paging ids by keyset. A failure for one organization is
 * logged (id and error name only) and the walk continues. `opts.afterId` sets the starting
 * keyset cursor; production callers omit it.
 */
export async function forEachOrganization(
  db: Database,
  fn: (orgId: string) => Promise<void>,
  batchSize: number = ORG_BATCH_SIZE,
  opts?: { afterId?: string },
): Promise<void> {
  let after: string | null = opts?.afterId ?? null;
  for (;;) {
    const page: { id: string }[] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(after === null ? undefined : gt(organization.id, after))
      .orderBy(asc(organization.id))
      .limit(batchSize);
    for (const { id } of page) {
      try {
        await fn(id);
      } catch (error) {
        logger.error('cron.org_failed', {
          orgId: id,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    const last = page.at(-1);
    if (!last || page.length < batchSize) return;
    after = last.id;
  }
}
