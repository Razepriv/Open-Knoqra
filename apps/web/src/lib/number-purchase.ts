import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api, throwIfFailed } from './api';
import { formatMicros } from './money';
import { numbersKey } from './numbers';
import { setupKey } from './setup';
import { usageRoot } from './usage';
import { useDebouncedValue } from './use-debounced-value';
import { walletKey } from './wallet';

export type AvailableNumber = components['schemas']['AvailableNumber'];
export type NumberQuote = components['schemas']['NumberQuote'];
export type NumberOrder = components['schemas']['NumberOrder'];
export type NumberPurchase = components['schemas']['NumberPurchase'];

export const SEARCH_DEBOUNCE_MS = 300;
const AREA_CODE = /^[2-9]\d{2}$/;

export type NumberFeature = 'voice' | 'sms' | 'mms';

export interface NumberSearchInput {
  areaCode: string;
  /** A two-letter state code, or an empty string for any state. */
  region: string;
  features: Readonly<Record<NumberFeature, boolean>>;
}

export const DEFAULT_SEARCH: NumberSearchInput = {
  areaCode: '',
  region: '',
  features: { voice: true, sms: true, mms: false },
};

/** Only the owner spends money on numbers. The role can be a comma-separated list. */
export function canBuyNumbers(role: string | undefined): boolean {
  return (role ?? '').split(',').some((part) => part.trim() === 'owner');
}

/** Search starts once the area code is a full one or a state is chosen. */
export function isSearchReady(search: NumberSearchInput): boolean {
  return AREA_CODE.test(search.areaCode) || search.region !== '';
}

export interface SearchParams {
  areaCode?: string;
  region?: string;
  features?: string;
}

/** The query string fields for `GET /numbers/available`; empty fields are left out. */
export function searchParams(search: NumberSearchInput): SearchParams {
  const features = (['voice', 'sms', 'mms'] as const).filter((key) => search.features[key]);
  return {
    ...(AREA_CODE.test(search.areaCode) ? { areaCode: search.areaCode } : {}),
    ...(search.region ? { region: search.region } : {}),
    ...(features.length > 0 ? { features: features.join(',') } : {}),
  };
}

export const availableKey = (params: SearchParams) => [...numbersKey, 'available', params] as const;

/**
 * The numbers for sale that match the search. The search is debounced by 300 ms; it runs once the
 * area code is complete or a state is chosen. `settling` is true while a change is still waiting.
 */
export function useAvailableNumbers(search: NumberSearchInput) {
  const wanted = JSON.stringify(searchParams(search));
  const settled = useDebouncedValue(wanted, SEARCH_DEBOUNCE_MS);
  const params = JSON.parse(settled) as SearchParams;
  const ready = isSearchReady(search);
  const query = useQuery({
    queryKey: availableKey(params),
    enabled: ready && (params.areaCode !== undefined || params.region !== undefined),
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/numbers/available', { params: { query: params }, signal }),
        'Could not search for numbers.',
      ).items,
  });
  return { query, ready, settling: ready && wanted !== settled };
}

/** Confirms the current price of one number; called when the confirm dialog opens. */
export function useCreateQuote() {
  return useMutation({
    mutationFn: async (e164: string): Promise<NumberQuote> =>
      throwIfFailed(
        await api.POST('/api/v1/numbers/quotes', { body: { e164 } }),
        'Could not confirm the price of this number.',
      ),
  });
}

/** One key per dialog, made once and kept across retries so a retry never charges twice. */
export function useIdempotencyKey(): string {
  const [key] = useState(() => crypto.randomUUID());
  return key;
}

/** Buys a quoted number. Pass the dialog's own `idempotencyKey` on every attempt. */
export function usePurchaseNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      quoteId: string;
      idempotencyKey: string;
    }): Promise<NumberPurchase> =>
      throwIfFailed(
        await api.POST('/api/v1/numbers/purchase', { body: input }),
        'Could not buy this number.',
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: numbersKey });
      void queryClient.invalidateQueries({ queryKey: setupKey });
      void queryClient.invalidateQueries({ queryKey: walletKey });
      void queryClient.invalidateQueries({ queryKey: usageRoot });
    },
  });
}

export const ORDER_FAILED_COPY =
  "Your phone provider couldn't complete this order. Nothing was charged.";
export const ORDER_PENDING_COPY =
  "Your number is being set up. It appears in Numbers as Pending and is assigned automatically once it's active.";

/** The provider's answer was lost: the order's total stays held until a sync confirms it. */
export function orderUnconfirmedCopy(order: NumberOrder): string {
  const total = formatMicros(order.upfrontMicros + order.monthlyMicros);
  return `We couldn't confirm this order with the provider yet. ${total} stays on hold in your wallet until it's confirmed.`;
}
export const PURCHASE_DONE_COPY = 'Number bought and set for calls and messages.';

export interface PurchaseFailure {
  message: string;
  /** Whether the person should go back to the search (the price or the number is gone). */
  searchAgain: boolean;
}

/** Our wording for whatever a quote or purchase threw. */
export function purchaseFailure(error: unknown): PurchaseFailure {
  const code = error instanceof ApiError ? error.code : undefined;
  const server = error instanceof ApiError ? error.message : undefined;
  switch (code) {
    case 'spend_blocked':
      return {
        message: server ?? 'Your spending limits do not allow this purchase.',
        searchAgain: false,
      };
    case 'quote_invalid':
      return { message: server ?? 'This price is no longer valid.', searchAgain: true };
    case 'voice_not_configured':
      return { message: 'Connect your phone provider before buying a number.', searchAgain: false };
    case 'forbidden':
      return { message: 'Only the workspace owner can buy numbers.', searchAgain: false };
    case 'provider_unavailable':
      return {
        message: 'Your phone provider did not answer. Try again in a minute.',
        searchAgain: false,
      };
    default:
      return { message: 'Something went wrong. Try again in a moment.', searchAgain: false };
  }
}

export type PurchaseOutcome = 'done' | 'pending' | 'unconfirmed' | 'failed';

/** The API's failure code on a pending order whose provider answer was lost. */
const UNCONFIRMED = 'unconfirmed';

/**
 * What a successful API answer means for the person: bought, still being set up, not yet
 * confirmed by the provider (the money stays held), or refused.
 */
export function purchaseOutcome(result: NumberPurchase): PurchaseOutcome {
  if (result.order.status === 'failed') return 'failed';
  if (result.order.status === 'pending' && result.order.failureCode === UNCONFIRMED) {
    return 'unconfirmed';
  }
  return result.order.status === 'pending' || result.number === null ? 'pending' : 'done';
}

export const US_STATES: readonly { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];
