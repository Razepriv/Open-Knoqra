# KNOQRA editions

KNOQRA comes in two editions built from one codebase.

| | Open source (this repository) | KNOQRA Cloud (hosted at [knoqra.app](https://knoqra.app)) |
| --- | --- | --- |
| License | [AGPL-3.0](LICENSE) with [additional terms](ADDITIONAL-TERMS.md) | Hosted service |
| Who runs it | You, on your own Cloudflare account and Postgres ([self-host guide](docs/self-host.md)) | KNOQRA |
| Source | [github.com/Razepriv/Open-Knoqra](https://github.com/Razepriv/Open-Knoqra) | Private |
| Telephony | Your own Telnyx or Plivo account, connected in the Desk | KNOQRA's account, or your own |
| License key | A free key, issued to anyone who stars the repository ([licensing](docs/licensing.md)) | Not needed |

## What the open-source edition includes

All of Phase 1, personal communications:

- **Calls:** the dialer, outbound and inbound calls, outcomes and voicemail, with consent and spend checks on the server before anything dials.
- **Contacts:** a timeline per contact, consent per channel, duplicate merge and CSV import.
- **Inbox:** SMS and WhatsApp threads, with the messaging policy enforced on the server.
- **Numbers and usage:** sync, assign and buy numbers on your own provider account, the setup wizard, the usage page and daily reconciliation.
- **Wallet:** an append-only ledger with warn and stop caps. It tracks your own provider spend: calls are estimated at a flat $0.01 a billed minute and reconciled against what the provider billed.
- **Today:** the week grid, streak, focus timer, tasks, notifications and the command palette.
- **Otto:** the assistant that drafts messages, writes contact briefs and summarizes what you missed, with every output labelled a draft and citing its sources. You connect your own model: an OpenAI-compatible API key today, and "Sign in with ChatGPT" later. The recommendation and personalization layer is the same in every edition.
- **Connectors:** connect any supported provider (Telnyx, recommended because it covers calls, SMS and WhatsApp, or Plivo).
- **Self-host tooling:** `pnpm knoqra setup` and `pnpm knoqra deploy`, and the self-host license key check.

## What KNOQRA Cloud adds

These are not part of this repository:

- payments, top-ups and subscription plans;
- per-destination call prices and a per-minute platform fee;
- numbers bought on KNOQRA's own telephony account, identity verification and the purchase gate;
- the service that issues self-host license keys;
- live call transcription;
- the mobile apps;
- the later phases: teams, a shared inbox and a CRM (Phase 2), and the AI go-to-market toolkit (Phase 3).

## How the editions fit together

The open-source core is complete on its own, and KNOQRA Cloud is the core plus extensions. Core code never depends on an extension: extensions plug into fixed extension points.

| Where | Extension point | What an extension can add |
| --- | --- | --- |
| API | `ApiExtension` in [`apps/api/src/extensions.ts`](apps/api/src/extensions.ts), passed to `createApp` and `createWorker` | Webhook routes, session-free pages, session routes under `/api/v1/*`, and the call pricing policy (`apps/api/src/lib/pricing.ts`) |
| Desk | `DeskExtension` in [`apps/web/src/extensions.ts`](apps/web/src/extensions.ts) | Pages under the signed-in shell, Settings sections, wallet funding buttons, a destination price line in the dialer, extra lines on the Usage page |
| Database | A second migration sequence with its own tracking table ([`packages/db/src/migrate.ts`](packages/db/src/migrate.ts)) | Its own tables, never columns on core tables |
| API client | A second OpenAPI document beside `packages/api-client/openapi.json` | Typed access to the extension's routes |

In the private repository, extension code lives in folders named `pro/`. This repository is produced from the private one by an export that leaves out every `pro/` folder and other private files, then installs, lints, typechecks and tests the result on its own. `pnpm check:editions` fails if a core file imports anything from a `pro/` folder.

## Contributing

Contributions to this repository go into the core and ship in both editions. A change must work with no extensions installed: if a feature needs an extension point that does not exist yet, propose the extension point. See [CONTRIBUTING.md](CONTRIBUTING.md).

The KNOQRA name, logo and Otto are trademarks, in every edition ([TRADEMARKS.md](TRADEMARKS.md)).
