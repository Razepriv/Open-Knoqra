import { describe, expect, it } from 'vitest';
import { classifyKeyword } from './keywords';

describe('classifyKeyword', () => {
  it.each([
    [' stop. ', 'stop'],
    ['Stop!', 'stop'],
    ['unsubscribe', 'stop'],
    ['STOPALL', 'stop'],
    ['cancel', 'stop'],
    ['end', 'stop'],
    ['quit', 'stop'],
    ['optout', 'stop'],
    ['revoke', 'stop'],
    ['Unstop', 'start'],
    ['START', 'start'],
    ['  ?start;: ', 'start'],
  ])('%j -> %s', (body, expected) => {
    expect(classifyKeyword(body)).toBe(expected);
  });
  it.each(['please stop by later', 'stopp', '', '   ', '...', 'STOP STOP'])(
    '%j -> null',
    (body) => {
      expect(classifyKeyword(body)).toBeNull();
    },
  );
});
