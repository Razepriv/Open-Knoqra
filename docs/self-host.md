# Self-hosting KNOQRA

This guide runs KNOQRA on your own Cloudflare account and your own Postgres database. Two commands do the work: `pnpm knoqra setup` asks for your accounts and keys, and `pnpm knoqra deploy` sets everything up and deploys it.

KNOQRA runs on Cloudflare Workers. There is no Docker deployment.

## What you need

- **A Cloudflare account.** The API and the Desk run there as two Workers, with Hyperdrive and Queues. Check Cloudflare's current plan limits for Workers, Hyperdrive and Queues.
- **An address.** Either a domain whose DNS is on Cloudflare, or a free `workers.dev` address (no domain needed).
- **Postgres 15 or newer.** [Neon](https://neon.tech) is recommended: it is free to start and needs no server. Any other Postgres works if you have a login that owns the database and can create roles.
- **A telephony account:** Telnyx (recommended: calls, SMS and WhatsApp) or Plivo.
- **Optional:** a [Resend](https://resend.com) account with a verified sending domain, for password-reset mail.
- **Optional:** an API key for OpenAI or an OpenAI-compatible provider, for Otto's AI drafts.
- **A GitHub account,** to get the free license key.
- **Node 22 and pnpm 10** on your computer.

## 1. Install

```bash
git clone https://github.com/Razepriv/Open-Knoqra.git
cd Open-Knoqra
corepack enable     # pnpm 10 is pinned in package.json
pnpm install
```

## 2. Answer the setup questions

```bash
pnpm knoqra setup
```

It asks seven groups of questions. Nothing you paste is shown on screen. Answers go to `.env.selfhost` at the repository root, readable only by you. Run it again at any time: press Enter to keep a saved value, or type `-` to clear a saved optional one.

1. **Cloudflare.** An API token and the account to deploy to.
   - Create the token at dash.cloudflare.com → My Profile → API Tokens → Create Token, from the **Edit Cloudflare Workers** template.
   - Check that it has these permissions, and add any that are missing:
     - Account · Workers Scripts · Edit
     - Account · Hyperdrive · Edit
     - Account · Queues · Edit
     - Zone · DNS · Edit (for your domain, or all zones)
   - If the token sees one account, setup picks it. Otherwise it lists them and asks.
2. **Postgres.** The owner connection string.
   - On Neon: your project → Connect, pick the owner role (usually `neondb_owner`), turn off **Connection pooling**, and copy the string. If you paste a pooled (`-pooler.`) address, setup switches it to the direct one.
   - Setup can test the connection.
   - This login is used only to create the app's own restricted login, `knoqra_app`, and to run migrations. The app itself never connects as the owner.
3. **Address.**
   - A domain: the Desk is at `https://app.example.com` and the API at `https://api.example.com`.
   - A workers.dev address: the Desk is at `https://knoqra-web.<your-subdomain>.workers.dev` and the API at `https://knoqra-api.<your-subdomain>.workers.dev`. Setup looks up your subdomain.
4. **Telephony provider.** Telnyx, Plivo or both.
   - This only sets which providers a workspace may connect. You connect the provider account itself later, in the Desk.
   - For Telnyx you can add the webhook public key now (Telnyx portal → Keys & Credentials → Public Key). It is optional.
5. **Email (optional).** A Resend API key and a sender, for example `KNOQRA <no-reply@example.com>`. Without both, password-reset mail is not sent. Everything else works.
6. **AI for Otto.**
   - **Mock:** no model. Otto writes simple, predictable drafts.
   - **OpenAI-compatible:** an API key, and optionally a model name and a base URL for providers other than OpenAI.
   - **ChatGPT sign-in:** each user signs in with ChatGPT in the Desk. This sign-in is coming in a later release; until then Otto uses the mock.
7. **License key (optional here).** See [step 4](#4-finish-in-the-desk).

Setup also generates three secrets: `BETTER_AUTH_SECRET`, `CREDENTIALS_MASTER_KEY` and `KNOQRA_APP_DB_PASSWORD`.

**Back up `.env.selfhost`** in a safe place, such as a password manager. `CREDENTIALS_MASTER_KEY` encrypts the provider keys stored in your database. If you lose it, those keys cannot be read and every workspace has to connect its provider again.

## 3. Deploy

```bash
pnpm knoqra deploy
```

It runs these steps in order:

| Step | What it does |
| --- | --- |
| `db` | Creates the `knoqra_app` login role (no superuser, no row-level security bypass) or updates its password, then runs the database migrations with the owner login. |
| `cloudflare` | Creates or updates the Hyperdrive config `knoqra` (caching off) for the `knoqra_app` login, creates the queues `knoqra-provider-events` and `knoqra-provider-events-dlq`, and creates the R2 bucket `knoqra-media` for WhatsApp images, voice notes and files. |
| `config` | Writes `apps/api/wrangler.selfhost.jsonc` and `apps/web/wrangler.selfhost.jsonc`. |
| `api` | Deploys the API Worker, `knoqra-api`. |
| `secrets` | Sets the API Worker's secrets. Only their names are printed. |
| `web` | Builds the Desk and deploys the web Worker, `knoqra-web`. |
| `status` | Prints the Desk and API addresses and checks the API's health. |

Hyperdrive caching stays off because cached reads would ignore each workspace's data boundaries. The `knoqra_app` role must not bypass row-level security, because that is how KNOQRA keeps workspaces apart. Deploy stops if it does.

## 4. Finish in the Desk

1. Open the Desk address and sign up.
2. **License key.** A self-hosted KNOQRA asks for a free license key before it unlocks.
   - Star the KNOQRA repository on GitHub.
   - Open <https://app.knoqra.app/api/license/github/start> and sign in with GitHub.
   - Copy the key and paste it on the license screen. If you gave it to setup, the Desk is already unlocked.
   - The key is not a software license: your rights to the code come from the [AGPL-3.0](../LICENSE). See [licensing.md](licensing.md) for how the key works.
3. **Connect your provider** in Settings › Connectors.
4. **Follow the Setup page** to add phone numbers.
5. **Enable messaging** in the Inbox, under Channels:
   - **SMS:** press Enable and fill in your business details. KNOQRA registers your number for US business texting (10DLC) with your own Telnyx account: brand, campaign and number. Telnyx bills the registration fees. Sending switches on when carriers approve it, usually within 1 to 3 business days.
   - **WhatsApp:** connect a WhatsApp Business number in the Telnyx portal, then press Enable and Check again. KNOQRA finds the number and shows it as live once Meta approves it.

WhatsApp files are stored in the R2 bucket `knoqra-media`. To create it by hand: `wrangler r2 bucket create knoqra-media`. Without the bucket, uploads answer 503 and inbound files show as unavailable. Outbound files are fetched by Telnyx from your API address, so `API_PUBLIC_ORIGIN` (set by `pnpm knoqra deploy`) must be your public `https://` API address.

Telnyx webhooks go to `https://api.example.com/webhooks/telnyx` (your API address). The Desk shows the exact webhook URLs for each connection, including Plivo's answer URL.

## Running one step again

Name the step:

```bash
pnpm knoqra deploy secrets    # after changing a key in setup
pnpm knoqra deploy api        # redeploy the API only
pnpm knoqra deploy status     # addresses and health
```

The `api`, `secrets` and `web` steps write their config first, so a changed setting is picked up.

## Upgrading

```bash
git pull
pnpm install
pnpm knoqra deploy
```

Deploy is safe to repeat: it updates what exists and creates what is missing. Migrations only apply what is new.

## Trying it first: `--dry-run`

```bash
pnpm knoqra deploy --dry-run
pnpm knoqra setup --dry-run
```

- `deploy --dry-run` prints every step: each Cloudflare request as `METHOD path`, each command line with secrets hidden, and both generated configs in full. It still reads from Cloudflare (for example, whether Hyperdrive exists), but creates, changes and writes nothing.
- `setup --dry-run` asks every question and checks the answers, but saves nothing.

Both commands also take `--env-file <path>` to use another settings file instead of `.env.selfhost`.

## Files it creates

| File | What it is | Commit it? |
| --- | --- | --- |
| `.env.selfhost` | Your answers and generated secrets. Mode 600. | Never. It is gitignored. |
| `apps/api/wrangler.selfhost.jsonc` | The API Worker's config: name, vars, Hyperdrive id, routes, rate limits. Generated from `apps/api/wrangler.jsonc`. No secrets. | No. It is gitignored and rewritten on every deploy. |
| `apps/web/wrangler.selfhost.jsonc` | The web Worker's config: name, routes and the service binding to the API. Generated from `apps/web/wrangler.jsonc`. | No. It is gitignored and rewritten on every deploy. |
| A temporary secrets file | Holds the Worker secrets while `wrangler secret bulk` runs. Mode 600, in your system's temp folder. | Deleted right after. |

The generated API config always sets `KNOQRA_EDITION` to `selfhost`, `PROVIDER` to `connectors`, and the rate limits `RL_AUTH`, `RL_DIAL`, `RL_VOICE_TOKEN` and `RL_MESSAGE_SEND` with namespace ids 1001 to 1004. Do not edit the generated files: change the settings and deploy again.

## Settings in `.env.selfhost`

| Name | What it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Where to deploy. Wrangler uses them too. |
| `POSTGRES_OWNER_URL` | The owner connection string, for the role and migrations only. |
| `KNOQRA_ADDRESS` | `domain` or `workers.dev`. |
| `KNOQRA_DOMAIN` or `KNOQRA_WORKERS_SUBDOMAIN` | The domain, or the account's workers.dev subdomain. |
| `CONNECTORS` | `telnyx`, `plivo` or `telnyx,plivo`. |
| `TELNYX_PUBLIC_KEY` | Optional. The Telnyx webhook public key. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Optional. Password-reset and welcome mail (branded HTML with a plain-text version; templates in `apps/api/src/email`). |
| `EMAIL_REPLY_TO` | Optional. Where replies to your mail go, for example your support inbox. |
| `EMAIL_POSTAL_ADDRESS` | Optional. Your postal address, one line, shown in every email footer. Required by law in marketing mail. |
| `BLOG_FEED_URL` | Optional. An RSS 2.0 feed whose three newest posts appear in the welcome email. |
| `AI_PROVIDER` | `mock`, `openai` or `chatgpt`. |
| `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | For `openai` only. The model and base URL are optional. |
| `KNOQRA_LICENSE_KEY` | Optional. The license key, instead of pasting it in the Desk. |
| `BETTER_AUTH_SECRET`, `CREDENTIALS_MASTER_KEY`, `KNOQRA_APP_DB_PASSWORD` | Generated by setup. |

## Troubleshooting

- **"Cloudflare did not accept that token."** Check the token's permissions (step 2) and that Account Resources includes your account.
- **"This token cannot see any domain."** Give the token Zone · DNS · Edit on your domain, or choose the workers.dev address.
- **"No workers.dev subdomain found."** Open Workers & Pages in the Cloudflare dashboard once to choose one, then run setup again.
- **The Postgres connection fails.** Use the owner login and the direct (non-pooled) host. Neon needs `sslmode=require` in the string, which Neon's copied string already has.
- **"This login cannot create roles."** Use the database owner, or a login with `CREATEROLE`.
- **"knoqra_app bypasses row-level security."** The role was created with too many rights. Drop it (`DROP ROLE knoqra_app;` as the owner) and run `pnpm knoqra deploy db` again.
- **"No Hyperdrive config named knoqra yet."** Run `pnpm knoqra deploy cloudflare`.
- **The Desk or API address does not answer right after the first deploy.** A new custom domain needs a few minutes for its certificate. Run `pnpm knoqra deploy status` again later.
- **Password-reset mail is not sent.** Set both the Resend API key and the sender, then run `pnpm knoqra deploy secrets`.
- **The license screen does not accept the key.** Copy the whole key, starting with `KNOQRA-LICENSE-1.`. See [licensing.md](licensing.md).
- **A secret you removed is still on the Worker.** Deploy only adds and updates secrets. Remove one with `pnpm exec wrangler secret delete <NAME> -c wrangler.selfhost.jsonc` in `apps/api`.
- **Rate limits are shared with another Worker.** Two Workers in one Cloudflare account that use the same namespace ids share counters. KNOQRA uses 1001 to 1004.
- **`node: <path>: not found` with `--env-file`.** Node 22 checks a file passed as `--env-file` itself, even after the script name. Create the file first, or call `node -- scripts/knoqra/cli.mjs` directly.

For the details behind each piece (Hyperdrive, queues, secrets, rate limits), see [architecture.md](architecture.md). Before the first real call, read [Running on a live Telnyx account](live-telnyx.md).
