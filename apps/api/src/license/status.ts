import { type LicenseFailure, type LicensePayload, verifyLicense } from '@knoqra/core';
import { type Database, instanceLicense } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../env';
import { type Edition, editionOf } from './edition';

export interface LicenseInfo {
  login: string;
  githubId: string;
  issuedAt: string;
  edition: 'selfhost';
}

export type LicenseReason = LicenseFailure | 'missing';

export interface LicenseStatus {
  edition: Edition;
  /** True on a self-hosted instance: a valid key is needed to use it. */
  required: boolean;
  /** A valid key was found (always false on cloud, where none is needed). */
  licensed: boolean;
  /** Where the valid key came from: the `KNOQRA_LICENSE_KEY` var or the key entered in the Desk. */
  source: 'env' | 'stored' | null;
  license: LicenseInfo | null;
  /** Why there is no valid key; null when licensed or on cloud. */
  reason: LicenseReason | null;
}

const toInfo = (p: LicensePayload): LicenseInfo => ({
  login: p.login,
  githubId: p.sub,
  issuedAt: p.iat,
  edition: p.edition,
});

/** A valid key is remembered this long per isolate, so the gate does not read Postgres each time. */
const VALID_TTL_MS = 60_000;

export interface LicenseChecker {
  /** The public key keys are checked against (the embedded one, or a test key). */
  readonly publicKey: string;
  status(env: Env, db: Database, now?: Date): Promise<LicenseStatus>;
  /** Drops the remembered key, after a new one is entered. */
  forget(): void;
}

/**
 * Checks this instance's license offline, against `publicKey`. Only a valid result is cached
 * (for a minute): while an instance is unlicensed every request looks again, so a key entered on
 * one isolate unlocks the others at once.
 */
export function createLicenseChecker(publicKey: string): LicenseChecker {
  let cached: { at: number; source: 'env' | 'stored'; license: LicensePayload } | null = null;

  return {
    publicKey,
    forget() {
      cached = null;
    },
    async status(env, db, now = new Date()) {
      const edition = editionOf(env);
      if (edition === 'cloud') {
        return {
          edition,
          required: false,
          licensed: false,
          source: null,
          license: null,
          reason: null,
        };
      }
      const licensed = (source: 'env' | 'stored', license: LicensePayload): LicenseStatus => ({
        edition,
        required: true,
        licensed: true,
        source,
        license: toInfo(license),
        reason: null,
      });
      if (cached && now.getTime() - cached.at < VALID_TTL_MS) {
        return licensed(cached.source, cached.license);
      }
      let reason: LicenseReason = 'missing';
      const fromEnv = env.KNOQRA_LICENSE_KEY?.trim();
      if (fromEnv) {
        const check = await verifyLicense(fromEnv, publicKey, now);
        if (check.ok) {
          cached = { at: now.getTime(), source: 'env', license: check.license };
          return licensed('env', check.license);
        }
        reason = check.reason;
      }
      const [row] = await db
        .select({ licenseKey: instanceLicense.licenseKey })
        .from(instanceLicense)
        .where(eq(instanceLicense.id, 1))
        .limit(1);
      if (row) {
        const check = await verifyLicense(row.licenseKey, publicKey, now);
        if (check.ok) {
          cached = { at: now.getTime(), source: 'stored', license: check.license };
          return licensed('stored', check.license);
        }
        // An env key that failed explains the problem better than a stale stored one.
        if (!fromEnv) reason = check.reason;
      }
      return { edition, required: true, licensed: false, source: null, license: null, reason };
    },
  };
}

/** What the Desk and the API say for each reason a key is not accepted. */
export const LICENSE_REASON_MESSAGES: Record<LicenseReason, string> = {
  missing: 'This KNOQRA instance needs a license key.',
  no_public_key:
    'This build has no license public key built in, so no key can be checked. Use an official KNOQRA release.',
  malformed:
    'That is not a KNOQRA license key. Copy the whole key, starting with KNOQRA-LICENSE-1.',
  bad_signature: 'This key was not issued by KNOQRA, or it was changed after it was issued.',
  wrong_edition: 'This key is not for a self-hosted instance.',
  future_date: "This key is dated in the future. Check the server's clock.",
};
