# Contributing to KNOQRA

Thanks for helping. KNOQRA is licensed under AGPL-3.0 with [additional terms](ADDITIONAL-TERMS.md), and everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Fix a bug or pick up an issue. Issues labelled `good first issue` are scoped for newcomers, and `help wanted` marks work where we would especially like a hand.
- Improve the documentation, including the guides under `docs/`.
- Report a bug or propose a feature with the [issue forms](https://github.com/Razepriv/Open-Knoqra/issues/new/choose).
- Review open pull requests.

For anything larger than a small fix, open or comment on an issue first so the approach can be agreed before you invest time. The [roadmap](ROADMAP.md) shows where the project is heading.

## Setup

Requirements: Node 22 (see `.nvmrc`), pnpm 10.34.5 (`corepack enable` picks it up from `packageManager`) and Docker for the local Postgres. The full walkthrough for macOS, Linux and Windows is in the [README](README.md#getting-started) and [docs/development.md](docs/development.md).

```bash
docker compose up -d
pnpm install
pnpm --filter @knoqra/db migrate
pnpm lint
pnpm typecheck
pnpm test
```

Other scripts: `pnpm dev`, `pnpm build`, `pnpm format`, `pnpm docs:check`, `pnpm check:imports`.

## Branches

Branch from `main` and name the branch for its type:

| Prefix | Use for |
| --- | --- |
| `feat/` | New behavior, for example `feat/contact-import` |
| `fix/` | Bug fixes, for example `fix/webhook-retry` |
| `docs/` | Documentation only |
| `chore/` | Tooling, dependencies, CI |

## Commit messages

Use conventional commits: `<type>: <description>`, with an optional body that explains why.

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

```text
feat: add contact import
fix: re-enqueue orphaned webhook events
docs: explain the RLS checklist for new tables
```

## Tests

Every change that alters behavior comes with tests, and we prefer them first: write a failing test, make it pass, then tidy up.

| Level | Where | Notes |
| --- | --- | --- |
| Unit | each package's `*.test.ts` | Pure logic, components, helpers |
| API integration | `apps/api/test` and `packages/db/test` | Run against real Postgres from `docker compose`, never a mock. Row-level security can only be proven on a real database |
| End to end | `apps/web/e2e` | Playwright against the local stack and the fake provider |

Run `pnpm test` for the unit and integration suites and `pnpm --filter @knoqra/web e2e` for the browser tests. Aim for at least 80% coverage on new code.

## Coding conventions

- **TypeScript strict.** `noUncheckedIndexedAccess` is on. No `any` without a comment that explains it.
- **No `console`.** Biome rejects it. Use the structured `logger` from `apps/api/src/lib/logger.ts`, and never log request bodies, tokens or phone numbers.
- **Immutable patterns.** Return new objects instead of mutating arguments.
- **Small files.** Aim for 200 to 400 lines, and split at 800. Keep functions short and focused.
- **Tenant data goes through `withTenant`.** Read and write tenant-owned tables only inside `withTenant(db, orgId, (tx) => ...)`, and use `tx`, never `db`, inside the callback (the request pool has one connection). See [docs/architecture.md](docs/architecture.md#tenancy-model).
- **Money is integer micros.** 1 USD is 1,000,000 micro-units. Never store or compute money as a float.
- **Provider calls go through `@knoqra/providers`.** App code depends on the interfaces, not on Telnyx or any other vendor SDK.
- **Loading states use `Skeleton` and `Reveal`.** See below.
- **Design tokens, not hex.** Style with the CSS variables from `@knoqra/tokens` (for example `var(--panel)`), never hard-coded colors.
- **Validate at the boundary.** Parse every external input with Zod, and use the `{ data, error }` envelope for `/api/v1` responses.

Biome formats and lints the code (`pnpm lint`, and `pnpm format` to fix). Markdown is not auto-formatted, so keep it tidy by hand: one `#` heading per file, tagged code fences, aligned tables.

### Loading states

Every loading placeholder uses `Skeleton` from `@knoqra/ui` (an ASCII glyph pattern from [ascii-reveal](https://github.com/quanhoangindex/ascii-reveal)). Wrap content that arrives later in `Reveal` so it decodes in. Do not add gray-box skeletons and do not import `ascii-reveal` directly in an app.

## Brand, attribution and legal notices

The KNOQRA name, logo, the Otto character and `packages/brand` are trademarks, not AGPL code. See [TRADEMARKS.md](TRADEMARKS.md).

- Keep the "Powered by KNOQRA" attribution and the legal notices that [ADDITIONAL-TERMS.md](ADDITIONAL-TERMS.md) requires. Pull requests that remove, hide or weaken them, or the self-host license key check, are declined.
- A new user interface, such as a new app or a signed-out screen not built on `AuthLayout`, shows the attribution too. In the Desk, use `PoweredBy` from `apps/web/src/components/powered-by.tsx`.
- The [CLA](CLA.md) lets the project owner also offer the code under a commercial license. That is how the white-label license works.
- AI coding agents follow [AGENTS.md](AGENTS.md).

## Pull requests

Keep each PR focused. The [pull request template](.github/pull_request_template.md) asks for the same checklist:

- [ ] Tests added or updated for the change
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] Tenant isolation considered (new tables have forced RLS, queries go through `withTenant`)
- [ ] No secrets, real phone numbers or personal data in code, fixtures or tests
- [ ] Docs updated where behavior or setup changed
- [ ] CLA signed

**PRs require the CLA.** The CLA bot comments on your first PR; sign by replying with the sentence it asks for. See [CLA.md](CLA.md).

## Review process

1. CI runs lint, typecheck, tests, the build and the E2E suite on every PR. Fix failures before asking for review.
2. A maintainer is requested automatically through CODEOWNERS and aims to respond within a few working days.
3. Address review comments with new commits, then mark the conversation resolved. Give the PR a title in the commit format above.
4. Security-sensitive changes (auth, tenancy, webhooks, secrets) get a closer review and may need extra tests.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
