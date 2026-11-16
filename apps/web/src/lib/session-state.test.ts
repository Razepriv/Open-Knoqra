import { describe, expect, it } from 'vitest';
import { classifySession } from './session-state';

const session = { user: { id: 'u1' }, session: { id: 's1' } };

describe('classifySession', () => {
  it('is authenticated when there is a session', () => {
    expect(classifySession({ data: session, error: null })).toEqual({
      status: 'authenticated',
      session,
    });
  });

  it('is unauthenticated when the server answers with no session', () => {
    expect(classifySession({ data: null, error: null })).toEqual({ status: 'unauthenticated' });
  });

  it.each([401])('is unauthenticated on HTTP %i', (status) => {
    expect(classifySession({ data: null, error: { status } })).toEqual({
      status: 'unauthenticated',
    });
  });

  it.each([403, 429, 500, 502, 503, 504, 0])('is unreachable on HTTP %i', (status) => {
    expect(classifySession({ data: null, error: { status } })).toEqual({ status: 'unreachable' });
  });

  it('is unreachable when the error carries no status (network failure)', () => {
    expect(classifySession({ data: null, error: {} })).toEqual({ status: 'unreachable' });
  });

  it('is unreachable when the request throws', () => {
    expect(classifySession(new TypeError('Failed to fetch'))).toEqual({ status: 'unreachable' });
  });
});
