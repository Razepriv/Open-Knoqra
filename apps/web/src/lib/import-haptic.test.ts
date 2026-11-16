import { describe, expect, it } from 'vitest';
import { importHaptic } from './import-haptic';

describe('importHaptic', () => {
  it('vibrates success only for a completed import', () => {
    expect(importHaptic('completed')).toBe('success');
  });
  it('vibrates error for a failed import', () => {
    expect(importHaptic('failed')).toBe('error');
  });
  it('stays silent for a cancelled import', () => {
    expect(importHaptic('cancelled')).toBeNull();
  });
});
