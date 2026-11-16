import { describe, expect, it } from 'vitest';
import { capabilityTiles, type PhoneNumber } from './numbers';

const base: PhoneNumber = {
  id: 'num_1',
  e164: '+12025550100',
  provider: 'fake',
  status: 'active',
  capabilities: { voice: true, sms: true, mms: false, whatsapp: false },
  tenDlcStatus: 'registered',
  whatsappStatus: 'none',
  assignedUse: 'calls_and_messages',
  lastSyncedAt: null,
};
const pass = (id: string) => ({ id, status: 'pass' as const, detail: 'ok' });

describe('capabilityTiles', () => {
  it('marks voice, sms ready and mms, whatsapp not', () => {
    const tiles = capabilityTiles(
      [pass('number'), pass('ten_dlc'), { id: 'whatsapp', status: 'fail', detail: 'No WhatsApp.' }],
      [base],
    );
    expect(tiles.map((tile) => [tile.id, tile.ready])).toEqual([
      ['voice', true],
      ['sms', true],
      ['mms', false],
      ['whatsapp', false],
    ]);
    expect(tiles[3]?.reason).toBe('No WhatsApp.');
  });

  it('needs an assigned number for messaging', () => {
    const tiles = capabilityTiles([pass('ten_dlc')], [{ ...base, assignedUse: 'calls' }]);
    expect(tiles[1]?.ready).toBe(false);
    expect(tiles[1]?.reason).toBe('Assign a number for messages first.');
  });

  it('uses the 10DLC detail while it is pending', () => {
    const tiles = capabilityTiles(
      [{ id: 'ten_dlc', status: 'pending', detail: 'Registration is pending.' }],
      [base],
    );
    expect(tiles[1]).toMatchObject({ ready: false, reason: 'Registration is pending.' });
  });
});
