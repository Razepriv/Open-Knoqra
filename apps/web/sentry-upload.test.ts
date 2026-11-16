import { describe, expect, it } from 'vitest';
import { sentryUploadConfig } from './sentry-upload';

const ALL = {
  SENTRY_AUTH_TOKEN: 'test-token',
  SENTRY_ORG: 'knoqra-test',
  SENTRY_PROJECT: 'desk',
};

describe('sentryUploadConfig', () => {
  it('is null without any upload keys', () => {
    expect(sentryUploadConfig({})).toBeNull();
  });

  it('returns the upload settings when all three keys are set', () => {
    expect(sentryUploadConfig(ALL)).toEqual({
      org: 'knoqra-test',
      project: 'desk',
      authToken: 'test-token',
    });
    expect(sentryUploadConfig({ ...ALL, VITE_SENTRY_RELEASE: 'abc123' })).toEqual({
      org: 'knoqra-test',
      project: 'desk',
      authToken: 'test-token',
      release: 'abc123',
    });
  });

  it('is null when any one of the three is missing or blank', () => {
    expect(sentryUploadConfig({ ...ALL, SENTRY_AUTH_TOKEN: undefined })).toBeNull();
    expect(sentryUploadConfig({ ...ALL, SENTRY_ORG: undefined })).toBeNull();
    expect(sentryUploadConfig({ ...ALL, SENTRY_PROJECT: ' ' })).toBeNull();
  });
});
