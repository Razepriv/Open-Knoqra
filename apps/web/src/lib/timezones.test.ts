import { describe, expect, it } from 'vitest';
import { timeZoneOptions } from './timezones';

describe('timeZoneOptions', () => {
  it('lists IANA zones, sorted, including UTC', () => {
    const zones = timeZoneOptions(null);
    expect(zones).toContain('Europe/Lisbon');
    expect(zones).toContain('UTC');
    expect([...zones]).toEqual([...zones].sort());
  });

  it('keeps a saved zone selectable even if this runtime does not list it', () => {
    expect(timeZoneOptions('Mars/Olympus_Mons')).toContain('Mars/Olympus_Mons');
  });

  it('does not duplicate a zone that is already listed', () => {
    const zones = timeZoneOptions('Europe/Lisbon');
    expect(zones.filter((z) => z === 'Europe/Lisbon')).toHaveLength(1);
  });
});
