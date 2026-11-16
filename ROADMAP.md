# Roadmap

KNOQRA is built in phases. Each phase reuses one core: numbers, contacts, a timeline of events, consent checks and an immutable ledger. The tracker for the work below lives in the repository's [issues](https://github.com/Razepriv/Open-Knoqra/issues) and [milestones](https://github.com/Razepriv/Open-Knoqra/milestones), seeded from [docs/roadmap/issues.yml](docs/roadmap/issues.yml).

This roadmap lists scope, not dates.

## Product principles

- **Consent and eligibility are enforced on the server.** The client never decides whether a call or message is allowed. Do-not-call, per-channel consent, WhatsApp windows and registration gates are checked before anything leaves the system.
- **No auto-calling unverified prospects.** Outbound automation only reaches contacts whose eligibility has been verified.
- **Costs are transparent.** Spend is shown before and after it happens, recorded in an immutable ledger, and capped by warning and stop limits.
- **Tenant isolation is not optional.** Every tenant table is protected by row-level security, tested against a real database.

## Phase 1: personal communications

One person, one US number: calls, SMS and WhatsApp, contacts with a full timeline, and spend control. Every table already carries `organization_id`, so the model is multi-tenant ready.

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 Foundation | Monorepo and CI, design tokens and UI kit, schema with row-level security, auth and workspaces, Hono API, webhook ingest and queue, OpenAPI client, fake provider, deploy pipeline | Done |
| M1 Desk shell and contacts | App shell (rail, header, theme), Contacts list, Contact 360 with timeline, consent and provenance, duplicate merge, CSV import, settings and two-factor | Done |
| M2 Voice | Telnyx credentials and WebRTC token, dialer states, live call panel and dock, outcomes, voicemail, realtime fan-out, ledger reserve, capture and release, spend caps | Done |
| M3 Inbox (SMS and WhatsApp) | Threads, composer states, delivery status chain, internal notes. Live sending stays gated behind 10DLC registration and Meta approval | Done |
| M4 Numbers and usage | Setup checks and capability tiles, balance polling, Usage page and ledger with CSV export, daily reconciliation | Done |
| M5 Today and Otto | Week grid, streak, heatmap, goal ring, focus timer, customizable widgets, tasks, notifications, command palette, the Otto assistant on a mock AI provider | Done |
| M6 Hardening | Full E2E matrix, accessibility pass, security review, a small live telephony test on owner-authorized numbers | Done (observability, rate limits, completeness, performance). The security audit is paused and the full E2E run is deferred to go-live |

Known gaps that block a production launch are tracked as `priority:p1` issues: durable auth rate limiting and a real email sender for password reset.

## Phase 1.2: get paid and verified

KNOQRA's hosted service: customers pay by UPI or card, verify their identity, and get a US number that KNOQRA buys on its own account. This phase is part of the hosted edition, not of the open-source core ([EDITIONS.md](EDITIONS.md)). Phase 2 starts after this is live.

| Milestone | Scope | Status |
| --- | --- | --- |
| M7 Billing and price book | Price book, top-ups and plans, bonus credit, number rent, invoices, refunds, pricing toggle | Planned |
| M8 Managed Telnyx and call safety | Platform Telnyx account, numbers per workspace, per-workspace limits, server-connected calls, emergency-call notice | Planned |
| M9 Identity verification | Passkeys, mobile one-time code, PAN or masked Aadhaar upload, face scan with liveness, review queue, Telnyx compliance sync, cron status check, approval notification | Planned |
| M10 Purchase gate and launch | Number purchase only when paid and verified, legal pages, live test | Planned |

## Later phases

These are directions, not commitments, and will be re-scoped when Phase 1 lands.

### Phase 2: teams and money

- Teams and a shared inbox
- Support tickets
- Wallet and billing
- A lightweight CRM

### Phase 3: AI go-to-market

- Website intelligence
- Ideal customer profile (ICP) definition
- Prospect discovery
- Watches on accounts and signals
- Campaigns
- Permissioned AI voice, only where consent and eligibility checks allow it

### Phase 4: revenue operations

- Pipeline reporting built on recorded activity
- Attribution from first touch to closed work
- Operational controls for larger teams

## How to take part

Pick an issue labelled `good first issue` or `help wanted`, or propose something with the feature request form. See [CONTRIBUTING.md](CONTRIBUTING.md).
