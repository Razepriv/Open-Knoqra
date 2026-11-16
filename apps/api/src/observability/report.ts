import { currentLogContext, logger } from '../lib/logger';

/** Where an error was caught: 'http' (app.onError), 'queue' (consumer) or 'cron' (scheduled). */
export interface ErrorContext {
  requestId?: string;
  where: string;
}

export type ErrorReporter = (error: unknown, context: ErrorContext) => void;

let reporter: ErrorReporter | null = null;

/** Installs the sink for caught errors (Sentry when configured). `null` restores the no-op. */
export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn;
}

/**
 * Sends an error that was caught and handled (so no wrapper sees it) to the error reporter.
 * A no-op until a reporter is installed, and never throws: reporting must not turn a handled
 * error into an unhandled one. The request id defaults to the one in the log context.
 */
export function reportError(error: unknown, context?: ErrorContext): void {
  if (!reporter) return;
  const requestId = context?.requestId ?? currentLogContext().requestId;
  const full: ErrorContext = {
    where: context?.where ?? 'unknown',
    ...(requestId === undefined ? {} : { requestId }),
  };
  try {
    reporter(error, full);
  } catch (failure) {
    logger.warn('observability.report_failed', { where: full.where, error: failure });
  }
}
