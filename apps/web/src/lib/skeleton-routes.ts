/** Which loading outline a path gets, before its route has rendered anything. */

export type AuthSkeletonId =
  | 'sign-in'
  | 'sign-up'
  | 'forgot-password'
  | 'reset-password'
  | 'two-factor';

export type AppSkeletonId =
  | 'today'
  | 'tasks'
  | 'contacts'
  | 'contact-360'
  | 'contacts-import'
  | 'settings'
  | 'calls'
  | 'inbox'
  | 'inbox-thread'
  | 'usage'
  | 'numbers'
  | 'setup'
  | 'app-default';

const AUTH_IDS: readonly AuthSkeletonId[] = [
  'sign-in',
  'sign-up',
  'forgot-password',
  'reset-password',
  'two-factor',
];

const trimmed = (pathname: string): string => pathname.replace(/\/+$/, '') || '/';

/** The auth page a path belongs to, or null for a signed-in page. A trailing slash is ignored. */
export function authSkeletonFor(pathname: string): AuthSkeletonId | null {
  const page = trimmed(pathname).slice(1);
  return AUTH_IDS.find((id) => id === page) ?? null;
}

const PAGES: Readonly<Record<string, AppSkeletonId>> = {
  '/': 'today',
  '/tasks': 'tasks',
  '/contacts': 'contacts',
  '/contacts/import': 'contacts-import',
  '/settings': 'settings',
  '/calls': 'calls',
  '/usage': 'usage',
  '/numbers': 'numbers',
  '/setup': 'setup',
};

/**
 * Which page outline a signed-in path gets. The search string matters for the Inbox only: an open
 * thread (`?thread=`) brings the contact ribbon. Unknown paths get the default outline.
 */
export function appSkeletonFor(pathname: string, search = ''): AppSkeletonId {
  const path = trimmed(pathname);
  if (path === '/inbox') {
    return new URLSearchParams(search).get('thread') ? 'inbox-thread' : 'inbox';
  }
  if (path.startsWith('/contacts/') && path !== '/contacts/import') return 'contact-360';
  return PAGES[path] ?? 'app-default';
}
