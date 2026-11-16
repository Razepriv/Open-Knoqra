import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  createUnauthorizedHandler,
  isUnauthorized,
  isUnreachable,
  NetworkError,
  networkAwareFetch,
  safeNext,
  throwIfFailed,
} from './api';

function fakeRouter(path = '/contacts', search = '') {
  return {
    navigate: vi.fn(() => Promise.resolve()),
    state: { location: { pathname: path, searchStr: search } },
  };
}

describe('401 handler', () => {
  it('sends the user to sign-in with the page they were on, and clears the cache', () => {
    const router = fakeRouter('/contacts', '?q=ana');
    const clear = vi.fn();
    createUnauthorizedHandler(router, { clear })(new ApiError(401, 'Sign in required.'));
    expect(clear).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/sign-in',
      search: { next: '/contacts?q=ana', expired: true },
    });
  });

  it('ignores errors that are not a 401', () => {
    const router = fakeRouter();
    const clear = vi.fn();
    const handle = createUnauthorizedHandler(router, { clear });
    handle(new ApiError(500, 'Boom.'));
    handle(new TypeError('Failed to fetch'));
    expect(router.navigate).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('does not loop when already on sign-in', () => {
    const router = fakeRouter('/sign-in');
    createUnauthorizedHandler(router, { clear: vi.fn() })(new ApiError(401, 'Nope.'));
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('omits next when the user was on the home page', () => {
    const router = fakeRouter('/');
    createUnauthorizedHandler(router, { clear: vi.fn() })(new ApiError(401, 'Nope.'));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/sign-in', search: { expired: true } });
  });

  it('navigates once for a burst of 401s', () => {
    const router = fakeRouter('/contacts');
    const handle = createUnauthorizedHandler(router, { clear: vi.fn() });
    handle(new ApiError(401, 'Nope.'));
    handle(new ApiError(401, 'Nope.'));
    expect(router.navigate).toHaveBeenCalledOnce();
  });
});

describe('error classification', () => {
  it('knows a 401', () => {
    expect(isUnauthorized(new ApiError(401, 'x'))).toBe(true);
    expect(isUnauthorized(new ApiError(403, 'x'))).toBe(false);
    expect(isUnauthorized(new Error('x'))).toBe(false);
  });

  it('treats network failures and 5xx as unreachable, not signed out', () => {
    expect(isUnreachable(new NetworkError())).toBe(true);
    expect(isUnreachable(new ApiError(503, 'x'))).toBe(true);
    expect(isUnreachable(new ApiError(502, 'x'))).toBe(true);
    expect(isUnreachable(new ApiError(401, 'x'))).toBe(false);
    expect(isUnreachable(new ApiError(404, 'x'))).toBe(false);
  });

  it('does not mistake a programming TypeError for an outage', () => {
    expect(
      isUnreachable(new TypeError("Cannot read properties of undefined (reading 'user')")),
    ).toBe(false);
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(false);
    expect(isUnreachable(new Error('boom'))).toBe(false);
  });
});

describe('networkAwareFetch', () => {
  const request = new Request('http://localhost/api/v1/me');

  it('passes responses through untouched, whatever the status', async () => {
    const response = new Response('{}', { status: 503 });
    const wrapped = networkAwareFetch(() => Promise.resolve(response));
    await expect(wrapped(request)).resolves.toBe(response);
  });

  it('turns a fetch failure into a NetworkError', async () => {
    const wrapped = networkAwareFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(wrapped(request)).rejects.toBeInstanceOf(NetworkError);
  });

  it('leaves an aborted request alone', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const wrapped = networkAwareFetch(() => Promise.reject(abort));
    await expect(wrapped(request)).rejects.toBe(abort);
  });
});

describe('throwIfFailed', () => {
  it('returns the data envelope content on success', () => {
    expect(throwIfFailed({ data: { data: { id: 1 } }, response: { status: 200 } }, 'x')).toEqual({
      id: 1,
    });
  });

  it('throws an ApiError carrying the HTTP status and server message', () => {
    expect(() =>
      throwIfFailed(
        { error: { error: { message: 'Sign in required.' } }, response: { status: 401 } },
        'fallback',
      ),
    ).toThrowError(expect.objectContaining({ status: 401, message: 'Sign in required.' }));
  });

  it('carries the machine-readable error code so callers can choose their own copy', () => {
    expect(() =>
      throwIfFailed(
        {
          error: { error: { code: 'duplicate_contact', message: 'Exists.' } },
          response: { status: 409 },
        },
        'fallback',
      ),
    ).toThrowError(expect.objectContaining({ status: 409, code: 'duplicate_contact' }));
  });

  it('uses the fallback message when the body has none', () => {
    expect(() => throwIfFailed({ response: { status: 500 } }, 'fallback')).toThrowError(
      expect.objectContaining({ status: 500, message: 'fallback' }),
    );
  });
});

describe('safeNext', () => {
  it.each([
    ['/contacts', '/contacts'],
    ['/contacts?q=ana', '/contacts?q=ana'],
    ['//evil.test', undefined],
    [`/${String.fromCharCode(9)}/evil.test`, undefined],
    [`/${String.fromCharCode(10)}/evil.test`, undefined],
    [`/a${String.fromCharCode(0)}`, undefined],
    [`/${String.fromCharCode(92)}evil.test`, undefined],
    ['https://evil.test', undefined],
    ['javascript:alert(1)', undefined],
    ['/sign-in', undefined],
    ['', undefined],
    [undefined, undefined],
    [42, undefined],
  ])('safeNext(%j) is %j', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});
