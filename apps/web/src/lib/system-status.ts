import type { components } from '@knoqra/api-client';
import { useQuery } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';
import type { ConfigIssue, WebObservabilityConfig } from './observability/config';

export type SystemHealth = components['schemas']['SystemHealth'];
export type CheckResult = components['schemas']['CheckResult'];
export type CheckStatus = CheckResult['status'];
export type OverallStatus = SystemHealth['status'];

/** The fields of a check row the section renders, shared by server and browser checks. */
export type CheckResultLike = Pick<CheckResult, 'id' | 'label' | 'status' | 'detail'>;

/** Same set as the API's SYSTEM_STATUS_ROLES: whoever may load the report sees the section. */
const SYSTEM_STATUS_ROLES: readonly string[] = ['owner', 'admin'];

export function canViewSystemStatus(role: string | undefined): boolean {
  return role !== undefined && SYSTEM_STATUS_ROLES.includes(role);
}

/** Label and dot colour (a design token) for each check status. */
export const STATUS_COPY = {
  ok: { label: 'OK', dot: 'var(--dot-ok)' },
  degraded: { label: 'Degraded', dot: 'var(--dot-warn)' },
  down: { label: 'Down', dot: 'var(--dot-bad)' },
  off: { label: 'Off', dot: 'var(--muted)' },
} as const satisfies Record<CheckStatus, { label: string; dot: string }>;

export const OVERALL_HEADLINE = {
  ok: 'All systems normal',
  degraded: 'Some systems need attention',
  down: 'A critical system is down',
} as const satisfies Record<OverallStatus, string>;

function issueFor(
  config: WebObservabilityConfig,
  keys: readonly string[],
): ConfigIssue | undefined {
  return config.issues.find((issue) => keys.includes(issue.key));
}

/** Off, with the offending key and its reason (never a value), or the missing key. */
function offDetail(issue: ConfigIssue | undefined, missingKey: string): string {
  return issue ? `${issue.key}: ${issue.reason}` : `${missingKey} is not set`;
}

/** The Desk's own integrations, read from this build's config; they never reach the server. */
export function browserChecks(config: WebObservabilityConfig): CheckResultLike[] {
  const sentryIssue = issueFor(config, ['VITE_SENTRY_DSN']);
  const posthogIssue = issueFor(config, ['VITE_POSTHOG_KEY', 'VITE_POSTHOG_HOST']);
  return [
    config.sentry
      ? { id: 'web_sentry', label: 'Sentry (Desk)', status: 'ok', detail: 'On' }
      : {
          id: 'web_sentry',
          label: 'Sentry (Desk)',
          status: 'off',
          detail: offDetail(sentryIssue, 'VITE_SENTRY_DSN'),
        },
    config.posthog
      ? { id: 'web_posthog', label: 'PostHog (Desk)', status: 'ok', detail: 'On' }
      : {
          id: 'web_posthog',
          label: 'PostHog (Desk)',
          status: 'off',
          detail: offDetail(posthogIssue, 'VITE_POSTHOG_KEY'),
        },
  ];
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** A local wall-clock time as HH:MM:SS. */
export function clockTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const systemStatusQueryKey = ['system-status'] as const;

export async function fetchSystemStatus(): Promise<SystemHealth> {
  return throwIfFailed(await api.GET('/api/health/deep'), 'Could not check system status.');
}

/** The deep health report. Always fresh when the section mounts; refreshed only on request. */
export function useSystemStatus() {
  return useQuery({
    queryKey: systemStatusQueryKey,
    queryFn: fetchSystemStatus,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
