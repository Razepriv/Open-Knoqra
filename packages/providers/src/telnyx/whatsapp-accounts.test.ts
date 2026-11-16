import { describe, expect, it } from 'vitest';
import { whatsappFactsByNumber, whatsappStateOf } from './whatsapp-accounts';

const number = (patch: Record<string, unknown> = {}) => ({
  phone_number: '+12025550100',
  status: 'CONNECTED',
  waba_id: 'w1',
  display_name: 'Example',
  quality_rating: 'GREEN',
  coexistence_state: null,
  ...patch,
});
const approved = { waba_id: 'w1', status: 'ACTIVE', account_review_status: 'APPROVED' };

describe('whatsappStateOf', () => {
  it('is approved for a CONNECTED number on an APPROVED account', () => {
    expect(whatsappStateOf(number(), approved)).toBe('approved');
  });

  it('is approved for an INACTIVE account whose review is APPROVED (it still sends)', () => {
    expect(whatsappStateOf(number(), { ...approved, status: 'INACTIVE' })).toBe('approved');
  });

  it('is pending while the review or the number is pending, or the account is unknown', () => {
    expect(
      whatsappStateOf(number(), {
        ...approved,
        status: 'PENDING',
        account_review_status: 'PENDING',
      }),
    ).toBe('pending');
    expect(whatsappStateOf(number({ status: 'PENDING' }), approved)).toBe('pending');
    expect(whatsappStateOf(number(), undefined)).toBe('pending');
    expect(whatsappStateOf(number({ coexistence_state: 'syncing' }), approved)).toBe('pending');
  });

  it('is rejected for a rejected review or a banned or deleted number', () => {
    expect(
      whatsappStateOf(number(), {
        ...approved,
        status: 'REJECTED',
        account_review_status: 'REJECTED',
      }),
    ).toBe('rejected');
    expect(whatsappStateOf(number({ status: 'BANNED' }), approved)).toBe('rejected');
    expect(whatsappStateOf(number({ status: 'deleted' }), approved)).toBe('rejected');
  });

  it('collects each number with its display name and quality rating', () => {
    const facts = whatsappFactsByNumber(
      [number(), number({ phone_number: '+12025550101', waba_id: 'w9', display_name: ' ' })],
      [approved],
    );
    expect(facts.get('+12025550100')).toEqual({
      state: 'approved',
      displayName: 'Example',
      qualityRating: 'GREEN',
    });
    expect(facts.get('+12025550101')).toEqual({
      state: 'pending',
      displayName: null,
      qualityRating: 'GREEN',
    });
  });
});
