import { describe, expect, it } from 'vitest';
import { api } from './helpers';

describe('GET /api/health', () => {
  it('health reports ok', async () => {
    const r = await api('/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok', db: 'ok' });
  });
});

describe('GET /api/openapi.json', () => {
  it('serves an OpenAPI 3.1 document describing the v1 routes', async () => {
    const r = await api('/api/openapi.json');
    expect(r.status).toBe(200);
    const doc = (await r.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/v1/me',
        '/api/v1/contacts',
        '/api/v1/contacts/{id}',
      ]),
    );
  });
});
