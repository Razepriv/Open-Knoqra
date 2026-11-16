# Running on a live Telnyx account

The fake provider covers development and tests. This page lists what only a real Telnyx account can verify, and the steps before the first real call. Deploying is covered in the [self-host guide](self-host.md).

## What needs a live Telnyx account

The fake provider covers development and tests. These cannot be verified without a real account and are untested against one:

- **Buying numbers:** in-app purchase is implemented but unverified against a live account. Check these calls before enabling it for real money:
  - `GET /available_phone_numbers` with `filter[country_code]`, `filter[national_destination_code]`, `filter[locality]`, `filter[administrative_area]`, `filter[features][]` and `filter[limit]`, and the quote lookup with `filter[phone_number][contains]`.
  - `POST /number_orders` with `phone_numbers[].phone_number` and an optional `connection_id`, and the order status mapping.
  - The field mapping (`cost_information` upfront and monthly cost and currency, `region_information`, `features`) is hand-written from fixtures, not from live responses.
  - **Ambiguous answers stay pending:** a network error, timeout, 5xx or unreadable 2xx from `POST /number_orders` leaves the order `pending` (`failureCode` `unconfirmed`) with its hold open; only a 4xx or an explicit failed status releases it. When a later sync (after a purchase, on Sync numbers, or from the 30-minute balance-poll cron) lists the number active, the hold is captured once and the number assigned. Confirm on a live account which Telnyx errors are truly definite refusals.
  - **Parked recovery:** an unconfirmed order (or a Worker crash between the hold and the settle) whose number never shows up keeps its hold, and nothing releases it automatically. Today, match it by hand against Telnyx orders and the synced numbers. Sending a `customer_reference` (the order id) on `POST /number_orders` would make that match possible, but the client does not send one yet.
- **REST field names:** the balance, `phone_numbers`, 10DLC phone-number campaigns and `detail_records` fixtures are hand-written from Telnyx's documentation (see `packages/providers/test/fixtures/telnyx/README.md`). Check each against a live account before relying on them.
- **10DLC registration:** the registration state is read per number; registering a brand and campaign happens in Telnyx and takes carrier approval.
- **WhatsApp and Meta approval:** WhatsApp status is never inferred from Telnyx and needs Meta business approval.
- **`TELNYX_PUBLIC_KEY`:** set this secret (`pnpm knoqra setup` asks for it) so Telnyx webhooks verify. The Setup page reports it as missing until then.
- **Real usage for reconciliation:** the fake provider mirrors the ledger, so drift handling is only proven on fixtures. Run a reconciliation against real `detail_records` and compare costs before trusting auto-adjust.
- **Audio playback:** voicemail and recording playback needs real provider audio.

## Before live Telnyx

M2 is built and tested against the fake provider. Before any real call goes through Telnyx (production, or staging with `PROVIDER=telnyx`):

- [ ] **Blocker: number ownership verification (M4).** In production, saving the caller id in Settings, Voice does not route inbound calls to the workspace, because the number is unverified user input and anyone could claim a number they do not own. Until M4's setup checks verify that the Telnyx account owns the number and write `provider_number_route`, inbound calls in production are parked as `unknown_call`. Outside production the save still claims the number for testing.
- [ ] In the Telnyx portal, create a **credential connection** (WebRTC) and note its connection id.
- [ ] Set that connection's **webhook URL** to the API Worker's own domain: `https://api.<your domain>/webhooks/telnyx`. Not the web origin: the web Worker does not forward `/webhooks/*`.
- [ ] Copy the platform's webhook **public key** and set it: `pnpm knoqra setup` (or `wrangler secret put TELNYX_PUBLIC_KEY -c wrangler.selfhost.jsonc`). Until then `/webhooks/telnyx` answers 404 and Telnyx will see failures.
- [ ] Confirm `CREDENTIALS_MASTER_KEY` is set for that environment and backed up.
- [ ] Sign in as the workspace owner and save the org's **Telnyx API key**, connection id and caller id in **Settings, Voice**. Saving does not call Telnyx, so a wrong key shows up at the first token request (a 502) rather than on save.
- [ ] Make sure the API runs with `PROVIDER=connectors` (`pnpm knoqra deploy` sets it).
- [ ] Record the credit you hold with Telnyx under Wallet (`POST /api/v1/wallet/credits`), then place a test call to a number you control.
- [ ] Live SMS needs US texting (10DLC) registration: press Enable next to SMS in the Inbox. Live WhatsApp needs a WhatsApp Business number connected in the Telnyx portal: press Enable next to WhatsApp, then Check again. Both switch on by themselves when approved.

Known gaps in M2 (tracked for later milestones):

- **The WebRTC token is a 24-hour JWT.** The Desk re-mints it automatically before the next dial once it is close to expiry, so a long session needs no reload.
- **Unauthorized SDK dials are not hung up yet.** The server authorizes a call before the browser dials, but a call placed through the SDK without that authorization is not rejected by the server. Restrict the credential connection and the account balance on the Telnyx side meanwhile.
- **Voicemail answering and recording are not built.** M2 ships the voicemail model, the fake events and the UI with transcripts. Real greeting, recording and storage need a live account and R2.
- **Decline does not reject the SDK call.** Declining an inbound call marks it canceled in KNOQRA, but the action does not reject the call on the SDK or Telnyx side.
- **Balance sync is M4.** The wallet is derived from the ledger, and owners record credits by hand. Reconciliation against the Telnyx balance arrives with M4.
- Mid-call top-up of holds and a low-wallet warning during a call are M6. Dialing is rate limited per user (`RL_DIAL`).
