import { queryStateKind } from './query-state';

/**
 * One sentence for a failed load inside a compact panel (Today's widgets, the task list), which keep
 * their own look rather than a full StatePanel. Offline says so; everything else names the subject.
 */
export function failureMessage(error: unknown, online: boolean, subject: string): string {
  switch (queryStateKind(error, online)) {
    case 'offline':
      return `You're offline, so we could not load ${subject}.`;
    case 'denied':
      return `You don't have access to ${subject}.`;
    case 'not-found':
      return `We could not find ${subject}.`;
    default:
      return `We could not load ${subject}.`;
  }
}
