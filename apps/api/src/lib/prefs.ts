import { z } from '@hono/zod-openapi';
import { isValidTimeZone } from '@knoqra/core';
import { type Database, THEMES, type Tx, userPrefs } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { safeText } from './schemas';

export const MAX_TIMEZONE_LENGTH = 64;

const timezone = safeText({ min: 1, max: MAX_TIMEZONE_LENGTH }).refine(isValidTimeZone, {
  message: 'Not an IANA time zone',
});

export const Prefs = z
  .object({
    timezone: z.string().nullable(),
    theme: z.enum(THEMES),
    notifyEmail: z.boolean(),
    notifyDesktop: z.boolean(),
    analyticsConsent: z.boolean(),
  })
  .openapi('Prefs');
export type PrefsJson = z.infer<typeof Prefs>;

/** Every field optional; `timezone: null` clears it. Unknown keys (such as a userId) are dropped. */
export const UpdatePrefs = z
  .object({
    timezone: timezone.nullable().optional(),
    theme: z.enum(THEMES).optional(),
    notifyEmail: z.boolean().optional(),
    notifyDesktop: z.boolean().optional(),
    analyticsConsent: z.boolean().optional(),
  })
  .openapi('UpdatePrefs');
export type UpdatePrefsInput = z.infer<typeof UpdatePrefs>;

export const DEFAULT_PREFS: PrefsJson = {
  timezone: null,
  theme: 'system',
  notifyEmail: true,
  notifyDesktop: true,
  analyticsConsent: false,
};

/** The user's preferences, or the defaults when they have never saved any. */
export async function loadPrefs(db: Database | Tx, userId: string): Promise<PrefsJson> {
  const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
  if (!row) return DEFAULT_PREFS;
  return {
    timezone: row.timezone,
    theme: row.theme,
    notifyEmail: row.notifyEmail,
    notifyDesktop: row.notifyDesktop,
    analyticsConsent: row.analyticsConsent,
  };
}
