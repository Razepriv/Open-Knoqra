import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect } from '@playwright/test';
import { parseDevVars } from './dev-vars';
import { API_ORIGIN } from './ports';

const devVarsPath = fileURLToPath(new URL('../../api/.dev.vars', import.meta.url));

let secret: string | null = null;

/** The fake provider's webhook secret, read once from the API's local `.dev.vars`. */
function webhookSecret(): string {
  if (secret === null) {
    const value = parseDevVars(readFileSync(devVarsPath, 'utf8')).FAKE_WEBHOOK_SECRET;
    if (!value) throw new Error('apps/api/.dev.vars: FAKE_WEBHOOK_SECRET is missing or empty.');
    secret = value;
  }
  return secret;
}

export interface FakeEvent {
  type: string;
  resourceId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
  id?: string;
}

/**
 * Posts one signed event to the API's fake provider webhook, straight to wrangler (not through
 * Vite), as the provider would. The queue consumer applies it a second or two later.
 */
export async function postFakeEvent(request: APIRequestContext, event: FakeEvent): Promise<void> {
  const body = JSON.stringify({
    id: event.id ?? `fake_evt_${randomUUID()}`,
    type: event.type,
    occurred_at: event.occurredAt ?? new Date().toISOString(),
    resource_id: event.resourceId,
    payload: event.payload,
  });
  const signature = createHmac('sha256', webhookSecret()).update(body).digest('hex');
  const response = await request.post(`${API_ORIGIN}/webhooks/fake`, {
    data: body,
    headers: { 'content-type': 'application/json', 'x-fake-signature': signature },
  });
  expect(response.status(), await response.text()).toBe(200);
}
