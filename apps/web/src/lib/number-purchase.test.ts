import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  canBuyNumbers,
  DEFAULT_SEARCH,
  isSearchReady,
  type NumberPurchase,
  ORDER_FAILED_COPY,
  ORDER_PENDING_COPY,
  orderUnconfirmedCopy,
  purchaseFailure,
  purchaseOutcome,
  searchParams,
} from './number-purchase';

const order = (status: 'pending' | 'completed' | 'failed') => ({
  id: 'no_1',
  e164: '+12025550150',
  status,
  upfrontMicros: 1_000_000,
  monthlyMicros: 1_000_000,
  failureCode: status === 'failed' ? 'order_failed' : null,
  createdAt: '2026-11-13T10:00:00.000Z',
});
const number = {
  id: 'pn_1',
  e164: '+12025550150',
  provider: 'fake',
  status: 'active',
  capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
  tenDlcStatus: 'none',
  whatsappStatus: 'none',
  assignedUse: 'calls_and_messages',
  lastSyncedAt: null,
} as const;

describe('canBuyNumbers', () => {
  it('is true only for the owner', () => {
    expect(canBuyNumbers('owner')).toBe(true);
    expect(canBuyNumbers('member,owner')).toBe(true);
    expect(canBuyNumbers('admin')).toBe(false);
    expect(canBuyNumbers('member')).toBe(false);
    expect(canBuyNumbers(undefined)).toBe(false);
  });
});

describe('isSearchReady', () => {
  it('needs a full area code or a state', () => {
    expect(isSearchReady(DEFAULT_SEARCH)).toBe(false);
    expect(isSearchReady({ ...DEFAULT_SEARCH, areaCode: '20' })).toBe(false);
    expect(isSearchReady({ ...DEFAULT_SEARCH, areaCode: '202' })).toBe(true);
    expect(isSearchReady({ ...DEFAULT_SEARCH, areaCode: '012' })).toBe(false);
    expect(isSearchReady({ ...DEFAULT_SEARCH, region: 'NY' })).toBe(true);
  });
});

describe('searchParams', () => {
  it('sends voice and sms by default and leaves empty fields out', () => {
    expect(searchParams({ ...DEFAULT_SEARCH, areaCode: '202' })).toEqual({
      areaCode: '202',
      features: 'voice,sms',
    });
  });

  it('adds the state and drops an unfinished area code', () => {
    expect(
      searchParams({
        areaCode: '20',
        region: 'NY',
        features: { voice: true, sms: false, mms: true },
      }),
    ).toEqual({ region: 'NY', features: 'voice,mms' });
  });

  it('omits features when none is checked', () => {
    expect(
      searchParams({
        areaCode: '202',
        region: '',
        features: { voice: false, sms: false, mms: false },
      }),
    ).toEqual({ areaCode: '202' });
  });
});

describe('purchaseFailure', () => {
  it('uses the API reason for a blocked spend', () => {
    const error = new ApiError(402, 'Not enough credit to buy this number.', 'spend_blocked');
    expect(purchaseFailure(error)).toEqual({
      message: 'Not enough credit to buy this number.',
      searchAgain: false,
    });
  });

  it('offers a new search when the quote is gone', () => {
    expect(purchaseFailure(new ApiError(409, 'gone', 'quote_invalid')).searchAgain).toBe(true);
  });

  it('words a provider outage and hides unknown errors', () => {
    expect(purchaseFailure(new ApiError(502, 'x', 'provider_unavailable')).message).toBe(
      'Telnyx did not answer. Try again in a minute.',
    );
    expect(purchaseFailure(new Error('boom: secret')).message).toBe(
      'Something went wrong. Try again in a moment.',
    );
  });
});

describe('purchaseOutcome', () => {
  it('tells done, pending and failed apart', () => {
    const done: NumberPurchase = { order: order('completed'), number };
    expect(purchaseOutcome(done)).toBe('done');
    expect(purchaseOutcome({ order: order('pending'), number: null })).toBe('pending');
    expect(purchaseOutcome({ order: order('failed'), number: null })).toBe('failed');
    expect(ORDER_FAILED_COPY).toContain('Nothing was charged');
  });

  it('tells an unconfirmed order apart and words its hold with the total', () => {
    const unconfirmed = { ...order('pending'), failureCode: 'unconfirmed' };
    expect(purchaseOutcome({ order: unconfirmed, number: null })).toBe('unconfirmed');
    expect(orderUnconfirmedCopy(unconfirmed)).toBe(
      "We couldn't confirm this order with the provider yet. $2.00 stays on hold in your wallet until it's confirmed.",
    );
    expect(ORDER_PENDING_COPY).toBe(
      "Your number is being set up. It appears in Numbers as Pending and is assigned automatically once it's active.",
    );
  });
});
