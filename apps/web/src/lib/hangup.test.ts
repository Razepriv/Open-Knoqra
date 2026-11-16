import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { HANGUP_FALLBACK_MS, type HangupSteps, hangupCall, isPreConnect } from './hangup';

function steps(over: Partial<HangupSteps> = {}) {
  let pending: (() => void) | null = null;
  let state: string | undefined = 'ringing';
  const order: string[] = [];
  const plan: HangupSteps = {
    callId: 'cl_a',
    neverDialed: false,
    endLeg: vi.fn(async () => {
      order.push('endLeg');
    }),
    cancel: vi.fn(async () => {
      order.push('cancel');
    }),
    stateOf: vi.fn(() => state),
    report: vi.fn(),
    later: vi.fn((fn: () => void) => {
      pending = fn;
    }),
    ...over,
  };
  return {
    plan,
    order,
    setState: (next: string | undefined) => {
      state = next;
    },
    /** Runs the scheduled fallback and lets its cancel settle. */
    fire: async () => {
      pending?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('isPreConnect', () => {
  it.each([
    ['queued', true],
    ['initiating', true],
    ['ringing', true],
    ['connected', false],
    ['ending', false],
    ['completed', false],
    ['canceled', false],
  ])('%s is pre-connect: %s', (state, expected) => {
    expect(isPreConnect(state)).toBe(expected);
  });
});

describe('hangupCall', () => {
  it('ends the provider leg first and never cancels a dialed call at once', async () => {
    const { plan, order } = steps();
    await hangupCall(plan);
    expect(order).toEqual(['endLeg']);
    expect(plan.endLeg).toHaveBeenCalledWith('cl_a');
    expect(plan.later).toHaveBeenCalledWith(expect.any(Function), HANGUP_FALLBACK_MS);
    expect(HANGUP_FALLBACK_MS).toBe(10_000);
  });

  it('cancels when the call is still pre-connect after the fallback wait', async () => {
    const { plan, order, fire } = steps();
    await hangupCall(plan);
    await fire();
    expect(order).toEqual(['endLeg', 'cancel']);
    expect(plan.cancel).toHaveBeenCalledWith('cl_a');
  });

  it.each([['completed'], ['canceled'], ['connected'], ['ending'], [undefined]])(
    'leaves a call that is %s by the fallback wait to the provider',
    async (state) => {
      const { plan, fire, setState } = steps();
      await hangupCall(plan);
      setState(state);
      await fire();
      expect(plan.cancel).not.toHaveBeenCalled();
    },
  );

  it('stays quiet when the fallback cancel finds the call already moved on', async () => {
    const { plan, fire } = steps({
      cancel: vi.fn(async () => {
        throw new ApiError(409, 'no', 'invalid_state');
      }),
    });
    await hangupCall(plan);
    await fire();
    expect(plan.report).not.toHaveBeenCalled();
  });

  it('reports a fallback cancel that failed for another reason', async () => {
    const failure = new ApiError(500, 'down', 'internal_error');
    const { plan, fire } = steps({
      cancel: vi.fn(async () => {
        throw failure;
      }),
    });
    await hangupCall(plan);
    await fire();
    expect(plan.report).toHaveBeenCalledWith(failure);
  });

  it('reports a failed leg hangup, then cancels at once while pre-connect', async () => {
    const failure = new Error('sdk refused');
    const { plan, order } = steps({
      endLeg: vi.fn(async () => {
        throw failure;
      }),
    });
    await hangupCall(plan);
    expect(plan.report).toHaveBeenCalledWith(failure);
    expect(order).toEqual(['cancel']);
    expect(plan.later).not.toHaveBeenCalled();
  });

  it('reports a failed leg hangup of a connected call without canceling it', async () => {
    const failure = new Error('sdk refused');
    const { plan, setState } = steps({
      endLeg: vi.fn(async () => {
        throw failure;
      }),
    });
    setState('connected');
    await hangupCall(plan);
    expect(plan.report).toHaveBeenCalledWith(failure);
    expect(plan.cancel).not.toHaveBeenCalled();
  });

  it('only cancels a call that never reached the provider', async () => {
    const { plan, order } = steps({ neverDialed: true });
    await hangupCall(plan);
    expect(order).toEqual(['cancel']);
    expect(plan.endLeg).not.toHaveBeenCalled();
    expect(plan.later).not.toHaveBeenCalled();
  });

  it('rejects when a never-dialed call could not be canceled', async () => {
    const failure = new ApiError(500, 'down', 'internal_error');
    const { plan } = steps({
      neverDialed: true,
      cancel: vi.fn(async () => {
        throw failure;
      }),
    });
    await expect(hangupCall(plan)).rejects.toBe(failure);
  });
});
