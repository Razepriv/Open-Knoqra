import { describe, expect, it } from 'vitest';
import { analyticsRoute } from './start';

describe('analyticsRoute', () => {
  it('strips the pathless /_app layout and keeps the root', () => {
    expect(analyticsRoute('/_app/contacts/$contactId')).toBe('/contacts/$contactId');
    expect(analyticsRoute('/_app')).toBe('/');
    expect(analyticsRoute('/')).toBe('/');
    expect(analyticsRoute('/sign-in')).toBe('/sign-in');
    expect(analyticsRoute('/_application')).toBe('/_application');
  });
});
