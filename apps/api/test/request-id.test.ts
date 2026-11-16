import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Synthetic, never a real token. */
const RESET_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('x-request-id', () => {
  it('is generated when absent', async () => {
    const r = await api('/api/health');
    expect(r.headers.get('x-request-id')).toMatch(UUID);
  });

  it('echoes a well-formed incoming id', async () => {
    const r = await api('/api/health', { headers: { 'x-request-id': 'req-12345678' } });
    expect(r.headers.get('x-request-id')).toBe('req-12345678');
  });

  it.each([
    ['too long', 'a'.repeat(500)],
    ['unsafe characters', '<script>alert(1)</script>'],
    ['too short', 'abc'],
  ])('replaces an unacceptable id (%s)', async (_label, value) => {
    const r = await api('/api/health', { headers: { 'x-request-id': value } });
    expect(r.headers.get('x-request-id')).toMatch(UUID);
  });

  it('is set on error and not-found responses too', async () => {
    const r = await api('/api/v1/nope');
    expect([401, 404]).toContain(r.status);
    expect(r.headers.get('x-request-id')).toMatch(UUID);
    const missing = await api('/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toMatch(UUID);
  });
});

describe('request.completed', () => {
  it('logs a reset-password request without its token or query string', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await api(`/api/auth/reset-password/${RESET_TOKEN}?callbackURL=%2Freset-password`, {
      headers: { 'x-request-id': 'req-redact-01' },
      redirect: 'manual',
    });
    await r.arrayBuffer();

    const lines = spy.mock.calls.map((call) => String(call[0]));
    const completed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === 'request.completed' && entry.requestId === 'req-redact-01');
    expect(completed).toBeDefined();
    expect(completed).toMatchObject({
      requestId: 'req-redact-01',
      method: 'GET',
      path: '/api/auth/reset-password/[redacted]',
      status: r.status,
    });
    expect(typeof completed?.durationMs).toBe('number');
    const output = lines.join('\n');
    expect(output).not.toContain(RESET_TOKEN);
    expect(output).not.toContain('callbackURL');
  });
});
