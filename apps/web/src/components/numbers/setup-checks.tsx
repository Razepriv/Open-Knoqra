import { Panel } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { type MicState, useMicPermission } from '../../lib/mic-permission';
import type { CheckStatus } from '../../lib/numbers';
import type { Setup, SetupCheck } from '../../lib/setup';
import { focusRing } from '../../lib/ui-classes';
import { sectionHeading } from '../usage/usage-layout';
import { CHECK_ROW_HEIGHT as ROW_HEIGHT } from './numbers-skeletons';
import { StatusBadge } from './status-icon';

const actionClass = `inline-flex h-[34px] shrink-0 items-center gap-2 rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-medium text-[13px] text-[color:var(--text)] leading-none [box-shadow:var(--pillShadow)] ${focusRing}`;

/** Shared by real and placeholder rows so the page does not shift when checks arrive. */

export interface CheckRow {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  fix: SetupCheck['fix'] | 'mic';
}

/** The browser's own microphone check, shown beside the server's. */
export function micCheck(state: MicState): CheckRow {
  const base = { id: 'mic', title: 'Microphone', fix: null } as const;
  if (state === 'granted') {
    return { ...base, status: 'pass', detail: 'This browser can use your microphone.' };
  }
  if (state === 'denied') {
    return {
      ...base,
      status: 'fail',
      detail: 'Microphone access is blocked for KNOQRA.',
      fix: 'mic',
    };
  }
  if (state === 'unsupported') {
    return {
      ...base,
      status: 'pending',
      detail: "This browser can't report microphone access.",
    };
  }
  return {
    ...base,
    status: 'pending',
    detail: 'KNOQRA has not asked for your microphone yet.',
    fix: { kind: 'wizard', step: 'audio' },
  };
}

function CheckAction({ row }: { row: CheckRow }) {
  const { fix, status } = row;
  if (!fix || status === 'pass') return null;
  if (fix === 'mic') {
    return (
      <Link to="/setup" search={{ step: 'audio' }} className={actionClass}>
        How to allow
      </Link>
    );
  }
  if (fix.kind === 'external') {
    return (
      <a href={fix.href} target="_blank" rel="noopener noreferrer" className={actionClass}>
        {fix.label}
        <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
      </a>
    );
  }
  return (
    <Link to="/setup" search={{ step: fix.step }} className={actionClass}>
      {status === 'fail' ? 'Fix' : 'Continue'}
    </Link>
  );
}

export function SetupChecks({ setup }: { setup: Setup }) {
  const mic = useMicPermission();
  const rows: CheckRow[] = [...setup.checks, micCheck(mic.state)];
  const passing = rows.filter((row) => row.status === 'pass').length;
  return (
    <section aria-labelledby="setup-checks-heading">
      <Panel className="flex flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="setup-checks-heading" className={sectionHeading}>
            Setup checks
          </h2>
          <p
            aria-live="polite"
            className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]"
          >
            {`${passing} of ${rows.length} checks pass`}
          </p>
        </div>
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`${ROW_HEIGHT} flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[20px] bg-[color:var(--cell)] p-4`}
            >
              <div className="w-[92px]">
                <StatusBadge status={row.status} />
              </div>
              <div className="min-w-[200px] flex-1">
                <p className="font-medium text-[15px]">{row.title}</p>
                <p className="text-[13px] text-[color:var(--muted)] leading-snug">{row.detail}</p>
              </div>
              <CheckAction row={row} />
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}
