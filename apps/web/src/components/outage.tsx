import { Button, Panel } from '@knoqra/ui';
import { copy } from '../lib/auth-errors';

export interface OutageStateProps {
  onRetry: () => void;
  /** True while a retry is in flight. */
  retrying?: boolean;
}

/**
 * Shown when KNOQRA's API cannot be reached. The user is not signed out, so nothing redirects.
 * A section, not a main: it shows inside a page that already has one. A layout-level outage, where
 * no shell is drawn, wraps it in its own main.
 */
export function OutageState({ onRetry, retrying = false }: OutageStateProps) {
  return (
    <section aria-labelledby="outage-title" className="flex flex-1 flex-col">
      <Panel className="flex flex-1 flex-col items-start justify-center gap-5 p-6 sm:p-10">
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
          Offline
        </p>
        <div role="alert" className="flex flex-col gap-3">
          <h1
            id="outage-title"
            className="font-[family-name:var(--font-display)] text-[clamp(32px,4.4vw,52px)] leading-none tracking-[-0.03em]"
          >
            {copy.unreachableTitle}
          </h1>
          <p className="max-w-[46ch] text-[15px] text-[color:var(--muted)] leading-relaxed">
            {copy.unreachableBody}
          </p>
        </div>
        {/* aria-disabled, not disabled, so keyboard focus stays on the button while retrying. */}
        <Button
          type="button"
          variant="primary"
          onClick={retrying ? undefined : onRetry}
          aria-disabled={retrying}
          aria-busy={retrying}
        >
          {copy.retry}
        </Button>
      </Panel>
    </section>
  );
}
