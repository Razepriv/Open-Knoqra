import { defaultComplianceTexts } from '@knoqra/core';
import { describe, expect, it } from 'vitest';
import type { ChannelStatus } from '../../lib/inbox';
import { channelAction } from './channels-bar';
import { registrationRequest } from './sms-enable-dialog';

const channel = (patch: Partial<ChannelStatus>): ChannelStatus => ({
  channel: 'sms',
  state: 'not_enabled',
  address: null,
  displayName: null,
  detail: '',
  sandbox: false,
  enable: { available: true, reason: 'ok' },
  registration: null,
  ...patch,
});

describe('channelAction', () => {
  it('offers Enable, Details or Fix to managers, and nothing to others', () => {
    expect(channelAction(channel({}))).toBe('Enable');
    expect(channelAction(channel({ state: 'pending' }))).toBe('Details');
    expect(channelAction(channel({ state: 'rejected' }))).toBe('Fix');
    expect(
      channelAction(channel({ enable: { available: false, reason: 'not_manager' } })),
    ).toBeNull();
  });
});

describe('registrationRequest', () => {
  const texts = defaultComplianceTexts({ brandName: 'Pat Plumbing', email: 'pat@example.test' });
  const form = {
    entityType: 'sole_proprietor' as const,
    brandName: ' Pat Plumbing ',
    legalName: 'ignored',
    ein: '12-3456789',
    firstName: 'Pat',
    lastName: 'Lee',
    email: 'pat@example.test',
    contactPhone: '+12025550123',
    street: '1 Main St',
    city: 'Springfield',
    state: 'il',
    postalCode: '62701',
    website: '',
    vertical: 'PROFESSIONAL' as const,
    usecase: 'CUSTOMER_CARE' as const,
  };

  it('sends a sole proprietor without EIN or use case, with the prefilled CTIA texts', () => {
    const body = registrationRequest(form, texts);
    expect(body).toMatchObject({
      entityType: 'sole_proprietor',
      brandName: 'Pat Plumbing',
      firstName: 'Pat',
      state: 'IL',
    });
    expect(body).not.toHaveProperty('ein');
    expect(body).not.toHaveProperty('usecase');
    expect(body).not.toHaveProperty('website');
    expect(body.optinMessage).toMatch(/Msg & data rates may apply/);
    expect(body.optinMessage).toMatch(/STOP/);
    expect(body.helpMessage).toContain('Pat Plumbing');
  });

  it('sends a business with its legal name, EIN and use case', () => {
    const body = registrationRequest({ ...form, entityType: 'private_profit' }, texts);
    expect(body).toMatchObject({
      legalName: 'ignored',
      ein: '12-3456789',
      usecase: 'CUSTOMER_CARE',
    });
    expect(body).not.toHaveProperty('firstName');
  });
});
