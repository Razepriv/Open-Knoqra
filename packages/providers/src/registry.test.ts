import { describe, expect, it } from 'vitest';
import { isProviderId, PROVIDER_IDS, PROVIDERS } from './registry';

describe('provider registry', () => {
  it('describes every provider id under its own id', () => {
    for (const id of PROVIDER_IDS) expect(PROVIDERS[id].id).toBe(id);
  });

  it('knows only real providers', () => {
    expect(isProviderId('telnyx')).toBe(true);
    expect(isProviderId('plivo')).toBe(true);
    expect(isProviderId('fake')).toBe(false);
    expect(isProviderId('Telnyx')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });

  it('marks Plivo as built from docs, not verified on a live account', () => {
    expect(PROVIDERS.plivo.liveVerified).toBe(false);
    expect(PROVIDERS.plivo.capabilities.messaging).toBe(false);
  });
});
