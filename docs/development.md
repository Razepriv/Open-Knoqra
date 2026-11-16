# Development guide

How to run, test and change KNOQRA locally. The short version is in the [README](../README.md#getting-started). Deploying is covered in [self-host.md](self-host.md), and the design in [architecture.md](architecture.md).

Local development runs against a fake telephony provider, so you need no Telnyx, Cloudflare or Neon account.

## Prerequisites

- Node 22 (`.nvmrc`)
- pnpm 10.34.5, activated with `corepack enable` (the version is pinned by `packageManager`)
- Docker, for the local Postgres 17

### macOS

```bash
brew install nvm                     # or: brew install fnm
nvm install 22
corepack enable
brew install --cask docker-desktop   # then start Docker Desktop once
```

### Linux

Install Node 22 with your preferred manager (nvm, fnm or your distribution), then:

```bash
corepack enable
```

Install Docker Engine and the Compose plugin from Docker's documentation, and make sure your user can run `docker compose` without `sudo`.

### Windows

Use PowerShell with Node 22 (for example through `nvm-windows` or `fnm`) and Docker Desktop with the WSL 2 backend.

```powershell
corepack enable
```

Every script in the repository is plain Node or a cross-platform tool, so nothing needs Git Bash or WSL. Line endings are LF (`.gitattributes`), so let Git handle conversion rather than editing them by hand.

## First run

```bash
docker compose up -d
pnpm install
pnpm --filter @knoqra/db migrate
cp apps/api/.dev.vars.example apps/api/.dev.vars   # on Windows PowerShell: Copy-Item apps/api/.dev.vars.example apps/api/.dev.vars
pnpm dev
```

The Desk is at http://localhost:5173 and the API at http://localhost:8787. In dev, Vite proxies `/api` to the API and forwards the browser's `Origin` unchanged, because Better Auth trusts only `BETTER_AUTH_URL`.

## Environment files

The API reads secrets for `wrangler dev` from `apps/api/.dev.vars`, which is gitignored. Copy `.dev.vars.example` and edit:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Optional override of the Hyperdrive local connection. Must be the non-superuser `knoqra_app` role |
| `BETTER_AUTH_SECRET` | At least 32 random characters, for example `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | The **web** origin, `http://localhost:5173` in dev. The E2E setup refuses any value other than the web origin it is about to start (see the port variables below) |
| `FAKE_WEBHOOK_SECRET` | Shared secret for the fake provider's webhook signature. Also turns the fake voice provider on: without it, dialing answers 409 `voice_not_configured` |
| `CREDENTIALS_MASTER_KEY` | Base64 of 32 random bytes. Seals the Telnyx API key saved in Settings (see below). Without it the voice connection API answers 503 `not_configured` |
| `PROVIDER` | Optional. `fake` (the default), or `connectors` to use each workspace's connected provider (Telnyx or Plivo). `telnyx` is the older name for `connectors` and still works. A real provider is used only for a workspace that has saved a connection |
| `CONNECTORS` | Optional. Comma list of the providers a workspace may connect in Settings › Connectors (`telnyx`, `plivo`). Unset: every provider outside production, and only live-verified ones (`telnyx`) in production |
| `API_PUBLIC_ORIGIN` | Optional. The API's public origin, for example `https://api.example.com`. Settings › Connectors then shows each connection's full webhook URLs, not just their paths |
| `TELNYX_PUBLIC_KEY` | Optional. Base64 Ed25519 platform webhook key. Unset, `/webhooks/telnyx` is a 404, which is what you want locally |
| `SMS_10DLC_APPROVED`, `WHATSAPP_META_APPROVED` | Optional. Commented out in the example. Exactly `true` lets that channel send live through Telnyx when `PROVIDER=telnyx`. Leave them unset locally |
| `SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE` | Optional. Commented out in the example. Blank or unset means Sentry is off |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Optional. Commented out in the example. Blank or unset means server-side PostHog is off |

### Generating `CREDENTIALS_MASTER_KEY`

```bash
openssl rand -base64 32
```

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Paste the value into `.dev.vars`. Use a different one per environment. If you change it, connections saved under the old key cannot be opened (`wrong_key`): remove them and save the key again in Settings. See [the credential vault](architecture.md#credential-vault).

### Web env (`apps/web/.env.local`)

The Desk reads optional build-time settings from `apps/web/.env.local`, which is gitignored. Copy `apps/web/.env.example` and uncomment what you need. Every key is optional, and a missing or invalid one switches that integration off.

| Variable | Meaning |
| --- | --- |
| `VITE_SENTRY_DSN` | Switches Sentry on in the browser |
| `VITE_SENTRY_RELEASE` | Release name on events |
| `VITE_SENTRY_ENVIRONMENT` | Environment label. Defaults to the Vite mode |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | A number from 0 to 1. Default `0.05` |
| `VITE_POSTHOG_KEY` | Switches PostHog on, for users who opt in |
| `VITE_POSTHOG_HOST` | An `https:` URL. Default `https://us.i.posthog.com` |

These values end up in the browser bundle, so never put a secret here. Source maps are not built or uploaded locally. What each tool collects, how to get the keys and how to verify them are in [observability.md](observability.md).

Never commit `.dev.vars`, `.env.local` or any real secret. Password-reset links in development are written to the API log (`email.dev_outbox`) instead of being sent.

## Otto and the mock AI provider

Otto runs on `MockAiProvider`, a deterministic stand-in that needs no key and no network. The `AI_PROVIDER` variable selects the provider: unset or `mock` uses the mock, and any other value is not configured yet, so the Otto routes answer 500 until a real adapter is wired in `apps/api/src/otto/provider.ts`. You do not need to set it locally. See [what a real provider needs](architecture.md#what-a-real-ai-provider-needs).

## Database

Postgres runs from `docker-compose.yml` on host port **54329**, with the database `knoqra` and the admin role `knoqra`. A second, restricted role is created on first start by `docker/postgres/init/01-app-role.sql`.

| Role | Password | Used for | Environment variable |
| --- | --- | --- | --- |
| `knoqra` (owner, admin) | `knoqra` | Migrations and test fixture setup only | `MIGRATION_DATABASE_URL` |
| `knoqra_app` (`NOSUPERUSER`, `NOBYPASSRLS`) | `knoqra_app` | Everything at runtime: the API, queue consumer and tests | `DATABASE_URL` |

Both connect to `localhost:54329/knoqra`, and both have local-only passwords. The app must never connect as the owner, because superusers ignore row-level security. See [Tenancy model](architecture.md#tenancy-model).

`pnpm --filter @knoqra/db migrate` applies the Drizzle migrations and then `packages/db/sql/rls.sql`, which is idempotent and re-runs every time. To start from scratch (this deletes all local data and re-runs the role init script):

```bash
docker compose down -v
docker compose up -d
pnpm --filter @knoqra/db migrate
```

## Running the apps

| Command | Starts |
| --- | --- |
| `pnpm dev` | Both servers through Turborepo |
| `pnpm --filter @knoqra/api dev` | `wrangler dev --port 8787` only |
| `pnpm --filter @knoqra/web dev` | Vite on 5173 (`--strictPort`) only |

## Running tests

| Scope | Command | Needs Docker Postgres |
| --- | --- | --- |
| Everything | `pnpm test` | Yes |
| Lint and format check | `pnpm lint` (fix formatting with `pnpm format`) | No |
| Import guard (apps never import `ascii-reveal`) | `pnpm check:imports` | No |
| Types | `pnpm typecheck` | No |
| Docs links and tracker | `pnpm docs:check` | No |
| Completeness, accessibility, state and visual checks | see [quality.md](quality.md) | Yes |
| One package | `pnpm --filter @knoqra/core test` | Only `db` and `api` |
| Database and RLS | `pnpm --filter @knoqra/db test` | Yes |
| API (real `workerd`) | `pnpm --filter @knoqra/api test` | Yes |
| UI kit | `pnpm --filter @knoqra/ui test` | No |
| Web unit tests | `pnpm --filter @knoqra/web test` | No |

API tests run inside the real Workers runtime through `@cloudflare/vitest-plugin`, as `knoqra_app`. Their global setup runs the migrations first and aborts if the app role could bypass RLS. The API `test` task depends on the `db` tests, so a broken isolation test fails fast.

## Performance checks

The perf seed, explain, load, realtime and web commands, their budgets and how to add a milestone's queries are in [docs/perf/README.md](perf/README.md).

## End-to-end tests

```bash
pnpm --filter @knoqra/web e2e
```

Playwright starts both servers itself (`reuseExistingServer: false`) and runs the migration first. Requirements and notes:

- `apps/api/.dev.vars` must exist and set every key: `BETTER_AUTH_URL` (the web origin, `http://localhost:5173` by default), a non-empty `BETTER_AUTH_SECRET`, `DATABASE_URL`, `FAKE_WEBHOOK_SECRET`, and a `CREDENTIALS_MASTER_KEY` that is base64 of 32 bytes (`openssl rand -base64 32`). The setup refuses to start without the key: every Telnyx connection save would answer 503, so the voice, setup and numbers specs could not connect.
- Ports **8787** (API) and **5173** (web) must be free. The suite never adopts a running server, because a stale one would test the wrong code. Stop `pnpm dev` before running it.
- The browser is launched with a fake microphone, so calls never wait on a permission prompt.
- First time only: `pnpm --filter @knoqra/web exec playwright install chromium`.
- Failures leave traces in `apps/web/test-results` and a report in `apps/web/playwright-report` (both gitignored).
- Playwright runs at most **4 workers** (`workers: 4` in `apps/web/playwright.config.ts`). One local `wrangler dev` and one Postgres serve every worker, and at the default (half the CPU threads) sign-ups timed out. Raise it only if your machine keeps up.
- **Parallel worktrees:** every Playwright, migrate, database and API test run must set `MIGRATION_DATABASE_URL` as well as `DATABASE_URL`, pointing at your own database. Playwright's global setup migrates the database named in `apps/api/.dev.vars`, but a bare `db migrate` or test run falls back to the shared `knoqra` database. Use separate ports too (`KNOQRA_WEB_PORT`, `KNOQRA_API_PORT`).
- **The focus timer:** tests drive the 25-minute timer with Playwright's clock instead of waiting. Call `page.clock.install()` before the page loads, `page.clock.pauseAt(...)` once it is running, then `page.clock.runFor(...)` or `page.clock.fastForward('25:00')`. See `apps/web/e2e/today.spec.ts`.
- **Windows:** `wrangler dev` can leave an orphaned `workerd.exe` holding port 8787 if its parent dies. The next run then fails with "already used". Find it with `netstat -ano | findstr :8787` and stop it with `taskkill /PID <pid> /F`.

### Running E2E in parallel worktrees

Two checkouts (for example two `git worktree`s) can run the suite at the same time if they share nothing. Each one needs its own ports and its own database:

1. **Ports.** Set `KNOQRA_WEB_PORT` and `KNOQRA_API_PORT` (integers from 1024 to 65535, defaults 5173 and 8787) in the shell that runs the tests. Playwright, Vite and `wrangler dev` all read them.
2. **`BETTER_AUTH_URL`.** In that worktree's `apps/api/.dev.vars`, set `BETTER_AUTH_URL=http://localhost:<KNOQRA_WEB_PORT>`. The E2E setup fails with a message if it does not match, because Better Auth trusts only that origin.
3. **Database.** The database and API test suites clear tables, and the E2E sign-ups share one database, so two runs on one database interfere with each other. Create one per worktree and point both URLs at it:

   ```bash
   docker compose exec postgres psql -U knoqra -c 'CREATE DATABASE knoqra_wt1'
   export MIGRATION_DATABASE_URL=postgres://knoqra:knoqra@localhost:54329/knoqra_wt1
   export DATABASE_URL=postgres://knoqra_app:knoqra_app@localhost:54329/knoqra_wt1
   pnpm --filter @knoqra/db migrate
   ```

   Put the same `DATABASE_URL` in that worktree's `apps/api/.dev.vars`. The `knoqra_app` role belongs to the whole server, and `migrate` grants it access to the new database. The `db` and `api` unit suites honor the same two variables. The E2E setup migrates the database named in `.dev.vars`, using the owner role, unless `MIGRATION_DATABASE_URL` is set. A bare `pnpm --filter @knoqra/db migrate` still defaults to `knoqra`.
4. Run `KNOQRA_WEB_PORT=5191 KNOQRA_API_PORT=8791 pnpm --filter @knoqra/web e2e`.

Each worktree needs its own `pnpm install`. Keep the 4-worker cap per run: two runs at 4 workers load the machine like one run at 8.

### Import fixtures

`apps/web/e2e/fixtures/contacts.csv` is the import fixture: a header and six rows chosen so one upload covers every outcome. With the default "skip existing" mode it gives 3 created, 2 rejected and 1 skipped:

| Row | Contact | Outcome |
| --- | --- | --- |
| 2 | Ada Lovelace, `+1 202 555 0101` | created (tags `vip` and `early`, a time zone) |
| 3, 4 | Grace Hopper, Alan Turing | created |
| 5 | Margaret Hamilton, no phone | rejected: "Phone is required" |
| 6 | Katherine Johnson, `not-an-email` | rejected: "Email is not valid" |
| 7 | Ada Lovelace Again, same number as row 2 | skipped: "Duplicate of row 2" |

Row numbers count the header as row 1, as a spreadsheet does. The specs `import.spec.ts` and `import-robust.spec.ts` use this file, and the robust one also builds hostile and malformed files in memory. To try the wizard by hand, sign in, open Contacts, choose Import and pick the file. Upload the same file twice to see the valid rows skipped as already existing, or choose "Update existing" to see rows that change nothing reported as "Already up to date". Add new fixtures to the same folder and keep them small and free of real people's data.

### Testing two-factor locally

Two-factor uses a standard authenticator app (TOTP, six digits, 30 seconds). No email or SMS is involved, so it works fully offline against the local stack.

By hand:

1. Sign up, open Settings, and under Security enter your password and choose "Set up two-factor".
2. The page shows a QR code and, under it, the secret as text. Scan the code with any authenticator app, or type the secret into one. A desktop tool works as well, for example `oathtool --totp -b <secret>`.
3. Enter the six-digit code to enable it. The page then shows ten single-use backup codes: save one for step 4.
4. Sign out and sign in again. The password alone now leads to `/two-factor`, where you enter a fresh code or choose "Use a backup code instead".

In Playwright, `apps/web/e2e/helpers.ts` has the pieces: `enableTwoFactor(page)` runs steps 1 to 3 and returns the secret and the backup codes, `codeFor(secret)` generates the current code with the `otpauth` package, and `signInToChallenge` stops at the challenge page. Read the secret from the page element `data-testid="totp-secret"`, as a user typing it would. A code is valid for one 30-second window, so generate it right before you submit, and do not reuse one for two sign-ins in the same window.

## OpenAPI client

The API routes are the source of truth. After changing a route, request or response schema:

```bash
pnpm api:generate
```

This emits `packages/api-client/openapi.json` from `apps/api/src/app.ts`, formats it, and regenerates `packages/api-client/src/schema.d.ts`. Commit both files. CI regenerates them and fails if they differ.

## Messaging sandbox

Messaging needs no Telnyx account. In development and staging (never production), with `FAKE_WEBHOOK_SECRET` set, `PUT /api/v1/messaging/sandbox` creates fake SMS and WhatsApp connections at `sandbox:<hex>` addresses (so no fake number impersonates a real one) and sets each connection's registration status:

```json
{ "sms": "approved", "whatsapp": "pending" }
```

Registration is per connection, so you can show the paused state by leaving a channel `pending`. The sandbox refuses a channel that already has a live Telnyx sender (422).

Live Telnyx sending needs all of: `PROVIDER=telnyx`, a saved Telnyx connection, the channel flag set to exactly `true` (`SMS_10DLC_APPROVED` or `WHATSAPP_META_APPROVED`, commented out in `.dev.vars.example`), and an approved live sender on a number from a real Telnyx account. Without them the composer stays paused, so a local setup never sends a real message. See [Messaging](architecture.md#messaging-m3) and [Running on a live Telnyx account](live-telnyx.md).

## Simulating webhooks

With the API running:

```bash
pnpm --filter @knoqra/api simulate outbound-answered
pnpm --filter @knoqra/api simulate inbound sms <sandbox-address> +12025550123 "Hello there"
pnpm --filter @knoqra/api simulate receipt sms <sandbox-address> <providerMessageId> delivered
pnpm --filter @knoqra/api simulate inbound --org <orgId> [--from +12025550142] [--voicemail]
```

The script reads `FAKE_WEBHOOK_SECRET` from the environment or `apps/api/.dev.vars`, signs each event and posts it to `http://localhost:$KNOQRA_API_PORT/webhooks/fake` (port 8787 when `KNOQRA_API_PORT` is unset; override the whole URL with `WEBHOOK_URL`). It prints one status line per event. The local queue batches for about a second (`max_batch_timeout: 1` in `wrangler.jsonc`, local only), so a message or receipt shows up in the Inbox within a few seconds, after the next poll.

- `inbound <sms|whatsapp> <to-address> <from-e164> <body...>` delivers a message to the sender at `to-address`. A body of `STOP` or `START` exercises the keyword rules.
- `receipt <sms|whatsapp> <from-address> <providerMessageId> <sent|delivered|read|failed>` applies a delivery receipt to an outbound message.
- `outbound-answered` uses a fresh provider call id with no matching call, so its events are stored and then parked as `unknown_call`. It exercises ingest and the queue only.
- `inbound --org <orgId>` rings the organization `<orgId>` (the fake provider's org hint, honored outside production only): the queue consumer creates an inbound call for the organization's owner, matched to a contact by the caller's number. `--voicemail` also leaves a 22-second voicemail with a transcript.

Signed in, the web app can drive the same pipeline through the development-only endpoints (404 in production and unless the workspace uses the fake provider):

- `POST /api/v1/dev/fake-voice/calls/{id}/events` sends `initiated`, `ringing`, `answered`, `completed`, `failed` or `voicemail` for one of your calls.
- `POST /api/v1/dev/fake-voice/inbound` rings your workspace from `from`, with scenario `ring` or `voicemail`.

### Fake voice scenarios

With a workspace on the fake provider (the default in development), dialing from the Desk plays the browser's side of a call against the dev endpoints, so the real pipeline (webhook, queue, state machine, ledger) runs. How an outbound call ends is chosen by the **last four digits** of the number:

| Number ends in | Result | Billed |
| --- | --- | --- |
| `0190` | Busy | Nothing: the hold is released |
| `0191` | No answer | Nothing |
| `0192` | Failed | Nothing |
| anything else | Rings, is answered, and stays connected until you hang up | Per started minute at $0.01 |

Use test numbers in `+1 202 555 01xx`, for example `+12025550190`. A new workspace in development starts with a $5.00 starter credit; each call holds $0.10 while it is active.

### The event pipeline

Each webhook is verified, stored once in `provider_event_raw` (`status = 'pending'`) and queued. The consumer normalizes the stored body, routes it to its call (by client state, then provider call id, then, for a new inbound call, by the dialed number), applies the state machine, settles the ledger on the first terminal transition, writes timeline and voicemail rows, and marks the raw row `processed`, all in one transaction. Realtime messages and the call-lock release follow the commit.

Events with nothing to apply become `ignored`. Events that cannot be routed are `parked` with a `park_reason` (`unknown_call`, `call_id_mismatch`, `no_owner`) and acked. Unexpected errors retry; after `max_retries` the message moves to the dead-letter queue, whose consumer marks the row `dead_lettered`. To inspect what did not apply:

```sql
select id, provider, event_type, status, park_reason, attempts, received_at
  from provider_event_raw
 where status in ('parked', 'dead_lettered')
 order by received_at desc;
```

`attempts` counts the deliveries that worked on the row. Bodies stay in the `body` column, so query them only on a database you own: they contain phone numbers. Connect as the owner role (`MIGRATION_DATABASE_URL`); `provider_event_raw` is a system table, not under row-level security.

| Status | Meaning | What to do |
| --- | --- | --- |
| `parked`, `unknown_call` | No call or number route matched. Normal for `outbound-answered`, or for an inbound number nobody owns | Usually nothing |
| `parked`, `call_id_mismatch` | The call is already bound to a different provider call id | Investigate: this should not happen |
| `parked`, `no_owner` | A new inbound call for an organization with no owner | Fix the membership |
| `dead_lettered` | The consumer failed five times and the dead-letter consumer gave up | Read the `queue.process_failed` log lines for the id and fix the cause. Do not wait for the provider: it got a 200 at ingest and will not redeliver. To replay, set the row back to `status = 'pending'` and send `{ "rawEventId": "<id>" }` to the provider-events queue with a one-off script (anything with the `PROVIDER_EVENTS` binding). A built-in replay command is a follow-up |
| `ignored` | The event carries nothing to apply | Nothing |

A `parked` row is claimed again if the provider redelivers the same event.

**Stale calls.** A call whose events stop arriving is ended by the stale-call sweep, a Cron Trigger every five minutes: pre-connect calls idle for 10 minutes and connected calls idle for 4 hours end as `failed`, with a `call_event` signal `swept`, their hold settled and the lock freed (see [Stale-call sweep](architecture.md#stale-call-sweep)). `wrangler dev` does not fire cron triggers on its own; to run the sweep locally, start dev with `--test-scheduled` and open `/__scheduled`.

### Webhooks in end-to-end tests

`apps/web/e2e/fake-webhooks.ts` signs a fake event with the `FAKE_WEBHOOK_SECRET` from `apps/api/.dev.vars` and posts it straight to the API, as the provider would. `apps/web/e2e/inbox-helpers.ts` builds on it (`setSandbox`, `inbound`, `receipt`, `grantConsent` and locators), and the `inbox-*.spec.ts` specs cover the delivery chain, the WhatsApp window, the paused state, notes and STOP. These flows are marked slow, because each webhook takes a queue hop and a poll to appear.

## Fake provider balance, usage and cron (M4)

With the fake provider, the numbers page lists three synced numbers: +1 202 555 0100, 0101 and 0102. Fake usage mirrors your own billed calls, so reconciliation matches until you seed drift. Development-only endpoints (404 in production and unless `FAKE_WEBHOOK_SECRET` is set; they use the signed-in session) drive the rest:

- `POST /api/v1/dev/fake-provider/balance` with `{ "balanceMicros": 1500000 }` sets the fake balance and polls it now. The fake account keeps that balance across Refresh and the 30-minute poll (like a real account, it does not change by itself) until you seed another. Below $2.00 the dialer warns; below the call reserve it blocks. Open Usage to see it.
- `POST /api/v1/dev/fake-provider/usage` with `{ "date": "2026-11-12", "costMicros": 250000, "quantity": 60 }` adds one provider usage record for that UTC day, creating drift.

### Fake number purchase

Search and buy work against the fake provider with these scenarios:

- Area code 202 (the default) lists 0150 to 0159 (`+1 202 555 0150` to `0159`); any other area code lists 0150 to 0154.
- Every number costs $1.00 one-time plus $1.00 monthly, so a purchase charges $2.00.
- Numbers ending in 0159 always fail the order: the hold is released and nothing is charged.
- Numbers the workspace already owns are unavailable, so a quote for one is refused.

A successful purchase appears in the numbers list assigned for calls and messages.

To see drift handled, seed a usage record for yesterday, then on the Usage page run a reconciliation for that day (owners and admins). Drift up to $50 is adjusted and shows as `adjusted`; seed more than $50 (`costMicros` is capped at 10,000,000 per record, so seed several) to get `needs_review`.

To run a cron locally, start the API with scheduled testing and trigger the expression, URL-encoded (`*/30 * * * *` becomes `*/30+*+*+*+*`):

```bash
pnpm --filter @knoqra/api exec wrangler dev --port 8787 --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
curl "http://localhost:8787/__scheduled?cron=15+3+*+*+*"
```

Use your `KNOQRA_API_PORT` instead of 8787 if you set it. The expression must match a trigger in `wrangler.jsonc`. Each run is recorded in the `cron_run` table.

## Adding a migration

1. Change the Drizzle schema in `packages/db/src/schema/`.
2. Generate the SQL: `pnpm --filter @knoqra/db generate`. This writes a numbered file and a snapshot under `packages/db/migrations/`.
3. Read the generated SQL, then apply it: `pnpm --filter @knoqra/db migrate`.
4. Commit the SQL and the `meta/` snapshot together. Never edit a migration that has been merged; add a new one.

## Adding a tenant-scoped table

Any table that holds organization data needs all of the following. The schema catalog test in `packages/db/test/rls.test.ts` fails if a table that has an `organization_id` column lacks `ENABLE` and `FORCE` row-level security. It cannot detect a tenant table that forgot `organization_id`, so reviewers must check that too.

- [ ] An `organization_id text not null` column, with a foreign key to `organization` unless the rows must outlive it (as `audit_event` does)
- [ ] `CHECK (organization_id <> '')`, so the empty string can never be a tenant
- [ ] The table name added to the array in `packages/db/sql/rls.sql`, which `ENABLE`s and `FORCE`s row-level security and creates the `tenant_isolation` policy
- [ ] If it points at a contact, a composite foreign key `(organization_id, contact_id)` to `contact (organization_id, id)`, so a row can never reference another tenant's contact
- [ ] If it is append-only history, the table added to the `REVOKE UPDATE, DELETE` line in `packages/db/sql/rls.sql`
- [ ] An id helper prefix in `packages/core/src/ids.ts` if the table has its own id type
- [ ] A migration (see above), then `pnpm --filter @knoqra/db migrate`
- [ ] Isolation tests next to the existing ones in `packages/db/test`: another tenant cannot read, update, delete or insert, and an empty tenant context sees nothing
- [ ] All queries inside `withTenant`, using `tx`

A table with an `organization_id` column that must stay readable without a tenant context (Better Auth's `member` and `invitation`) is listed in `RLS_EXEMPT` in the catalog test, with a comment explaining why. Tables with no `organization_id` column, such as `provider_event_raw` and the other Better Auth tables, are never inspected and need no entry.

## Troubleshooting

**`DATABASE_URL must connect as knoqra_app`.** The test setup found a superuser or `BYPASSRLS` role. Check `DATABASE_URL`, and recreate the volume if the role was never created (`docker compose down -v`, then up again).

**`role "knoqra_app" does not exist` or login fails.** The init script only runs on an empty volume. Reset it with `docker compose down -v` and start again.

**`permission denied for table`.** Migrations ran before the role existed, so privileges were not granted. Re-run `pnpm --filter @knoqra/db migrate` as the admin role; `rls.sql` grants them again.

**Port 54329, 8787 or 5173 already in use.** Another Postgres, `wrangler dev` or Vite is running. Stop it. On Windows, look for an orphaned `workerd.exe` (see the E2E notes).

**Sign-in fails with an invalid origin, or no cookie is set.** `BETTER_AUTH_URL` must be exactly the origin the browser uses (`http://localhost:5173` in dev), and you must open the Desk on that origin, not on port 8787.

**`apps/api/.dev.vars is missing`.** Copy `.dev.vars.example` as shown under first run.

**CI says the generated API client is out of date.** Run `pnpm api:generate` and commit the changes under `packages/api-client`.

**Biome reports an error in a CSS file.** Biome cannot parse Tailwind directives, so `@source` paths live in `apps/web/src/tailwind-sources.pcss`, which `styles.css` imports. Put new Tailwind-only directives there.

**Docker is not running.** The database and API tests cannot work without a real Postgres: start Docker Desktop (or the Docker service) and run `docker compose up -d`.

**Expo Go cannot sign in, or the API answers 500 on every auth call.** `exp://` origins are trusted only when `APP_ENV=development` and `BETTER_AUTH_URL` is localhost, 127.0.0.1 or [::1], so pointing it at a LAN IP or a tunnel disables the Expo dev origins. If `NODE_ENV=development` is set for a staging or production environment, or with a non-local `BETTER_AUTH_URL`, the auth guard fails every request on purpose: use `NODE_ENV=production` for deployed builds.

**Rate limits do not seem to apply locally.** The `RL_*` Rate Limiting bindings are declared only in the staging and production blocks of `wrangler.jsonc`, and without a binding every request is allowed. Better Auth's own limiter is off outside staging and production too. The auth limit keys on `cf-connecting-ip`, which exists only behind Cloudflare. Tests pass fake bindings instead (`apps/api/test/rate-limit.test.ts`).
