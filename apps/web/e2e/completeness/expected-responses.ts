import type { ExpectedResponse } from './guards';

/**
 * Non-2xx API responses a screen shows on purpose. Each entry needs a `reason` naming the screen
 * copy that explains it. Add an entry only when the page visibly explains the status; an
 * unexplained 4xx or any 5xx fails the page guard.
 */
export const EXPECTED_RESPONSES: readonly ExpectedResponse[] = [];
