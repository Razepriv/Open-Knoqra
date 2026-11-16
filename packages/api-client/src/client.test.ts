import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';

describe('createApiClient', () => {
  it('calls typed /api/v1/me and unwraps the envelope', async () => {
    const fetchStub = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        data: {
          user: { id: 'u1', name: 'Ana', email: 'a@x.test' },
          organization: { id: 'o1', name: "Ana's workspace", role: 'owner' },
        },
        error: null,
      }),
    );
    const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub });
    const { data } = await api.GET('/api/v1/me');
    expect(data?.data?.organization.role).toBe('owner');
    const sent = fetchStub.mock.calls[0]?.[0] as Request | undefined;
    expect(sent?.credentials).toBe('include');
  });
});
