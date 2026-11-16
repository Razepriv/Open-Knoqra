import { describe, expect, it } from 'vitest';
import { api, get, signUp, uniqueEmail } from './helpers';

describe('Cache-Control on API responses', () => {
  it('marks the health check no-store', async () => {
    const r = await api('/api/health');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('marks an unauthenticated 401 no-store', async () => {
    const r = await get('/api/v1/contacts', '');
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('marks a signed-in response no-store', async () => {
    const cookie = await signUp(uniqueEmail('ch'), 'Cache Headers');
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('marks a webhook response no-store', async () => {
    const r = await api('/webhooks/no-such-provider', { method: 'POST', body: '{}' });
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('marks Better Auth responses with a Cache-Control header', async () => {
    const r = await api('/api/auth/get-session');
    expect(r.headers.get('cache-control')).toBeTruthy();
  });
});
