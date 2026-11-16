import { describe, expect, it } from 'vitest';
import { isNavActive, NAV_ITEMS, SETTINGS_ITEM } from './nav-items';

const item = (label: string) => {
  const found = [...NAV_ITEMS, SETTINGS_ITEM].find((i) => i.label === label);
  if (!found) throw new Error(`no nav item ${label}`);
  return found;
};

describe('nav items', () => {
  it('lists the rail in Desk order with Settings kept apart', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Today',
      'Inbox',
      'Calls',
      'Contacts',
      'Usage',
      'Numbers',
    ]);
    expect(SETTINGS_ITEM.to).toBe('/settings');
  });

  it('marks Today active only on the exact home path', () => {
    expect(isNavActive('/', item('Today'))).toBe(true);
    expect(isNavActive('/inbox', item('Today'))).toBe(false);
  });

  it('marks a section active on its own path and below it', () => {
    expect(isNavActive('/contacts', item('Contacts'))).toBe(true);
    expect(isNavActive('/contacts/ct_123', item('Contacts'))).toBe(true);
    expect(isNavActive('/contacts/import', item('Contacts'))).toBe(true);
    expect(isNavActive('/contactsx', item('Contacts'))).toBe(false);
    expect(isNavActive('/settings/security', SETTINGS_ITEM)).toBe(true);
  });
});
