import { env } from 'cloudflare:workers';
import { type Database, member, providerEventRaw } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '../src/cron/jobs';
import { cronCheck, durableObjectsCheck, telnyxConfigured } from '../src/health/checks';
import { HEALTH_CHECKS } from '../src/health/registry';
import { overallStatus, runHealthChecks } from '../src/health/run';
import type { CheckResult, HealthCheck, HealthContext } from '../src/health/types';
import { get, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

const CHECK_IDS = [
  'database',
  'migrations',
  'queue',
  'durable_objects',
  'cron',
  'provider',
  'email',
  'sentry',
  'posthog',
];

interface Report {
  status: string;
  checkedAt: string;
  release: string | null;
  environment: string;
  checks: CheckResult[];
}

async function deepReport(
  cookie: string,
): Promise<{ status: number; text: string; report: Report }> {
  const r = await get('/api/health/deep', cookie);
  const text = await r.text();
  const body = JSON.parse(text) as { data: Report };
  return { status: r.status, text, report: body.data };
}

function check(report: Report, id: string): CheckResult {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check in the report`);
  return found;
}

function result(id: string, status: CheckResult['status']): CheckResult {
  return { id, label: id, status, detail: '', durationMs: 0, data: null };
}

function fakeCheck(id: string, critical: boolean, run: HealthCheck['run']): HealthCheck {
  return { id, label: id, critical, run };
}

/** Unit tests of the runner never touch the database. */
const noDbContext = (): HealthContext => ({
  env,
  db: undefined as unknown as Database,
  now: new Date(),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/health/deep', () => {
  const insertedEvents: string[] = [];

  afterAll(async () => {
    for (const id of insertedEvents) {
      await withAdminDb((db) => db.delete(providerEventRaw).where(eq(providerEventRaw.id, id)));
    }
  });

  it('answers 401 with the envelope without a session', async () => {
    const r = await get('/api/health/deep');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'unauthenticated', message: 'Sign in to continue.' },
    });
  });

  it('gives an owner the nine checks in order', async () => {
    const cookie = await signUp(uniqueEmail('health-owner'));
    const { status, text, report } = await deepReport(cookie);

    expect(status).toBe(200);
    expect(['ok', 'degraded']).toContain(report.status);
    expect(report.checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(new Date(report.checkedAt).toISOString()).toBe(report.checkedAt);
    expect(report.environment).toBe('test');

    expect(check(report, 'database').status).toBe('ok');
    const migrations = check(report, 'migrations');
    expect(migrations.status).toBe('ok');
    expect(migrations.data?.applied).toBe(migrations.data?.expected);

    // M2's two Durable Object bindings are registered and bound in tests.
    expect(check(report, 'durable_objects')).toMatchObject({ status: 'ok', detail: '2 bound' });
    // The stale-call sweep is registered, but cron triggers never fire under test.
    expect(check(report, 'cron').status).toBe('degraded');
    expect(check(report, 'cron').data).toHaveProperty('stale-call-sweepLastRunAt');
    for (const id of ['provider', 'sentry', 'posthog']) {
      expect(check(report, id).status, id).toBe('off');
    }
    expect(check(report, 'sentry').detail).toContain('SENTRY_DSN');
    expect(check(report, 'provider').data).toEqual({ fakeProvider: true });

    expect(text).not.toContain(env.BETTER_AUTH_SECRET);
    expect(text).not.toContain(env.FAKE_WEBHOOK_SECRET);
  });

  it('refuses a plain member with 403 forbidden', async () => {
    const cookie = await signUp(uniqueEmail('health-member'));
    const me = (await (await get('/api/v1/me', cookie)).json()) as {
      data: { user: { id: string } };
    };
    await withAdminDb((db) =>
      db.update(member).set({ role: 'member' }).where(eq(member.userId, me.data.user.id)),
    );

    const r = await get('/api/health/deep', cookie);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      data: null,
      error: {
        code: 'forbidden',
        message: 'Only workspace owners and admins can see system status.',
      },
    });
  });

  it('reads the queue as degraded when an event waits for 10 minutes', async () => {
    const id = `pe_health_${crypto.randomUUID()}`;
    insertedEvents.push(id);
    await withAdminDb((db) =>
      db.insert(providerEventRaw).values({
        id,
        provider: 'fake',
        externalEventId: id,
        eventType: 'health.test',
        body: {},
        receivedAt: new Date(Date.now() - 10 * 60_000),
      }),
    );

    const cookie = await signUp(uniqueEmail('health-queue'));
    const { report } = await deepReport(cookie);
    const queue = check(report, 'queue');
    expect(queue.status).toBe('degraded');
    expect(queue.detail).toMatch(/^Processing is behind by \d+ min$/);
    expect(queue.data?.pending).toBeGreaterThanOrEqual(1);
    expect(queue.data?.oldestPendingSeconds).toBeGreaterThanOrEqual(600);
    // Only the two values served by the partial index; no full-scan "last processed" time.
    expect(Object.keys(queue.data ?? {}).sort()).toEqual(['oldestPendingSeconds', 'pending']);
    expect(report.status).toBe('degraded');
  });

  it('leaves dead-lettered events out of the queue backlog', async () => {
    const id = `pe_health_${crypto.randomUUID()}`;
    insertedEvents.push(id);
    const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60_000);
    await withAdminDb((db) =>
      db.insert(providerEventRaw).values({
        id,
        provider: 'fake',
        externalEventId: id,
        eventType: 'health.test',
        body: {},
        receivedAt: yearAgo,
        status: 'dead_lettered',
      }),
    );

    const cookie = await signUp(uniqueEmail('health-dlq'));
    const { report } = await deepReport(cookie);
    const oldest = check(report, 'queue').data?.oldestPendingSeconds;
    // Final rows keep processed_at null; a year-old one must not become the oldest pending event.
    expect(oldest === null || Number(oldest) < 300 * 24 * 60 * 60).toBe(true);
  });
});

describe('runHealthChecks', () => {
  it('times a hanging check out as down in under 2.5 s', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const started = Date.now();
    const [hung] = await runHealthChecks(
      [fakeCheck('hung', false, () => new Promise(() => undefined))],
      noDbContext(),
    );
    expect(Date.now() - started).toBeLessThan(2500);
    expect(hung).toMatchObject({ id: 'hung', status: 'down', detail: 'Timed out after 2 s' });
    expect(hung?.data).toBeNull();
  });

  it('reports a throwing check as down', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const [broken] = await runHealthChecks(
      [
        fakeCheck('broken', false, async () => {
          throw new Error('boom');
        }),
      ],
      noDbContext(),
    );
    expect(broken).toMatchObject({ id: 'broken', status: 'down', detail: 'Check failed' });
  });

  it('keeps the order of the checks and their data', async () => {
    const results = await runHealthChecks(
      [
        fakeCheck('a', false, async () => ({ status: 'ok', detail: 'A', data: { n: 1 } })),
        fakeCheck('b', false, async () => ({ status: 'off', detail: 'B' })),
      ],
      noDbContext(),
    );
    expect(results.map((r) => [r.id, r.status, r.data])).toEqual([
      ['a', 'ok', { n: 1 }],
      ['b', 'off', null],
    ]);
  });
});

describe('overallStatus', () => {
  const checks = [
    fakeCheck('core', true, async () => ({ status: 'ok', detail: '' })),
    fakeCheck('extra', false, async () => ({ status: 'ok', detail: '' })),
  ];

  it('is down when a critical check is down', () => {
    expect(overallStatus([result('core', 'down'), result('extra', 'ok')], checks)).toBe('down');
  });

  it('is degraded when a non-critical check is down', () => {
    expect(overallStatus([result('core', 'ok'), result('extra', 'down')], checks)).toBe('degraded');
  });

  it('is degraded when any check is degraded', () => {
    expect(overallStatus([result('core', 'degraded'), result('extra', 'ok')], checks)).toBe(
      'degraded',
    );
  });

  it('is ok when every check is ok or off', () => {
    expect(overallStatus([result('core', 'ok'), result('extra', 'off')], checks)).toBe('ok');
  });
});

describe('registry checks', () => {
  it('lists the nine checks in order, only the database critical', () => {
    expect(HEALTH_CHECKS.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(HEALTH_CHECKS.filter((c) => c.critical).map((c) => c.id)).toEqual(['database']);
  });

  it('cronCheck reads a job that never ran as degraded', async () => {
    const job: CronJob = {
      name: `health-never-ran-${crypto.randomUUID().slice(0, 8)}`,
      cron: '*/5 * * * *',
      maxIntervalMinutes: 5,
      run: async () => undefined,
    };
    const outcome = await withAppDb((db) => cronCheck([job]).run({ env, db, now: new Date() }));
    expect(outcome.status).toBe('degraded');
    expect(outcome.detail).toBe(`${job.name} missed its schedule`);
    expect(outcome.data).toEqual({ [`${job.name}LastRunAt`]: null });
  });

  it('cronCheck is off with no jobs', async () => {
    const outcome = await cronCheck([]).run(noDbContext());
    expect(outcome).toEqual({ status: 'off', detail: 'No scheduled jobs yet' });
  });

  it('durableObjectsCheck reads a missing binding as down', async () => {
    const outcome = await durableObjectsCheck([{ binding: 'NOPE', label: 'Realtime' }]).run(
      noDbContext(),
    );
    expect(outcome).toEqual({ status: 'down', detail: 'Realtime binding missing' });
  });

  it('durableObjectsCheck is off with no probes', async () => {
    const outcome = await durableObjectsCheck([]).run(noDbContext());
    expect(outcome).toEqual({ status: 'off', detail: 'None configured yet' });
  });
});

describe('telnyxConfigured', () => {
  const full = {
    PROVIDER: 'telnyx',
    TELNYX_PUBLIC_KEY: 'pk',
    CREDENTIALS_MASTER_KEY: 'mk',
  } as const;

  it('needs PROVIDER=telnyx, the webhook key and the master key', () => {
    expect(telnyxConfigured(full)).toBe(true);
    expect(telnyxConfigured({ ...full, PROVIDER: 'fake' })).toBe(false);
    expect(telnyxConfigured({ ...full, TELNYX_PUBLIC_KEY: undefined })).toBe(false);
    expect(telnyxConfigured({ ...full, CREDENTIALS_MASTER_KEY: '' })).toBe(false);
  });

  it('accepts PROVIDER=connectors, the newer name for real providers', () => {
    expect(telnyxConfigured({ ...full, PROVIDER: 'connectors' })).toBe(true);
  });
});
