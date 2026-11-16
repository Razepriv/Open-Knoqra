import { expect, type Page, test } from '@playwright/test';
import { timeline } from './contact-helpers';
import { signUp } from './session';

// Every call here runs on the fake provider: the browser's FakeVoiceClient posts provider events
// through the dev endpoint, so the real pipeline (webhook, queue, state machine, realtime) runs.
// State changes wait on that pipeline (the local queue batches for up to a second, and four workers
// share one API), so they get a longer timeout than the 5 s default. No fixed sleeps.
const PIPELINE = { timeout: 15_000 };
test.describe.configure({ timeout: 90_000 });

interface ApiEnvelope<T> {
  data: T;
}

/** Creates a contact through the API with the signed-in page's session. Returns its id. */
async function createContact(page: Page, displayName: string, phone: string): Promise<string> {
  const response = await page.request.post('/api/v1/contacts', { data: { displayName, phone } });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as ApiEnvelope<{ id: string }>;
  return body.data.id;
}

async function grantManualCall(page: Page, contactId: string): Promise<void> {
  const response = await page.request.put(`/api/v1/contacts/${contactId}/permissions/manual_call`, {
    data: { status: 'granted', evidence: 'Asked us to call back.' },
  });
  expect(response.ok()).toBe(true);
}

async function markDoNotContact(page: Page, contactId: string): Promise<void> {
  const response = await page.request.post(`/api/v1/contacts/${contactId}/do-not-contact`, {
    data: {},
  });
  expect(response.ok()).toBe(true);
}

const dialer = (page: Page) => page.getByRole('region', { name: 'Dialer' });
const liveCall = (page: Page) => page.getByRole('region', { name: 'Live call' });
const callButton = (page: Page) => dialer(page).getByRole('button', { name: 'Call', exact: true });
const callState = (page: Page) => liveCall(page).getByRole('status');
const outcomeDialog = (page: Page) => page.getByRole('dialog', { name: 'How did it go?' });

test('call a contact with consent, hang up, log the outcome and see it on the timeline', async ({
  page,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Ines Duarte', '+1 202 555 0151');
  await grantManualCall(page, id);

  await page.goto(`/calls?contactId=${id}`);
  await expect(dialer(page).getByText('Ines Duarte')).toBeVisible();
  await expect(dialer(page).getByText('Holds $0.10 while the call runs')).toBeVisible();
  await expect(dialer(page).getByLabel('Number to call')).toHaveValue('+1 202 555 0151');
  await callButton(page).click();

  await expect(callState(page)).toHaveText(/Ringing/, PIPELINE);
  await expect(callState(page)).toHaveText('Connected', PIPELINE);
  const timer = liveCall(page).getByRole('timer');
  await expect(timer).toHaveText(/^0:0[1-9]$/);
  const first = await timer.textContent();
  await expect.poll(async () => timer.textContent()).not.toBe(first);

  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  const dialog = outcomeDialog(page);
  await expect(dialog).toBeVisible(PIPELINE);
  await expect(dialog.getByRole('radio')).toHaveCount(6);
  await dialog.getByRole('radio', { name: 'Follow-up' }).check();
  await dialog.getByLabel('Note').fill('Send the quote on Friday.');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Outcome saved to Ines Duarte's timeline")).toBeVisible();
  await expect(callState(page)).toHaveText('Call ended', PIPELINE);

  await page.goto(`/contacts/${id}`);
  await expect(timeline(page).getByText('Outbound call').first()).toBeVisible();
  await expect(timeline(page).getByText('Outcome: Follow-up')).toBeVisible();
  await expect(timeline(page).getByText('Send the quote on Friday.')).toBeVisible();
});

test('without a voice provider the dialer asks to set up calling and Call stays disabled', async ({
  page,
}) => {
  await signUp(page);
  // Status `none` cannot happen on the dev fake provider, so the status answer is stubbed.
  await page.route('**/api/v1/voice/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({
        data: { provider: 'none', connected: false, last4: null },
        error: null,
      }),
    }),
  );
  await page.goto('/calls?to=%2B12025550152');
  await expect(
    dialer(page).getByText('Calling is not set up. Connect a provider in Settings to place calls.'),
  ).toBeVisible();
  await expect(callButton(page)).toBeDisabled();
  const link = dialer(page).getByRole('link', { name: 'Open connectors' });
  await expect(link).toHaveAttribute('href', '/settings#connectors');
  await link.click();
  await expect(page).toHaveURL(/\/settings#connectors$/);
  await expect(page.getByRole('region', { name: 'Connectors' })).toBeVisible();
});

test('a do-not-contact contact is blocked before anything is dialed', async ({ page }) => {
  await signUp(page);
  const id = await createContact(page, 'Wen Zhao', '+1 202 555 0153');
  await markDoNotContact(page, id);

  await page.goto(`/calls?contactId=${id}`);
  const banner = dialer(page).getByRole('alert');
  await expect(banner).toContainText('This call is blocked.');
  await expect(banner).toContainText('Do not contact. Policy, not a task.');
  await expect(callButton(page)).toBeDisabled();
});

test('a number with no contact needs the review checkbox before Call is enabled', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/calls');
  await dialer(page).getByLabel('Number to call').fill('+1 202 555 0177');
  await expect(dialer(page).getByText("Confirm you're authorized before calling.")).toBeVisible();
  await expect(callButton(page)).toBeDisabled();
  const review = dialer(page).getByRole('checkbox', { name: "I'm authorized to call this number" });
  await expect(review).toHaveAttribute('required', '');
  await review.check();
  await expect(callButton(page)).toBeEnabled();
  await callButton(page).click();
  await expect(callState(page)).toHaveText(/Ringing|Connected/, PIPELINE);
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await expect(outcomeDialog(page)).toBeVisible(PIPELINE);
  await outcomeDialog(page).getByRole('button', { name: 'Skip' }).click();
  await expect(outcomeDialog(page)).toHaveCount(0);
});

test('a busy number ends as Busy and the outcome is offered, not forced', async ({ page }) => {
  await signUp(page);
  await page.goto('/calls?to=%2B12025550190');
  await expect(dialer(page).getByLabel('Number to call')).toHaveValue('+1 202 555 0190');
  await dialer(page).getByRole('checkbox', { name: "I'm authorized to call this number" }).check();
  await callButton(page).click();
  await expect(callState(page)).toHaveText('Busy', PIPELINE);
  const dialog = outcomeDialog(page);
  await expect(dialog).toBeVisible(PIPELINE);
  await expect(dialog.getByRole('radio', { name: 'No answer' })).toBeVisible();
  // Save needs a choice; Skip leaves the call without an outcome.
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(callState(page)).toHaveText('Busy', PIPELINE);
  const calls = await page.request.get('/api/v1/calls');
  const body = (await calls.json()) as ApiEnvelope<{ items: { state: string; outcome: null }[] }>;
  expect(body.data.items[0]).toMatchObject({ state: 'busy', outcome: null });
});

test('the call dock follows the call to other pages and hangs up from there', async ({ page }) => {
  await signUp(page);
  const id = await createContact(page, 'Tomas Reyes', '+1 202 555 0152');
  await grantManualCall(page, id);
  await page.goto(`/calls?contactId=${id}`);
  const dock = page.getByRole('region', { name: 'Call in progress' });
  await callButton(page).click();
  await expect(callState(page)).toHaveText('Connected', PIPELINE);
  // The dock is not shown on the Calls page itself.
  await expect(dock).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Contacts' })
    .click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(dock).toBeVisible();
  await expect(dock).toContainText('Tomas Reyes');
  await expect(dock).toContainText('Connected', PIPELINE);
  await expect(dock.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/calls');
  await dock.getByRole('button', { name: 'Hang up' }).click();
  await expect(dock).toHaveCount(0, PIPELINE);
  await expect(outcomeDialog(page)).toBeVisible(PIPELINE);
  await outcomeDialog(page).getByRole('button', { name: 'Skip' }).click();
  await expect(outcomeDialog(page)).toHaveCount(0);
});

test('the dialer works from the keyboard: type digits, Enter dials, Escape clears', async ({
  page,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Maya Okafor', '+1 202 555 0161');
  await grantManualCall(page, id);
  await page.goto('/calls');
  const field = dialer(page).getByLabel('Number to call');
  await field.focus();
  await page.keyboard.type('999');
  await page.keyboard.press('Escape');
  await expect(field).toHaveValue('');
  await page.keyboard.type('2025550161');
  // The bare number is matched to the contact by the server.
  await expect(dialer(page).getByText('Holds $0.10 while the call runs')).toBeVisible();
  await expect(dialer(page).getByText('Maya Okafor')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(callState(page)).toHaveText(/Ringing|Connected/, PIPELINE);
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await expect(outcomeDialog(page)).toBeVisible(PIPELINE);
});

test('the keypad has a labelled button for every key', async ({ page }) => {
  await signUp(page);
  await page.goto('/calls');
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
    await expect(dialer(page).getByRole('button', { name: `Digit ${key}` })).toBeVisible();
  }
  await expect(dialer(page).getByRole('button', { name: 'Star' })).toBeVisible();
  await expect(dialer(page).getByRole('button', { name: 'Pound' })).toBeVisible();
  for (const key of ['2', '0', '2', '5', '5', '5', '0', '1', '7', '8']) {
    await dialer(page)
      .getByRole('button', { name: `Digit ${key}` })
      .click();
  }
  await expect(dialer(page).getByLabel('Number to call')).toHaveValue('2025550178');
});

const DENY_MIC = `(() => {
  const devices = navigator.mediaDevices;
  if (!devices) return;
  const real = devices.getUserMedia.bind(devices);
  window.__knoqraDenyMic = true;
  devices.getUserMedia = (constraints) =>
    window.__knoqraDenyMic
      ? Promise.reject(new DOMException('denied', 'NotAllowedError'))
      : real(constraints);
})();`;

test('a blocked microphone shows a recoverable panel, and Try again dials once allowed', async ({
  page,
  context,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Lena Fischer', '+1 202 555 0163');
  await grantManualCall(page, id);
  await context.clearPermissions();
  await context.grantPermissions([]);
  await page.addInitScript(DENY_MIC);
  await page.goto(`/calls?contactId=${id}`);
  await callButton(page).click();

  const blocked = page.getByRole('region', { name: 'Microphone blocked' });
  await expect(blocked).toContainText(
    'Microphone blocked. Allow microphone access for this site, then try again.',
  );
  // The call that could not start was canceled, so nothing is in progress and no outcome is asked.
  await expect(outcomeDialog(page)).toHaveCount(0);

  // The person allows the microphone, then tries again.
  await context.grantPermissions(['microphone']);
  await page.evaluate(() => {
    (window as unknown as { __knoqraDenyMic: boolean }).__knoqraDenyMic = false;
  });
  await blocked.getByRole('button', { name: 'Try again' }).click();
  await expect(blocked).toHaveCount(0);
  await expect(callState(page)).toHaveText(/Ringing|Connected/, PIPELINE);
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await expect(outcomeDialog(page)).toBeVisible(PIPELINE);
});

test('a never-dialed call is not offered for an outcome once it is released', async ({
  page,
  context,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Omar Haddad', '+1 202 555 0164');
  await grantManualCall(page, id);
  await context.clearPermissions();
  await page.addInitScript(DENY_MIC);
  await page.goto(`/calls?contactId=${id}`);
  await callButton(page).click();
  const blocked = page.getByRole('region', { name: 'Microphone blocked' });
  await expect(blocked).toBeVisible();
  await blocked.getByRole('button', { name: 'Dismiss' }).click();
  // The canceled call is gone from the panel: no live call, no Log outcome, no dialog.
  await expect(liveCall(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log outcome' })).toHaveCount(0);
  await expect(outcomeDialog(page)).toHaveCount(0);
  await expect(callButton(page)).toBeEnabled();
});

test('when the failed call cannot be released, it stays on screen and Hang up releases it', async ({
  page,
  context,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Sara Lind', '+1 202 555 0165');
  await grantManualCall(page, id);
  await context.clearPermissions();
  await page.addInitScript(DENY_MIC);
  // The first cancel fails, as a dropped connection or a server error would.
  let cancels = 0;
  await page.route('**/api/v1/calls/*/cancel', async (route) => {
    cancels += 1;
    if (cancels === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: { code: 'internal_error', message: 'boom' } }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto(`/calls?contactId=${id}`);
  await callButton(page).click();

  await expect(dialer(page).getByRole('alert')).toHaveText(
    "We couldn't release that call. Hang up to try again.",
  );
  // The call is still held, so it stays the current call with Hang up, and Call stays off.
  await expect(liveCall(page)).toBeVisible();
  await expect(callButton(page)).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Microphone blocked' })).toHaveCount(0);

  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await expect(liveCall(page)).toHaveCount(0, PIPELINE);
  await expect(dialer(page).getByRole('alert')).toHaveCount(0);
  await expect(outcomeDialog(page)).toHaveCount(0);
  expect(cancels).toBe(2);
  const calls = await page.request.get('/api/v1/calls');
  const body = (await calls.json()) as ApiEnvelope<{ items: { state: string }[] }>;
  expect(body.data.items[0]?.state).toBe('canceled');
});

const FAKE_EVENTS = '**/api/v1/dev/fake-voice/calls/*/events';
const ACCEPTED = {
  status: 202,
  contentType: 'application/json',
  body: '{"data":{"accepted":true}}',
};

/**
 * Dials a new number and keeps it pre-connect: the fake client's `ringing` event is held, so its
 * script never answers. Records the events the browser sends (with when) and every cancel.
 * `completed` is passed through, swallowed (the provider never hears the hangup) or failed.
 */
async function dialAndHold(page: Page, to: string, completed: 'pass' | 'swallow' | 'fail') {
  const sent: { event: string; at: number }[] = [];
  const cancels: number[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(FAKE_EVENTS, async (route) => {
    const { event } = route.request().postDataJSON() as { event: string };
    sent.push({ event, at: Date.now() });
    if (event === 'ringing') {
      await released;
      await route.fulfill(ACCEPTED);
    } else if (event === 'completed' && completed === 'swallow') {
      await route.fulfill(ACCEPTED);
    } else if (event === 'completed' && completed === 'fail') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: { code: 'internal_error', message: 'boom' } }),
      });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/v1/calls/*/cancel', async (route) => {
    cancels.push(Date.now());
    await route.continue();
  });
  await signUp(page);
  await page.goto('/calls');
  await dialer(page).getByLabel('Number to call').fill(to);
  await dialer(page).getByRole('checkbox', { name: "I'm authorized to call this number" }).check();
  await callButton(page).click();
  await expect(callState(page)).toHaveText('Calling…', PIPELINE);
  await expect.poll(() => sent.some((item) => item.event === 'ringing')).toBe(true);
  return { sent, cancels, release };
}

const completedAt = (sent: { event: string; at: number }[]) =>
  sent.find((item) => item.event === 'completed')?.at;

/** The ended call asks for an outcome (its modal hides the page): skip it, then check the page. */
async function skipOutcome(page: Page, options = PIPELINE) {
  await expect(outcomeDialog(page)).toBeVisible(options);
  await outcomeDialog(page).getByRole('button', { name: 'Skip' }).click();
  await expect(outcomeDialog(page)).toHaveCount(0);
}

test('hanging up a call before it connects ends the provider leg and never cancels first', async ({
  page,
}) => {
  const { sent, cancels, release } = await dialAndHold(page, '+1 202 555 0178', 'pass');
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await skipOutcome(page);
  await expect(callState(page)).toHaveText('Canceled');
  expect(completedAt(sent)).toBeDefined();
  expect(cancels).toEqual([]);
  release();
});

test('a call still pre-connect 10 seconds after its leg hung up is canceled', async ({ page }) => {
  // The provider never reports the hangup, so only the fallback cancel can end the call.
  const { sent, cancels, release } = await dialAndHold(page, '+1 202 555 0179', 'swallow');
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await expect.poll(() => completedAt(sent)).toBeDefined();
  await skipOutcome(page, { timeout: 25_000 });
  await expect(callState(page)).toHaveText('Canceled');
  expect(cancels).toHaveLength(1);
  expect((cancels[0] ?? 0) - (completedAt(sent) ?? 0)).toBeGreaterThanOrEqual(9_500);
  release();
});

test('a failed leg hangup is shown, and the pre-connect call is canceled at once', async ({
  page,
}) => {
  const { cancels, release } = await dialAndHold(page, '+1 202 555 0180', 'fail');
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  await skipOutcome(page);
  await expect(dialer(page).getByRole('alert')).toHaveText(
    'The call could not be ended. Press Hang up to try again.',
  );
  await expect(callState(page)).toHaveText('Canceled');
  expect(cancels).toHaveLength(1);
  release();
});
