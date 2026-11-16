import { describe, expect, it } from 'vitest';
import type { WebObservabilityConfig } from './observability/config';
import {
  browserChecks,
  canViewSystemStatus,
  clockTime,
  OVERALL_HEADLINE,
  STATUS_COPY,
  systemStatusQueryKey,
} from './system-status';

const EMPTY: WebObservabilityConfig = { sentry: null, posthog: null, issues: [] };

describe('canViewSystemStatus', () => {
  it('lets owners and admins see the section', () => {
    expect(canViewSystemStatus('owner')).toBe(true);
    expect(canViewSystemStatus('admin')).toBe(true);
  });

  it('hides it from members and from an unknown role', () => {
    expect(canViewSystemStatus('member')).toBe(false);
    expect(canViewSystemStatus(undefined)).toBe(false);
    expect(canViewSystemStatus('')).toBe(false);
    expect(canViewSystemStatus('Owner')).toBe(false);
  });
});

describe('browserChecks', () => {
  it('reads both Desk integrations as off when nothing is configured', () => {
    const rows = browserChecks(EMPTY);
    expect(rows.map((row) => row.id)).toEqual(['web_sentry', 'web_posthog']);
    expect(rows.map((row) => row.label)).toEqual(['Sentry (Desk)', 'PostHog (Desk)']);
    expect(rows.map((row) => row.status)).toEqual(['off', 'off']);
    expect(rows[0]?.detail).toBe('VITE_SENTRY_DSN is not set');
    expect(rows[1]?.detail).toBe('VITE_POSTHOG_KEY is not set');
  });

  it('reads a configured integration as on', () => {
    const rows = browserChecks({
      sentry: {
        dsn: 'https://public@o1.ingest.example.test/42',
        release: null,
        environment: 'production',
        tracesSampleRate: 0.05,
      },
      posthog: { key: 'phc_test', host: 'https://us.i.posthog.com' },
      issues: [],
    });
    expect(rows.map((row) => [row.status, row.detail])).toEqual([
      ['ok', 'On'],
      ['ok', 'On'],
    ]);
  });

  it('names the invalid key and its reason, never a value', () => {
    const rows = browserChecks({
      ...EMPTY,
      issues: [
        { key: 'VITE_SENTRY_DSN', reason: 'not a valid DSN' },
        { key: 'VITE_POSTHOG_HOST', reason: 'must be an https URL' },
      ],
    });
    expect(rows.map((row) => [row.status, row.detail])).toEqual([
      ['off', 'VITE_SENTRY_DSN: not a valid DSN'],
      ['off', 'VITE_POSTHOG_HOST: must be an https URL'],
    ]);
  });

  it('does not let a sample-rate issue turn Sentry off', () => {
    const rows = browserChecks({
      sentry: {
        dsn: 'https://public@o1.ingest.example.test/42',
        release: null,
        environment: 'production',
        tracesSampleRate: 0.05,
      },
      posthog: null,
      issues: [
        { key: 'VITE_SENTRY_TRACES_SAMPLE_RATE', reason: 'must be a number between 0 and 1' },
      ],
    });
    expect(rows[0]?.status).toBe('ok');
  });
});

describe('STATUS_COPY', () => {
  it('covers every check status with a label and a token colour', () => {
    expect(Object.keys(STATUS_COPY).sort()).toEqual(['degraded', 'down', 'off', 'ok']);
    expect(STATUS_COPY.ok).toEqual({ label: 'OK', dot: 'var(--dot-ok)' });
    expect(STATUS_COPY.degraded).toEqual({ label: 'Degraded', dot: 'var(--dot-warn)' });
    expect(STATUS_COPY.down).toEqual({ label: 'Down', dot: 'var(--dot-bad)' });
    expect(STATUS_COPY.off).toEqual({ label: 'Off', dot: 'var(--muted)' });
    for (const copy of Object.values(STATUS_COPY)) expect(copy.dot).toMatch(/^var\(--/);
  });

  it('has a headline for every overall status', () => {
    expect(OVERALL_HEADLINE).toEqual({
      ok: 'All systems normal',
      degraded: 'Some systems need attention',
      down: 'A critical system is down',
    });
  });
});

describe('clockTime', () => {
  it('formats a local time as HH:MM:SS', () => {
    expect(clockTime(new Date(2026, 10, 12, 9, 5, 3))).toBe('09:05:03');
    expect(clockTime(new Date(2026, 10, 12, 23, 59, 59))).toBe('23:59:59');
  });
});

describe('systemStatusQueryKey', () => {
  it('is stable', () => {
    expect(systemStatusQueryKey).toEqual(['system-status']);
  });
});
