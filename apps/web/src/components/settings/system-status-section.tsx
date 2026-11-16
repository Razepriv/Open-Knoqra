import { Button, Reveal } from '@knoqra/ui';
import { type Ref, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { track } from '../../lib/observability/analytics';
import { webObservability } from '../../lib/observability/config';
import {
  browserChecks,
  type CheckResultLike,
  type CheckStatus,
  clockTime,
  OVERALL_HEADLINE,
  STATUS_COPY,
  type SystemHealth,
  useSystemStatus,
} from '../../lib/system-status';
import { FormAlert } from '../form-alert';
import { SettingsSection } from './section';
import {
  SYSTEM_STATUS_ROW_CLASS as ROW_CLASS,
  SYSTEM_STATUS_SECTION,
  SystemStatusSkeleton,
} from './system-status-skeleton';

const BROWSER_CHECKS = browserChecks(webObservability);

const LIST_HEADING_CLASS =
  'font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]';
const META_CLASS =
  'font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] leading-snug';

type View = 'loading' | 'error' | 'report';

/**
 * Moves focus to the newly shown primary button ("Refresh" or "Try again") when the section
 * settles on a new error or report view, but only if focus was inside the section when the old
 * view went away: the swap unmounts the focused button, which would drop focus to the page body.
 * A retry from the error state passes through the skeleton (TanStack Query resets a data-less
 * error query to pending), so the focus is read when a settled view is left, not on arrival.
 * The first load never takes focus, and focus elsewhere on the page is never stolen.
 */
function useFocusOnSwap(view: View) {
  const containerRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const shownView = useRef(view);
  const settledView = useRef<View | null>(view === 'loading' ? null : view);
  const focusWasInside = useRef(false);
  if (view !== shownView.current && shownView.current !== 'loading') {
    // Read during render, before the commit removes the old (possibly focused) button.
    focusWasInside.current = containerRef.current?.contains(document.activeElement) ?? false;
  }
  useEffect(() => {
    if (view === shownView.current) return;
    shownView.current = view;
    if (view === 'loading') return;
    const hadSettled = settledView.current !== null;
    settledView.current = view;
    if (hadSettled && focusWasInside.current) primaryRef.current?.focus();
    focusWasInside.current = false;
  }, [view]);
  return { containerRef, primaryRef };
}

/** Health of this KNOQRA server and of this browser's own integrations, for owners and admins. */
export function SystemStatusSection() {
  const status = useSystemStatus();
  // Bumped after each successful refresh; the keyed text re-mounts so it is announced every time.
  const [updates, setUpdates] = useState(0);
  // A Refresh the user pressed that failed shows the error (and Try again). A background refetch
  // that fails, offline for one, keeps the last report: the OfflineBanner says why.
  const [refreshFailed, setRefreshFailed] = useState(false);
  const view: View = status.isPending
    ? 'loading'
    : status.data === undefined || refreshFailed
      ? 'error'
      : 'report';
  const { containerRef, primaryRef } = useFocusOnSwap(view);
  const forbidden = status.error instanceof ApiError && status.error.code === 'forbidden';

  const retry = async () => {
    const result = await status.refetch();
    if (!result.isSuccess) return;
    setRefreshFailed(false);
    setUpdates((count) => count + 1);
  };

  const refresh = async () => {
    if (status.isFetching) return;
    const result = await status.refetch();
    setRefreshFailed(!result.isSuccess);
    if (!result.isSuccess) return;
    track('system_status_refreshed', { status: result.data.status });
    setUpdates((count) => count + 1);
  };

  return (
    <SettingsSection {...SYSTEM_STATUS_SECTION}>
      <div ref={containerRef}>
        <Reveal loading={status.isPending}>
          {status.isPending ? (
            <SystemStatusSkeleton />
          ) : view === 'error' || status.data === undefined ? (
            <StatusError
              forbidden={forbidden}
              onRetry={() => void retry()}
              retrying={status.isFetching}
              primaryRef={primaryRef}
            />
          ) : (
            <StatusReport
              report={status.data}
              refreshing={status.isFetching}
              onRefresh={() => void refresh()}
              primaryRef={primaryRef}
            />
          )}
        </Reveal>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {updates > 0 ? <span key={updates}>System status updated</span> : null}
      </p>
    </SettingsSection>
  );
}

interface StatusErrorProps {
  forbidden: boolean;
  onRetry: () => void;
  retrying: boolean;
  primaryRef: Ref<HTMLButtonElement>;
}

const ERROR_COPY = 'We could not check system status. The API or database may be down.';
const FORBIDDEN_COPY = 'Only workspace owners and admins can see system status.';

function StatusError({ forbidden, onRetry, retrying, primaryRef }: StatusErrorProps) {
  return (
    <div className="flex flex-col items-start gap-3">
      <FormAlert message={forbidden ? FORBIDDEN_COPY : ERROR_COPY} />
      {/* aria-disabled, not disabled, so keyboard focus stays on the button while retrying. */}
      <Button
        ref={primaryRef}
        variant="ghost"
        onClick={retrying ? undefined : onRetry}
        aria-disabled={retrying}
        aria-busy={retrying}
      >
        Try again
      </Button>
    </div>
  );
}

interface StatusReportProps {
  report: SystemHealth;
  refreshing: boolean;
  onRefresh: () => void;
  primaryRef: Ref<HTMLButtonElement>;
}

function StatusReport({ report, refreshing, onRefresh, primaryRef }: StatusReportProps) {
  const checkedAt = new Date(report.checkedAt);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-3 font-medium text-[17px] leading-snug">
          <Dot status={report.status} size="size-3" />
          {OVERALL_HEADLINE[report.status]}
        </p>
        <p className={META_CLASS}>
          Checked{' '}
          <time dateTime={report.checkedAt}>
            {Number.isNaN(checkedAt.getTime()) ? report.checkedAt : clockTime(checkedAt)}
          </time>
          {report.release ? ` · Release ${report.release}` : ''} · {report.environment}
        </p>
      </div>
      <CheckList title="Server checks" checks={report.checks} />
      <CheckList title="This browser" checks={BROWSER_CHECKS} />
      {/* aria-disabled, not disabled, so keyboard focus stays on the button while checking. */}
      <Button
        ref={primaryRef}
        variant="ghost"
        className="self-start"
        onClick={refreshing ? undefined : onRefresh}
        aria-disabled={refreshing}
        aria-busy={refreshing}
      >
        {refreshing ? 'Checking…' : 'Refresh'}
      </Button>
    </div>
  );
}

function CheckList({ title, checks }: { title: string; checks: readonly CheckResultLike[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className={LIST_HEADING_CLASS}>{title}</h3>
      {/* role="list" restores list semantics that Safari drops when list-style is none. */}
      {/* biome-ignore lint/a11y/noRedundantRoles: see above */}
      <ul role="list" aria-label={title} className="flex flex-col gap-2">
        {checks.map((check) => (
          <li key={check.id} className={ROW_CLASS}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="font-medium text-[14px] leading-none">{check.label}</span>
              <StatusLabel status={check.status} />
            </div>
            <p className={`${META_CLASS} [overflow-wrap:anywhere]`}>{check.detail}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusLabel({ status }: { status: CheckStatus }) {
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-2 rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[10px] py-[5px] font-medium text-[12px] text-[color:var(--text)] leading-none"
    >
      <Dot status={status} />
      {STATUS_COPY[status].label}
    </span>
  );
}

function Dot({ status, size = 'size-2' }: { status: CheckStatus; size?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${size}`}
      style={{ background: STATUS_COPY[status].dot }}
    />
  );
}
