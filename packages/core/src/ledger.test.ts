import { describe, expect, it } from 'vitest';
import {
  assertLedgerInvariants,
  CALL_RESERVE_MINUTES,
  callCostMicros,
  callReserveMicros,
  LEDGER_KINDS,
  type LedgerLine,
  MESSAGE_RATE_MICROS,
  messageCostMicros,
  planCapture,
  planRelease,
  planReserve,
  platformFeeMicros,
  summarizeLedger,
  VOICE_RATE_MICROS_PER_MINUTE,
} from './ledger';

const credit = (id: string, amount: number): LedgerLine => ({
  id,
  kind: 'credit',
  balanceDeltaMicros: amount,
  heldDeltaMicros: 0,
  reservationId: null,
});
const reserve = (id: string, amount: number): LedgerLine => ({
  id,
  kind: 'reserve',
  ...planReserve(amount),
  reservationId: null,
});
const capture = (id: string, of: string, hold: number, cost: number): LedgerLine => ({
  id,
  kind: 'capture',
  ...planCapture(hold, cost),
  reservationId: of,
});
const release = (id: string, of: string, hold: number): LedgerLine => ({
  id,
  kind: 'release',
  ...planRelease(hold),
  reservationId: of,
});

describe('rates', () => {
  it('exposes the voice rate and reserve', () => {
    expect(VOICE_RATE_MICROS_PER_MINUTE).toBe(10_000);
    expect(CALL_RESERVE_MINUTES).toBe(10);
    expect(callReserveMicros()).toBe(100_000);
    expect(LEDGER_KINDS).toEqual(['credit', 'adjust', 'reserve', 'capture', 'release', 'fee']);
  });

  it('adds the platform fee for the reserved minutes to the call hold', () => {
    expect(callReserveMicros(0)).toBe(100_000);
    expect(callReserveMicros(4_000)).toBe(140_000);
  });
});

describe('platform fee', () => {
  it('charges every started minute at the rate', () => {
    expect(platformFeeMicros(0, 4_000)).toBe(0);
    expect(platformFeeMicros(1, 4_000)).toBe(4_000);
    expect(platformFeeMicros(60, 4_000)).toBe(4_000);
    expect(platformFeeMicros(61, 4_000)).toBe(8_000);
    expect(platformFeeMicros(3_600, 4_000)).toBe(240_000);
    expect(platformFeeMicros(125, 0)).toBe(0);
  });
});

describe('message rates', () => {
  it('are flat estimates: $0.01 per SMS and $0.05 per WhatsApp message', () => {
    expect(MESSAGE_RATE_MICROS).toEqual({ sms: 10_000, whatsapp: 50_000 });
    expect(messageCostMicros('sms')).toBe(10_000);
    expect(messageCostMicros('whatsapp')).toBe(50_000);
  });

  it('cost a positive whole number of micros for every channel', () => {
    for (const channel of ['sms', 'whatsapp'] as const) {
      expect(Number.isSafeInteger(messageCostMicros(channel))).toBe(true);
      expect(messageCostMicros(channel)).toBeGreaterThan(0);
    }
  });
});

describe('callCostMicros', () => {
  it.each([
    [0, 0],
    [1, 10_000],
    [59, 10_000],
    [60, 10_000],
    [61, 20_000],
    [600, 100_000],
  ])('%i seconds costs %i micros', (seconds, cost) => {
    expect(callCostMicros(seconds)).toBe(cost);
  });

  it('honours a custom rate', () => {
    expect(callCostMicros(61, 5)).toBe(10);
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s seconds', (s) => {
    expect(() => callCostMicros(s)).toThrow(RangeError);
  });

  it('rejects a bad rate', () => {
    expect(() => callCostMicros(60, -1)).toThrow(RangeError);
    expect(() => callCostMicros(60, 0.5)).toThrow(RangeError);
  });
});

describe('plans', () => {
  it('computes deltas', () => {
    expect(planReserve(100_000)).toEqual({ balanceDeltaMicros: 0, heldDeltaMicros: 100_000 });
    expect(planCapture(100_000, 20_000)).toEqual({
      balanceDeltaMicros: -20_000,
      heldDeltaMicros: -100_000,
    });
    expect(planRelease(100_000)).toEqual({ balanceDeltaMicros: 0, heldDeltaMicros: -100_000 });
  });

  it('rejects invalid amounts', () => {
    expect(() => planReserve(-1)).toThrow(RangeError);
    expect(() => planReserve(1.5)).toThrow(RangeError);
    expect(() => planCapture(-1, 0)).toThrow(RangeError);
    expect(() => planCapture(10, 1.5)).toThrow(RangeError);
    expect(() => planRelease(0.1)).toThrow(RangeError);
    expect(() => planRelease(-5)).toThrow(RangeError);
  });
});

describe('summarizeLedger', () => {
  it('credit, reserve, capture gives an exact balance', () => {
    const lines = [
      credit('a', 5_000_000),
      reserve('b', 100_000),
      capture('c', 'b', 100_000, 20_000),
    ];
    expect(summarizeLedger(lines)).toEqual({
      balanceMicros: 4_980_000,
      heldMicros: 0,
      availableMicros: 4_980_000,
    });
    expect(() => assertLedgerInvariants(lines)).not.toThrow();
  });

  it('reserve then release restores available', () => {
    const base = [credit('a', 5_000_000)];
    const held = [...base, reserve('b', 100_000)];
    expect(summarizeLedger(held).availableMicros).toBe(4_900_000);
    const released = [...held, release('c', 'b', 100_000)];
    expect(summarizeLedger(released)).toEqual(summarizeLedger(base));
  });

  it('is empty-safe', () => {
    expect(summarizeLedger([])).toEqual({ balanceMicros: 0, heldMicros: 0, availableMicros: 0 });
  });
});

describe('assertLedgerInvariants', () => {
  it('rejects a second settlement for one reserve', () => {
    const lines = [
      credit('a', 1_000_000),
      reserve('b', 100_000),
      capture('c', 'b', 100_000, 10_000),
      release('d', 'b', 100_000),
    ];
    expect(() => assertLedgerInvariants(lines)).toThrow(/settle/i);
  });

  it('rejects a settlement without a reserve', () => {
    expect(() => assertLedgerInvariants([release('x', 'missing', 10)])).toThrow(/reserve/i);
    const noRef: LedgerLine = { ...release('x', 'b', 10), reservationId: null };
    expect(() => assertLedgerInvariants([noRef])).toThrow(/reserve/i);
  });

  it('rejects a settlement that references a non-reserve line', () => {
    const lines = [credit('a', 100), release('r', 'a', 100)];
    expect(() => assertLedgerInvariants(lines)).toThrow(/reserve/i);
  });

  it('rejects a settlement that does not free the reserved amount', () => {
    const lines = [reserve('b', 100_000), { ...release('c', 'b', 100_000), heldDeltaMicros: -5 }];
    expect(() => assertLedgerInvariants(lines)).toThrow(/held/i);
  });

  it('rejects negative held', () => {
    expect(() => assertLedgerInvariants([{ ...credit('a', 0), heldDeltaMicros: -1 }])).toThrow(
      /negative/i,
    );
  });

  it('accepts adjust lines and open reserves', () => {
    const adjust: LedgerLine = { ...credit('a', 50), kind: 'adjust' };
    expect(() => assertLedgerInvariants([adjust, reserve('b', 10)])).not.toThrow();
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ledger properties', () => {
  it('random sequences keep invariants and available = balance - held', () => {
    const rand = mulberry32(1234);
    for (let run = 0; run < 200; run++) {
      const lines: LedgerLine[] = [];
      const open = new Map<string, number>();
      let n = 0;
      for (let step = 0; step < 40; step++) {
        const roll = rand();
        const id = `l${n++}`;
        if (roll < 0.3) {
          lines.push(credit(id, Math.floor(rand() * 1_000_000)));
        } else if (roll < 0.65 || open.size === 0) {
          const amount = callReserveMicros();
          lines.push(reserve(id, amount));
          open.set(id, amount);
        } else {
          const keys = [...open.keys()];
          const key = keys[Math.floor(rand() * keys.length)] as string;
          const hold = open.get(key) as number;
          open.delete(key);
          lines.push(
            rand() < 0.5
              ? release(id, key, hold)
              : capture(id, key, hold, callCostMicros(Math.floor(rand() * 600))),
          );
        }
        expect(() => assertLedgerInvariants(lines)).not.toThrow();
        const s = summarizeLedger(lines);
        expect(s.availableMicros).toBe(s.balanceMicros - s.heldMicros);
        expect(s.heldMicros).toBe([...open.values()].reduce((a, b) => a + b, 0));
      }
    }
  });
});
