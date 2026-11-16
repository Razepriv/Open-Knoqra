// Runs in the `api-db-unreachable` vitest project, whose DATABASE_URL points at a closed port.
import { expect, it } from 'vitest';
import { api } from './helpers';

it('health is 503 within 3s when the database is unreachable', async () => {
  const started = Date.now();
  const r = await api('/api/health');
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ status: 'degraded', db: 'unreachable' });
  expect(Date.now() - started).toBeLessThan(3000);
});

it('deep health answers an envelope within 5s when the database is unreachable', async () => {
  const started = Date.now();
  const r = await api('/api/health/deep');
  expect([401, 500]).toContain(r.status);
  const body = (await r.json()) as { data: unknown; error: { code: string } | null };
  expect(body.data).toBeNull();
  expect(['unauthenticated', 'internal_error']).toContain(body.error?.code);
  expect(Date.now() - started).toBeLessThan(5000);
});
