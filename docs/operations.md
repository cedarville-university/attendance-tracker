# Operations

Environment variables, processes, migrations, and the background worker.

For Canvas setup see [canvas-installation.md](canvas-installation.md); for Azure deployment see
[../infra/azure/README.md](../infra/azure/README.md).

## Processes

One container image runs three roles, selected by command override:

| Role | Command | Notes |
|---|---|---|
| Web | `node --import ./server/dist/telemetry/otel-preload.js server/dist/index.js` | The image default. Serves the API and `web/`. |
| Worker | `node --import ./server/dist/telemetry/otel-preload.js server/dist/worker.js` | Runs **one pass, then exits**. Scheduled, not long-running. |
| Migrate | `node server/dist/migrate.js` | Deliberately without the OTel preload. |

The `--import` preload is load-bearing. Calling `startTelemetry()` from inside `index.ts` runs after
Fastify, `pg`, and `node:http` are already in the module registry, so instrumentation wraps nothing
and Application Insights records zero requests. The in-module `startTelemetry()` calls remain only to
cover the loader-less `tsx` development path and are idempotent no-ops under `--import`.

### The worker

`server/src/worker.ts` performs a single pass and calls `process.exit`. Per pass, in order:

1. **Maintenance** — purge expired `oidc_transactions`, expired `app_sessions`, then `audit_events`
   older than `RETENTION_DAYS`.
2. **Line-item deletions** — `DELETE` Canvas line items for courses whose last closed session was
   removed. Wrapped in its own error boundary so one poisoned course cannot stall grade sync.
3. **Grade sync** — claim up to 50 due jobs, group by course, and post AGS scores.

It then logs a single JSON tally line prefixed `[worker]`. SIGTERM sets a cooperative abort flag
checked between units of work.

In Azure it is a Container Apps Job on `*/5 * * * *` with `parallelism: 1`, a 600 s replica timeout,
and scale-to-zero between runs. Locally, run one pass with `npm run build && npm run worker`.

Grade-sync retry behavior is set by **compile-time constants**, not environment variables
(`server/src/attendance/grade-sync-store.ts`): 6 attempts maximum, exponential backoff from 5 min
doubling to a 60 min cap, with ±20% jitter. HTTP 429, 5xx, network errors, and 401 are retried; a
401 re-mints the token once per course per pass. Permanent 4xx and malformed JSON fail immediately.
A course with a missing or invalid AGS line-items URL fails terminally.

An instructor can re-queue a course's failed jobs with **Retry grade sync**, which also re-arms a
terminally-failed line-item deletion.

## Environment variables

### Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Local dev: `postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker` (matches `docker-compose.yml`). |
| `APP_BASE_URL` | The app's own public base URL, e.g. `https://attendance.example.edu`. **Normalized to a bare origin** — any path or trailing slash is stripped. Used to build the LTI `redirect_uri`, to generate `/lti/config.json`, for the CSRF origin check, and to decide whether the session cookie is `Secure` (only when it starts with `https://`). |
| `ALLOWED_TARGET_LINK_URIS` | Comma-separated exact-match allowlist of `target_link_uri` values `/lti/launch` may redirect to. Must contain `<APP_BASE_URL>/index.html`. |

A missing or invalid value in this whole table is a **hard boot failure** for both web and worker —
except where noted as unvalidated below.

### Optional — LTI and sessions

| Variable | Default | Purpose |
|---|---|---|
| `LTI_TOOL_SIGNING_KEYS_JSON` | unset → a key is generated on first boot and persisted to `tool_signing_keys` | JSON array of `{ kid, privateKeyPkcs8Pem, status: 'active' \| 'previous' }`. Takes precedence over the database table. Generate with `node scripts/generate-signing-keys.mjs`. **Never commit.** |
| `LTI_TOOL_TITLE` | `Scanttendance` | The tool's name in Canvas. Sets every `title` and `text` field in `/lti/config.json` at once — the app title and the course-navigation link label instructors click — so the two cannot disagree. Whitespace is trimmed and an empty value is rejected. Does **not** rename the gradebook column, which is always `Attendance`. |
| `SETUP_TOKEN` | unset → the admin page's token bootstrap is disabled | Bootstrap credential (≥ 16 chars) for `/admin.html`, sent as the `x-setup-token` header. Lets you add the first Canvas connection before an Administrator-role launch exists. Unset it once an admin launch works. **Never commit.** |
| `CLOCK_SKEW_SECONDS` | `120` | Allowed skew when validating a launch JWT's `exp`/`nbf`/`iat`. |
| `LOGIN_TRANSACTION_TTL_SECONDS` | `300` | How long an `/lti/login`-issued `state`/`nonce` stays valid. |
| `APP_SESSION_TTL_HOURS` | `8` | Application session lifetime. |

### Optional — runtime and data

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port. The host is always `0.0.0.0`. |
| `NODE_ENV` | unset | Drives the `RUN_MIGRATIONS_ON_BOOT` default, the log level, and pino-pretty. |
| `RUN_MIGRATIONS_ON_BOOT` | `true` unless `NODE_ENV=production` | Literal `'true'` or `'false'` only — any other value fails validation. |
| `RETENTION_DAYS` | unset → the retention sweep is a **no-op** | Deletes `audit_events` older than this. Attendance data is never pruned. |
| `CARD_FINGERPRINT_SECRET` | unset → fingerprints are not persisted | HMAC key for the stored per-card fingerprint. Its **presence is the feature flag**. Read directly from `process.env`, so it is not schema-validated; if fingerprinting is enabled while it is unset, scans throw at request time. **Never commit.** |
| `LOG_LEVEL` | `info` when `NODE_ENV=production`, else `debug` | pino level. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | unset → telemetry is a no-op and the Azure package is never imported | Enables Azure Monitor / OpenTelemetry. |
| `OTEL_SAMPLING_RATIO` | `1` | Azure Monitor sampling ratio. |

### Optional — card-lookup identity resolver

Card lookups happen entirely server-side, so no lookup credentials reach the browser.

- **`MockIdentityResolver`** (default) fabricates a deterministic pseudo-student per card code, so
  the app can be demoed without a real API. Two special card codes exercise error states without
  hardware: a code containing `NOID` simulates a response missing a University ID, and one
  containing `ERR` simulates a network failure.
- **`HttpIdentityResolver`** calls a real institutional card-lookup API, selected automatically once
  the three required variables below are set.

| Variable | Required | Default |
|---|---|---|
| `IDENTITY_API_URL` | yes | — |
| `IDENTITY_API_KEY_NAME` | yes | — |
| `IDENTITY_API_KEY` | yes | — (redacted in logs) |
| `IDENTITY_API_METHOD` | no | `GET` |
| `IDENTITY_API_TIMEOUT_MS` | no | `5000` |
| `IDENTITY_API_UNIVERSITY_ID_FIELD` | no | `redwoodId` |
| `IDENTITY_API_FIRST_NAME_FIELD` | no | `firstName` |
| `IDENTITY_API_LAST_NAME_FIELD` | no | `lastName` |
| `IDENTITY_API_EMAIL_FIELD` | no | `email` |

`IDENTITY_API_URL` may contain the literal placeholders `{CARD_CODE}`, `{KEY_NAME}`, and `{KEY}`,
each URI-encoded at request time. The `*_FIELD` variables are field names or dot-paths (e.g.
`student.universityId`) read from the raw JSON response.

> **Caveat:** if any of the three required variables is missing, the app falls back to
> `MockIdentityResolver` **silently** — no error, no warning. If real lookups are not working,
> verify all three are actually present in the running environment.

### Test-only

| Variable | Default |
|---|---|
| `TEST_DATABASE_URL` | `postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_test` |
| `E2E_DATABASE_URL` | `postgres://…/attendance_tracker_e2e` |
| `E2E_SETUP_TOKEN` | `e2e-setup-token-0123456789` |
| `E2E_CARD_FINGERPRINT_SECRET` | `e2e-secret-not-for-prod` |
| `E2E_BASE_URL` | — |

There is no `.env` loading anywhere in the app; export variables or prefix the command. No
`.env.example` file exists.

## Migrations

SQL lives in `server/migrations/`, generated by Drizzle from
`server/src/database/schema.ts` via `drizzle.config.ts`. The migrations folder is resolved relative
to the module URL, never `process.cwd()`, so it works from both `src/` and `dist/`.

There is no `generate` npm script — create a new migration with `npx drizzle-kit generate`.

- **Development:** applied at boot. `npm run dev` and `npm run worker` set
  `RUN_MIGRATIONS_ON_BOOT=true` explicitly, and it defaults true anyway when `NODE_ENV` is not
  `production`. `npm run migrate` runs them standalone.
- **Production:** **never at boot.** The runtime image sets `NODE_ENV=production` and the Bicep
  modules additionally pin `RUN_MIGRATIONS_ON_BOOT=false`. Schema changes come only from the CI
  migrate job, which opens a just-in-time Postgres firewall rule for the runner, runs
  `node server/dist/migrate.js`, and removes the rule in an `always()` step.

The deploy pipeline enforces ordering: the infra pass pins the *current* image so it cannot roll
code, then migrate runs, then the deploy rolls web and worker to the new image. Migrations are never
a race between replicas.

Neither the app nor `migrate.js` can **create** a database — only migrate an existing one. The test
harnesses create theirs via an admin connection.

## Health probes

| Endpoint | Behavior |
|---|---|
| `GET /health/live` | 200, no I/O. |
| `GET /health/ready` | Config check plus `SELECT 1` with a 2 s timeout; 503 `{status:'not-ready'}` on failure. |

Readiness deliberately does **not** depend on Canvas — a Canvas outage must not take the app out of
rotation.

`GET /lti/config.json` is also public and does no I/O; it serves the Canvas registration body (see
[canvas-installation.md](canvas-installation.md)).

## Security posture

- Helmet CSP, with the `form-action` directive derived at boot from enabled registrations' OIDC
  origins. Adding a **new Canvas origin** therefore requires a restart.
- `Permissions-Policy: hid=(self)` — the scanner page gets WebHID, nothing embedded does.
- `/lti/login` and `/lti/launch` are rate-limited to 30 requests/minute/IP, inside an encapsulated
  plugin scope so classroom scan bursts on
  `POST /api/attendance-sessions/:id/scans` are not limited.
- Mutating `/api/*` requests require an `x-csrf-token` header plus an origin check.
- Cross-course access returns **404, never 403**, so session IDs cannot be probed.
- Admin routes require an LTI Administrator-role session **or** a matching `x-setup-token`.

## Tests

```bash
docker compose up -d     # required: the suite fails at global setup without Postgres
npm test                 # vitest: unit + integration
npm run test:e2e         # playwright against a mock Canvas platform
npm run lint
npm run typecheck
```

`npm test` uses `TEST_DATABASE_URL`, a **different** database from `DATABASE_URL`: the suite
`TRUNCATE`s every table between files, so sharing one would wipe development data. It is created
automatically on first run. Vitest's `globalSetup` creates and migrates it once before any test file
runs, including the browser tests that never touch the database — so if Postgres is down, the whole
suite fails at setup rather than on an assertion. Test files run serially because they share that one
database.

## Known gaps

- **`RETENTION_DAYS` is not set in any Bicep parameter file**, so the audit-event retention sweep is
  currently inert in all deployed environments.
- **The identity resolver falls back to mock silently** when any required `IDENTITY_API_*` variable
  is missing (see the caveat above).
- Only `deploy-dev.yml` exists. Stage and prod Bicep parameter files are present, but no workflow
  deploys them. The dev deploy triggers on a `v*` tag or manual dispatch.
- Attendance data has no retention sweep; only `audit_events` are pruned.
