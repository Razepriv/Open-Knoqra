import { describe, expect, it } from 'vitest';
import {
  type ExpectedResponse,
  isExplained,
  isReportableRequestFailure,
  isResourceLoadNoise,
} from './guards';

const expected: ExpectedResponse[] = [
  { method: 'GET', path: /^\/api\/v1\/thing$/, status: 404, reason: 'The page says "Not found".' },
  { path: /\/api\/v1\/any/, status: 401, reason: 'The page says "Sign in".' },
];

describe('isExplained', () => {
  it('matches on method, path regex and exact status', () => {
    expect(isExplained('GET', 'http://localhost:1/api/v1/thing', 404, expected)).toBe(true);
    expect(isExplained('POST', 'http://localhost:1/api/v1/thing', 404, expected)).toBe(false);
    expect(isExplained('GET', 'http://localhost:1/api/v1/thing', 403, expected)).toBe(false);
  });

  it('treats a missing method as any method', () => {
    expect(isExplained('DELETE', 'http://localhost:1/api/v1/any/x', 401, expected)).toBe(true);
  });

  it('never explains a 500 with a 4xx entry', () => {
    expect(isExplained('GET', 'http://localhost:1/api/v1/thing', 500, expected)).toBe(false);
    expect(isExplained('GET', 'http://localhost:1/api/v1/any', 500, expected)).toBe(false);
  });

  it('matches methods case-insensitively and ignores the query string', () => {
    expect(isExplained('get', 'http://localhost:1/api/v1/thing?x=1', 404, expected)).toBe(true);
  });

  it('explains nothing from an empty list', () => {
    expect(isExplained('GET', 'http://localhost:1/api/v1/thing', 404, [])).toBe(false);
  });
});

describe('console and request noise', () => {
  it('treats the browser resource-load line as noise', () => {
    expect(
      isResourceLoadNoise(
        'Failed to load resource: the server responded with a status of 404 (Not Found)',
      ),
    ).toBe(true);
    expect(isResourceLoadNoise('TypeError: x is undefined')).toBe(false);
  });

  it('ignores aborts but reports other request failures', () => {
    expect(isReportableRequestFailure('net::ERR_ABORTED')).toBe(false);
    expect(isReportableRequestFailure('net::ERR_CONNECTION_REFUSED')).toBe(true);
    expect(isReportableRequestFailure(undefined)).toBe(true);
  });
});
