import { describe, expect, it } from 'vitest';
import { profileSaveErrorMessage } from './profile';

describe('profileSaveErrorMessage', () => {
  it('says nothing was changed when the first part fails', () => {
    expect(profileSaveErrorMessage('name', false)).toBe(
      "We couldn't save your name. Nothing was changed.",
    );
    expect(profileSaveErrorMessage('timezone', false)).toBe(
      "We couldn't save your time zone. Nothing was changed.",
    );
  });

  it('says what did save when only the second part fails', () => {
    expect(profileSaveErrorMessage('timezone', true)).toBe(
      "Your name was saved, but we couldn't save your time zone. Try again.",
    );
  });
});
