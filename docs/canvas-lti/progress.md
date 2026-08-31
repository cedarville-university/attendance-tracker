# Canvas LTI Attendance Tracker — Progress Tracker

Tracks implementation of `docs/canvas-lti/spec.md` (§54 "Implementation phases").
This pass (`docs/superpowers/plans/i-have-a-spec-velvety-moon.md` — see the user's
plan file, not committed to this repo) covers **Phases 0–2 only**. Phases 3–8 are
listed below for continuity but have not been planned in detail yet.

## Phase checklist

- [x] **Phase 0 — Baseline and tests** — Node project tooling, linting, unit-test
      harness; tests around the OMNIKEY parser, `ScanPipeline`, and roster CSV
      parsing; existing browser app behavior preserved unchanged.
      Exit criterion: current standalone scanner still works. ✅ met.
- [x] **Phase 1 — Repository restructuring** — move browser sources into `web/`;
      create `server/`; one local dev command starts Postgres + backend +
      frontend; Docker Compose for local Postgres.
      Exit criterion: existing frontend served through the new backend, no card
      behavior regression. ✅ met.
- [x] **Phase 2 — Server-side identity resolver** — `IdentityResolver` interface,
      `MockIdentityResolver`, `HttpIdentityResolver`; browser card-service
      requests replaced with same-origin backend scan requests; production
      credentials UI removed.
      Exit criterion: scanner works through backend, no resolver secret reaches
      browser JavaScript. ✅ met.
- [ ] **Phase 3 — LTI authentication** — `/lti/login`, `/lti/launch`,
      `/lti/jwks`; OIDC transaction storage; launch validation; application
      sessions; role authorization; full security test matrix (spec §45).
      Exit criterion: all 24 §45 cases pass against the in-process mock Canvas
      platform (`npm test`). **Automated implementation complete.** Registering
      the tool in a real Canvas instance and verifying an instructor launch
      end-to-end (docs/canvas-installation.md) needs a public HTTPS deployment
      and has moved to **Phase 7** (see below) — it does not gate this phase.
- [x] **Phase 4 — NRPS** — Canvas token acquisition and roster retrieval;
      uploaded roster replaced as the primary workflow; identity matching
      configuration.
      Exit criterion: instructor launches from a course and sees the active
      Canvas learner roster without uploading a file.
- [x] **Phase 5 — Persistent attendance** — attendance sessions, roster
      snapshots, scan persistence, manual corrections, session close/reopen,
      audit events, CSV export.
      Exit criterion: closing/reopening the browser does not lose
      server-accepted attendance. ✅ met.
- [x] **Phase 6 — AGS grading** — cumulative line item, grade calculation,
      score submission, grade outbox, retry worker, status UI.
      Exit criterion: closing attendance updates the expected Canvas Gradebook
      column. ✅ met.
- [ ] **Phase 7 — Infrastructure and CI/CD** — Dockerfile, Bicep, Azure
      Container Apps, PostgreSQL, Key Vault, ACR, GitHub Actions OIDC
      deployment, stage/prod environments, health checks, monitoring.
      **Then, once a public HTTPS instance exists:** register the tool in
      Canvas (Admin → Apps, JSON config), install it in a test course, seed the
      registration, and verify an instructor launch opens the scanner in a new
      tab while a learner-role launch returns 403 — including checking
      `AUTHORIZED_INSTRUCTOR_ROLE_URIS` against a real launch payload
      (docs/canvas-installation.md). This is the real-Canvas verification that
      Phase 3 could not run.
      Exit criterion: a tagged/approved release deploys without any long-lived
      Azure deployment password in GitHub, and a real instructor Canvas launch
      against the deployed instance succeeds while a learner launch is refused.
- [ ] **Phase 8 — Hardening** — dependency review, CSP/CSRF/tenant-isolation/
      rate-limit testing, resolver redaction testing, key rotation drill,
      database restore drill, Canvas token/key rotation tests, browser/hardware
      validation.

## Phase 0 — what actually happened

- Root `package.json`/`tsconfig.json`/`vitest.config.ts`/`eslint.config.js`/
  `.prettierrc` added. `npm run dev`/`test`/`lint`/`typecheck` all present;
  `dev` is still the placeholder `python3 -m http.server 8000` command until
  Phase 1 stands up the Fastify server.
- `tsconfig.json`'s `include` points at `server/src/**/*.ts`; a placeholder
  `server/src/index.ts` (`export {}`) was added only so `tsc --noEmit` has a
  real input — Phase 1 replaces it with the actual Fastify entrypoint.
- ESLint's `no-unused-vars` rule was configured with `ignoreRestSiblings: true`
  — a pre-existing, correct use of that pattern in `app.js`
  (`parsedReportLogDetail`) would otherwise false-positive now that a linter
  exists for the first time.
- 33 tests added across `tests/omnikey-parser.test.js`, `tests/roster.test.js`,
  `tests/scan-pipeline.test.js`, covering every case in this plan's Phase 0
  Step 2–4 (byte-offset parsing incl. the real-firmware fallback from commit
  `99aec05`; CSV quoting/BOM/leading-zero-ID handling; and the full
  `ScanPipeline` concurrency/correlation matrix — duplicate suppression within
  and outside the time window, retry-after-failure, stale-lookup-does-not-
  clobber-latest, deletion-during-lookup, roster expected/unexpected/timeout).
  These are the pre-refactor regression baseline Phase 2 must not break when
  it swaps `lookupCard()` for a `fetch('/api/scans')` call.
- No existing runtime file (`app.js`, `scan-pipeline.js`, `lookup.js`, etc.)
  was modified. Verified via `git diff --stat` against the tracked source
  files (empty) and by serving the app with `python3 -m http.server` and
  confirming all files still serve as before.
- `docs/canvas-lti/spec.md` was copied verbatim from the user-supplied
  `docs/lti-spec.md` (which was untracked in the parent checkout and not
  copied automatically into this worktree).

## Phase 1 — what actually happened

- All 14 frontend source files plus `index.html`/`styles.css` were moved with
  `git mv` into `web/`; Phase 0's test files moved to `web/tests/` and
  `vitest.config.ts`'s `include` was updated to match. No import paths needed
  to change — all cross-file imports were already relative siblings. All 33
  Phase 0 tests still pass after the move alone.
- `server/src/index.ts` now boots a real Fastify app: `@fastify/static` serves
  `web/` at the root, and `GET /health` returns `{ status: 'ok' }`. The
  Phase 0 placeholder (`export {}`) is gone.
- `npm run dev` now runs `tsx watch server/src/index.ts` (hot-reloading
  Fastify) instead of the Phase 0 placeholder `python3 -m http.server 8000`.
  Added `fastify`, `@fastify/static`, `tsx`, and `@types/node` as
  dependencies.
- `eslint.config.js` gained a `typescript-eslint` block scoped to
  `server/**/*.ts` (existing `web/**/*.js` and `web/tests/**/*.js` blocks were
  narrowed with explicit `files` globs to match). Without this, `eslint .`
  silently skipped `.ts` files with no error, so `npm run lint` would have
  passed while never actually checking `server/src/index.ts`. Verified by
  temporarily adding an unused variable to `index.ts` and confirming ESLint
  flagged it, then reverting.
- `docker-compose.yml` added at repo root with a single `postgres:16` service
  (named volume, port 5432). Per the plan's decision #1, nothing in
  `npm run dev` or any app code starts or reads this yet — it's scaffolding
  only, for Phase 5.
- `README.md`'s "Running it locally for testing" section now leads with
  `npm run dev`, and keeps a fallback note for serving `web/` directly with
  any static server for frontend-only work.
- Verified manually via Playwright MCP (no physical card reader available in
  this environment, consistent with the plan's note that WebHID cannot be
  exercised by automated tooling): loaded `http://localhost:3000/index.html`
  through the new Fastify server, confirmed the page/markup/console are
  identical to pre-move behavior, expanded the Settings panel, uploaded a
  roster CSV (parsed to 2 rows, column selector populated correctly), and
  clicked Download Attendance CSV (produced a real file download with the
  expected header row, zero data rows since no scan occurred). No console
  errors or warnings at any point. `npm test`/`lint`/`typecheck` all pass.
- WebHID connect/scan itself was **not** exercised end-to-end in this session
  — that requires real OMNIKEY hardware and a human at a Chromium browser.
  This is unchanged from Phase 0/the plan's stated limitation, not a new gap
  introduced by Phase 1's restructuring.

## Phase 2 — what actually happened

- `server/src/identity/types.ts` defines `IdentityResolver`/`IdentityResolution`, mirroring
  `lookup.js`'s old normalized shape. `missing-credentials` was dropped from the error-kind union
  per the plan: server config is validated at startup (resolver selection falls back to Mock)
  instead of a request ever reaching a misconfigured resolver.
- `server/src/identity/mock-resolver.ts` (`MockIdentityResolver`) ports `lookup.js`'s `mockLookup`
  hash/name-list/`ERR`/`NOID` logic verbatim — same card code always resolves to the same identity.
- `server/src/identity/http-resolver.ts` (`HttpIdentityResolver`) ports `realLookup`'s
  AbortController timeout, HTTP-status check, JSON-parse check, and missing-ID check verbatim.
  Config (URL template, credentials, timeout, field paths) comes from `IDENTITY_API_*` env vars,
  documented in `README.md` §5; `createHttpIdentityResolverFromEnv()` returns `null` when they're
  unset, and `server/src/index.ts` falls back to `MockIdentityResolver` in that case — not wired to
  real Cedarville ProxID values this pass, per decision #2.
- `server/src/routes/scans.ts` adds `POST /api/scans`, Zod-validated (`{ cardCode: string }`,
  non-empty). The raw card code is never logged: nothing in the handler logs `request.body` or
  `cardCode`, and Fastify's default request/response logging only records method/url/status/timing.
  Verified with a test that captures the Fastify logger's output stream and asserts a scanned card
  code never appears in it.
- `web/scan-pipeline.js`'s `_resolveScan` now calls a local `submitScan(cardCode)` (POSTs to
  `/api/scans`, same-origin) instead of importing `lookupCard` from the now-deleted `lookup.js`.
  `submitScan` preserves `lookupCard`'s "never throws/rejects" contract (network/HTTP-status/bad-JSON
  failures all fold into the same normalized error shape) and its diagnostics logging
  (`lookup-request`/`lookup-result` events, PII-limited the same way). All suppression/correlation/
  retry state-machine logic in `ScanPipeline` is untouched — only the promise source changed.
  `web/tests/scan-pipeline.test.js` now mocks `global.fetch` (delegating to the same
  `lookupCardMock` the tests already used, so nearly every test body is unchanged) instead of
  mocking `../lookup.js`; the extra fetch/json promise hops meant a couple of tests needed a
  macrotask-based `flushAsync()` helper instead of a fixed number of `await Promise.resolve()` ticks.
  All 11 pre-refactor regression tests still pass.
- `web/lookup.js` and `web/credentials.js` deleted. `web/config.js` dropped `LOOKUP_CONFIG` and
  `ABSENT_LOOKUP_CONCURRENCY`; browser-side config is now just `HID_VENDOR_ID`,
  `DUPLICATE_SUPPRESS_WINDOW_MS`, `DIAGNOSTICS_RING_BUFFER_SIZE`, `DEBUG_MODE_DEFAULT`,
  `SESSION_STORAGE_KEY`.
- `web/absentees.js`'s `computeAbsentRows` is now a synchronous roster-diff (no `lookupPerson` call,
  no `cache`/`concurrency`/`onProgress`/`shouldAbort` params) per decision #3 — absent rows use only
  the uploaded roster CSV's own fields, `lookupData: {}` always. `web/app.js`'s CSV-export handler
  is now fully synchronous: the "Looking up N of M absent students…" progress UI, `exportInFlight`,
  `exportGeneration`, and `absentLookupCache` are all gone since there's no async gap to guard
  against anymore. The now-dead `ui.setExportInProgress`/`setExportProgressText` functions and the
  `#export-progress-text` element were removed rather than left unused.
- `web/ui.js`/`web/index.html`: removed the "Card Lookup API Credentials" panel (key name/key
  inputs, Save/Clear buttons, status text) and the always-visible "no API key saved" warning banner;
  removed `web/app.js`'s credentials wiring and `initCredentials()`.
- Added `zod` as a dependency (request validation). `tsconfig.json`'s `include` and
  `vitest.config.ts`'s `include` both extended to cover `server/tests/**`; `eslint.config.js`
  already matched `server/**/*.ts`, so no lint config change was needed for the new test files.
- 19 new tests added: `server/tests/identity/mock-resolver.test.ts` (5),
  `server/tests/identity/http-resolver.test.ts` (9, including `createHttpIdentityResolverFromEnv`),
  `server/tests/routes/scans.test.ts` (5, using Fastify `inject`). Combined with the 33 Phase 0/1
  tests (11 of which were updated for the fetch-based transport), the suite is now 52 tests, all
  passing.
- Verified manually via Playwright MCP (no physical reader available, same limitation as Phase 1):
  `npm run dev`, then in-browser exercised the real `ScanPipeline`/`submitScan()` code path via a
  synthetic HID report (`handleParsedReport({ valid: true, hasPayload: true, trimmedCardCode: ... })`)
  — the scan resolved through the actual backend's Mock resolver end-to-end. Uploaded a roster CSV,
  selected the University ID column, enabled roster checking, and downloaded the CSV in both
  "Present only" (0 rows, succeeds) and "Absent only" (both roster rows present, `roster.*` columns
  only, no `lookup.*` data) modes. `browser_network_requests` showed every request — static assets
  and the one `POST /api/scans` — going to `http://localhost:3000` only; confirmed via `grep` on the
  server's log output that neither test card code ever appeared in it. Zero console errors/warnings
  throughout. `npm test`/`lint`/`typecheck` all pass (52 tests, 0 lint errors, 0 type errors).

## Phase 5 — what actually happened

- Schema additions: `attendanceSessions`, `attendanceSessionMembers`, and
  `attendanceRecords` tables per spec §26 (state enum: open/closed/reopened;
  status enum: present/absent/excused/lookup_error/unexpected—no `late`; scanned_at
  nullable; snapshot_data jsonb; unique index on (session_id, client_scan_id)).
  `attendance_session_id` FK added to existing `audit_events` table. Migration
  `0003_flawless_chamber.sql` additive only, handles both orderings vs Phase 4.
- DI re-thread: `db: Database` is the first parameter of every DB-touching function
  (`createAttendanceSession`, `submitScan`, `closeAttendanceSession`,
  `reopenAttendanceSession`, `applyManualCorrection`). No `import { db }` singleton.
  Every route receives `deps: { db, resolver, requireSession, requireCsrf, signingKey }`.
  `ToolSigningKey` threaded end-to-end from `index.ts` through route deps to
  `getRosterWithFallback`, with sync `getActiveSigningKey(signingKeys)` selector.
- `getRosterWithFallback` <24h stale-cache degradation for Start Attendance:
  on fresh-roster fetch success → live roster; on failure → cache iff `< 24h` old →
  `{stale: true}`; past 24h → `RosterUnavailableError` → 502 (no transient-failure
  workaround without fresh data). `stale` flag stored on the audit `attendance_session_created`
  event `newValue`, not a schema column.
- `submitScan` idempotency via `(session_id, client_scan_id)` unique key +
  `onConflictDoNothing` + fallback SELECT on lost race. Prior `lookup_error` rows
  are RE-RESOLVED + UPDATEd in place on retry (spec §47). Ambiguous roster match
  (>1 member for a resolved institutionalId) → `unexpected`, never `present`. Resolver
  `ok:false` → `lookup_error` (kind from error or 'unknown'). `ok:true` + `universityId:null`
  → `lookup_error` kind `missing-university-id` (spec §20). Card fingerprint only if
  institution opts in; raw `cardCode` never persisted.
- `closeAttendanceSession`: inserts one `system_absence`/`absent`/`scannedAt:null`/
  `clientScanId:null` record per eligible member with no current record
  (`resolveCurrentRecord`), sets `state=closed`, writes `attendance_session_closed`
  audit event. Steps 3–4 of spec §25.7 (cumulative recalc, grade sync) deferred
  to Phase 6. `SessionAlreadyClosedError` 409 guard.
- `reopenAttendanceSession`: mirrors close; sets `state=reopened`, `closedAt:null`,
  writes `attendance_session_reopened` audit event with optional reason.
  `SessionNotClosedError` 409 guard.
- Manual corrections append-only: `applyManualCorrection` always INSERTs a new row
  (source `'manual'`, scannedAt/clientScanId `null`), never UPDATEs. Correction note
  lives only in `audit_events.new_value.note` JSONB, no `note` column on records.
- DELETE-record route: HARD DELETE + one `attendance_record_removed` audit event
  (oldValue with status/source) in a single transaction. Recovery via audit log only;
  no tombstone, no in-band undo.
- State-transition 409 guards: `session_already_closed` (close when closed),
  `session_not_closed` (reopen when not closed), with opaque error codes + request.id
  correlation.
- CSV export: `buildAttendanceSessionCsv` byte-identical escaping to `web/csv.js`
  (RFC-4180: `/[",\r\n]/` → wrap + double-quote; null/undefined → ''). Columns:
  institutionalId, displayName, status, source, scannedAt (CRLF join).
- 8 routes on `POST /api/attendance-sessions` root: POST create (with
  `getRosterWithFallback`), GET :id (roster snapshot), POST :id/scans (scan ingestion),
  PATCH :id/members/:ltiUserId (manual correction), DELETE :id/members/:ltiUserId/records/:recordId,
  POST :id/close, POST :id/reopen, GET :id/export.csv. All behind `requireSession`
  (GETs) or `[requireSession, requireCsrf]` (mutations). Tenant isolation returns 404,
  never 403. Explicit serializers hide internal columns. Mounted on root `app`
  (outside rate-limit scope per spec §31.10). Opaque error responses:
  `{error: code, requestId: request.id}`.
- `web/api-client.js` CSRF bootstrap: `bootstrapSession()` GETs `/api/me`, caches
  `csrfToken` from response, never throws (network/status/JSON errors normalized).
  `apiFetch` wrapper: GET pass-through; non-GET adds `x-csrf-token` header +
  `Content-Type: application/json` + JSON-stringified body.
- `web/scan-pipeline.js` refactor: `submitScan(sessionId, clientScanId, cardCode)`
  POSTs to `/api/attendance-sessions/{sessionId}/scans` via `apiFetch`. `clientScanId`
  now `crypto.randomUUID()` instead of a counter. Status vocab changed: `accepted`→`present`,
  `lookup-error`→`lookup_error`. No-session guard: `handleParsedReport` early-returns
  if `!sessionId`, logs `scan-ignored-no-session`, no request. `ScanPipeline`
  constructor takes `sessionId`; set at Start Attendance in `app.js`. Tests rewritten
  to mock `api-client.js` instead of `global.fetch` (removes a cross-file mock leak).
- `web/attendance-session.js` new module: `createAttendanceSession(body)` /
  `closeAttendanceSession(sessionId)` / `reopenAttendanceSession(sessionId, reason)` /
  `getAttendanceSession(sessionId)` wrappers over `apiFetch` with shared never-throws
  `request()` helper (network/status/JSON failures → `{ok:false, error:{kind}}`).
- `web/app.js` / `web/ui.js` / `web/index.html` wiring: Start/Close/Reopen buttons
  in a `#session-panel`. `init()` awaits `bootstrapSession()` before showing controls.
  Session state rendered via `renderSessionState({state, label})`. Record status vocab
  updated: `rosterStatus`→`status`, `universityId`→`institutionalId`, `lookup-error`→`lookup_error`.
  CSV export reads `institutionalId` instead of `universityId`. Sound alert checks
  `record.status === 'unexpected'` instead of `rosterStatus`. CSS selectors realigned
  for new status names.
- Retirement of `POST /api/scans`: route and `server/src/routes/scans.ts` +
  `server/tests/routes/scans.test.ts` removed. `server/src/index.ts` no longer
  registers it; rate-limit scope comment updated to name the new session-scoped
  endpoint. No phase-in period — the old endpoint is gone and the new session-scoped
  route is wired.
- Deferred/out-of-scope: `late` status deferred (not in enum/schema/routes);
  standalone-mode CSV roster panel unchanged but not wired to the new backend
  (roster-checking UI kept for demo, server status always trusted); card-fingerprint
  secret is app-wide `CARD_FINGERPRINT_SECRET` env var, not per-institution
  (per-institution migration path documented as future work); no scan-API rate
  limiting yet (Phase 8).
- Suite checkpoint: **292 tests / 44 files**, all passing. Lint and typecheck clean.
  Manual Playwright verification of the full LTI→Start→scan→Close→Reopen flow
  (CSRF header present, no null-session requests) is outstanding (Phase 7 gate —
  needs real Canvas launch).

## Phase 6 — what actually happened

- Executed as 14 tasks per `docs/superpowers/plans/2026-08-26-canvas-lti-phase6-ags-grading.md`
  (feature/test commits `565321c`..`452f7df`). A single independent pre-flight
  reviewer (opus) reproduced `drizzle-kit generate`, `tsc`, `eslint`, an
  import-cycle check, and a Fastify-5 mock-AGS harness; its 7 blockers + 15
  quality items were folded back into the plan (revision `3bc582d`) before
  execution, plus two user rulings — **N1** (grade population source) and
  **N2** (backoff gets the pre-increment `attemptCount`). Every task landed as
  written.
- **Schema: two new tables + migration `0004_outgoing_speedball.sql`** (additive
  only — 2 `CREATE TABLE` with inline UNIQUE + 3 FK `ADD CONSTRAINT`).
  `grade_line_items` (`UNIQUE(course_id)` — one cumulative line item per course;
  persists the Canvas line-item id + URL) and `grade_sync_jobs`
  (`UNIQUE(course_id, lti_user_id)` durable outbox: `state` text
  pending/synced/failed no CHECK, `score` `double precision`, `attempt_count`,
  `next_attempt_at`, short-code `last_error`). Both added to `db.ts`
  `TRUNCATE_ORDER`.
- **`grade-policy.ts` / `grade-calc.ts` — pure, no I/O.** `grade-policy.ts`
  defines `GradingPolicy` and `DEFAULT_GRADING_POLICY` (present = 1, absent = 0,
  excused excluded from the denominator; `lookup_error` / `unexpected` never map
  to a grade); `scoreContribution` returns `null` for a non-graded status.
  `grade-calc.ts`'s `computeCumulativeScores` folds every closed session's
  most-recent-wins record per member into `scoreGiven` (0..100, rounded to 4
  places) over `scoreMaximum` 100; denominator 0 → the member is omitted (no
  score posted). Both take the policy as a parameter — the seam for §27.2
  "configurable by institution", but only the default is wired.
  **Per-institution policy config + editor is deferred to Phase 8.**
- **`closeAttendanceSession` extended, entirely inside the existing close
  transaction, with NO Canvas call.** Population is the course's CURRENT roster
  — `getCachedRosterAsMembers(db, session.courseId)` filtered to
  `eligibleForAttendance` (2026-08-28 user ruling N1: this is literally
  "current roster × all closed sessions"; `course_members` is refreshed on every
  `createAttendanceSession`). The denominator walks every `state = 'closed'`
  session for the course (a `reopened` session is excluded — a test pins 1/1 =
  100 vs 1/2 = 50). Computes cumulative scores, calls `upsertGradeSyncJobs(tx, …)`
  (enqueue in the same txn per §28), and writes one `grade_sync_requested` audit
  row. `createAttendanceSession` / `reopenAttendanceSession` are untouched —
  reopen writes nothing to `grade_sync_jobs`.
- **`server/src/lti/ags.ts` — dumb HTTP client.** `ensureLineItem` queries the
  course's `ags_lineitems_url` (verbatim from the signed launch, SSRF anchor =
  provenance) by stable `tag` + `resourceId` and reuses or creates one line item,
  idempotently. `postScore` PUT/POSTs an AGS Score with
  `activityProgress: Completed` / `gradingProgress: FullyGraded`, keyed by the
  NRPS `user_id` (no launch required), timestamped from a fresh `now.toISOString()`
  each attempt (so a retry always carries a strictly-later timestamp than Canvas's
  existing result). Error taxonomy is airtight — only `ags:*` short-code literals,
  status classified before `.json()`: 429 / 5xx / network / 401 are retryable,
  other 4xx / bad-JSON are permanent (never auto-retried; §25.9's manual route is
  the escape hatch).
- **`grade-sync-store.ts` — outbox operations.** `upsertGradeSyncJobs`
  (`onConflictDoUpdate` on the course+member UNIQUE → back to `pending`);
  `claimDueJobs` (a plain non-locking `SELECT` of due `pending` rows — the
  single-writer invariant comes from `npm run worker` being one-shot;
  `SKIP LOCKED` / multi-replica is Phase 7); `computeBackoff` (exponential with
  jitter, first retry at `GRADE_SYNC_BASE_DELAY_MS` = 5 min per §35.2, then
  10/20/40/60/60, capped); `markJobSynced` / `markJobRetry` / `markJobFailed`;
  `getGradeSyncSummary` (failed > pending > synced > none, `lastError` from the
  most-recently-updated row); `resetFailedJobs` (the manual-retry primitive).
- **`grade-worker.ts` + `server/src/worker.ts` + `npm run worker` — standalone,
  one pass, NOT wired into Fastify.** `processGradeSyncJobs` claims due jobs,
  groups by course, mints one token + `ensureLineItem` per course, then posts
  scores sequentially. On a 401 it calls `clearAccessTokenCache` and re-mints
  **once per course** (`authRetried` guard, mirroring `nrps.ts`); a still-failing
  auth error then goes to the retry/fail path. `server/src/worker.ts` is a thin
  top-level-await entrypoint (`loadEnv` → `createDbClient` → `applyMigrations` →
  signing key → one `processGradeSyncJobs` pass → tally log → `pool.end` / exit);
  its `catch` logs `err.message` only (§31.8). No automated test for the
  entrypoint itself (whole-branch follow-up #8); all logic is covered by the
  `grade-worker` suite + the integration test.
- **Route surface.** `GET /api/attendance-sessions/:id` gains an append-only
  `gradeSync` summary object. `POST /api/attendance-sessions/:id/grade-sync`
  (mutation — `requireSession` + `requireCsrf`) resolves the session scoped to the
  authenticated course (cross-tenant → 404, never 403), calls `resetFailedJobs`,
  and writes a `grade_sync_requested` audit row
  (`{ retriedJobCount, trigger: 'manual' }`).
- **AGS scope constants** — `AGS_LINEITEM_SCOPE` + `AGS_SCORE_SCOPE` added to
  `server/src/lti/scopes.ts` as the character-exact 1EdTech URIs (lineitem +
  score write; no Result read scope per §10). Phase 4 Task 3 had deliberately
  deferred these.
- **`MockCanvasPlatform` AGS additions** (additions only, mirroring the Phase 4
  NRPS additions): vendor content-type parsers, `GET`/`POST .../lineitems`,
  `POST .../lineitems/:id/scores`, plus test injectors `failNextAgsRequest`
  (union widened with a one-shot `'auth'` 401) and `failNextScorePost`, and
  `seedExistingLineItem` / `getLineItems` / `getPostedScores` helpers.
- **Web status panel** — `#grade-sync-panel` inside `#session-panel`. `app.js`
  refreshes the grade-sync state on close / reopen / resume; `renderGradeSyncState`
  maps job state to text, hides on `none`, and shows a retry button only on
  `failed` (which calls the CSRF-guarded retry route via a never-throws
  `retryGradeSync`). Deliberately thin; the functional gate is the integration
  test + a deferred Phase 7 Playwright pass.
- **`grade-sync-integration.test.ts` is the exit criterion made executable.** It
  composes real `/lti/login` + `/lti/launch` + `/api/me` + the attendance-session
  routes onto a local Fastify (`@fastify/formbody` + `registerMeRoute`, `origin`
  header on every mutation), drives a real minted instructor `id_token` through
  login → launch → Start → close, then runs `processGradeSyncJobs(db, { signingKey })`
  directly and asserts: every job `pending` → `synced`, exactly one line item
  created, `learner-1 = 100` / `learner-2 = 0` posted to the mock Gradebook, and
  two `grade_sync_completed` audit rows. The reviewer confirmed every assertion is
  regression-sensitive.
- Suite checkpoint: **373 tests / 52 files**, all passing; `npm run lint` and
  `npm run typecheck` clean. No real-Canvas step here.

### Deferred out of Phase 6

- **Per-institution grading policy** (config surface + editor) — Phase 8. The
  `GradingPolicy` parameter is the seam; only `DEFAULT_GRADING_POLICY` is wired.
- **The worker's production schedule / deploy, and web-vs-worker migration
  ownership** — Phase 7. `npm run worker` is a one-shot entrypoint with no
  scheduler; there is no CI/deploy story yet.
- **Real-Canvas AGS verification** — Phase 7 post-deploy. The scope URIs and the
  line-item / score field shapes are written from the 1EdTech vocabulary and stay
  unverified against a real Canvas Developer Key until then.
- **6 pre-flight deferred quality items** (recorded for the Phase-6-range review,
  not fixed now — see the plan's `## Self-review notes`): **Q4** (terminal-failure
  path leaves `attempt_count` at its pre-increment value while the audit `newValue`
  says +1; harmless), **Q9** (Task 11's GET edit relies on preserving the existing
  `// B3:` comment), **Q10** (`getGradeSyncSummary` loads every job row for the
  course to compute three counters), **Q11** (`failNextAgsRequest` /
  `failNextScorePost` are process-global one-shots, unlike Phase 4's per-course
  `rateLimitNextRequest(courseId)`), **Q14** (no bare `postScore` 401→`auth`
  classification unit case — covered end-to-end only), **Q15** (the retry route
  writes a `grade_sync_requested` audit row even when `retried === 0`).
- **8 whole-branch follow-ups still open** (from the 2026-08-28 final
  whole-branch review; none block Phase 6): (1) `GET /api/attendance-sessions`
  ignores `?state=`; (2) resume flow — stat tiles show 0 after reload; (3) resume
  flow — a resumed member who re-scans gets a second visible row; (4)
  `attendance-sessions.ts` B2 adds one member lookup per scan (N+1 on the hot
  path); (5) **#7** no production run path (`package.json` has no `build`/`start`,
  `tsx` is a devDep, `noEmit: true`) — Phase 7; (6) **#8** `server/src/index.ts`
  has no integration test, `hardening.test.ts` asserts a hand-copy of its CSP —
  extract `buildApp(env, deps)` — Phase 7; (7) manual Playwright / real-Canvas
  verification of the full launch → Start → scan → Close → Reopen → grade-sync
  flow — Phase 7; (8) `server/src/lti/roles.ts` `AUTHORIZED_INSTRUCTOR_ROLE_URIS`
  — capture a real Canvas launch's `roles` array — Phase 7.

## Phase 3 — what actually happened (automated portion)

- `server/src/lti/`, `server/src/auth/`, `server/src/database/`, and `server/src/config/` added
  per `docs/superpowers/plans/2026-08-26-canvas-lti-phase3-lti-authentication.md`. Hand-rolled LTI
  1.3 orchestration on `jose` rather than a maintained LTI framework: the available Node ones own
  their own datastore, session model, and Express-style routing, which would fight this repo's
  Fastify + Drizzle conventions and hide the very validation steps spec §45 requires us to test
  case by case. Drizzle ORM + PostgreSQL via the existing `docker-compose.yml` service.
- All 24 spec §45 test-matrix cases have a passing automated test against an in-process mock Canvas
  platform (`server/tests/support/mock-canvas.ts`, a real second Fastify server, not a mocked
  `fetch`). Every failure case asserts no `app_sessions` row was created: the 21 launch-time
  failure cases through a `SELECT` count of zero in `server/tests/lti/launch.test.ts`, and case 24
  (target-link open-redirect) structurally in `server/tests/routes/lti-login.test.ts`, since
  `/lti/login` rejects before writing an OIDC transaction and has no session-creation path at all.
  Cases 1 and 12 are success cases and do create a session.
- `GET /lti/jwks` publishes this app's own public signing keys (active + previous, env-configured
  or an ephemeral dev fallback); `POST /lti/login` and `POST /lti/launch` implement the full OIDC
  login/launch flow; `GET /api/me` returns the spec §25.1 bootstrap shape.
- **`POST /api/scans` is deliberately left unauthenticated in Phase 3**, exactly as Phase 2 shipped
  it. Phase 3 adds endpoints beside it and introduces no new exposure; the existing browser UI and
  the standalone dev mode (spec §51, which performs no LTI launch) both still call it without a
  session. Phase 5 retires it in favour of `POST /api/attendance-sessions/{id}/scans` behind
  `requireSession` + `requireCsrf` and migrates the UI at the same time.
- **Deferred to Phase 7 (needs a public HTTPS deployment):** the real-Canvas tool registration
  (Admin → Apps, JSON config) and instructor/learner launch verification in
  `docs/canvas-installation.md`. Canvas cannot deliver a launch to `http://localhost`, so this
  could never have run in Phase 3. `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS`
  set is written from the standard 1EdTech role vocabulary and stays flagged there as unverified
  against a real Canvas launch payload until that Phase 7 step runs.

## Phase 4 — what actually happened

- Executed as 15 tasks per `docs/superpowers/plans/` Phase 4 plan (14 feature/test
  commits `18234b0`..`1bcd0cf` plus this integration test). Pre-flight review folded
  its blockers back into the plan first, so execution hit no surprises — every task
  landed as written.
- **Task 1 was a launch-time retrofit, not new NRPS code.** Spec §31.7 wants the
  NRPS/AGS service URLs taken from the signature-verified launch JWT and used
  verbatim, but Phase 3's `launch.ts` never persisted them. Task 1 added three
  nullable `courses` columns (`nrps_url`, `ags_lineitems_url`, `last_launched_at`),
  two optional service claims in `claims.ts`, and turned `findOrCreateCourse` into
  find-or-create-then-update-launch-metadata (keeping the ON CONFLICT race fix) so
  every launch refreshes the stored endpoints and stamps `last_launched_at`.
  `server/tests/lti/launch-nrps-persistence.test.ts` covers a rotated `nrpsUrl`
  updating the one `courses` row in place.
- **No outbound host allowlist.** `server/src/lti/service-url.ts`'s
  `validateCanvasServiceUrl` is a structural check only — absolute `http(s)` scheme,
  no embedded credentials — and deliberately accepts `http:` so the in-process mock
  works. The SSRF trust anchor is provenance (a verified launch JWT, stored and used
  verbatim), not a token-endpoint-host anchor, which spec §11 makes wrong on real
  Canvas. Redirect rejection stays at the fetch call sites. A future per-institution
  service-host policy is noted for later.
- **Shared `getRosterWithFallback` degradation helper** (`server/src/attendance/roster-store.ts`).
  It calls `refreshCourseRoster` (paginated NRPS fetch via `nrps.ts`, client-
  credentials token from `token-client.ts` with retry-once on expired-token and
  429-backoff), and on failure falls back to the `course_members` cache only while
  it is under `STALE_CACHE_MAX_AGE_MS` (24h); past that ceiling it throws
  `RosterUnavailableError` (→ 502 at the route). Both routes and Phase 5's session
  creation consume this one helper.
- **`roster_refreshed` audit on both GET and POST.** `getRosterWithFallback` returns
  `refreshed: boolean`; `GET /api/course/roster` (5-min cache, live refresh past
  that) and `POST /api/course/roster/refresh` each write one `audit_events` row with
  `request_id = request.id` when `refreshed === true`. Pure cache hits and stale-
  cache fallbacks write nothing.
- **`POST /api/course/roster/refresh` is CSRF-gated now, ahead of Phase 5.** No
  Phase 4 web caller exists, so there is no dead end — it is exercised by tests
  until Phase 5 wires the browser CSRF/JSON bootstrap (Phase 5 Task 13).
- **The contract Phase 5 consumes is fixed:** `CourseRosterMember` (defined once in
  `server/src/lti/nrps.ts` — `ltiUserId`, `institutionalId`, `displayName`,
  name parts, `email`, `roles`, `status`, `eligibleForAttendance`) and
  `getRosterWithFallback(db, courseId, { signingKey })` →
  `{ members, fetchedAt, stale, refreshed }`. `eligibleForAttendance` is always
  computed from the institution's `rosterLearnerRoles` (default `['Learner']`),
  identically on the fresh and stale paths.
- The `nrps.ts ⇄ roster-store.ts` import cycle is function-body-only (ESM live
  bindings), not a load-time cycle. No module imports a `db` or signing-key handle:
  `db: Database` is the first arg of every DB-touching function and the active
  `ToolSigningKey` is threaded `index.ts` → route deps → `getRosterWithFallback` →
  `refreshCourseRoster` → `getAccessToken`.
- The AGS scope constants (`AGS_LINEITEM_SCOPE`/`AGS_SCORE_SCOPE`) were deferred to
  Phase 6 (YAGNI) even though `courses.ags_lineitems_url` is persisted at launch so
  Phase 6 has the data.
- `server/tests/routes/course-roster-integration.test.ts` is the Phase 4 exit
  criterion made executable: it composes the real `registerLtiLoginRoute` +
  `registerLtiLaunchRoute` + `registerCourseRosterRoutes` onto a local `Fastify()`
  (with `@fastify/cookie` + `@fastify/formbody`, mirroring `lti-launch.test.ts` — no
  `index.ts` import) and drives `POST /lti/login` → 302 with `state`/`nonce` →
  `mintIdToken` (instructor role, NRPS claim via `extraClaims`) →
  `POST /lti/launch` → 303 + session cookie → `GET /api/course/roster` → 200 with 2
  normalized members (one eligible learner, one excluded instructor) and exactly one
  `roster_refreshed` audit row with a truthy `request_id`. `platform.setPageSize(1)`
  with 2 members means the GET path exercises real Link-header pagination end to end.
  It passed on the first run with no source changes.
- Suite is now **233 tests across 36 files**, all passing; `npm run typecheck` and
  `npm run lint` clean. No real-Canvas step here — that stays a Phase 7 post-deploy
  item, as for Phase 3.

## Phase 7 — what actually happened

- **Task 22B — Canvas roster wired into the scanner UI.** Phase 4's exit criterion
  ("instructor launches from a course and sees the active Canvas learner roster
  without uploading a file") and spec §50 step 4 ("App displays course name and
  current roster count") were met at the API level only — `web/` never called
  `GET /api/course/roster` or rendered `/api/me`'s course context. Task 22B adds
  `web/course-roster.js` (fetch/refresh/index helpers, unit-tested), a course-context
  strip and a Canvas Roster panel in `web/index.html`/`web/ui.js`, and `init()`
  wiring in `web/app.js` that loads the roster right after `bootstrapSession()`.
  The CSV panel remains as "Manual Roster (CSV fallback)". Covered by an
  `e2e/instructor-flow.spec.ts` assertion against the mock-Canvas NRPS roster.

## Deferred decisions

- **Real ProxID credentials.** `HttpIdentityResolver` is implemented (ported
  from `lookup.js`'s `realLookup`) and documented in `README.md` §5
  (`IDENTITY_API_URL`, `IDENTITY_API_KEY_NAME`, `IDENTITY_API_KEY`, and five
  optional overrides), but no real Cedarville ProxID values have been set
  anywhere — `createHttpIdentityResolverFromEnv()` returns `null` until they
  are, so `MockIdentityResolver` stays the default/working resolver. Setting
  the real env vars in the deployment environment is a future-session TODO;
  no code change should be required.
- **Phases 3–8 not yet planned.** This progress tracker mirrors spec §54's
  phase list for continuity, but no plan/execute pass has been done for
  Phases 3–8. Before planning Phase 3, resolve:
  - LTI library vs. hand-rolled (spec §7) — a maintained LTI 1.3 library MAY
    replace portions of the implementation if it satisfies all validation/
    security requirements in spec §13.
  - ORM choice (spec §7 recommends Drizzle or equivalent typed SQL layer).
  - Whether a Canvas test/beta Developer Key registration and a
    nonproduction Canvas environment are available for validation (spec §46).
  - Azure subscription/OIDC federation access (spec §35–42).
- **npm workspaces.** Not introduced yet (decision #4 in the plan) — one root
  `package.json`/`tsconfig.json` covers `server/`; `web/` stays
  dependency-free plain ES modules. Revisit if `packages/shared/` becomes
  necessary (spec §6 mentions this directory; not created yet).
- **Absentee-by-ID enrichment lookup retired, not migrated.** The former
  `lookup.js`'s `lookupPerson`/`personByIdUrl` (used by `absentees.js` to
  enrich "Absent" CSV rows) was retired in Phase 2, not ported to the server
  — `absentees.js`'s `computeAbsentRows` is now a synchronous roster-diff.
  Canvas NRPS (Phase 4) will supply authoritative names for absent students;
  until then, absent CSV rows use only whatever fields the uploaded roster
  CSV already contains.
