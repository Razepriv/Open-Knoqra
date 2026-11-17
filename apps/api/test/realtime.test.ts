import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { publish, type RealtimeMessage } from '../src/lib/realtime';
import { api, BASE, get, signUp, signUpTeammate, uniqueEmail } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

function upgrade(headers: Record<string, string>): Promise<Response> {
  return api('/api/v1/realtime', { headers: { upgrade: 'websocket', ...headers } });
}

/** An accepted client socket plus a queue of the text frames it has received. */
interface Client {
  ws: WebSocket;
  next: () => Promise<string>;
}

async function connect(cookie: string): Promise<Client> {
  const r = await upgrade({ cookie, origin: BASE });
  expect(r.status).toBe(101);
  const ws = r.webSocket;
  if (!ws) throw new Error('no webSocket on the 101 response');
  ws.accept();
  const queued: string[] = [];
  const waiting: Array<(value: string) => void> = [];
  ws.addEventListener('message', (event) => {
    const text = String(event.data);
    const resolve = waiting.shift();
    if (resolve) resolve(text);
    else queued.push(text);
  });
  const next = () => {
    const ready = queued.shift();
    return ready !== undefined
      ? Promise.resolve(ready)
      : new Promise<string>((resolve) => waiting.push(resolve));
  };
  return { ws, next };
}

function orgStub(orgId: string) {
  return env.ORG_REALTIME.get(env.ORG_REALTIME.idFromName(orgId));
}

let cookieA: string;
let cookieB: string;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('rt-a'), 'Realtime A');
  cookieB = await signUp(uniqueEmail('rt-b'), 'Realtime B');
  orgA = await orgOf(cookieA);
  orgB = await orgOf(cookieB);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/realtime', () => {
  it('answers 426 without an Upgrade: websocket header', async () => {
    const r = await api('/api/v1/realtime', { headers: { cookie: cookieA, origin: BASE } });
    expect(r.status).toBe(426);
  });

  it('answers 403 forbidden for a foreign Origin', async () => {
    const r = await upgrade({ cookie: cookieA, origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    const body = (await r.json()) as Envelope<null>;
    expect(body.error?.code).toBe('forbidden');
  });

  it('answers 403 when Origin is missing', async () => {
    const r = await upgrade({ cookie: cookieA });
    expect(r.status).toBe(403);
  });

  it('rejects bad upgrades before the session lookup (no cookie still gets 426 or 403)', async () => {
    expect((await api('/api/v1/realtime', { headers: { origin: BASE } })).status).toBe(426);
    expect((await upgrade({ origin: 'https://evil.example' })).status).toBe(403);
  });

  it('answers 401 without a session', async () => {
    const r = await upgrade({ origin: BASE });
    expect(r.status).toBe(401);
    const body = (await r.json()) as Envelope<null>;
    expect(body.error?.code).toBe('unauthenticated');
  });

  it('answers ping with pong', async () => {
    const client = await connect(cookieA);
    client.ws.send('ping');
    expect(await client.next()).toBe('pong');
    client.ws.close(1000, 'done');
  });

  it('broadcasts to every socket of the org and to no other org', async () => {
    // A fresh org, so no socket from an earlier test is still counted.
    const cookie = await signUp(uniqueEmail('rt-fresh'), 'Realtime Fresh');
    const org = await orgOf(cookie);
    const first = await connect(cookie);
    const second = await connect(cookie);
    const other = await connect(cookieB);

    const message: RealtimeMessage = { type: 'call.updated', data: { id: 'cl_1' } };
    expect(await orgStub(org).broadcast(message)).toBe(2);
    expect(JSON.parse(await first.next())).toEqual(message);
    expect(JSON.parse(await second.next())).toEqual(message);

    // Org B's first frame must be its own marker: it never saw org A's message.
    const marker: RealtimeMessage = { type: 'wallet.updated', data: { marker: true } };
    await orgStub(orgB).broadcast(marker);
    expect(JSON.parse(await other.next())).toEqual(marker);

    for (const c of [first, second, other]) c.ws.close(1000, 'done');
  });

  it('sends to one member only when the frame names a user', async () => {
    const cookie = await signUp(uniqueEmail('rt-user'), 'Realtime User');
    const org = await orgOf(cookie);
    const ownerId = (
      (await (await get('/api/v1/me', cookie)).json()) as Envelope<{ user: { id: string } }>
    ).data?.user.id as string;
    const mate = await signUpTeammate(org);
    const owner = await connect(cookie);
    const teammate = await connect(mate.cookie);

    const message: RealtimeMessage = { type: 'ext.test', data: { private: true } };
    expect(await orgStub(org).broadcast(message, ownerId)).toBe(1);
    expect(JSON.parse(await owner.next())).toEqual(message);

    // The teammate's first frame is the next org-wide one: the private frame never reached it.
    const marker: RealtimeMessage = { type: 'wallet.updated', data: { marker: true } };
    expect(await orgStub(org).broadcast(marker)).toBe(2);
    expect(JSON.parse(await teammate.next())).toEqual(marker);
    for (const c of [owner, teammate]) c.ws.close(1000, 'done');
  });

  it('ignores client messages other than ping', async () => {
    const client = await connect(cookieA);
    client.ws.send(JSON.stringify({ type: 'call.updated', data: { forged: true } }));
    const marker: RealtimeMessage = { type: 'voicemail.created', data: { marker: true } };
    await orgStub(orgA).broadcast(marker);
    expect(JSON.parse(await client.next())).toEqual(marker);
    client.ws.close(1000, 'done');
  });
});

describe('publish', () => {
  it('delivers through the org Durable Object', async () => {
    const client = await connect(cookieA);
    const message: RealtimeMessage = { type: 'voicemail.created', data: { id: 'vm_1' } };
    await publish(env, orgA, message);
    expect(JSON.parse(await client.next())).toEqual(message);
    client.ws.close(1000, 'done');
  });

  it('swallows a Durable Object failure and logs the org id only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = {
      ORG_REALTIME: {
        idFromName: () => {
          throw new Error('namespace unavailable');
        },
      },
    } as unknown as Env;
    await expect(
      publish(broken, 'org_x', { type: 'call.updated', data: { secret: 'payload' } }),
    ).resolves.toBeUndefined();
    const line = String(spy.mock.calls.at(-1)?.[0]);
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.msg).toBe('realtime.publish_failed');
    expect(entry.orgId).toBe('org_x');
    expect(line).not.toContain('payload');
  });
});
