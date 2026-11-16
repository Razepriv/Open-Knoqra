import { describe, expect, it } from 'vitest';
import { currentContacts, paletteActions } from './palette';

describe('paletteActions', () => {
  it('lists every destination and offers no task for an empty query', () => {
    const a = paletteActions('');
    expect(a.createTask).toBeNull();
    expect(a.navigate.map((n) => n.label)).toEqual([
      'Today',
      'Inbox',
      'Calls',
      'Contacts',
      'Tasks',
      'Usage',
      'Numbers',
      'Settings',
    ]);
    expect(a.navigate.find((n) => n.label === 'Tasks')?.to).toBe('/tasks');
  });

  it('trims the query into a task title', () => {
    expect(paletteActions('  Call Maya  ').createTask).toBe('Call Maya');
    expect(paletteActions('   ').createTask).toBeNull();
  });

  it('refuses a title over 200 characters', () => {
    expect(paletteActions('a'.repeat(200)).createTask).toBe('a'.repeat(200));
    expect(paletteActions('a'.repeat(201)).createTask).toBeNull();
  });

  it('filters destinations by label, ignoring case', () => {
    expect(paletteActions('TASK').navigate.map((n) => n.label)).toEqual(['Tasks']);
    expect(paletteActions('zzz').navigate).toEqual([]);
  });
});

describe('currentContacts', () => {
  const base = { query: 'ines', debounced: 'ines', isPlaceholderData: false, items: [1, 2, 3] };

  it('shows the rows once they belong to the typed query', () => {
    expect(currentContacts(base, 2)).toEqual([1, 2]);
  });

  it('hides rows while the debounce has not caught up with the typed text', () => {
    expect(currentContacts({ ...base, query: ' inesa ' }, 5)).toEqual([]);
  });

  it('hides rows kept from a previous query while the new fetch runs', () => {
    expect(currentContacts({ ...base, isPlaceholderData: true }, 5)).toEqual([]);
  });

  it('shows nothing for an empty query', () => {
    expect(currentContacts({ ...base, query: '  ', debounced: '' }, 5)).toEqual([]);
  });
});
