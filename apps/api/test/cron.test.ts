import { env } from 'cloudflare:workers';
import { cronRun, organization } from '@knoqra/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_JOBS, type CronJob } from '../src/cron/jobs';
import { forEachOrganization, handleScheduled } from '../src/cron/run';
import { setErrorReporter } from '../src/observability/report';
import { withAdminDb } from './helpers';

const EVERY_FIVE = '*/5 * * * *';

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function controller(cron: string): ScheduledController {
  return { cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController;
}

const names: string[] = [];

function job(label: string, run: CronJob['run']): CronJob {
  const name = `test-${label}-${crypto.randomUUID().slice(0, 8)}`;
  names.push(name);
  return { name, cron: EVERY_FIVE, maxIntervalMinutes: 10, run };
}

function readRun(name: string) {
  return withAdminDb(async (db) => {
    const rows = await db.select().from(cronRun).where(eq(cronRun.name, name));
    return rows[0];
  });
}

afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (names.length === 0) return;
  await withAdminDb((db) => db.delete(cronRun).where(inArray(cronRun.name, names)));
});

describe('handleScheduled', () => {
  it('runs every job on the expression, each recorded, even after one fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('first job exploded');
    const first = job('first', async () => {
      throw failure;
    });
    const secondRun = vi.fn(async () => undefined);
    const second = job('second', secondRun);
    await expect(handleScheduled(controller(EVERY_FIVE), env, ctx, [first, second])).rejects.toBe(
      failure,
    );
    expect(secondRun).toHaveBeenCalledTimes(1);
    expect((await readRun(first.name))?.lastStatus).toBe('error');
    expect((await readRun(second.name))?.lastStatus).toBe('ok');
  });

  it('records a successful run as ok with its duration', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = vi.fn(async () => undefined);
    const okJob = job('ok', run);

    await handleScheduled(controller(EVERY_FIVE), env, ctx, [okJob]);

    expect(run).toHaveBeenCalledTimes(1);
    const row = await readRun(okJob.name);
    expect(row?.lastStatus).toBe('ok');
    expect(row?.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(row?.lastFinishedAt).toBeInstanceOf(Date);
  });

  it('records a failed run as error, reports it and rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const failure = new Error('job exploded');
    const failingJob = job('fail', async () => {
      throw failure;
    });

    await expect(handleScheduled(controller(EVERY_FIVE), env, ctx, [failingJob])).rejects.toBe(
      failure,
    );

    const row = await readRun(failingJob.name);
    expect(row?.lastStatus).toBe('error');
    expect(row?.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(reporter).toHaveBeenCalledWith(failure, expect.objectContaining({ where: 'cron' }));
  });

  it('logs and reports a connection failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const run = vi.fn(async () => undefined);
    // No DATABASE_URL and no Hyperdrive binding: resolving the connection string throws.
    const broken = {
      ...env,
      DATABASE_URL: undefined,
      HYPERDRIVE: undefined,
    } as unknown as typeof env;

    await expect(
      handleScheduled(controller(EVERY_FIVE), broken, ctx, [job('broken', run)]),
    ).rejects.toThrow();

    expect(run).not.toHaveBeenCalled();
    expect(reporter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'cron' }),
    );
    expect(errors.mock.calls.some((call) => String(call[0]).includes('cron.failed'))).toBe(true);
  });

  it('logs an unknown cron and writes nothing', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async () => undefined);
    const idle = job('idle', run);

    await expect(
      handleScheduled(controller('0 3 * * *'), env, ctx, [idle]),
    ).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(await readRun(idle.name)).toBeUndefined();
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('cron.unknown') && line.includes('0 3 * * *'))).toBe(
      true,
    );
  });
});

describe('CRON_JOBS', () => {
  it('registers the planned jobs on their crons', () => {
    expect(CRON_JOBS.map((j) => [j.name, j.cron])).toEqual([
      ['stale-call-sweep', '*/5 * * * *'],
      ['balance-poll', '*/30 * * * *'],
      ['ledger-reconcile', '15 3 * * *'],
      ['message-dispatch-sweep', '*/5 * * * *'],
      ['messaging-status', '*/30 * * * *'],
    ]);
  });
});

describe('forEachOrganization', () => {
  it('visits every organization across batches and continues past a failure', async () => {
    const prefix = `zzzz_cron_${crypto.randomUUID().replaceAll('-', '')}`;
    const ids = ['a', 'b', 'c'].map((suffix) => `${prefix}_${suffix}`);
    await withAdminDb((db) =>
      db
        .insert(organization)
        .values(ids.map((id) => ({ id, name: id, slug: id, createdAt: new Date() }))),
    );
    const visited: string[] = [];
    try {
      await withAdminDb((db) =>
        forEachOrganization(
          db,
          async (orgId) => {
            visited.push(orgId);
            if (orgId === ids[0]) throw new Error('org failed');
          },
          1,
          { afterId: prefix },
        ),
      );
    } finally {
      await withAdminDb((db) => db.delete(organization).where(inArray(organization.id, ids)));
    }
    expect(visited).toEqual(ids);
    expect(new Set(visited).size).toBe(visited.length);
  });
});
