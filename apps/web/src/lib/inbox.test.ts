import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { sendErrorCopy } from './inbox';

describe('sendErrorCopy', () => {
  it('asks the sender to wait when sending is rate limited', () => {
    const error = new ApiError(
      429,
      'Too many requests. Wait a minute and try again.',
      'rate_limited',
    );
    expect(sendErrorCopy(error)).toBe('Too many messages at once. Wait a minute and try again.');
  });

  it("shows the server's reason for a refused send", () => {
    const error = new ApiError(422, 'This conversation is paused.', 'send_paused');
    expect(sendErrorCopy(error)).toBe('This conversation is paused.');
  });

  it('falls back for any other failure', () => {
    expect(sendErrorCopy(new ApiError(500, 'boom', 'internal_error'))).toBe(
      'We could not send this message. Try again.',
    );
    expect(sendErrorCopy(new Error('offline'))).toBe('We could not send this message. Try again.');
  });
});
