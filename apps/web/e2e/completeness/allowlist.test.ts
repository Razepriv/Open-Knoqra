import { describe, expect, it } from 'vitest';
import { isPending, type PendingRoute, readPendingRoutes } from './allowlist';

describe('pending routes allowlist', () => {
  it('is empty: every Phase 1 route has its real screen', () => {
    expect(readPendingRoutes()).toEqual([]);
  });

  it('isPending matches exact patterns only', () => {
    const pending: PendingRoute[] = [{ route: '/usage', owner: 'Example lane', files: ['x.tsx'] }];
    expect(isPending('/usage', pending)).toBe(true);
    expect(isPending('/calls', pending)).toBe(false);
    expect(isPending('/usage/', pending)).toBe(false);
    expect(isPending('/usage', readPendingRoutes())).toBe(false);
  });
});
