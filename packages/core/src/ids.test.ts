import { describe, expect, it } from 'vitest';
import { newId } from './ids';

describe('newId', () => {
  it('has prefix and 32 hex chars', () => {
    expect(newId('ct')).toMatch(/^ct_[0-9a-f]{32}$/);
    expect(newId('ae')).toMatch(/^ae_[0-9a-f]{32}$/);
    expect(newId('pe')).toMatch(/^pe_[0-9a-f]{32}$/);
    expect(newId('ct')).not.toBe(newId('ct'));
  });
});

describe('newId M1 prefixes', () => {
  it.each(['cp', 'te', 'dd'] as const)('supports %s', (prefix) => {
    expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  });
});

describe('newId M4 prefixes', () => {
  it.each(['pn', 'bs', 'pu', 'rc'] as const)('supports %s', (prefix) => {
    expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9a-f]{32}$`));
  });
});
