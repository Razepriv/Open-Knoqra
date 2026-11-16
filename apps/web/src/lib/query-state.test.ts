import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api';
import { queryStateKind } from './query-state';

describe('queryStateKind', () => {
  it('maps a 403 to denied', () => {
    expect(queryStateKind(new ApiError(403, 'no'), true)).toBe('denied');
  });
  it('maps the forbidden code to denied whatever the status', () => {
    expect(queryStateKind(new ApiError(400, 'no', 'forbidden'), true)).toBe('denied');
  });
  it('maps a 404 to not-found', () => {
    expect(queryStateKind(new ApiError(404, 'gone'), true)).toBe('not-found');
  });
  it('maps a NetworkError to offline', () => {
    expect(queryStateKind(new NetworkError(), true)).toBe('offline');
  });
  it('maps a bare fetch TypeError to offline', () => {
    expect(queryStateKind(new TypeError('Failed to fetch'), true)).toBe('offline');
  });
  it('maps any error to offline while the browser is offline', () => {
    expect(queryStateKind(new ApiError(500, 'boom'), false)).toBe('offline');
    expect(queryStateKind(new Error('x'), false)).toBe('offline');
  });
  it('maps a 500 to error', () => {
    expect(queryStateKind(new ApiError(500, 'boom'), true)).toBe('error');
  });
  it('maps an unknown error to error', () => {
    expect(queryStateKind(new Error('x'), true)).toBe('error');
    expect(queryStateKind(undefined, true)).toBe('error');
  });
});
