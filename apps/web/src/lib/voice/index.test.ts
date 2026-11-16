import { describe, expect, it } from 'vitest';
import { fakeOutboundScenario } from './fake-scenario';
import { createVoiceClient, FakeVoiceClient, TelnyxVoiceClient } from './index';

describe('createVoiceClient', () => {
  it('picks the client for the provider', () => {
    expect(createVoiceClient('fake')).toBeInstanceOf(FakeVoiceClient);
    expect(createVoiceClient('telnyx')).toBeInstanceOf(TelnyxVoiceClient);
  });
});

describe('fakeOutboundScenario', () => {
  it('chooses by the last four digits, like the server rule', () => {
    expect(fakeOutboundScenario('+12025550190')).toBe('busy');
    expect(fakeOutboundScenario('+12025550191')).toBe('no_answer');
    expect(fakeOutboundScenario('+12025550192')).toBe('failed');
    expect(fakeOutboundScenario('+12025550123')).toBe('answered');
  });
});
