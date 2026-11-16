import { Button } from '@knoqra/ui';
import { isUnreachable } from '../../lib/api';

// The layout and loading pieces live in a leaf module (the page outline loads with the route tree).
export * from './usage-layout';

export interface BlockErrorProps {
  /** What failed to load, as a noun phrase: "your balances". */
  what: string;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

/** A block's failure: its own offline copy for an unreachable API, else a plain error, both with Retry. */
export function BlockError({ what, error, onRetry, retrying }: BlockErrorProps) {
  const offline = isUnreachable(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-1">
      <p className="font-medium text-[15px]">
        {offline ? "You're offline, or KNOQRA can't be reached." : `We could not load ${what}.`}
      </p>
      <p className="text-[13px] text-[color:var(--muted)]">
        {offline
          ? 'Nothing is lost. Check your connection and retry.'
          : 'Your data is safe. Retry.'}
      </p>
      <Button variant="ghost" onClick={retrying ? undefined : onRetry} aria-busy={retrying}>
        Retry
      </Button>
    </div>
  );
}
