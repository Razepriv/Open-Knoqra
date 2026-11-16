import { VOICE_RATE_MICROS_PER_MINUTE } from '@knoqra/core';
import type { Env } from '../env';

/** The destination a per-destination price was read for. */
export interface QuotedDestination {
  /** ISO 3166-1 alpha-2. */
  country: string;
  countryName: string;
  numberType: 'landline' | 'mobile' | 'mobile_or_landline' | 'toll_free' | 'special';
}

/** The price of one call, fixed when it is authorized and kept on the call row. */
export interface CallQuote {
  /** What the wallet is charged per billed minute, in micros. */
  priceMicrosPerMinute: number;
  /** The provider's estimated cost per minute, or null when the pricing does not know it. */
  costMicrosPerMinute: number | null;
  /** The destination the price is for, or null for a price that does not depend on it. */
  destination: QuotedDestination | null;
}

/** How calls are priced. The core prices every call flat; an extension may replace it. */
export interface CallPricing {
  /** The price of calling `toE164` from `fromE164`, or null when calls there are not offered. */
  quote(env: Env, toE164: string, fromE164: string | null): CallQuote | null;
  /** A fee per billed minute charged on top of the call price, in micros (0: none). */
  platformFeeMicrosPerMinute(env: Env): number;
}

/**
 * The core's pricing: every call is estimated at the flat voice rate ($0.01 a billed minute) and no
 * fee is added. The wallet tracks the workspace's own provider spend, so this is an estimate: the
 * balance poll and the daily reconciliation compare it with what the provider actually billed.
 */
export const FLAT_PRICING: CallPricing = {
  quote: () => ({
    priceMicrosPerMinute: VOICE_RATE_MICROS_PER_MINUTE,
    costMicrosPerMinute: null,
    destination: null,
  }),
  platformFeeMicrosPerMinute: () => 0,
};

/** The pricing in force: the first extension's, or the core's flat pricing. */
export function pricingOf(env: Pick<Env, 'EXTENSIONS'>): CallPricing {
  for (const extension of env.EXTENSIONS ?? []) {
    if (extension.pricing) return extension.pricing;
  }
  return FLAT_PRICING;
}

/** How a call is billed beyond its price per minute. */
export interface CallBilling {
  platformFeeMicrosPerMinute: number;
}

export const NO_PLATFORM_FEE: CallBilling = { platformFeeMicrosPerMinute: 0 };

/** The fee per billed call minute, in micros (0: none). */
export function platformFeeRate(env: Env): number {
  return pricingOf(env).platformFeeMicrosPerMinute(env);
}

export function callBillingOf(env: Env): CallBilling {
  return { platformFeeMicrosPerMinute: platformFeeRate(env) };
}

/** The price of calling `toE164` from the caller id `fromE164`, or null when it is not offered. */
export function quoteFor(env: Env, toE164: string, fromE164: string | null): CallQuote | null {
  return pricingOf(env).quote(env, toE164, fromE164);
}

/** "Calls to this destination are not available": the pricing offers no price for it. */
export const RATE_UNAVAILABLE_MESSAGE = "KNOQRA can't call this destination yet.";
