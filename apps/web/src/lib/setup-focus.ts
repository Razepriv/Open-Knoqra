import type { SetupStep } from './setup';

/** Focus the step heading when the step changes after first render, so the change is announced. */
export function shouldFocusStepHeading(previous: SetupStep | null, next: SetupStep): boolean {
  return previous !== null && previous !== next;
}
