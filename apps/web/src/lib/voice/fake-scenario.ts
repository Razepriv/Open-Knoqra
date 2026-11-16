export type FakeOutboundScenario = 'answered' | 'busy' | 'no_answer' | 'failed';

/**
 * How a fake outbound call ends, from the destination's last four digits. A copy of
 * `fakeOutboundScenario` in `@knoqra/providers` (packages/providers/src/fake.ts), which is the
 * source of truth: the web bundle must not depend on server packages. Keep the two in step.
 */
export function fakeOutboundScenario(toE164: string): FakeOutboundScenario {
  switch (toE164.slice(-4)) {
    case '0190':
      return 'busy';
    case '0191':
      return 'no_answer';
    case '0192':
      return 'failed';
    default:
      return 'answered';
  }
}
