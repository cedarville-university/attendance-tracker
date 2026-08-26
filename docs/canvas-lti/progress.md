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
- [ ] **Phase 2 — Server-side identity resolver** — `IdentityResolver` interface,
      `MockIdentityResolver`, `HttpIdentityResolver`; browser card-service
      requests replaced with same-origin backend scan requests; production
      credentials UI removed.
      Exit criterion: scanner works through backend, no resolver secret reaches
      browser JavaScript.
- [ ] **Phase 3 — LTI authentication** — `/lti/login`, `/lti/launch`,
      `/lti/jwks`; OIDC transaction storage; launch validation; application
      sessions; role authorization; full security test matrix (spec §45).
      Exit criterion: valid instructor Canvas launches work, malformed/replayed
      launches fail.
- [ ] **Phase 4 — NRPS** — Canvas token acquisition and roster retrieval;
      uploaded roster replaced as the primary workflow; identity matching
      configuration.
      Exit criterion: instructor launches from a course and sees the active
      Canvas learner roster without uploading a file.
- [ ] **Phase 5 — Persistent attendance** — attendance sessions, roster
      snapshots, scan persistence, manual corrections, session close/reopen,
      audit events, CSV export.
      Exit criterion: closing/reopening the browser does not lose
      server-accepted attendance.
- [ ] **Phase 6 — AGS grading** — cumulative line item, grade calculation,
      score submission, grade outbox, retry worker, status UI.
      Exit criterion: closing attendance updates the expected Canvas Gradebook
      column.
- [ ] **Phase 7 — Infrastructure and CI/CD** — Dockerfile, Bicep, Azure
      Container Apps, PostgreSQL, Key Vault, ACR, GitHub Actions OIDC
      deployment, stage/prod environments, health checks, monitoring.
      Exit criterion: a tagged/approved release deploys without any long-lived
      Azure deployment password in GitHub.
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

## Deferred decisions

- **Real ProxID credentials.** Phase 2 implements `HttpIdentityResolver`
  correctly (ported from `lookup.js`'s `realLookup`) but does not wire it to
  real Cedarville ProxID credentials/env vars — `MockIdentityResolver` stays
  the default/working resolver for Phases 0–2. Required env vars for the real
  resolver (URL template, field paths, timeout, auth) will be documented here
  once Phase 2 lands.
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
- **Absentee-by-ID enrichment lookup retired, not migrated.** `lookup.js`'s
  `lookupPerson`/`personByIdUrl` (used by `absentees.js` to enrich "Absent"
  CSV rows) is being retired in Phase 2, not ported to the server. Canvas
  NRPS (Phase 4) will supply authoritative names for absent students; until
  then, absent CSV rows use only whatever fields the uploaded roster CSV
  already contains.
