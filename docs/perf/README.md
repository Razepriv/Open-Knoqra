# Performance tools

This folder holds the performance reports and explains the tools that make them. A teammate can use it to re-run every check after a milestone merges, and to add that milestone's queries and pages.

All commands run from the repository root. Every tool takes the target database explicitly, so no tool can run against a database by accident.

## What the budgets are

| Budget | Limit |
| --- | --- |
| Initial JavaScript | At most 200 KB gzipped. KB means 1024 bytes. "Initial" is the entry chunk plus every chunk it reaches through static imports. Size is zlib gzip at the default level. |
| Route chunks | Lazy. No file under `apps/web/src/routes/` except `__root.tsx` may be in the initial set. |
| LCP | At most 2.0 s on `/sign-in`, `/contacts` and `/contacts/{id}`, using Lighthouse's desktop preset. LCP (largest contentful paint) is when the biggest visible element finishes drawing. |
| CLS | At most 0.05 on the same pages. CLS (cumulative layout shift) scores how much the layout jumps while loading. |
| API p95 | At most 150 ms locally for list, search and detail calls, with 100,000 contacts and 1,000,000 timeline events in one organization. p95 means 95 percent of requests are at least this fast. |

Database rules behind the API budget:

- Every list is paginated.
- Every hot query is checked with `EXPLAIN (ANALYZE, BUFFERS)` as the `knoqra_app` role, with `app.org_id` set.
- A "large table" is any relation whose `pg_class.reltuples` is 10,000 or more.

All data is synthetic. Emails end in `@example.test`, phones look like `+1 NPA 555 XXXX`, and names come from fixed word lists. Reports record the CPU count, OS family, and Node and Postgres versions. They never record a hostname or a path.

## One-time setup

1. Start the local Postgres (see [the development guide](../development.md)).
2. Create an empty database for the perf tools. Its name must contain `perf`. This stream used `knoqra_s9_perf`. Create it the same way the guide creates the dev database. `perf:seed` runs the migrations.
3. Make sure `apps/api/.dev.vars` exists. The perf tools copy it and replace only `DATABASE_URL`. `BETTER_AUTH_URL` in it must equal the web origin, for example `http://localhost:5173`.
4. Pick ports if the defaults are taken. `KNOQRA_WEB_PORT` defaults to 5173 and `KNOQRA_API_PORT` to 8787. The tools stop with an error if a port is already in use, so stop your dev servers first.
5. Install the browser that `perf:web` drives:

```bash
pnpm --filter @knoqra/web exec playwright install chromium
```

Default connection URLs, with `<db>` as the database name:

- Owner: `postgres://knoqra:knoqra@localhost:54329/<db>`
- App: `postgres://knoqra_app:knoqra_app@localhost:54329/<db>`

Set `PERF_ADMIN_DATABASE_URL` and `PERF_DATABASE_URL` to override them. Each must name the same database as the other, and as `--database` if you pass it.

### Database safety rules

- `knoqra` and `knoqra_m1` are always refused. `--force` does not change that.
- Any other name must contain `perf`. `--force` lifts only this check.
- `--reset` needs a name containing `perf` even with `--force`, because it empties every user and organization in the database. It prints the database name and row counts before it truncates.

## The commands, in order

Run them in this order. Each later tool reads `.perf/fixtures.json`, which `perf:seed` writes. The file records which database it was seeded for, and the tools refuse a different one.

Seed the database. It runs migrations, creates two organizations, loads data, and checks that organization B cannot see organization A's contacts. Organization A gets about 100,000 contacts and 1,000,000 timeline events, plus the Phase 1 tables listed below. A full seed takes about 6 to 7 minutes on a 16-core machine.

```bash
pnpm perf:seed --database knoqra_s9_perf --reset
```

Seed flags:

- `--reset`: empties the database first. Without it, a non-empty database is refused.
- `--scale <n>`: n is in (0, 1], a fraction of full size. The default is 1. Use `0.1` for a quick check.
- `--seed <n>`: the random seed. The default is 42. The same seed gives the same data.
- `--fixtures-only`: recomputes `.perf/fixtures.json` from the data already in the database. It does not migrate, reset or load.

Fixtures include deep cursors. These are page cursors that point 50,000 rows into the contact list and 25,000 rows into the heaviest contact's timeline (scaled down with `--scale`). A shallow cursor would hide the cost of the security filter on late pages.

### Phase 1 volumes

Organization A also gets these rows at full scale. Organization B gets about 1% of each. Every generator draws from its own random stream (`streamRand` in `seed/random.ts`), so the M1 rows are the same as before and adding a generator never shifts another.

| Table | Rows | Shape |
| --- | --- | --- |
| `call` | 200,000 | All finished, so the owner has no live call. About 2% are unanswered inbound calls with a voicemail. |
| `voicemail` | 4,000 | One per voicemail call. |
| `conversation` | 60,000 | 50,000 contacts each have an SMS thread, and 10,000 of them also have WhatsApp. About 10% are unread. |
| `message` | 600,000 | 20,000 in the heaviest contact's SMS thread, the rest spread over the others. |
| `message_status_event` | about 1.2 million | Each message's delivery chain: `received` inbound, and `queued`, `sent`, `delivered`, `read` or `failed` outbound. |
| `timeline_event` notes | about 100,000 | 65% of the M1 notes of a contact with an SMS thread reference that thread. No timeline rows are added. |
| `task` | 20,000 | For owner A: 60% open (30% without a due date, 5% overdue, the rest due in 2099) and 40% done. 2,000 are about the heaviest contact. |
| `notification` | 5,000 | For owner A, 10% unread. Every overdue task already has its `task_due` notification, so a notifications poll inserts nothing new. |
| `message_template` | 50 | About 60% SMS, every tenth archived. |
| `ledger_entry` | 300,000 | The starter credit, top-ups, adjustments and reservations, each closed by a capture or a release. |
| `number_order`, `number_quote` | 200 each | A quarter completed, 2.5% pending, the rest failed. Each holds a ledger reservation. |
| `phone_number` | 50 | Mostly active. |
| `usage_event`, `reconciliation_report` | 300 each | One report per day. One in ten is adjusted, with its ledger adjustment. |

The future due dates and their reminders are fixed in 2099, not relative to today, so the same seed gives the same rows and a notifications poll never starts materializing reminders. A unit test keeps every reminder after 2090.

Phase 1 fixture placeholders: `{ids.heavyConversation}`, `{ids.message}`, `{search.conversationName}`, `{search.conversationDigits}`, `{usage.from}`, `{usage.to}`, and the deep cursors `{cursors.callsDeep}`, `{cursors.conversationsDeep}`, `{cursors.threadDeep}`, `{cursors.tasksOpenDeep}`, `{cursors.tasksDoneDeep}`, `{cursors.ledgerDeep}` and `{cursors.reconciliationsDeep}`. All of them are read back by SQL after the load, so `--fixtures-only` recomputes them. The Phase 1 explain cases live in `packages/perf/src/explain/phase1-cases.ts`.

Explain every registered query:

```bash
pnpm perf:explain --database knoqra_s9_perf
```

Run the API load test:

```bash
pnpm perf:load --database knoqra_s9_perf
```

`--target` picks what the load hits (Ruling L-a). Every target runs the same mix, warm-up, duration and virtual users, and shares one runner and one report format.

- `inprocess` (the default) carries the p95 gate. It calls the real Hono app in-process under Node, through the same harness `perf:explain` uses, against the perf database as `knoqra_app`. Each call is timed around the app's request handler. It measures routing, middleware, auth and SQL. It leaves out the Workers runtime and the network.
- `wrangler` starts local `wrangler dev` and sends HTTP to it. It is informational: the report says "informational, no gate", and the run fails only on errors. Local wrangler dev handles requests one at a time, with a floor of about 50 ms each, so 10 users measure its queue, not the API. The report adds a single-user line: the median of 15 sequential requests to `/api/health`, the contact list and one contact. Its default report name is `<date>-load-wrangler.md`.
- `remote` sends HTTPS to an already-deployed Worker and carries the same p95 gate as `inprocess`. It needs `--api-origin <https url>` and `--web-origin <https url>`, starts no local server, and still reads its fixtures through `--database`, so seed the perf branch that Worker uses first (with `PERF_ADMIN_DATABASE_URL` and `PERF_DATABASE_URL`). It refuses a host that names none of `staging`, `preview` or `perf` unless `--force`. It signs in once and leaves the `sign-in` scenario out, rescaling the other weights, because staging rate-limits sign-in. The report names only the hosts. Deploying a Worker to test against is covered in [the self-host guide](../self-host.md).

Neither local target is a production number. Production Workers run isolates concurrently behind Hyperdrive's connection pool.

Users per target (Ruling L-b). `--vus` overrides either default.

- `inprocess` defaults to 1 virtual user, and fires a scenario's requests one at a time (Ruling L-c), so one request is in flight. It gates latency at full data scale. Every in-process user shares one Node event loop, so more users measure that loop, not the API.
- `remote` defaults to 10 virtual users. It gates throughput on real infrastructure (go-live step 6a).
- `wrangler` defaults to 10 and stays informational.

`remote` and `wrangler` fire a scenario's requests in parallel, as a browser does.

Finding behind the ruling (2026-11-14, background CPU about 88% from other sessions): at 10 in-process users every gated request failed. With one user a contact list costs about 50 ms against under 10 ms of SQL, so each request spends about 40 ms of CPU outside SQL, and 10 users queue on the one event loop. That run did not gate the Phase 1 routes (inbox, thread, calls, tasks): their requests were not yet named `list`, `search` or `timeline`, and they measured 660–890 ms p95.

| Request (10 in-process users) | p50 ms | p95 ms |
| --- | --- | --- |
| contacts list | 413 | 654 |
| contacts list, deep cursor | 395 | 660 |
| contacts search | 522 | 778 |
| contact detail | 497 | 749 |
| contact timeline | 521 | 794 |
| timeline, deep cursor | 492 | 702 |

The 1-user, one-request-at-a-time run ([2026-11-14-load.md](2026-11-14-load.md), background CPU about 90%) fails three gated routes. Contact search (p50 98 ms, p95 154 ms) and inbox search (p50 110 ms, p95 176 ms) are part SQL and part overhead: the R2 bounded scan costs 25 to 51 ms of SQL in the same day's explain run, and the rest is the per-request overhead. Notifications (p50 168 ms, p95 239 ms, only 2 samples) is overhead: its 8 statements cost 7.7 ms of SQL in explain.

Follow-up:

- Profile the per-request CPU of the in-process app: a `pg` connect and SCRAM handshake per request, the session lookup, and request logging.

Run the realtime fan-out test:

```bash
pnpm perf:realtime --database knoqra_s9_perf
```

Measure the web app:

```bash
pnpm perf:web --database knoqra_s9_perf
```

Flags shared by the tools:

| Flag | Tools | Meaning |
| --- | --- | --- |
| `--database <name>` | all | The target database. Required unless a `PERF_*` URL names it. |
| `--force` | all | Lifts the "name must contain perf" check. Never lifts the protected names. |
| `--out <file>` | explain, load, web | Report file. The default is `docs/perf/<YYYY-MM-DD>-<tool>.md` (`-load-wrangler.md` and `-load-remote.md` for those targets). `perf:realtime` has no `--out`; it always writes the default path. |
| `--target <t>` | load | `inprocess` (default), `wrangler` or `remote`. See above. |
| `--api-origin <url>`, `--web-origin <url>` | load | Both required with `--target remote`, and refused without it. |
| `--vus <n>` | load | Virtual users, meaning simultaneous clients. Default 1 for `inprocess`, 10 for `remote` and `wrangler` (Ruling L-b). |
| `--duration <s>` | load | Seconds of load. Default 30. The machine is shared, so keep it at 60 or less. |
| `--runs <n>` | web | Lighthouse runs per page. The median is reported. Default 3. |
| `--note <text>` | explain, load | Free text for the report, for example the background load during the run. |

Every flag takes either `--flag value` or `--flag=value`, for example `--out=report.md` or `--vus=5`.

Each tool exits 0 on PASS and 1 on any failure. The report is still written when a check fails, including a hard failure such as a sign-in error or a replay that throws (the report then carries a one-line `FAIL` reason). A missing or mismatched fixtures file stops the tool with one line: `no fixtures for <db>: run pnpm perf:seed --database <db> first`.

Resource use: `perf:load`, `perf:web` and a full seed are CPU heavy. Run Playwright with 2 workers or fewer, and do not run these while other heavy jobs run. `perf:web` also builds the web app if the build is stale.

`perf:explain` runs mutating cases for real. The import case commits its rows. The replay then runs the same statements inside a rolled-back transaction, so those inserts hit `ON CONFLICT DO NOTHING`. The plans are still the real ones. Re-run `perf:seed --reset` to get back to the pristine data.

## How to read each report

Reports live in this folder and are named `docs/perf/<YYYY-MM-DD>-<tool>.md`, where the tool is `explain`, `load`, `web` or `realtime`.

Existing reports:

- [2026-11-12-explain-before.md](2026-11-12-explain-before.md): the explain run before the indexes in migration `0012` (first numbered `0005`, then `0008` after the M2, M3 and M5 merge, then `0012` after the Phase 1 merge). It is the baseline.
- [2026-11-13-explain-after.md](2026-11-13-explain-after.md): the M1 cases after the contact indexes.
- [2026-11-14-explain-phase1-before.md](2026-11-14-explain-phase1-before.md): the first run with the Phase 1 seed and cases, before the Phase 1 fixes.
- [2026-11-14-explain.md](2026-11-14-explain.md): every case after the Phase 1 fixes.

Every report starts with `Overall: PASS` or `Overall: **FAIL**` and a list of problems.

### Explain report

One row per registered case:

| Column | Meaning |
| --- | --- |
| Case | The case name from `EXPLAIN_CASES`. |
| Milestone | The milestone that owns it. |
| Status | PASS or FAIL. |
| DB ms | Total database time, summed over the statements the request ran. |
| Budget ms | The limit for that case. |
| Statements | How many SQL statements the request ran. |
| Seq scans | Tables read in full. `-` means none. |

A case fails when:

- the HTTP status is not 2xx,
- a response contains an id from another organization,
- DB ms is over budget,
- a statement does a sequential scan on a large table that is not allowed.

A sequential scan (Seq Scan in the plan) reads every row of a table. It is fine on a small table and a failure on a large one, unless the case lists the table in `allowSeqScan` with a reason.

The allowlist today has one reason: substring search under row-level security is a bounded scan on `contact`, with a 150 ms budget. It covers the contact search and the inbox search (`conversations.search.*`). See "RLS and indexes" below.

A case can also be allowed over its time budget, but only under a recorded ruling (`allowOverBudget` in the registry, with a `reason` and a `ceilingMs`). The report still prints its time and marks it `PASS (allowlisted)`, with the ceiling next to the reason. Above the ceiling the case fails again (`over allowlisted ceiling`), so a regression on an allowlisted path is still caught. One ruling uses this today: T10-b, for `usage.ledger.*`. The usage ledger computes running balances with a window over the organization's whole ledger, so every page costs about 1 to 2 seconds at 300,000 entries. Its ceiling is 3,000 ms. The fix is a stored running balance, proposed at the end of [2026-11-14-explain.md](2026-11-14-explain.md) and parked until after Phase 1.

Each case then lists its statements with their time, buffer counts and plan nodes. Values from the data are never written into the report.

### Load report

One row per request name and per scenario:

| Column | Meaning |
| --- | --- |
| Count | Requests made. |
| Errors | Responses that were not 2xx, or that failed. |
| p50, p95, p99 ms | The median, 95th and 99th percentile latency. |
| max ms | The slowest request. |
| req/s | Throughput. |

The header names the target and says what it measures. The load test first runs 5 s of warm-up at 2 users, which is not recorded. For `inprocess` and `remote`, FAIL means any error, or a gated request with p95 over 150 ms. For `wrangler`, FAIL means any error; there is no time gate. The request mix is in `packages/perf/load/mix.json`.

### Web report

- A bundle table: each initial file with its gzipped KB, and the total against 200 KB.
- A pages table: median LCP in seconds, CLS, TBT (total blocking time, how long the main thread was blocked, in ms), the Lighthouse performance score, and PASS or FAIL.
- A details section per page: the LCP element, its phases, and the largest layout shifts.

FAIL means LCP over 2.0 s, CLS over 0.05, initial JS over 200 KB, or a route chunk in the initial set. A missing metric counts as a failure, never as zero.

The bundle check also runs on every `pnpm build` (`apps/web/scripts/check-bundle-budget.mjs`). To run only that check:

```bash
pnpm --filter @knoqra/web check:bundle
```

### Realtime report

The test opens 200 WebSockets in one organization, sends one trigger request, and times how long every socket takes to get the expected message. Until Durable Objects exist, it prints `SKIP perf:realtime: no Durable Object bindings in apps/api/wrangler.jsonc yet (they land with M2).` and exits 0. Once bindings exist, the run is marked FAIL (and the report still written) with `configure realtime/config.ts trigger and expectType` if either is still `null`, so it can never PASS without measuring fan-out. A `wrangler.jsonc` that does not parse (trailing commas are fine) is an error, never a SKIP.

## Adding a milestone's queries and pages

Do this once a milestone has merged. Use fixture placeholders, never real values.

### Placeholders

Strings in paths and bodies can use `{name}` placeholders. They resolve against `.perf/fixtures.json`, for example `{ids.heavy}` (the contact with the most timeline events), `{ids.middle}`, `{cursors.contactsDeep}`, `{cursors.timelineDeep}` and `{search.name}`. A body value `{ "$fixture": "importRows" }` inserts that fixture value as it is, arrays included. For new fixture data, extend `packages/perf/src/seed/fixtures.ts`, then run `pnpm perf:seed --database <name> --fixtures-only`.

### Explain case

Append an entry to `EXPLAIN_CASES` in `packages/perf/src/explain/registry.ts`. Every case runs as owner A. Set `mutates: true` if the request writes. Add `allowSeqScan` only with a table and a written reason.

```ts
{
  name: 'tasks.list.first',
  milestone: 'M3',
  method: 'GET',
  path: '/api/v1/tasks?limit=50',
  budgetMs: 50,
},
```

### Load mix

Add a scenario to `packages/perf/load/mix.json`. `weight` is its share of the traffic. A scenario can run several requests in order. In a path, `{rotate:a|b}` uses a different fixture on each iteration. The Node runner and the k6 script both read this file. Only a request whose `name` is one of `list`, `search`, `detail` or `timeline` is held to the 150 ms p95 budget, so give every request that must be gated one of those names. Both runners fail on an unknown placeholder (the Node runner checks the whole mix before it starts any server). After adding a fixture key, re-run `pnpm perf:seed --database <name> --fixtures-only`.

```json
{
  "name": "tasks.list",
  "weight": 10,
  "requests": [{ "name": "list", "method": "GET", "path": "/api/v1/tasks?limit=50" }]
}
```

### Web page

Append to `PAGES` in `packages/perf/src/web/budgets.ts`. Set `auth: true` for a page that needs a signed-in session. The tool measures unauthenticated pages first. It then signs in as owner A in the browser and measures the others with the same cookies.

```ts
{ name: 'tasks', path: '/tasks', auth: true },
```

### Realtime trigger

Set `trigger` and `expectType` in `packages/perf/src/realtime/config.ts`. `trigger` is the one request that causes a broadcast. `expectType` is the `type` field of the JSON message every socket must receive. Both are `null` until M2 fills them in.

```ts
trigger: { method: 'POST', path: '/api/v1/contacts', body: { displayName: 'Perf Broadcast' } },
expectType: 'contact.created',
```

The path, socket count and timeout are in the same file. The tool reads `apps/api/wrangler.jsonc` and skips itself while it has no `durable_objects` bindings.

## RLS and indexes

Row-level security (RLS) is a Postgres feature that adds a filter to every query on a table. Here it limits each query to the organization in `app.org_id`. The app connects as `knoqra_app`, which cannot bypass it.

Postgres only lets an index answer a condition when the comparison is leakproof. A leakproof function cannot reveal the value it compares through an error message or other side effect. With RLS on, Postgres refuses to use a non-leakproof comparison as an index condition, because it could expose rows the filter would hide. It runs those comparisons as plain filters on every row it reads instead.

Functions like `lower()`, `ILIKE`, `LIKE` and `regexp_replace` are not leakproof. So an index on `lower(display_name)` does not help a query that compares it.

The rule for new indexes: index only plain columns, or stored generated columns, compared with `=`, `<` or `>`. If a query needs an expression, put the expression in a stored generated column, then index and compare that column.

Migration `0012` does this for `contact` and `task`. On `task` it adds `due_key`, equal to `coalesce(due_at, 'infinity')`, the open task list's sort key. On `contact` it adds four stored generated columns:

- `sort_name`: `lower(display_name)`, for the list order.
- `name_key`: the lowercased display name with spaces collapsed, for duplicates.
- `email_key`: `lower(email)`, for duplicates.
- `search_text`: lowercased name, company and email joined by a separator, for search.

The queries compare against these columns and return what they returned before. One measurement as `knoqra_app`: a keyset predicate over `lower(display_name)` ran as a filter in 445 ms. The same predicate on a stored column ran as an index condition in 0.24 ms.

Deploy note: the migration adds the four columns with four separate `ALTER TABLE ... ADD COLUMN ... STORED` statements. Each rewrites the table under an exclusive lock. That is seconds per 100,000 contacts. It is fine at launch and worth planning for once the table is large.

### Substring search

A trigram index (an index of three-letter pieces, which speeds up `LIKE '%text%'`) cannot serve substring search under RLS, for the leakproof reason above. Marking the operator leakproof needs a superuser, which hosted Postgres does not give you.

So search runs `search_text LIKE lower('%q%')` on the pre-lowered column. That is one comparison per row instead of three `ILIKE`s. It measured 134 ms against 460 ms at about 105,000 contacts on one core. Matching is unchanged: the separator cannot appear in input, `%`, `_` and `\` are escaped, and a match cannot span two fields.

This is a bounded scan, so its cost grows with the number of contacts in one organization. Past about 250,000 contacts per organization, plan a trigram side table: one row per contact and trigram, matched with leakproof equality. Until then the search cases allow a sequential scan on `contact`, with a 150 ms budget.

## Caching and compression

The Desk's static files are served with Workers Static Assets. The rules are in `apps/web/public/_headers`:

- `/assets/*` (hashed names, never change after a build): `Cache-Control: public, max-age=31536000, immutable`. The rule first removes the default header with `! Cache-Control`, so the two are not combined. This detach syntax is Workers Static Assets behaviour. If it is ever ignored, hashed files get a combined header, which is still correct and only less cacheable.
- Everything else, including the HTML shell and single-page-app routes: `Cache-Control: no-cache`. The browser revalidates, so a new deploy shows up at once.

The API never goes through `_headers`. The Worker answers `/api/*` and `/webhooks/*`, and the middleware in `apps/api/src/app.ts` sets `Cache-Control: no-store` on those responses unless a route sets its own header. So no cache keeps API data.

Compression is done by Cloudflare's edge, which compresses responses for browsers that ask for it. The Worker and the local servers do not compress. So local runs of `perf:load` measure uncompressed responses, and the bundle check computes gzip sizes itself.

## k6

[k6](https://k6.io) is a load testing tool. It is optional. `perf:load` is a Node program that needs no extra install. The k6 script runs the same mix with the same fixtures over HTTP, so it is comparable to `--target wrangler`, not to the gated `inprocess` run:

```bash
k6 run -e API_ORIGIN=http://localhost:8787 -e WEB_ORIGIN=http://localhost:5173 --vus 10 --duration 30s packages/perf/load/k6.js
```

Before you run it:

1. Seed the perf database, so `.perf/fixtures.json` exists.
2. Start the API against the perf database. Run `wrangler dev` with an env file whose `DATABASE_URL` names the perf database. `perf:load --target wrangler` writes such a copy of `.dev.vars` to `.perf/dev.vars.perf` each time it starts the API.
3. `WEB_ORIGIN` is only sent as the `Origin` header on the sign-in request. It must equal `BETTER_AUTH_URL`.

The script signs in once. It fails the run if any request fails or p95 goes over 150 ms.
