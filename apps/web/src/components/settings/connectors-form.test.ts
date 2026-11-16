import { describe, expect, it } from 'vitest';
import type { ConnectorProvider } from '../../lib/connectors';
import { toInput, validate } from './connectors-section';

const field = (name: string, label: string, secret = false, required = true) => ({
  name,
  label,
  secret,
  required,
  hint: '',
});

const PLIVO: ConnectorProvider = {
  id: 'plivo',
  label: 'Plivo',
  liveVerified: false,
  capabilities: {
    voice: true,
    numbers: true,
    purchase: true,
    balance: true,
    usage: true,
    messaging: false,
  },
  fields: [
    field('authId', 'Auth ID'),
    field('authToken', 'Auth token', true),
    field('appId', 'Application id'),
    field('callerIdE164', 'Caller id'),
  ],
};

const TELNYX: ConnectorProvider = {
  ...PLIVO,
  id: 'telnyx',
  label: 'Telnyx',
  liveVerified: true,
  fields: [
    field('apiKey', 'API key', true),
    field('connectionId', 'Credential connection id'),
    field('callerIdE164', 'Caller id'),
    field('webhookPublicKey', 'Webhook public key', false, false),
  ],
};

describe('connector form', () => {
  it('asks for every required field, in the label’s own words', () => {
    expect(validate(PLIVO, {})).toEqual({
      authId: 'Enter the auth ID.',
      authToken: 'Enter the auth token.',
      appId: 'Enter the application id.',
      callerIdE164: 'Enter the caller id.',
    });
    expect(validate(TELNYX, {}).apiKey).toBe('Enter the API key.');
    expect(validate(TELNYX, {}).webhookPublicKey).toBeUndefined();
  });

  it('refuses a secret with spaces and a caller id without a country code', () => {
    const errors = validate(PLIVO, {
      authId: 'MAUNITONLYAUTHID0000',
      authToken: 'has a space',
      appId: 'app',
      callerIdE164: '12',
    });
    expect(errors.authToken).toBe('Paste it without spaces.');
    expect(errors.callerIdE164).toBe(
      'Enter a full number with country code, like +1 202 555 0123.',
    );
  });

  it('sends each provider its own body, with the caller id in E.164', () => {
    expect(
      toInput('plivo', {
        authId: ' MAUNITONLYAUTHID0000 ',
        authToken: 'tok',
        appId: ' app-1 ',
        callerIdE164: '+1 202 555 0123',
      }),
    ).toEqual({
      provider: 'plivo',
      body: {
        authId: 'MAUNITONLYAUTHID0000',
        authToken: 'tok',
        appId: 'app-1',
        callerIdE164: '+12025550123',
      },
    });
    expect(
      toInput('telnyx', {
        apiKey: 'KEY',
        connectionId: '1',
        callerIdE164: '+12025550123',
        webhookPublicKey: '',
      }),
    ).toEqual({
      provider: 'telnyx',
      body: { apiKey: 'KEY', connectionId: '1', callerIdE164: '+12025550123' },
    });
  });
});
