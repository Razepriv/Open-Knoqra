import { describe, expect, it } from 'vitest';
import { fillTemplate } from '../src/fixtures-template';
import type { Fixtures } from '../src/seed/fixtures';

const fixtures = {
  ids: { heavy: 'ct_abc', middle: 'ct_mid' },
  search: { name: 'ann lee & co' },
  cursors: { contactsDeep: 'a+b/c=' },
} as unknown as Fixtures;

describe('fillTemplate', () => {
  it('resolves dotted paths', () => {
    expect(fillTemplate('/c/{ids.heavy}/t?x={ids.middle}', fixtures)).toBe('/c/ct_abc/t?x=ct_mid');
  });

  it('URL-encodes values', () => {
    expect(fillTemplate('q={search.name}&cursor={cursors.contactsDeep}', fixtures)).toBe(
      'q=ann%20lee%20%26%20co&cursor=a%2Bb%2Fc%3D',
    );
  });

  it('throws on an unknown path', () => {
    expect(() => fillTemplate('{ids.nope}', fixtures)).toThrow('unknown placeholder {ids.nope}');
  });
});
