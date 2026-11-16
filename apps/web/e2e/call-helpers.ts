import { expect, type Page } from '@playwright/test';

// Shared by the inbound, wallet and voice settings specs. Every request goes through
// `page.request`, which shares the signed-in page's session cookie.

/** Waits on the async call pipeline (queue batches, realtime), shared by four workers. */
export const PIPELINE = { timeout: 15_000 };

interface ApiEnvelope<T> {
  data: T;
}

export async function dataOf<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return ((await response.json()) as ApiEnvelope<T>).data;
}

/** Creates a contact through the API. Returns its id. */
export async function createContact(
  page: Page,
  displayName: string,
  phone: string,
): Promise<string> {
  const response = await page.request.post('/api/v1/contacts', { data: { displayName, phone } });
  expect(response.status()).toBe(201);
  return (await dataOf<{ id: string }>(response)).id;
}

export async function grantManualCall(page: Page, contactId: string): Promise<void> {
  const response = await page.request.put(`/api/v1/contacts/${contactId}/permissions/manual_call`, {
    data: { status: 'granted', evidence: 'Asked us to call back.' },
  });
  expect(response.ok()).toBe(true);
}

/** Rings this workspace from `from` on the fake provider (development only). */
export async function fakeInbound(
  page: Page,
  from: string,
  scenario: 'ring' | 'voicemail',
): Promise<void> {
  const response = await page.request.post('/api/v1/dev/fake-voice/inbound', {
    data: { from, scenario },
  });
  expect(response.status()).toBe(202);
}

/** Sends one fake provider event for a call of the signed-in user (development only). */
export async function fakeCallEvent(
  page: Page,
  callId: string,
  body: { event: 'completed'; billableSeconds?: number },
): Promise<void> {
  const response = await page.request.post(`/api/v1/dev/fake-voice/calls/${callId}/events`, {
    data: body,
  });
  expect(response.status()).toBe(202);
}

/** The id of the signed-in user's call in progress (fails when there is none). */
export async function activeCallId(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/calls/active');
  expect(response.ok()).toBe(true);
  const call = await dataOf<{ id: string } | null>(response);
  if (!call) throw new Error('no call in progress');
  return call.id;
}

export const dialer = (page: Page) => page.getByRole('region', { name: 'Dialer' });
export const liveCall = (page: Page) => page.getByRole('region', { name: 'Live call' });
export const callButton = (page: Page) =>
  dialer(page).getByRole('button', { name: 'Call', exact: true });
export const callState = (page: Page) => liveCall(page).getByRole('status');
export const outcomeDialog = (page: Page) => page.getByRole('dialog', { name: 'How did it go?' });
export const incomingDialog = (page: Page) => page.getByRole('dialog', { name: 'Incoming call' });
export const callsPanel = (page: Page) => page.getByRole('region', { name: 'Calls' });
export const wallet = (page: Page) => page.getByRole('complementary', { name: 'Wallet' });
