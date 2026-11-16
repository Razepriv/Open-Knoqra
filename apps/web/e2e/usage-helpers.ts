import { expect, type Page } from '@playwright/test';

// Shared by the Usage and reconciliation specs. Calls run on the fake provider: the dev endpoint
// signs and ingests provider events, so the real pipeline (queue, state machine, ledger) runs.

export const PIPELINE = { timeout: 15_000 };

/** Today in UTC, as the API's `YYYY-MM-DD`. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

interface Envelope<T> {
  data: T;
}

async function callState(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/v1/calls/${id}`);
  const body = (await response.json()) as Envelope<{ state: string }>;
  return body.data.state;
}

async function sendEvent(
  page: Page,
  id: string,
  body: { event: string; hangupCause?: string; billableSeconds?: number },
): Promise<void> {
  const response = await page.request.post(`/api/v1/dev/fake-voice/calls/${id}/events`, {
    data: body,
  });
  expect(response.status()).toBe(202);
}

async function waitForState(page: Page, id: string, states: string[]): Promise<void> {
  await expect
    .poll(() => callState(page, id), PIPELINE)
    .toMatch(new RegExp(`^(${states.join('|')})$`));
}

/**
 * Places one outbound fake call and completes it with 61 billable seconds, which the ledger
 * captures as $0.02. Resolves once the call has completed.
 */
export async function placeBilledCall(page: Page): Promise<string> {
  const created = await page.request.post('/api/v1/calls', {
    data: {
      to: '+12025550171',
      reviewConfirmed: true,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const { data } = (await created.json()) as Envelope<{ call: { id: string } }>;
  const id = data.call.id;
  await sendEvent(page, id, { event: 'initiated' });
  await sendEvent(page, id, { event: 'ringing' });
  await waitForState(page, id, ['ringing', 'connected']);
  await sendEvent(page, id, { event: 'answered' });
  await waitForState(page, id, ['connected']);
  await sendEvent(page, id, { event: 'completed', hangupCause: 'normal', billableSeconds: 61 });
  await waitForState(page, id, ['completed']);
  return id;
}

/** Waits until the wallet has captured `heldMicros`-free spend, i.e. the call has been billed. */
export async function waitForAvailable(page: Page, availableMicros: number): Promise<void> {
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/wallet');
      const body = (await response.json()) as Envelope<{
        availableMicros: number;
        heldMicros: number;
      }>;
      return body.data.heldMicros === 0 ? body.data.availableMicros : null;
    }, PIPELINE)
    .toBe(availableMicros);
}
