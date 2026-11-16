import type { AcquireResult } from '../do/user-call-lock';
import type { Env } from '../env';
import { logger } from './logger';

function lockOf(env: Env, userId: string) {
  return env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId));
}

/** Claims the user's single call slot for `callId`. Errors propagate: a caller must not dial without it. */
export function acquireCallLock(env: Env, userId: string, callId: string): Promise<AcquireResult> {
  return lockOf(env, userId).acquire(callId);
}

/** Frees the slot if `callId` holds it. Never throws: the TTL alarm is the backstop. */
export async function releaseCallLock(env: Env, userId: string, callId: string): Promise<void> {
  try {
    await lockOf(env, userId).release(callId);
  } catch (error) {
    logger.error('call_lock.release_failed', { userId, callId, error });
  }
}

/** Clears the slot whoever holds it (recovery from a stuck call). */
export async function forceReleaseCallLock(env: Env, userId: string): Promise<void> {
  await lockOf(env, userId).forceRelease();
}
