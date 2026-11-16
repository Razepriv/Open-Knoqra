import { describe, expect, it } from 'vitest';
import {
  initialStep,
  isFakeProvider,
  nextStep,
  parseSetupStep,
  SETUP_STEP_LABELS,
  SETUP_STEPS,
  setupPath,
  stepToPin,
} from './setup';

describe('setupPath', () => {
  it('returns the bare path without a step', () => {
    expect(setupPath()).toBe('/setup');
  });
  it.each(SETUP_STEPS)('adds the %s step', (step) => {
    expect(setupPath(step)).toBe(`/setup?step=${step}`);
  });
});

describe('SETUP_STEP_LABELS', () => {
  it('names the four steps', () => {
    expect(SETUP_STEP_LABELS).toEqual({
      connect: 'Connect Telnyx',
      number: 'Choose a number',
      audio: 'Test audio',
      test_call: 'Test call',
    });
  });
});

describe('parseSetupStep', () => {
  it('keeps a known step and drops anything else', () => {
    expect(parseSetupStep('audio')).toBe('audio');
    expect(parseSetupStep('nope')).toBeUndefined();
    expect(parseSetupStep(3)).toBeUndefined();
    expect(parseSetupStep(undefined)).toBeUndefined();
  });
});

describe('initialStep', () => {
  it('prefers the URL, then where the person left off, then the first step not done', () => {
    expect(initialStep('audio', { currentStep: 'number', lastStep: 'connect' })).toBe('audio');
    expect(initialStep(undefined, { currentStep: 'connect', lastStep: 'number' })).toBe('number');
    expect(initialStep(undefined, { currentStep: 'number', lastStep: null })).toBe('number');
    expect(initialStep(undefined, { currentStep: null, lastStep: null })).toBe('connect');
  });
});

describe('nextStep', () => {
  it('moves forward and stops at the last step', () => {
    expect(nextStep('connect')).toBe('number');
    expect(nextStep('audio')).toBe('test_call');
    expect(nextStep('test_call')).toBeUndefined();
  });
});

describe('isFakeProvider', () => {
  const check = (detail: string) => ({
    checks: [
      {
        id: 'credential' as const,
        status: 'pass' as const,
        title: 'Telnyx key',
        detail,
        fix: null,
      },
    ],
  });
  it('reads the credential check', () => {
    expect(isFakeProvider(check('Saved. Calls use the fake provider in development.'))).toBe(true);
    expect(isFakeProvider(check('Saved and accepted by Telnyx.'))).toBe(false);
    expect(isFakeProvider({ checks: [] })).toBe(false);
  });
});

describe('stepToPin', () => {
  it('pins the step the visit opened on when the URL names none', () => {
    expect(stepToPin(undefined, { currentStep: 'connect', lastStep: null })).toBe('connect');
    expect(stepToPin(undefined, { currentStep: 'connect', lastStep: 'audio' })).toBe('audio');
  });
  it('leaves a URL step alone', () => {
    expect(stepToPin('number', { currentStep: 'connect', lastStep: null })).toBeUndefined();
  });
});
