import { describe, expect, it } from 'vitest';
import worker, { type Env, isApiPath } from './index';

function envRecording(): { env: Env; calls: string[] } {
  const calls: string[] = [];
  const binding = (name: string) => ({
    fetch: async (request: Request) => {
      calls.push(`${name} ${new URL(request.url).pathname}`);
      return new Response(name);
    },
  });
  return { env: { API: binding('API'), ASSETS: binding('ASSETS') }, calls };
}

describe('web worker', () => {
  it('sends /api/* to the API service binding with the original request', async () => {
    const { env, calls } = envRecording();
    const request = new Request('https://desk.example.test/api/v1/me', {
      headers: { origin: 'https://desk.example.test' },
    });
    const res = await worker.fetch(request, env);
    expect(await res.text()).toBe('API');
    expect(calls).toEqual(['API /api/v1/me']);
  });

  it('forwards the same Request, keeping method and Origin (R17)', async () => {
    let seen: Request | undefined;
    const env: Env = {
      API: {
        fetch: async (request) => {
          seen = request;
          return new Response('ok');
        },
      },
      ASSETS: { fetch: async () => new Response('assets') },
    };
    const request = new Request('https://desk.example.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin: 'https://desk.example.test' },
      body: '{}',
    });
    await worker.fetch(request, env);
    expect(seen).toBe(request);
    expect(seen?.method).toBe('POST');
    expect(seen?.headers.get('origin')).toBe('https://desk.example.test');
  });

  it('serves everything else from static assets', async () => {
    const { env, calls } = envRecording();
    for (const path of ['/', '/sign-in', '/showcase', '/api', '/apiary']) {
      await worker.fetch(new Request(`https://desk.example.test${path}`), env);
    }
    expect(calls).toEqual([
      'ASSETS /',
      'ASSETS /sign-in',
      'ASSETS /showcase',
      'ASSETS /api',
      'ASSETS /apiary',
    ]);
  });

  it('matches only the /api/ prefix', () => {
    expect(isApiPath('/api/auth/sign-in/email')).toBe(true);
    expect(isApiPath('/api')).toBe(false);
    expect(isApiPath('/apis/x')).toBe(false);
  });
});
