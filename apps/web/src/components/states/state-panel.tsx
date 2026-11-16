import { Button, Panel, Reveal } from '@knoqra/ui';
import type { ReactNode } from 'react';
import { queryStateKind, type StateKind } from '../../lib/query-state';
import { useOnline } from '../../lib/use-online';

export interface StatePanelProps {
  kind: StateKind | 'empty';
  title: string;
  body: string;
  action?: ReactNode;
  /** 1 when the state is the whole page (a missing record), else a level under the page's own. */
  headingLevel?: 1 | 2 | 3;
}

const EYEBROW: Record<StatePanelProps['kind'], string> = {
  empty: 'Nothing here yet',
  offline: 'Offline',
  denied: 'No access',
  'not-found': 'Not found',
  error: 'Something went wrong',
};

/**
 * An empty, error, offline, denied or not-found state. Errors are announced as alerts; an empty
 * state is a polite status. It decodes in through `Reveal`.
 */
export function StatePanel({ kind, title, body, action, headingLevel = 2 }: StatePanelProps) {
  const Heading = (['h1', 'h2', 'h3'] as const)[headingLevel - 1] ?? 'h2';
  return (
    <Reveal loading={false} revealOnMount>
      <Panel
        role={kind === 'empty' ? 'status' : 'alert'}
        data-state-kind={kind}
        className="flex flex-col items-start gap-4 p-6 sm:p-8"
      >
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
          {EYEBROW[kind]}
        </p>
        <div className="flex flex-col gap-2">
          <Heading className="font-[family-name:var(--font-display)] text-[clamp(22px,2.6vw,30px)] leading-[1.1] tracking-[-0.02em]">
            {title}
          </Heading>
          <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
            {body}
          </p>
        </div>
        {action}
      </Panel>
    </Reveal>
  );
}

interface Copy {
  title: (subject: string) => string;
  body: (subject: string) => string;
  retry: boolean;
}

const COPY: Record<StateKind, Copy> = {
  offline: {
    title: () => "You're offline",
    body: (subject) => `We could not load ${subject}. Changes will not save until you reconnect.`,
    retry: true,
  },
  denied: {
    title: () => 'No access',
    body: (subject) => `You don't have access to ${subject}.`,
    retry: false,
  },
  'not-found': {
    title: () => 'Not found',
    body: (subject) => `We could not find ${subject}. It may have been removed.`,
    retry: false,
  },
  error: {
    title: (subject) => `We could not load ${subject}.`,
    body: () => 'Something went wrong on our side. Try again in a moment.',
    retry: true,
  },
};

export interface QueryStatePanelProps {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  /** What failed to load, with its article: "your contacts", "this contact". */
  subject: string;
  headingLevel?: 1 | 2 | 3;
}

/** The right state for a failed query, with copy per kind and a Try again button where it helps. */
export function QueryStatePanel({
  error,
  onRetry,
  retrying,
  subject,
  headingLevel,
}: QueryStatePanelProps) {
  const online = useOnline();
  const kind = queryStateKind(error, online);
  const copy = COPY[kind];
  return (
    <StatePanel
      kind={kind}
      title={copy.title(subject)}
      body={copy.body(subject)}
      {...(headingLevel ? { headingLevel } : {})}
      action={
        copy.retry ? (
          // aria-disabled, not disabled, so keyboard focus stays on the button while retrying.
          <Button
            type="button"
            variant="primary"
            onClick={retrying ? undefined : onRetry}
            aria-disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
        ) : undefined
      }
    />
  );
}
