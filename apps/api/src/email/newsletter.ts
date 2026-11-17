import { type Database, type Tx, userPrefs } from '@knoqra/db';
import type { Env } from '../env';
import { logger } from '../lib/logger';

/** A user's newsletter choice, as passed to `ApiExtension.newsletterChanged`. */
export interface NewsletterChange {
  userId: string;
  email: string;
  name: string;
  subscribed: boolean;
  /** Where the choice was made. */
  source: 'sign-up' | 'settings' | 'unsubscribe-link' | 'account-deleted';
}

/**
 * Records the user's newsletter choice and when it was made (the consent record). `user_prefs`
 * is keyed by user and has no tenant policy, so this needs no organization.
 */
export async function saveNewsletterChoice(
  db: Database | Tx,
  userId: string,
  subscribed: boolean,
  at: Date = new Date(),
): Promise<void> {
  await db
    .insert(userPrefs)
    .values({ userId, newsletter: subscribed, newsletterUpdatedAt: at })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { newsletter: subscribed, newsletterUpdatedAt: at, updatedAt: at },
    });
}

/** The version of the terms and privacy policy shown at sign-up: their "last updated" date. */
export const TERMS_VERSION = '2026-11-17';

/** Records that the user accepted the terms and privacy policy, and which version. */
export async function saveTermsAcceptance(
  db: Database | Tx,
  userId: string,
  at: Date = new Date(),
  version: string = TERMS_VERSION,
): Promise<void> {
  await db
    .insert(userPrefs)
    .values({ userId, termsAcceptedAt: at, termsVersion: version })
    .onConflictDoUpdate({
      target: userPrefs.userId,
      set: { termsAcceptedAt: at, termsVersion: version, updatedAt: at },
    });
}

/** Tells each extension about the change. Never throws: a mailing list being down must not fail the request. */
export async function announceNewsletterChange(env: Env, change: NewsletterChange): Promise<void> {
  for (const extension of env.EXTENSIONS ?? []) {
    if (!extension.newsletterChanged) continue;
    try {
      await extension.newsletterChanged(env, change);
    } catch (error) {
      logger.warn('newsletter.sync_failed', {
        extension: extension.name,
        source: change.source,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
