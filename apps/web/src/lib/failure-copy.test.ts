import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api';
import { failureMessage } from './failure-copy';

const apiError = (status: number, code = 'internal') => new ApiError(status, 'nope', code);

describe('failureMessage', () => {
  it('says offline when the browser is offline', () => {
    expect(failureMessage(apiError(500), false, 'your tasks')).toBe(
      "You're offline, so we could not load your tasks.",
    );
  });

  it('says offline when no answer came back', () => {
    expect(failureMessage(new TypeError('Failed to fetch'), true, 'this week')).toBe(
      "You're offline, so we could not load this week.",
    );
  });

  it('names the subject for a server error', () => {
    expect(failureMessage(apiError(500), true, "today's numbers")).toBe(
      "We could not load today's numbers.",
    );
  });

  it('says access is missing for a 403', () => {
    expect(failureMessage(apiError(403, 'forbidden'), true, 'your streak')).toBe(
      "You don't have access to your streak.",
    );
  });

  it('keeps a NetworkError as offline', () => {
    expect(failureMessage(new NetworkError(), true, 'your tasks')).toContain("You're offline");
  });
});
