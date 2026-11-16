export type SpendDecision = {
  outcome: 'ok' | 'warn' | 'stop';
  reason:
    | 'ok'
    | 'warn_cap'
    | 'stop_cap'
    | 'insufficient_funds'
    | 'provider_low'
    | 'provider_exhausted';
};

export type SpendInput = {
  availableMicros: number;
  periodSpendMicros: number;
  heldMicros: number;
  requestMicros: number;
  warnCapMicros: number | null;
  stopCapMicros: number | null;
};

/**
 * Projected spend = captured this month + currently held + the new request.
 * Order: insufficient funds, then stop cap (projected > cap), then warn cap
 * (projected >= cap). A null cap is off.
 */
export function evaluateSpend(input: SpendInput): SpendDecision {
  const projected = input.periodSpendMicros + input.heldMicros + input.requestMicros;
  if (input.requestMicros > input.availableMicros) {
    return { outcome: 'stop', reason: 'insufficient_funds' };
  }
  if (input.stopCapMicros !== null && projected > input.stopCapMicros) {
    return { outcome: 'stop', reason: 'stop_cap' };
  }
  if (input.warnCapMicros !== null && projected >= input.warnCapMicros) {
    return { outcome: 'warn', reason: 'warn_cap' };
  }
  return { outcome: 'ok', reason: 'ok' };
}
