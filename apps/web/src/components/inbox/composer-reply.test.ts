import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { sendFailure } from './composer-reply';

describe('sendFailure', () => {
  it('shows a mode refusal and reads the conversation again', () => {
    const failure = sendFailure(new ApiError(422, 'Sending is paused: x.', 'send_paused'));
    expect(failure).toEqual({ message: 'Sending is paused: x.', stale: true });
  });

  it('shows a template refusal without reading the conversation again', () => {
    const failure = sendFailure(
      new ApiError(422, 'This template is archived.', 'validation_error'),
    );
    expect(failure).toEqual({ message: 'This template is archived.', stale: false });
  });

  it("shows the server's spend refusal and never treats it as a stale mode", () => {
    const failure = sendFailure(
      new ApiError(402, 'Not enough credit for this message.', 'spend_blocked'),
    );
    expect(failure).toEqual({ message: 'Not enough credit for this message.', stale: false });
  });

  it('falls back to a generic retry message for anything else', () => {
    expect(sendFailure(new ApiError(500, 'boom', 'internal_error')).stale).toBe(false);
    expect(sendFailure(new Error('network')).message).toBe(
      'We could not send this message. Try again.',
    );
  });
});
