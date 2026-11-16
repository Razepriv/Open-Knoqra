import type { WhatsAppState } from '@knoqra/core';
import { z } from 'zod';

/**
 * Telnyx's WhatsApp account reads (OpenAPI `ListPhoneNumbers` and `ListWabas`): which of the
 * account's numbers are WhatsApp senders, and whether Meta approved them. Both lists take only
 * `page[number]` and `page[size]` (at most 250) and answer `{ data, meta }`.
 */
const metaSchema = z.object({ page_number: z.number(), total_pages: z.number() });

export const whatsappNumbersPageSchema = z.object({
  data: z.array(
    z.object({
      phone_number: z.string().min(1),
      status: z.string().nullish(),
      waba_id: z.string().nullish(),
      display_name: z.string().nullish(),
      quality_rating: z.string().nullish(),
      coexistence_state: z.string().nullish(),
    }),
  ),
  meta: metaSchema,
});

export const whatsappAccountsPageSchema = z.object({
  data: z.array(
    z.object({
      waba_id: z.string().nullish(),
      status: z.string().nullish(),
      account_review_status: z.string().nullish(),
    }),
  ),
  meta: metaSchema,
});

export type TelnyxWhatsAppNumber = z.infer<typeof whatsappNumbersPageSchema>['data'][number];
export type TelnyxWhatsAppAccount = z.infer<typeof whatsappAccountsPageSchema>['data'][number];

/** What the number sync keeps about a WhatsApp sender number. */
export interface WhatsAppNumberFacts {
  state: WhatsAppState;
  displayName: string | null;
  qualityRating: string | null;
}

/** Meta number statuses that mean the number can no longer send. */
const DEAD_NUMBER_STATUSES: ReadonlySet<string> = new Set(['BANNED', 'DELETED']);

const upper = (value: string | null | undefined) => (value ?? '').trim().toUpperCase();

/**
 * Meta's verdict on one number, from the number and its business account:
 * - `approved`: the number is CONNECTED (and a coexistence number has finished onboarding), and
 *   the account's review is APPROVED (Telnyx's account `status` ACTIVE says the same);
 * - `rejected`: the account review was REJECTED, or the number is BANNED or DELETED;
 * - `pending`: anything else (review pending, number still registering, account unknown).
 * An INACTIVE account with an APPROVED review still sends (Telnyx: "INACTIVE does not block").
 */
export function whatsappStateOf(
  number: TelnyxWhatsAppNumber,
  account: TelnyxWhatsAppAccount | undefined,
): WhatsAppState {
  const numberStatus = upper(number.status);
  const review = upper(account?.account_review_status);
  const accountStatus = upper(account?.status);
  if (DEAD_NUMBER_STATUSES.has(numberStatus)) return 'rejected';
  if (review === 'REJECTED' || accountStatus === 'REJECTED') return 'rejected';
  const coexisting = number.coexistence_state != null && number.coexistence_state !== 'active';
  const accountApproved = review === 'APPROVED' || accountStatus === 'ACTIVE';
  if (numberStatus === 'CONNECTED' && !coexisting && accountApproved) return 'approved';
  return 'pending';
}

/** Each listed WhatsApp number's facts, keyed by E.164. */
export function whatsappFactsByNumber(
  numbers: readonly TelnyxWhatsAppNumber[],
  accounts: readonly TelnyxWhatsAppAccount[],
): Map<string, WhatsAppNumberFacts> {
  const byWaba = new Map(
    accounts.filter((a) => a.waba_id).map((a) => [a.waba_id as string, a] as const),
  );
  const facts = new Map<string, WhatsAppNumberFacts>();
  for (const number of numbers) {
    const account = number.waba_id ? byWaba.get(number.waba_id) : undefined;
    facts.set(number.phone_number, {
      state: whatsappStateOf(number, account),
      displayName: number.display_name?.trim() || null,
      qualityRating: number.quality_rating?.trim() || null,
    });
  }
  return facts;
}
