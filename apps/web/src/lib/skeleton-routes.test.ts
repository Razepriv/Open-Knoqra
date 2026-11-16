import { describe, expect, it } from 'vitest';
import { appSkeletonFor, authSkeletonFor } from './skeleton-routes';

describe('authSkeletonFor', () => {
  it('names each auth page, with or without a trailing slash', () => {
    expect(authSkeletonFor('/sign-in')).toBe('sign-in');
    expect(authSkeletonFor('/sign-up/')).toBe('sign-up');
    expect(authSkeletonFor('/forgot-password')).toBe('forgot-password');
    expect(authSkeletonFor('/reset-password')).toBe('reset-password');
    expect(authSkeletonFor('/two-factor')).toBe('two-factor');
  });

  it('is null for signed-in pages and look-alikes', () => {
    expect(authSkeletonFor('/')).toBeNull();
    expect(authSkeletonFor('/contacts')).toBeNull();
    expect(authSkeletonFor('/sign-in/extra')).toBeNull();
    expect(authSkeletonFor('/sign-inx')).toBeNull();
  });
});

describe('appSkeletonFor', () => {
  it('maps each signed-in page to its outline', () => {
    expect(appSkeletonFor('/')).toBe('today');
    expect(appSkeletonFor('/tasks')).toBe('tasks');
    expect(appSkeletonFor('/contacts')).toBe('contacts');
    expect(appSkeletonFor('/contacts/')).toBe('contacts');
    expect(appSkeletonFor('/contacts/import')).toBe('contacts-import');
    expect(appSkeletonFor('/contacts/3f1c')).toBe('contact-360');
    expect(appSkeletonFor('/settings')).toBe('settings');
    expect(appSkeletonFor('/calls')).toBe('calls');
    expect(appSkeletonFor('/usage/')).toBe('usage');
    expect(appSkeletonFor('/numbers')).toBe('numbers');
    expect(appSkeletonFor('/setup')).toBe('setup');
  });

  it('gives the Inbox its thread outline only when a thread is open', () => {
    expect(appSkeletonFor('/inbox')).toBe('inbox');
    expect(appSkeletonFor('/inbox', '?filter=unread')).toBe('inbox');
    expect(appSkeletonFor('/inbox', '?thread=')).toBe('inbox');
    expect(appSkeletonFor('/inbox', '?filter=all&thread=c1')).toBe('inbox-thread');
  });

  it('gives unknown paths the default outline', () => {
    for (const path of ['/nowhere', '/callsx', '/contactsx']) {
      expect(appSkeletonFor(path)).toBe('app-default');
    }
  });
});
