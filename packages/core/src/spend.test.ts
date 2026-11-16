import { describe, expect, it } from 'vitest';
import { evaluateSpend } from './spend';

// projected = 100_000 spent + 100_000 held + 100_000 request = 300_000
const base = {
  availableMicros: 1_000_000,
  periodSpendMicros: 100_000,
  heldMicros: 100_000,
  requestMicros: 100_000,
  warnCapMicros: null,
  stopCapMicros: null,
};

describe('evaluateSpend', () => {
  it('is ok with no caps', () => {
    expect(evaluateSpend(base)).toEqual({ outcome: 'ok', reason: 'ok' });
  });

  it('stops on insufficient funds', () => {
    expect(evaluateSpend({ ...base, availableMicros: 99_999 })).toEqual({
      outcome: 'stop',
      reason: 'insufficient_funds',
    });
  });

  it('insufficient funds wins over the stop cap', () => {
    expect(evaluateSpend({ ...base, availableMicros: 0, stopCapMicros: 1 })).toEqual({
      outcome: 'stop',
      reason: 'insufficient_funds',
    });
  });

  it('allows a request exactly equal to available', () => {
    expect(evaluateSpend({ ...base, availableMicros: 100_000 }).outcome).toBe('ok');
  });

  it('stops when projected exceeds the stop cap, ok at equality', () => {
    expect(evaluateSpend({ ...base, stopCapMicros: 299_999 })).toEqual({
      outcome: 'stop',
      reason: 'stop_cap',
    });
    expect(evaluateSpend({ ...base, stopCapMicros: 300_000 })).toEqual({
      outcome: 'ok',
      reason: 'ok',
    });
  });

  it('warns when projected reaches the warn cap, including equality', () => {
    expect(evaluateSpend({ ...base, warnCapMicros: 300_000 })).toEqual({
      outcome: 'warn',
      reason: 'warn_cap',
    });
    expect(evaluateSpend({ ...base, warnCapMicros: 300_001 })).toEqual({
      outcome: 'ok',
      reason: 'ok',
    });
  });

  it('stop cap wins over warn cap', () => {
    expect(evaluateSpend({ ...base, warnCapMicros: 1, stopCapMicros: 1 })).toEqual({
      outcome: 'stop',
      reason: 'stop_cap',
    });
  });

  it('warns when under the stop cap but over the warn cap', () => {
    expect(evaluateSpend({ ...base, warnCapMicros: 200_000, stopCapMicros: 400_000 })).toEqual({
      outcome: 'warn',
      reason: 'warn_cap',
    });
  });

  it('treats a zero cap as a real cap, not off', () => {
    expect(evaluateSpend({ ...base, stopCapMicros: 0 }).outcome).toBe('stop');
    expect(evaluateSpend({ ...base, warnCapMicros: 0 }).outcome).toBe('warn');
  });
});
