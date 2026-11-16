import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { acquireCallLock, forceReleaseCallLock, releaseCallLock } from '../src/lib/call-lock';

/** A fresh lock per test: each user id names its own Durable Object. */
function lockFor(userId = `usr_${crypto.randomUUID().replaceAll('-', '')}`) {
  return { userId, stub: env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId)) };
}

/** An env whose Durable Object namespaces throw on every use. */
const brokenEnv = {
  USER_CALL_LOCK: {
    idFromName: () => {
      throw new Error('namespace unavailable');
    },
  },
} as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserCallLock', () => {
  it('holds one call at a time and releases only for the holder', async () => {
    const { stub } = lockFor();
    expect(await stub.acquire('cl_a')).toEqual({ ok: true });
    expect(await stub.acquire('cl_a')).toEqual({ ok: true });
    expect(await stub.acquire('cl_b')).toEqual({ ok: false, heldBy: 'cl_a' });
    expect(await stub.current()).toBe('cl_a');
    expect(await stub.release('cl_b')).toBe(false);
    expect(await stub.current()).toBe('cl_a');
    expect(await stub.release('cl_a')).toBe(true);
    expect(await stub.current()).toBeNull();
    expect(await stub.acquire('cl_b')).toEqual({ ok: true });
  });

  it('grants exactly one of 10 concurrent acquires with distinct ids', async () => {
    const { stub } = lockFor();
    const ids = Array.from({ length: 10 }, (_, i) => `cl_${i}`);
    const results = await Promise.all(ids.map((id) => stub.acquire(id)));
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const holder = await stub.current();
    expect(holder).not.toBeNull();
    for (const r of results) {
      if (!r.ok) expect(r.heldBy).toBe(holder);
    }
  });

  it('clears the lock when the TTL alarm fires', async () => {
    const { stub } = lockFor();
    expect(await stub.acquire('cl_ttl', 60_000)).toEqual({ ok: true });
    const alarmAt = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).toBeGreaterThan(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.current()).toBeNull();
    expect(await stub.acquire('cl_next')).toEqual({ ok: true });
  });

  it('cancels the alarm on release', async () => {
    const { stub } = lockFor();
    await stub.acquire('cl_rel');
    await stub.release('cl_rel');
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('forceRelease clears any holder', async () => {
    const { stub } = lockFor();
    await stub.acquire('cl_stuck');
    await stub.forceRelease();
    expect(await stub.current()).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
});

describe('call-lock helpers', () => {
  it('acquire, release and force-release through the namespace', async () => {
    const { userId, stub } = lockFor();
    expect(await acquireCallLock(env, userId, 'cl_1')).toEqual({ ok: true });
    expect(await acquireCallLock(env, userId, 'cl_2')).toEqual({ ok: false, heldBy: 'cl_1' });
    await releaseCallLock(env, userId, 'cl_1');
    expect(await stub.current()).toBeNull();
    await acquireCallLock(env, userId, 'cl_2');
    await forceReleaseCallLock(env, userId);
    expect(await stub.current()).toBeNull();
  });

  it('releaseCallLock never throws and logs ids only', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(releaseCallLock(brokenEnv, 'usr_x', 'cl_x')).resolves.toBeUndefined();
    const line = JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(line.msg).toBe('call_lock.release_failed');
    expect(line.userId).toBe('usr_x');
    expect(line.callId).toBe('cl_x');
  });
});
