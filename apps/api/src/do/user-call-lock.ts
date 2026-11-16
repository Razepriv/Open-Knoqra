import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

export type AcquireResult = { ok: true } | { ok: false; heldBy: string };

/** Default lock lifetime: no call legitimately lasts longer than four hours. */
export const DEFAULT_CALL_LOCK_TTL_MS = 4 * 3600_000;

const HOLDER_KEY = 'callId';

/**
 * One active call per user (keyed `idFromName(userId)`). The holder is a call id in storage; a
 * storage alarm clears it at the TTL so a crashed call can never wedge the user forever.
 *
 * Atomicity: each method reads and writes only through `ctx.storage` KV, with no other I/O in
 * between. Storage operations keep the input gate closed, so no other request or RPC call is
 * delivered to this object until the method's read-check-write completes. Two concurrent acquires
 * therefore run one after another, and the second sees the first one's holder.
 */
export class UserCallLock extends DurableObject<Env> {
  async acquire(callId: string, ttlMs: number = DEFAULT_CALL_LOCK_TTL_MS): Promise<AcquireResult> {
    const holder = await this.ctx.storage.get<string>(HOLDER_KEY);
    if (holder !== undefined && holder !== callId) return { ok: false, heldBy: holder };
    await this.ctx.storage.put(HOLDER_KEY, callId);
    // Re-acquiring with the same id refreshes the TTL.
    await this.ctx.storage.setAlarm(Date.now() + ttlMs);
    return { ok: true };
  }

  async release(callId: string): Promise<boolean> {
    const holder = await this.ctx.storage.get<string>(HOLDER_KEY);
    if (holder !== callId) return false;
    await this.clear();
    return true;
  }

  async forceRelease(): Promise<void> {
    await this.clear();
  }

  async current(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(HOLDER_KEY)) ?? null;
  }

  /** TTL expiry. Release and acquire reset or delete the alarm, so it only fires for a stale holder. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.delete(HOLDER_KEY);
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.delete(HOLDER_KEY);
    await this.ctx.storage.deleteAlarm();
  }
}
