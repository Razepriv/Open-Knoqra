import { Hash, House, Inbox, type LucideIcon, Phone, Settings, Users, Wallet } from 'lucide-react';

/**
 * Paths of pages that other branches add. Typed as plain `string` so links to them compile before
 * their routes exist; once merged, the router's typed `to` can take over.
 */
export const CONTACTS_PATH: string = '/contacts';
export const CONTACTS_IMPORT_PATH: string = '/contacts/import';
export const SETTINGS_PATH: string = '/settings';

export interface NavItem {
  label: string;
  /** A plain string: the Contacts, Settings and Import pages are built on other branches. */
  to: string;
  icon: LucideIcon;
  /** Active only on this exact path, not on paths below it. */
  exact?: boolean;
}

/** The rail, in the order the Desk export shows it. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Today', to: '/', icon: House, exact: true },
  { label: 'Inbox', to: '/inbox', icon: Inbox },
  { label: 'Calls', to: '/calls', icon: Phone },
  { label: 'Contacts', to: CONTACTS_PATH, icon: Users },
  { label: 'Usage', to: '/usage', icon: Wallet },
  { label: 'Numbers', to: '/numbers', icon: Hash },
];

/** Pinned at the bottom of the rail. */
export const SETTINGS_ITEM: NavItem = { label: 'Settings', to: SETTINGS_PATH, icon: Settings };

export function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
