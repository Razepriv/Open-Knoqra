# Observability

Errors go to Sentry, product analytics go to PostHog, and the API writes structured logs to Cloudflare Workers Logs. Everything is optional. A missing or invalid key switches that integration off, and the app runs the same without it.

Settings has a **System status** section that shows whether each piece is on. Use it to verify this guide. Only workspace owners and admins see it.

## What is collected, and what never is

| Tool | Collected | Never collected |
| --- | --- | --- |
| Sentry (API and Desk) | Errors and a sample of performance traces (5% by default), with the release and the environment. No user is attached to events | Any user (no id, name, email or IP), request bodies, cookies, query strings, request headers other than `user-agent` and `content-type`, response headers, session replays, UI click and input breadcrumbs (they carry element labels such as contact names), credentials in URL paths (auth tokens are replaced with `[redacted]`) |
| PostHog (Desk and API) | A short fixed list of events (below), only for users who opted in | Page URLs, text on the page, session recordings, autocapture, names, emails, phone numbers, contact or message content |
| Workers Logs | One structured JSON line per request and per notable event | Request bodies, secrets, bound query values (error messages are redacted outside development) |

### Sentry privacy rules

Both apps use the same rules. Sentry 11 removed `sendDefaultPii`; the `dataCollection` option replaces it, and we set it to:

```ts
dataCollection: {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
}
```

On top of that, before an event leaves the app:

- request bodies, cookies, query strings and every request header except `user-agent` and `content-type` are dropped;
- neither app sets a user; if a `user` ever reached an event, the scrubber would keep only its `id`;
- every string in messages, exception values, breadcrumbs, extra data, contexts and tags goes through `scrubText`;
- console breadcrumbs (both apps) and `ui.*` click and input breadcrumbs (Desk) are dropped;
- in the API, the request path in transaction names, `request.url`, span descriptions and the `url.full`, `url.path`, `http.target`, `http.url` and `http.route` trace data goes through the same path redaction as the logs (see [Logs](#logs));
- the Replay integration is not installed.

`scrubText` replaces:

| Pattern | Becomes |
| --- | --- |
| An email address | `[email]` |
| `+` followed by 7 or more digits, spaces, dots, dashes or parentheses, ending in a digit | `[phone]` |
| A bare run of 7 or more digits | `[phone]` |
| `ddd-ddd-dddd` or `(ddd) ddd-dddd`, with a space, dot or dash | `[phone]` |
| `Bearer <token>` | `Bearer [redacted]` |
| The `params:` tail that Drizzle adds to database errors | `params: [redacted]` |

ISO dates and times (`2026-11-12`) are left alone. A string longer than 8192 characters is cut at 8192 and ends with `…[truncated]`.

### PostHog privacy rules

Analytics are opt-in. The setting is **Settings, Preferences, "Share anonymous usage data"**, and it is **off by default** (stored as `user_prefs.analytics_consent`). Nothing reaches PostHog from a user who has not turned it on, from the Desk or from the API. The distinct id is the internal user id, never a name, email or phone number.

The Desk starts PostHog with autocapture, automatic page views, page leave, session recording, surveys, web experiments, product tours, feature flags, exception capture, performance capture, dead-click capture and rage-click capture all off. It masks all text, does not store the referrer, does not send the IP, creates person profiles only for identified users, keeps state in `localStorage`, and denies the URL and referrer properties (`$current_url`, `$pathname`, `$referrer`, `$referring_domain` and their `$initial_*` forms).

The only events are:

| Event | Sent by | Properties |
| --- | --- | --- |
| `page_viewed` | Desk | `route`: the route id (for example `/contacts`), never the URL |
| `contact_created` | Desk | none |
| `system_status_refreshed` | Desk | `status`: `ok`, `degraded` or `down` |
| `contacts_import_batch` | API | `created`, `updated`, `skipped`, `rejected`: counts only |

Any other event, or any property outside this list, is dropped before it is sent. The API sends `contacts_import_batch` in the background (`waitUntil`), and only for a user who opted in.

## Keys

Every key is read from the environment or from secrets. Nothing is hard-coded. An invalid value is logged once as `config.invalid` with the key name only, never the value, and that integration stays off.

### Where to get them

| What | Where |
| --- | --- |
| Sentry DSN | Your Sentry project, Settings, Client Keys (DSN). Use one project for the API and one for the Desk, or one for both |
| Sentry org and project slugs | The slugs in the Sentry URL for the project. The project is the **Desk** project that receives source maps |
| Sentry auth token | Sentry, Settings, Developer Settings: an internal integration or organization auth token that may upload source maps and create releases for the Desk project. It is a secret |
| PostHog project key | PostHog, Project settings, Project API key. It starts with `phc_` and is public by design |
| PostHog host | `https://us.i.posthog.com` for US cloud, `https://eu.i.posthog.com` for EU cloud, or your own `https://` host |

Vendor menus change from time to time. If a label differs, look for the same item.

### Worker (secrets with `wrangler secret put`, or `apps/api/.dev.vars` locally)

| Key | Meaning |
| --- | --- |
| `SENTRY_DSN` | Switches Sentry on. Must be an `https:` DSN with a public key and a numeric project id |
| `SENTRY_RELEASE` | Release name on every event. The deploy workflow sets it to the deployed commit's SHA with `--var` |
| `SENTRY_TRACES_SAMPLE_RATE` | A number from 0 to 1. Default `0.05`. Anything else falls back to `0.05` and is logged as `config.invalid` |
| `POSTHOG_KEY` | Switches server-side PostHog on |
| `POSTHOG_HOST` | Must be an `https:` URL. Default `https://us.i.posthog.com` when the key is set |

```bash
cd apps/api
pnpm exec wrangler secret put SENTRY_DSN --env staging
pnpm exec wrangler secret put POSTHOG_KEY --env staging
pnpm exec wrangler secret put POSTHOG_HOST --env staging   # optional
```

`SENTRY_RELEASE` is not a secret, and the deploy workflow sets it. To use a trace rate other than 5%, set `SENTRY_TRACES_SAMPLE_RATE` with `wrangler secret put` as above.

### Desk (read at build time, `apps/web/.env.local` locally)

| Key | Meaning |
| --- | --- |
| `VITE_SENTRY_DSN` | Switches Sentry on in the browser |
| `VITE_SENTRY_RELEASE` | Release name. The deploy job uses the deployed commit's SHA, so it matches the uploaded source maps |
| `VITE_SENTRY_ENVIRONMENT` | Environment label. Defaults to the Vite mode. The deploy job sets `staging` or `production` |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | A number from 0 to 1. Default `0.05` |
| `VITE_POSTHOG_KEY` | Switches PostHog on in the browser, for users who opt in |
| `VITE_POSTHOG_HOST` | An `https:` URL. Default `https://us.i.posthog.com` |

These values end up in the browser bundle, so only public keys belong here. See `apps/web/.env.example`.

The Desk loads both SDKs lazily, so an integration that is off downloads nothing and the initial JavaScript stays inside its budget. Errors raised before Sentry has loaded are buffered (at most 20) and sent once it does.

### Deploy only (GitHub environments `staging` and `production`)

| Key | Kind | Meaning |
| --- | --- | --- |
| `SENTRY_AUTH_TOKEN` | Environment **secret** | Uploads Desk source maps. Never a `VITE_` value |
| `SENTRY_ORG` | Environment variable | Sentry organization slug |
| `SENTRY_PROJECT` | Environment variable | Sentry Desk project slug |
| `VITE_SENTRY_DSN` | Environment variable | Desk DSN, built into the bundle |
| `VITE_POSTHOG_KEY` | Environment variable | Desk PostHog key, built into the bundle |
| `VITE_POSTHOG_HOST` | Environment variable | Desk PostHog host, built into the bundle |

The workflow also sets `VITE_SENTRY_RELEASE` and the Worker's `SENTRY_RELEASE` to the deployed commit's SHA, and `VITE_SENTRY_ENVIRONMENT` to `staging` or `production`. An unset variable is an empty string, and an empty value means off. Set them where your deploy runs (`pnpm knoqra deploy` passes Worker vars from its config).

### Source maps

`vite build` uploads source maps to Sentry only when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` are all set, which is the deploy job. The maps are `hidden` (the bundle does not point at them), and the Sentry plugin deletes them after the upload. Locally nothing is emitted or uploaded. After the build, the deploy job checks `apps/web/dist` and fails if any `.map` file is left, so maps never ship. Worker source maps are not wired; that is a later step.

### Verify the keys

Sign in as an owner or admin, open **Settings, System status** and refresh it.

Each row shows a status (`OK` or `Off` for these four) and a detail line underneath.

| List, row | What to expect |
| --- | --- |
| Server checks, **Sentry** | `OK` with `On (release <sha>)`, the deployed commit's SHA after a deploy, or `On` when no release is set. `Off` with `SENTRY_DSN: not a valid DSN` means the DSN is malformed. `Off` with `SENTRY_DSN is not set` means it is missing |
| Server checks, **PostHog** | `OK` with `On`. `Off` with `POSTHOG_HOST: must be an https URL` means the host is wrong. `Off` with `POSTHOG_KEY is not set` means the key is missing |
| This browser, **Sentry (Desk)** | `OK` with `On` when this Desk build has a valid `VITE_SENTRY_DSN`. Otherwise `Off` with the reason, such as `VITE_SENTRY_DSN: not a valid DSN` or `VITE_SENTRY_DSN is not set` |
| This browser, **PostHog (Desk)** | `OK` with `On` when this Desk build has a valid `VITE_POSTHOG_KEY` and host. Otherwise `Off` with the reason, such as `VITE_POSTHOG_HOST: must be an https URL` or `VITE_POSTHOG_KEY is not set` |

The two "This browser" rows report this Desk build's configuration only. They do not show whether you have opted in to analytics, and they do not show whether the SDK has loaded in this tab.

To see an error arrive in Sentry, cause a real failure in staging and open the project's Issues page. To see an event arrive in PostHog, opt in under Settings, Preferences, browse a few pages, and look for `page_viewed` in PostHog's activity view.

## Logs

The API writes one JSON object per line. Workers Logs are enabled in `apps/api/wrangler.jsonc`. Every line has:

| Field | Meaning |
| --- | --- |
| `level` | `debug`, `info`, `warn` or `error` |
| `msg` | A short event name, such as `request.completed`, `config.invalid` or `email.not_configured` |
| `time` | ISO 8601 timestamp |
| `requestId` | The id of the request that produced the line. Absent outside a request |

`request.completed` is logged once per request and adds `method`, `path`, `status` and `durationMs`. The `path` never has a query string, and credentials are redacted: under `/api/auth/` only the first segment is kept (`/api/auth/reset-password/[redacted]`), and elsewhere any segment of 20 or more token characters becomes `[redacted]` unless it is a KNOQRA id such as `ct_…` or a route word. `request.failed` uses the same `path`. `config.invalid` adds `key` and `reason`.

To query them, open the Cloudflare dashboard, then Workers & Pages, the API Worker, Logs. Filter on `msg = request.completed` and a `status` of 500 or more for server errors, on `requestId = <id>` to follow one request, or on `msg = config.invalid` after a deploy. Use the field names from the table in the query builder.

Outside development, error logs carry no stack and nothing after a Drizzle `params:` marker, because that tail holds bound values such as phone numbers and tokens. Full detail is on only when `APP_ENV` is `development`.

### Request id

Every API response carries an `x-request-id` header, including errors and 404s. If the caller sends a well-formed `x-request-id` (8 to 128 characters from letters, digits, `.`, `_`, `:` and `-`), the API reuses it. Otherwise it generates a UUID. Ask a user who reports a problem for the id from the failed response, then search the logs for it. Sentry events from the API carry it as the `request_id` tag.

## Health

| Endpoint | Auth | Use |
| --- | --- | --- |
| `GET /api/health` | none | Liveness. `200 {"status":"ok","db":"ok"}`, or `503 {"status":"degraded","db":"unreachable"}` when the database does not answer in 2 s. Uptime monitors use this |
| `GET /api/health/deep` | session of an `owner` or `admin` of the active organization | The detailed report behind the System status page |

`/api/health/deep` answers `200` with the report whenever you are authorized, so read `data.status`. It answers `401` without a session, `409 no_active_org` when the session has no active organization, and `403 forbidden` for other roles. If the database is down the session cannot be verified, so the answer is `500 internal_error`.

Each check is `ok`, `degraded`, `down` or `off`. `off` means not configured, and it never lowers the overall status. The overall status is `down` if a critical check is `down` (only the database is critical), otherwise `degraded` if any check is `degraded` or `down`, otherwise `ok`. A check that takes longer than 2 s counts as `down` with the detail `Timed out after 2 s`. No response ever contains a secret value.

| Check id | Reads | `off` when |
| --- | --- | --- |
| `database` | `select 1` (critical) | never |
| `migrations` | Applied migrations against the ones bundled with this release | never |
| `queue` | Count and age of unprocessed provider events (`pending`, `oldestPendingSeconds`, both served by a partial index). Degraded after 5 minutes | never |
| `durable_objects` | Each binding in `DURABLE_OBJECT_PROBES` is a Durable Object namespace | no probes registered (`None configured yet`) |
| `cron` | The `cron_run` table, for each job in `CRON_JOBS`. Degraded if a job missed two intervals or failed on its last run | no jobs registered (`No scheduled jobs yet`) |
| `provider` | Whether this deployment can run Telnyx (`PROVIDER=telnyx` with `TELNYX_PUBLIC_KEY` and `CREDENTIALS_MASTER_KEY` set; not whether your workspace saved a connection), and whether the fake provider is live | no provider (`Not connected`) |
| `email` | `ok` when `RESEND_API_KEY` and `EMAIL_FROM` are both set, in development too | either is unset. In development the detail reads `Development: mail goes to the log` |
| `sentry` | Sentry config is valid | no valid `SENTRY_DSN` |
| `posthog` | PostHog config is valid | no valid `POSTHOG_KEY` |

### Extending it (M2, M4, M5)

- **Health checks.** Add a `HealthCheck` (`id`, `label`, `critical`, `run`) to `HEALTH_CHECKS` in `apps/api/src/health/registry.ts`. Keep `data` to booleans, counts and timestamps.
- **Durable Objects.** Append `{ binding, label }` to `DURABLE_OBJECT_PROBES` in the same file. The check turns from `off` to `ok`, and goes `down` if the binding is missing.
- **Scheduled jobs.** Append a job (`name`, `cron`, `maxIntervalMinutes`, `run`) to `CRON_JOBS` in `apps/api/src/cron/jobs.ts`, and add the same cron expression to `triggers.crons` in `apps/api/wrangler.jsonc`. There is no trigger today. The `scheduled` handler records each run in `cron_run`, the cron health check starts reading it, and the job `name` becomes the Sentry cron monitor slug.

## Alerts to create in Sentry

Create these once per environment, in Sentry's UI. Menu names change over time, so follow the intent if a label differs.

### Uptime check

Alerts, Create Alert, Uptime Monitor (or any HTTP monitor from another tool).

- Request: `GET https://<api-host>/api/health`
- Interval: every 1 minute
- Expect: HTTP `200` and a body containing `"status":"ok"`
- Alert after 2 consecutive failures

### Error spike

Alerts, Create Alert, Issues. One rule per project.

- Condition: more than 50 events in 5 minutes, **or** 3 times the event count of the 1-hour baseline
- Environment: `production`. Add a second rule for `staging` if you want it
- Action: notify the owner by email

If the rule builder takes only one of the two conditions per rule, create two rules.

### New issue in the latest release

Alerts, Create Alert, Issues.

- Condition: a new issue is created, and it is in the latest release
- Environment: `production`
- Action: notify the owner

This depends on `SENTRY_RELEASE` and `VITE_SENTRY_RELEASE` being set, which the deploy workflow does.

### Cron missed

Once a job is registered in `CRON_JOBS`, the Worker's `cronTriggersIntegration` creates a Sentry cron monitor for it, with the job name as the slug. Open Alerts, Crons (or the Crons page), find the monitor, and check that it alerts on a missed check-in and on a failed check-in. No monitor exists before the first job has run, so there is nothing to create today.

### Health degraded

`/api/health/deep` needs an owner or admin session, so an external monitor cannot read it. That is deliberate: it needs no new secret to rotate. Until you add a variant that a monitor can reach:

- rely on the uptime check for liveness and database reachability;
- check Settings, System status for the rest;
- once a job exists, the cron monitor above catches jobs that stall or fail.

A token-protected variant of the deep endpoint, with an uptime monitor on it, is a possible later change. It is not built.

## Related

- [Development guide](development.md#environment-files) for local env files
- [Self-host guide](self-host.md) for secrets and deploying
