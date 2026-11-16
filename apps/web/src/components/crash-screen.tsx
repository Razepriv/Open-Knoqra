import { Button, ButtonLink, Panel } from '@knoqra/ui';
import { type ErrorComponentProps, Link, useMatch, useRouter } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { reportError } from '../lib/observability/sentry';

export const CRASH_COPY = {
  eyebrow: 'Something broke',
  title: 'This page hit a problem.',
  body: 'It has been noted. Try again, or go back to your desk.',
  retry: 'Try again',
  home: 'Back to your desk',
} as const;

/** The same pill as `ButtonLink variant="ghost"`, for the router's `Link`. */
const ghostLinkClass =
  'inline-flex h-10 cursor-pointer items-center justify-center gap-[7px] whitespace-nowrap rounded-full border border-[color:var(--pillBorder)] bg-transparent px-4 font-semibold text-[color:var(--text)] text-sm leading-none focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2';

export interface CrashScreenProps {
  /** Shows "Try again" when set. */
  onRetry?: () => void;
  /** The "Back to your desk" link. Defaults to a plain link to `/`, which works outside the router. */
  home?: ReactNode;
  /**
   * False when rendered inside a page that already has its `<main>` (the Desk shell), so the
   * screen is a labelled section instead of a second main landmark.
   */
  landmark?: boolean;
}

/**
 * Calm, generic copy: the error itself is never shown, it may hold someone's data. Focus moves to
 * the heading on mount, so keyboard and screen reader users land on the message after the swap.
 */
export function CrashScreen({ onRetry, home, landmark = true }: CrashScreenProps) {
  const Root = landmark ? 'main' : 'section';
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    title.current?.focus();
  }, []);

  return (
    <Root aria-labelledby={titleId} className="flex flex-1 flex-col">
      <Panel className="flex flex-1 flex-col items-start justify-center gap-5 p-6 sm:p-10">
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
          {CRASH_COPY.eyebrow}
        </p>
        <div role="alert" className="flex flex-col gap-3">
          <h1
            id={titleId}
            ref={title}
            tabIndex={-1}
            className="font-[family-name:var(--font-display)] text-[clamp(32px,4.4vw,52px)] leading-none tracking-[-0.03em] outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-4"
          >
            {CRASH_COPY.title}
          </h1>
          <p className="max-w-[46ch] text-[15px] text-[color:var(--muted)] leading-relaxed">
            {CRASH_COPY.body}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {onRetry ? (
            <Button type="button" variant="primary" onClick={onRetry}>
              {CRASH_COPY.retry}
            </Button>
          ) : null}
          {home ?? (
            <ButtonLink variant="ghost" href="/">
              {CRASH_COPY.home}
            </ButtonLink>
          )}
        </div>
      </Panel>
    </Root>
  );
}

/**
 * The router's `defaultErrorComponent`: a loader or render error in one route. Reports the error
 * once (StrictMode re-runs effects; the ref survives that) and retries the route in place.
 */
export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const reported = useRef<unknown>(null);
  // Pages under the Desk layout render inside the shell's <main>.
  const routeId: string = useMatch({
    strict: false,
    select: (match): string => match.routeId ?? '',
  });
  const insideShell = routeId.startsWith('/_app/');

  useEffect(() => {
    if (reported.current === error) return;
    reported.current = error;
    reportError(error, { where: 'route' });
  }, [error]);

  const retry = () => {
    reset();
    // A failed reload must not become an unhandled rejection; it is reported like the original.
    router.invalidate().catch((failure: unknown) => reportError(failure, { where: 'route' }));
  };

  return (
    <CrashScreen
      onRetry={retry}
      landmark={!insideShell}
      home={
        <Link to="/" className={ghostLinkClass}>
          {CRASH_COPY.home}
        </Link>
      }
    />
  );
}
