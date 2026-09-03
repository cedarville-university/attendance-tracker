# Canvas LTI Phase 6 — AGS Grading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Closing an attendance session computes each current roster member's cumulative attendance score, enqueues a durable grade-sync job per member in the same transaction, and a small retry worker posts those scores to a single per-course Canvas Gradebook line item via AGS — so closing attendance updates the expected Canvas Gradebook column (the Phase 6 exit criterion).

**Architecture:** `server/src/attendance/grade-policy.ts` and `grade-calc.ts` are pure (no DB, no Canvas): the policy maps an attendance status to earned points + denominator membership; `computeCumulativeScores` folds every *closed* session's resolved per-member status into one `scoreGiven`/`scoreMaximum` per member. `closeAttendanceSession` (`session-lifecycle.ts`) is extended to call these and `upsertGradeSyncJobs` **inside its existing transaction** (spec §28 step 3) plus write one `grade_sync_requested` audit row — it makes **no** Canvas call. `server/src/lti/ags.ts` is dumb authenticated HTTP against the launch-provided `courses.ags_lineitems_url` (create-or-reuse a line item by stable tag/resourceId) and the line item's `/scores` sub-resource. `server/src/attendance/grade-worker.ts`'s `processGradeSyncJobs` is the orchestrator: it claims due `pending` jobs, acquires one AGS token per course, ensures the line item once, posts scores sequentially, and applies exponential-backoff-with-jitter retry / terminal-failure state transitions with `grade_sync_completed` / `grade_sync_failed` audit rows. `server/src/worker.ts` is a thin top-level-await entrypoint (mirrors `index.ts`) that runs one pass; a `worker` npm script runs it locally. `GET /api/attendance-sessions/:id` gains a `gradeSync` summary; `POST /api/attendance-sessions/:id/grade-sync` (spec §25.9) re-queues a course's failed jobs.

**Tech Stack:** `jose` (client-assertion JWT — already a Phase 3 dependency), `drizzle-orm` + `pg`, Fastify 5, Zod, Vitest, plain ES modules on the browser side. **No new npm dependencies this phase.**

## Phase 3/4/5 interfaces this plan builds on (verified against shipped HEAD `7852b75`)

This plan is written against the **real, shipped** code on `worktree-canvas-lti-phase0`, not an earlier design doc. Load-bearing facts:

- **No importable `db` singleton.** `server/src/database/client.ts` exports `createDbClient(url) => { db, pool }`, the `Database` / `DbClient` types, and `applyMigrations(client)`. Every DB-touching lib function takes `db: Database` as its **first** parameter; every route module is `registerXRoute(app, deps)`; `server/src/index.ts` and `server/src/worker.ts` are the only callers of `createDbClient`. Tests do `const { db } = getTestDb();` (from `server/tests/support/db.ts`) with a **file-scope** `afterAll(() => closeTestDb())`.
- **`getActiveSigningKey(keys: ToolSigningKey[]): ToolSigningKey`** is **synchronous** (`server/src/lti/signing-keys.ts`). `ToolSigningKey = { kid: string; status: 'active' | 'previous'; privateKey: CryptoKey; publicJwk: Record<string, unknown> }`. It is structurally assignable to `token-client.ts`'s `SigningKeyRef = { kid: string; privateKey: CryptoKey }` — pass it straight through, exactly as `refreshCourseRoster` does.
- **`token-client.ts`** exports `getAccessToken(registration: { id; clientId; tokenEndpoint; tokenAudience }, scopes: string[], deps: { signingKey: SigningKeyRef; fetchImpl?: typeof fetch }): Promise<string>` and `clearAccessTokenCache(registrationId, scopes)`. The token cache is process-global, keyed `registrationId + sorted-scope-set`, reused until ~60s before expiry. Reuse it verbatim for AGS.
- **`courses.agsLineitemsUrl`** (`schema.ts`) is captured from the signature-verified launch JWT's `https://purl.imsglobal.org/spec/lti-ags/claim/endpoint` → `.lineitems` and persisted at launch time (Phase 4 Task 1). Nullable. Use it **verbatim** — no reconstruction, no host allowlist, same SSRF trust anchor as NRPS (spec §31.7).
- **`server/src/lti/scopes.ts`** currently exports only `NRPS_MEMBERSHIP_READONLY_SCOPE`. Phase 4 Task 3 deliberately deferred the AGS scope constants to this phase.
- **`server/src/lti/service-url.ts`** exports `validateCanvasServiceUrl(url): { ok: boolean; error?: 'malformed-url' | 'unsupported-scheme' | 'embedded-credentials' }` — accepts both `http:` and `https:`. Reuse it for `agsLineitemsUrl`.
- **`server/src/lti/nrps.ts`** is the reference pattern for this phase: `fetchRawMembershipPages(url, token, deps)` is dumb HTTP with an error-kind union; `refreshCourseRoster(db, courseId, deps)` is the orchestrator that acquires the token and applies retry. `loadCourseRosterContext` (private) is the courses→institutions→deployments→registrations join. Mirror this split for AGS: `ags.ts` = dumb HTTP, `grade-worker.ts` = orchestrator.
- **`server/src/attendance/session-lifecycle.ts`** exports `closeAttendanceSession(db, sessionId, actorLtiUserId, requestId?): Promise<void>`. It runs ONE `db.transaction`, `.for('update')`-locks the session row (D1), inserts `system_absence` rows for eligible members with no current record, sets `state='closed'`, and writes one `attendance_session_closed` audit row. **That transaction is the Phase 6 extension point** (spec §25.7 steps 3–4). `type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]` is already exported from this file. `resolveCurrentRecord(records)` (`member-status.ts`) is the most-recent-wins resolver.
- **`attendance_records.status`** enum is `present | absent | excused | lookup_error | unexpected` — **no `late`**. `lookup_error` / `unexpected` rows always have `ltiUserId = null` (off-roster scans) and per spec §24 ("`lookup_error` and `unexpected` are operational scan states and do not automatically map to a student grade") do **not** map to a grade.
- **`attendance_session_members`** is the immutable per-session roster snapshot: `{ attendanceSessionId, ltiUserId, institutionalId, displayName, eligibleForAttendance, status, snapshotData }`. `eligibleForAttendance` marks the gradeable learners.
- **`auditEvents`** (`schema.ts`): `{ institutionId (NOT NULL FK), courseId (nullable FK), attendanceSessionId (nullable FK), actorLtiUserId (nullable), eventType, targetType (NOT NULL), targetId (NOT NULL), oldValue (jsonb null), newValue (jsonb null), requestId (nullable) }`. Worker-written rows use `actorLtiUserId: null`, `requestId: null`.
- **`server/src/routes/attendance-sessions.ts`** — `registerAttendanceSessionsRoute(app, deps: { db, resolver, requireSession, requireCsrf, signingKey })`. `mutation` preHandler = `[requireSession, requireCsrf]`; `readOnly` = `requireSession`. `loadSessionScopedToCourse(id, courseId)` → cross-tenant returns 404. `replyForError` maps `err.code` via `HTTP_FOR_CODE`, else rethrows (→ Fastify 500); opaque body `{ error: code, requestId }`. `GET /api/attendance-sessions/:id` already returns `{ session, members, unmatchedRecords }`.
- **`server/tests/support/mock-canvas.ts`** is `class MockCanvasPlatform`. Phase 4 added `POST /login/oauth2/token` + `GET /nrps/:courseId/members` + `issuedTokens`/`expiredTokens` sets + getters (`tokenUrl`, `nrpsUrlFor`, `setCourseMembers`, `setPageSize`, `expireAccessToken`, `rateLimitNextRequest`, `breakPaginationOnNextPage`). Phase 6 adds AGS routes **by the same additions-only discipline** — do not touch any Phase 3/4 method.
- **`server/tests/support/seed.ts`** — `seedInstitutionAndCourse(db, platform, overrides?: SeedOverrides & { nrpsUrl?: string | null })` → `SeededCourse extends SeededRegistration { courseId }`. `seedInstitutionAndRegistration` points `tokenEndpoint` at `platform.tokenUrl`. Task 5 adds `agsLineitemsUrl?: string | null` to the overrides.
- **`server/tests/support/db.ts`** `TRUNCATE_ORDER` lists 11 tables; Task 1 adds `grade_sync_jobs` + `grade_line_items`.
- **Migrations** are schema-first: edit `server/src/database/schema.ts`, run `npx drizzle-kit generate` (root `drizzle.config.ts`, `out: './migrations'`), commit the generated `NNNN_*.sql` + `migrations/meta/` changes. **Never** run `drizzle-kit migrate`. Vitest `globalSetup` (`server/tests/support/global-setup.ts`) applies pending migrations before the suite. Last migration is `0003_flawless_chamber.sql`; Phase 6's is `0004_*`.
- **`vitest.config.ts`** sets `singleFork: true` and `test.env.CARD_FINGERPRINT_SECRET`. `npm test` REQUIRES Postgres (`docker compose up -d postgres`, project `canvas-lti-phase0`).
- **Baseline:** 315 tests / 45 files green, `npm run lint` + `npm run typecheck` clean at HEAD `7852b75`.

If any real file differs from the above when a task runs, **adapt the task's call sites to the real code — never change a Phase 3/4/5 shipped public interface to fit this plan.** The one sanctioned interface change is Task 5's additive `agsLineitemsUrl` override on the `seedInstitutionAndCourse` test helper.

## Fixed contract — new shapes Phase 6 introduces

```ts
// grade-policy.ts (Task 3)
export interface GradingPolicy {
  presentPoints: number;   // earned points for a 'present' member-session (default 1)
  absentPoints: number;    // earned points for an 'absent' member-session (default 0)
  excusedExcluded: boolean; // true -> 'excused' member-session is excluded from the denominator (default true)
}
export const DEFAULT_GRADING_POLICY: GradingPolicy;
export type GradeableStatus = 'present' | 'absent' | 'excused';
// null  -> this member-session does not map to a grade (no record, or lookup_error/unexpected)
export function scoreContribution(
  status: GradeableStatus | null,
  policy: GradingPolicy,
): { earned: number; inDenominator: boolean } | null;

// grade-calc.ts (Task 4)
export interface SessionResolvedStatuses {
  sessionId: string;
  statusByLtiUserId: Map<string, GradeableStatus>; // only members with a gradeable resolved record
}
export interface CumulativeScore {
  scoreGiven: number;   // 0..100
  scoreMaximum: 100;
}
// Returns one entry per roster member whose denominator > 0. Members with denominator 0 are OMITTED
// (spec §27.2 "If the denominator is zero, do not submit a score").
export function computeCumulativeScores(
  closedSessions: SessionResolvedStatuses[],
  rosterLtiUserIds: string[],
  policy: GradingPolicy,
): Map<string, CumulativeScore>;

// ags.ts (Task 6)
export const ATTENDANCE_RESOURCE_ID = 'attendance-cumulative-v1';
export const ATTENDANCE_TAG = 'attendance';
export const ATTENDANCE_LABEL = 'Attendance';
export const ATTENDANCE_SCORE_MAXIMUM = 100;

export type AgsErrorKind =
  | 'invalid-service-url'
  | 'rate-limited'   // HTTP 429 — retryable
  | 'auth'           // HTTP 401 — retryable (worker clears the token cache)
  | 'client-error'   // other 4xx — PERMANENT, never auto-retried (spec §28)
  | 'server-error'   // 3xx / 5xx — retryable
  | 'network'        // fetch threw — retryable
  | 'bad-json';      // 2xx body not parseable — PERMANENT

export interface AgsError {
  kind: AgsErrorKind;
  message: string;            // opaque short code, safe to persist/return (never a raw Canvas body)
  status?: number;
  retryAfterSeconds?: number;
  retryable: boolean;
}
export type AgsResult<T> = { ok: true; value: T } | { ok: false; error: AgsError };

export interface EnsuredLineItem {
  canvasLineItemId: string;   // trailing path segment of the line item URL
  canvasLineItemUrl: string;  // full URL — scores POST to `${canvasLineItemUrl}/scores`
  resourceId: string;
  tag: string;
  scoreMaximum: number;
}
export function ensureLineItem(
  lineItemsUrl: string,
  accessToken: string,
  deps?: { fetchImpl?: typeof fetch },
): Promise<AgsResult<EnsuredLineItem>>;

export interface AgsScoreInput {
  userId: string;      // NRPS user_id == attendance_session_members.ltiUserId (spec §27.3)
  scoreGiven: number;
  scoreMaximum: number;
  timestamp: string;   // ISO 8601 with subsecond precision
}
export function postScore(
  lineItemUrl: string,
  accessToken: string,
  score: AgsScoreInput,
  deps?: { fetchImpl?: typeof fetch },
): Promise<AgsResult<void>>;

// grade-sync-store.ts (Task 7)
export const MAX_GRADE_SYNC_ATTEMPTS = 6;
export const GRADE_SYNC_BASE_DELAY_MS = 5 * 60 * 1000;
export const GRADE_SYNC_MAX_DELAY_MS = 60 * 60 * 1000;

export function computeBackoff(attemptCount: number, now: Date, rand?: () => number): Date;

export function upsertGradeSyncJobs(
  executor: Database | Tx,
  courseId: string,
  attendanceSessionId: string,
  scores: Map<string, { scoreGiven: number }>,
): Promise<number>;

export function claimDueJobs(db: Database, now: Date, limit: number): Promise<GradeSyncJobRow[]>;
export function markJobSynced(db: Database, jobId: string, now: Date): Promise<void>;
export function markJobRetry(db: Database, jobId: string, attemptCount: number, nextAttemptAt: Date, lastError: string, now: Date): Promise<void>;
export function markJobFailed(db: Database, jobId: string, lastError: string, now: Date): Promise<void>;

export interface GradeSyncSummary {
  state: 'none' | 'synced' | 'pending' | 'failed';
  counts: { pending: number; synced: number; failed: number };
  lastError: string | null; // most recent failed job's lastError code
}
export function getGradeSyncSummary(db: Database, courseId: string): Promise<GradeSyncSummary>;
export function resetFailedJobs(db: Database, courseId: string, now: Date): Promise<number>;

// grade-worker.ts (Task 9)
export interface ProcessGradeSyncJobsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxJobs?: number;   // default 50
  rand?: () => number; // default Math.random — jitter source
}
export interface ProcessGradeSyncJobsResult {
  processed: number;
  synced: number;
  retried: number;
  failed: number;
}
export function processGradeSyncJobs(db: Database, deps: ProcessGradeSyncJobsDeps): Promise<ProcessGradeSyncJobsResult>;
```

## Global Constraints

- **No new npm dependencies.**
- **Dependency injection, always.** No module-level `db`; no module-level signing-key handle. Every DB-touching function takes `db: Database` (or `Database | Tx`) first. The active `ToolSigningKey` is threaded `index.ts`/`worker.ts` → deps → `getAccessToken`. Tests use `getTestDb().db`.
- **The line item and every score URL come only from `courses.ags_lineitems_url`** (the signature-verified, launch-persisted value), used **verbatim** through `validateCanvasServiceUrl` (structural check only). No request body ever supplies a Canvas URL. Score POSTs go to `${lineItemUrl}/scores`, where `lineItemUrl` is Canvas's own returned line item `id`.
- **Closing an attendance session makes NO Canvas call.** `closeAttendanceSession` only computes scores and `upsertGradeSyncJobs` **in the same `db.transaction` as the close** (spec §28 steps 1–3), then returns. All Canvas writes happen in the worker (spec §28: "Closing attendance must not depend on hundreds of Canvas writes succeeding inside one browser request").
- **One cumulative line item per course** (spec §27): `resourceId = attendance-cumulative-v1`, `tag = attendance`, `label = Attendance`, `maximum = 100`. `ensureLineItem` queries existing tool line items by tag/resourceId, reuses a match, creates only if none exists, and the create is idempotent. The result is persisted to `grade_line_items` with `UNIQUE(course_id)`.
- **Grade calculation** (spec §27.2, implementing the 2026-08-28 user ruling "current roster × all closed sessions"): population = the **current course roster** — `course_members` rows for the course, filtered to eligible learners via `isEligibleForAttendance(status, roles, institution.rosterLearnerRoles)` (2026-08-28 user ruling on pre-flight note N1). `course_members` is genuinely current: every `createAttendanceSession` refreshes it (`getRosterWithFallback` → `refreshCourseRoster` → `upsertCourseMembers`). It is read with `tx.select()` inside the close transaction. For each such member, iterate every `state='closed'` session in the course; resolve the member's current record for that session with `resolveCurrentRecord`; `present` adds `presentPoints` earned + 1 denominator, `absent` adds `absentPoints` (0) earned + 1 denominator, `excused` is skipped (excluded from denominator), and a session with **no gradeable record** for that member is skipped (natural handling of mid-term adds/drops). `scoreGiven = earned / denominator * 100`; `scoreMaximum = 100`. **Denominator 0 → no job enqueued** (spec §27.2).
- **`reopened` sessions are excluded from the cumulative calculation** — only `state='closed'` counts. A reopen writes nothing to `grade_sync_jobs`; the subsequent close recomputes and re-upserts (2026-08-28 user ruling).
- **`grade_sync_jobs` is keyed `UNIQUE(course_id, lti_user_id)`** (2026-08-28 user ruling). Each close upserts: new `score`, `state='pending'`, `attempt_count=0`, `last_error=null`, `next_attempt_at=now`, `attendance_session_id` = the triggering session.
- **Retry policy** (spec §28): retry `rate-limited` (429), `server-error` (3xx/5xx), `network`, and `auth` (401). Exponential backoff with jitter: `delay = min(GRADE_SYNC_BASE_DELAY_MS * 2^attemptCount, GRADE_SYNC_MAX_DELAY_MS)`, `± 20%` jitter. `computeBackoff` is called with the job's **pre-increment** `attemptCount` (2026-08-28 user ruling on pre-flight note N2), so the FIRST retry lands at `GRADE_SYNC_BASE_DELAY_MS` = 5 min (spec §35.2), then 10, 20, 40, 60, 60. After `MAX_GRADE_SYNC_ATTEMPTS` (6) → terminal `state='failed'`. A `client-error` (non-429 4xx) or `bad-json` → terminal `state='failed'` immediately, never retried.
- **A 401 from Canvas re-mints the AGS token once per course per pass** — `clearAccessTokenCache(registrationId, AGS_SCOPES)` then one fresh `getAccessToken`, mirroring `nrps.ts:297-300`. Without it the process-global token cache would hand the same dead token to every retry for up to an hour and walk every job in the course to the attempt ceiling.
- **Worker Canvas writes are sequential** — one job at a time per course (spec §28 "mostly sequential or low-concurrency"). One AGS token per course per pass; one `ensureLineItem` per course per pass.
- **Every grade mutation writes an `audit_events` row** (spec §33): `grade_sync_requested` (on close and on the retry route — has an actor + requestId), `grade_sync_completed` and `grade_sync_failed` (worker — `actorLtiUserId: null`, `requestId: null`). `institutionId` is the non-null course institution.
- **Opaque errors** (spec §31.9): the retry route returns `{ error: code, requestId }`; `grade_sync_jobs.last_error` and `GradeSyncSummary.lastError` hold a short code (`ags:rate-limited`, `ags:client-error`, `ags:no-lineitems-url`, …), never a raw Canvas body, hostname, token, or SQL.
- **Never log Canvas access tokens or score/line-item request URLs with credentials** (spec §31.8). Do not log full AGS response bodies.
- **New route** (`POST /api/attendance-sessions/:id/grade-sync`) requires `requireSession` + `requireCsrf`, rejects form-encoded bodies, and is tenant-scoped through `loadSessionScopedToCourse` (cross-tenant → 404).
- **The retry worker runs as a standalone entrypoint** (`server/src/worker.ts` + `npm run worker`), NOT wired into the Fastify process (2026-08-28 user ruling; spec §35.2). Phase 7 owns its schedule/deploy.
- `npm test` / `npm run lint` / `npm run typecheck` stay clean after **every** task. The baseline 315 tests must still pass (all new columns nullable-or-defaulted, no behavior change to an existing path except the additive close-transaction extension).

---

## File/module layout

```
server/src/database/
  schema.ts               # MODIFY (Task 1) add gradeLineItems, gradeSyncJobs + row-type exports

server/src/lti/
  scopes.ts               # MODIFY (Task 2) add AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE
  ags.ts                  # NEW (Task 6) ensureLineItem + postScore + AGS error classification (dumb HTTP)

server/src/attendance/
  grade-policy.ts         # NEW (Task 3) GradingPolicy + DEFAULT_GRADING_POLICY + scoreContribution (pure)
  grade-calc.ts           # NEW (Task 4) computeCumulativeScores (pure)
  grade-sync-store.ts     # NEW (Task 7) job upsert/claim/transition + backoff + summary + resetFailedJobs
  session-lifecycle.ts    # MODIFY (Task 8) closeAttendanceSession: compute + enqueue + grade_sync_requested audit, same txn
  grade-worker.ts         # NEW (Task 9) processGradeSyncJobs orchestrator

server/src/routes/
  attendance-sessions.ts  # MODIFY (Task 11) gradeSync summary on GET :id; POST :id/grade-sync retry route

server/src/
  worker.ts               # NEW (Task 10) thin top-level-await entrypoint: one processGradeSyncJobs pass

package.json              # MODIFY (Task 10) "worker": "tsx server/src/worker.ts"

web/
  attendance-session.js   # MODIFY (Task 12) retryGradeSync(sessionId)
  ui.js                   # MODIFY (Task 12) renderGradeSyncState + elements
  app.js                  # MODIFY (Task 12) render gradeSync after close / on load; wire retry button
  index.html              # MODIFY (Task 12) #grade-sync-panel markup

server/tests/support/
  mock-canvas.ts          # MODIFY (Task 5) AGS lineitems + scores endpoints + injectors (additions only)
  seed.ts                 # MODIFY (Task 5) agsLineitemsUrl override on seedInstitutionAndCourse
  db.ts                   # MODIFY (Task 1) grade_sync_jobs + grade_line_items in TRUNCATE_ORDER

server/tests/database/schema.test.ts        # MODIFY (Task 1) grade-table row-chain smoke test
server/tests/support/mock-canvas-ags.test.ts # NEW (Task 5)
server/tests/lti/scopes.test.ts              # MODIFY (Task 2)
server/tests/attendance/grade-policy.test.ts # NEW (Task 3)
server/tests/attendance/grade-calc.test.ts   # NEW (Task 4)
server/tests/lti/ags.test.ts                 # NEW (Task 6)
server/tests/attendance/grade-sync-store.test.ts # NEW (Task 7)
server/tests/attendance/session-lifecycle.test.ts # MODIFY (Task 8)
server/tests/attendance/grade-worker.test.ts  # NEW (Task 9)
server/tests/routes/attendance-sessions.test.ts # MODIFY (Task 11)
server/tests/routes/grade-sync-integration.test.ts # NEW (Task 13)
web/tests/attendance-session.test.js         # MODIFY (Task 12)

docs/canvas-lti/progress.md                  # MODIFY (Task 14) Phase 6 checkbox + "what actually happened"
```

Task count: **14**.

---

### Task 1: Phase 6 schema — `grade_line_items` + `grade_sync_jobs` + migration `0004`

**Files:**
- Modify: `server/src/database/schema.ts` (append two `pgTable`s + two `$inferSelect` exports, next to `attendanceRecords` / `auditEvents`)
- Modify: `server/tests/support/db.ts:27-40` (`TRUNCATE_ORDER`)
- Modify: `server/tests/database/schema.test.ts` (append one smoke test)
- Generate: `migrations/0004_*.sql` + `migrations/meta/*` (via `npx drizzle-kit generate`)

**Interfaces:**
- Consumes: `courses`, `attendanceSessions` (existing tables, for FKs)
- Produces: `gradeLineItems`, `gradeSyncJobs` tables; `type GradeLineItemRow`, `type GradeSyncJobRow`

- [ ] **Step 1: Write the failing smoke test**

Append to `server/tests/database/schema.test.ts`. This file currently imports only vitest, `randomUUID`, `{ getTestDb, resetDb, closeTestDb }`, and eleven table symbols — it does **not** import `seedInstitutionAndCourse` or `MockCanvasPlatform`, so you must **add three imports**:

```ts
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
```

and add `gradeLineItems, gradeSyncJobs` to the existing `../../src/database/schema.js` import list.

```ts
it('stores a grade line item (one per course) and grade-sync jobs (one per course+member)', async () => {
  const { db } = getTestDb();
  await resetDb();
  const { courseId } = await seedInstitutionAndCourse(db, new MockCanvasPlatform());

  const [li] = await db.insert(gradeLineItems).values({
    courseId,
    canvasLineItemId: '123',
    canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/123',
    resourceId: 'attendance-cumulative-v1',
    tag: 'attendance',
    scoreMaximum: 100,
  }).returning();
  expect(li.id).toBeTruthy();

  // UNIQUE(course_id): a second line item for the same course is rejected.
  await expect(
    db.insert(gradeLineItems).values({
      courseId, canvasLineItemId: '999', canvasLineItemUrl: 'https://x/999',
      resourceId: 'attendance-cumulative-v1', tag: 'attendance', scoreMaximum: 100,
    }),
  ).rejects.toThrow();

  const [job] = await db.insert(gradeSyncJobs).values({
    courseId, ltiUserId: 'user-1', score: 94.5,
  }).returning();
  expect(job.state).toBe('pending');
  expect(job.attemptCount).toBe(0);
  expect(job.score).toBeCloseTo(94.5);

  // UNIQUE(course_id, lti_user_id): a second job for the same member is rejected.
  await expect(
    db.insert(gradeSyncJobs).values({ courseId, ltiUserId: 'user-1', score: 10 }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- server/tests/database/schema.test.ts`
Expected: FAIL — `gradeLineItems` / `gradeSyncJobs` are not exported.

- [ ] **Step 3: Add the tables to `schema.ts`**

Append after the `auditEvents` table and the existing `$inferSelect` exports:

```ts
// One cumulative Canvas Gradebook line item per course (spec §27). UNIQUE(course_id) makes
// ensureLineItem's persist step idempotent regardless of how many times the worker runs.
export const gradeLineItems = pgTable(
  'grade_line_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull().references(() => courses.id),
    canvasLineItemId: text('canvas_line_item_id').notNull(),
    canvasLineItemUrl: text('canvas_line_item_url').notNull(),
    resourceId: text('resource_id').notNull(),
    tag: text('tag').notNull(),
    scoreMaximum: integer('score_maximum').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId)],
);

// Durable grade-sync outbox (spec §28). One row per (course, member): each session close upserts
// the member's latest cumulative score and resets the row to pending. state: pending -> synced on a
// successful AGS post; pending -> failed after MAX_GRADE_SYNC_ATTEMPTS retries or a permanent 4xx.
// (the `enum` on the state column narrows the TS type only — Postgres stores plain text with no CHECK
// constraint, same as attendance_records.status / attendance_sessions.state.)
export const gradeSyncJobs = pgTable(
  'grade_sync_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull().references(() => courses.id),
    // The session whose close last (re)computed this score. Nullable per spec §26; a manual retry
    // (POST /grade-sync) leaves it unchanged.
    attendanceSessionId: uuid('attendance_session_id').references(() => attendanceSessions.id),
    ltiUserId: text('lti_user_id').notNull(),
    // Cumulative percentage 0..100 (scoreGiven; maximum is 100). doublePrecision (float8) on purpose:
    // `real` (float4) has ~7 significant digits and would lose the 4th decimal of e.g. 33.3333, and
    // `numeric` comes back from node-postgres as a STRING, which would break every toBeCloseTo and
    // force a Number() wrapper in grade-worker.ts. Do not "improve" this to numeric.
    score: doublePrecision('score').notNull(),
    state: text('state', { enum: ['pending', 'synced', 'failed'] }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'), // opaque short code only (spec §31.9) — never a raw Canvas body
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId, t.ltiUserId)],
);

export type GradeLineItemRow = typeof gradeLineItems.$inferSelect;
export type GradeSyncJobRow = typeof gradeSyncJobs.$inferSelect;
```

Add `doublePrecision` to the existing `drizzle-orm/pg-core` import at the top of `schema.ts` (it currently imports `pgTable, uuid, text, boolean, timestamp, jsonb, integer, unique, uniqueIndex`).

- [ ] **Step 4: Add both tables to `TRUNCATE_ORDER`**

In `server/tests/support/db.ts`, add the two names at the **top** of the array (children before parents; the single `TRUNCATE ... CASCADE` is order-insensitive but keep the convention):

```ts
const TRUNCATE_ORDER = [
  'grade_sync_jobs',
  'grade_line_items',
  'attendance_records',
  'attendance_session_members',
  'attendance_sessions',
  'audit_events',
  'course_members',
  'app_sessions',
  'courses',
  'oidc_transactions',
  'lti_deployments',
  'lti_registrations',
  'institutions',
];
```

- [ ] **Step 5: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: creates `migrations/0004_<name>.sql` containing exactly two `CREATE TABLE` statements — each with its `CONSTRAINT ... UNIQUE(...)` **inline** — followed by **three** `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` statements (`grade_line_items_course_id_courses_id_fk`, `grade_sync_jobs_course_id_courses_id_fk`, `grade_sync_jobs_attendance_session_id_attendance_sessions_id_fk`; `grade_sync_jobs` has two FKs), and updates `migrations/meta/_journal.json` (one new `idx: 4` entry) plus a new `0004_snapshot.json`.
Confirm there is no `DROP` and no `ALTER COLUMN` touching an existing table. `score` must render as `"score" double precision NOT NULL`, and `state` as `"state" text DEFAULT 'pending' NOT NULL` (the TS `enum` emits no database CHECK).

- [ ] **Step 6: Run the full suite — expect PASS**

Run: `npm test` (globalSetup applies `0004`) — expected: baseline + 1 test, all green.
Run: `npm run lint && npm run typecheck` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/database/schema.ts server/tests/support/db.ts server/tests/database/schema.test.ts migrations/
git commit -m "$(cat <<'EOF'
feat(phase6): add grade_line_items and grade_sync_jobs tables

Migration 0004: one cumulative line item per course (UNIQUE course_id),
durable grade-sync outbox keyed UNIQUE(course_id, lti_user_id). Additive only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 2: AGS scope constants — `scopes.ts`

**Files:**
- Modify: `server/src/lti/scopes.ts`
- Modify: `server/tests/lti/scopes.test.ts`

**Interfaces:**
- Produces: `AGS_LINEITEM_SCOPE`, `AGS_SCORE_SCOPE` (string constants)

- [ ] **Step 1: Write the failing test**

Append to `server/tests/lti/scopes.test.ts`:

```ts
import { AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE } from '../../src/lti/scopes.js';

it('exposes the character-exact AGS line-item and score scope URIs', () => {
  expect(AGS_LINEITEM_SCOPE).toBe('https://purl.imsglobal.org/spec/lti-ags/scope/lineitem');
  expect(AGS_SCORE_SCOPE).toBe('https://purl.imsglobal.org/spec/lti-ags/scope/score');
});

it('does not request the AGS Result read scope (spec §10 "The application does not initially require the AGS Result read scope")', () => {
  const all = [AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE];
  expect(all.some((s) => s.includes('result'))).toBe(false);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`AGS_LINEITEM_SCOPE` not exported)

Run: `npm test -- server/tests/lti/scopes.test.ts`

- [ ] **Step 3: Add the constants**

In `server/src/lti/scopes.ts`, after `NRPS_MEMBERSHIP_READONLY_SCOPE`:

```ts
// AGS line-item read/write and score write (spec §10 "Canvas registration" — the capability list
// "AGS line items: read/write" / "AGS scores: write"). These are the literal 1EdTech URIs Canvas's
// Developer Key UI populates and `docs/canvas-installation.md` lists verbatim; reproduce them
// character-for-character, never paraphrase. The app deliberately does NOT request the AGS Result
// read scope (spec §10: "The application does not initially require the AGS Result read scope").
export const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
export const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
```

- [ ] **Step 4: Run it — expect PASS**; then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/scopes.ts server/tests/lti/scopes.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): add AGS lineitem and score scope constants

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 3: `grade-policy.ts` — default grading policy (pure)

**Files:**
- Create: `server/src/attendance/grade-policy.ts`
- Test: `server/tests/attendance/grade-policy.test.ts`

**Interfaces:**
- Produces: `GradingPolicy`, `DEFAULT_GRADING_POLICY`, `GradeableStatus`, `scoreContribution(status, policy)` — see the Fixed-contract block.

- [ ] **Step 1: Write the failing test**

`server/tests/attendance/grade-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_GRADING_POLICY, scoreContribution } from '../../src/attendance/grade-policy.js';

describe('DEFAULT_GRADING_POLICY', () => {
  it('is present=1, absent=0, excused excluded from the denominator (spec §27.2)', () => {
    expect(DEFAULT_GRADING_POLICY).toEqual({ presentPoints: 1, absentPoints: 0, excusedExcluded: true });
  });
});

describe('scoreContribution', () => {
  const p = DEFAULT_GRADING_POLICY;

  it('present -> earns presentPoints and counts toward the denominator', () => {
    expect(scoreContribution('present', p)).toEqual({ earned: 1, inDenominator: true });
  });

  it('absent -> earns absentPoints and counts toward the denominator', () => {
    expect(scoreContribution('absent', p)).toEqual({ earned: 0, inDenominator: true });
  });

  it('excused -> excluded from the denominator when excusedExcluded is true', () => {
    expect(scoreContribution('excused', p)).toEqual({ earned: 0, inDenominator: false });
  });

  it('excused -> treated like absent when excusedExcluded is false', () => {
    expect(scoreContribution('excused', { ...p, excusedExcluded: false })).toEqual({ earned: 0, inDenominator: true });
  });

  it('null (no gradeable record / lookup_error / unexpected) -> no contribution (spec §24)', () => {
    expect(scoreContribution(null, p)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`scoreContribution` not defined)

Run: `npm test -- server/tests/attendance/grade-policy.test.ts`

- [ ] **Step 3: Implement**

`server/src/attendance/grade-policy.ts`:

```ts
// server/src/attendance/grade-policy.ts
//
// Attendance -> Gradebook policy (spec §27.2). Pure: no DB, no Canvas. The default is
// present=1 / absent=0 / excused-excluded-from-denominator. Spec §27.2 says grading policy
// "must be configurable by institution"; the per-institution surface (an institutions.grading_policy
// column + an editor) is deferred to Phase 8 — this phase ships the documented default with a clean
// seam: any caller can pass a different GradingPolicy, and only DEFAULT_GRADING_POLICY is wired up.
// 'late' is intentionally absent — it is not in the attendance_records status enum this phase.

export interface GradingPolicy {
  presentPoints: number;
  absentPoints: number;
  excusedExcluded: boolean;
}

export const DEFAULT_GRADING_POLICY: GradingPolicy = {
  presentPoints: 1,
  absentPoints: 0,
  excusedExcluded: true,
};

export type GradeableStatus = 'present' | 'absent' | 'excused';

/**
 * The earned points + denominator membership for one member's resolved status in one session.
 * `null` status means "no gradeable record for this member-session" (member had no record, or the
 * only record is lookup_error/unexpected — spec §24): contributes nothing, not even a denominator.
 */
export function scoreContribution(
  status: GradeableStatus | null,
  policy: GradingPolicy,
): { earned: number; inDenominator: boolean } | null {
  if (status === null) return null;
  if (status === 'present') return { earned: policy.presentPoints, inDenominator: true };
  if (status === 'absent') return { earned: policy.absentPoints, inDenominator: true };
  // excused
  return policy.excusedExcluded
    ? { earned: 0, inDenominator: false }
    : { earned: policy.absentPoints, inDenominator: true };
}
```

- [ ] **Step 4: Run it — expect PASS**; then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/grade-policy.ts server/tests/attendance/grade-policy.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): add default grading policy module

present=1 / absent=0 / excused excluded from denominator (spec §27.2).
Per-institution policy config deferred to Phase 8; seam left via the
GradingPolicy parameter.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 4: `grade-calc.ts` — `computeCumulativeScores` (pure)

**Files:**
- Create: `server/src/attendance/grade-calc.ts`
- Test: `server/tests/attendance/grade-calc.test.ts`

**Interfaces:**
- Consumes: `GradingPolicy`, `GradeableStatus`, `scoreContribution` (Task 3)
- Produces: `SessionResolvedStatuses`, `CumulativeScore`, `computeCumulativeScores(closedSessions, rosterLtiUserIds, policy)` — see the Fixed-contract block.

- [ ] **Step 1: Write the failing test**

`server/tests/attendance/grade-calc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeCumulativeScores } from '../../src/attendance/grade-calc.js';
import { DEFAULT_GRADING_POLICY } from '../../src/attendance/grade-policy.js';

const P = DEFAULT_GRADING_POLICY;

function session(sessionId: string, entries: Record<string, 'present' | 'absent' | 'excused'>) {
  return { sessionId, statusByLtiUserId: new Map(Object.entries(entries)) };
}

describe('computeCumulativeScores', () => {
  it('is 100 for a member present in every closed session', () => {
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'present' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')).toEqual({ scoreGiven: 100, scoreMaximum: 100 });
  });

  it('is 50 for a member present in half of the closed sessions', () => {
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'absent' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')).toEqual({ scoreGiven: 50, scoreMaximum: 100 });
  });

  it('excludes an excused session from the denominator', () => {
    // present, excused, absent -> earned 1 / denominator 2 -> 50
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'excused' }), session('s3', { u1: 'absent' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')).toEqual({ scoreGiven: 50, scoreMaximum: 100 });
  });

  it('skips a session where the member has no gradeable record (mid-term add/drop)', () => {
    // u2 only appears in s2 -> denominator 1, present -> 100
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'present', u2: 'present' })],
      ['u1', 'u2'],
      P,
    );
    expect(scores.get('u2')).toEqual({ scoreGiven: 100, scoreMaximum: 100 });
  });

  it('omits a member whose denominator is 0 (only excused, or no records at all)', () => {
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'excused' })],
      ['u1', 'u3'],
      P,
    );
    expect(scores.has('u1')).toBe(false); // only-excused -> denominator 0
    expect(scores.has('u3')).toBe(false); // never appears
  });

  it('returns an empty map when there are no closed sessions', () => {
    expect(computeCumulativeScores([], ['u1'], P).size).toBe(0);
  });

  it('rounds scoreGiven to at most 4 decimal places', () => {
    // 1 of 3 -> 33.3333...
    const scores = computeCumulativeScores(
      [session('s1', { u1: 'present' }), session('s2', { u1: 'absent' }), session('s3', { u1: 'absent' })],
      ['u1'],
      P,
    );
    expect(scores.get('u1')!.scoreGiven).toBeCloseTo(33.3333, 4);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- server/tests/attendance/grade-calc.test.ts`

- [ ] **Step 3: Implement**

`server/src/attendance/grade-calc.ts`:

```ts
// server/src/attendance/grade-calc.ts
//
// Cumulative attendance -> Canvas score (spec §27, §27.2). Pure: no DB, no Canvas.
//
// Population is decided by the caller (session-lifecycle.ts passes the course's CURRENT roster —
// course_members filtered to eligible learners — per the 2026-08-28 "current roster x all closed
// sessions" ruling). For each roster member we walk every CLOSED session (reopened sessions
// are excluded by the caller) and accumulate earned points + denominator per grade-policy.ts.
// Denominator 0 -> the member is omitted (spec §27.2 "do not submit a score").

import { type GradingPolicy, type GradeableStatus, scoreContribution } from './grade-policy.js';

export interface SessionResolvedStatuses {
  sessionId: string;
  // Only members with a gradeable resolved record (present | absent | excused) for this session.
  // A member absent from this map contributed no record to that session.
  statusByLtiUserId: Map<string, GradeableStatus>;
}

export interface CumulativeScore {
  scoreGiven: number;
  scoreMaximum: 100;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export function computeCumulativeScores(
  closedSessions: SessionResolvedStatuses[],
  rosterLtiUserIds: string[],
  policy: GradingPolicy,
): Map<string, CumulativeScore> {
  const result = new Map<string, CumulativeScore>();

  for (const ltiUserId of rosterLtiUserIds) {
    let earned = 0;
    let denominator = 0;

    for (const session of closedSessions) {
      const status = session.statusByLtiUserId.get(ltiUserId) ?? null;
      const contribution = scoreContribution(status, policy);
      if (contribution === null) continue;
      earned += contribution.earned;
      if (contribution.inDenominator) denominator += 1;
    }

    if (denominator === 0) continue; // spec §27.2
    result.set(ltiUserId, { scoreGiven: round4((earned / denominator) * 100), scoreMaximum: 100 });
  }

  return result;
}
```

- [ ] **Step 4: Run it — expect PASS**; then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/grade-calc.ts server/tests/attendance/grade-calc.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): add cumulative attendance score calculation

computeCumulativeScores folds every closed session's resolved per-member
status into one scoreGiven/scoreMaximum; denominator 0 -> member omitted.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 5: Extend `MockCanvasPlatform` with AGS line-item + score endpoints

**Files:**
- Modify: `server/tests/support/mock-canvas.ts` (**additions only** — do not touch any Phase 3/4 field, route, or method)
- Modify: `server/tests/support/seed.ts` (add `agsLineitemsUrl` override)
- Test: `server/tests/support/mock-canvas-ags.test.ts` (NEW self-test)

**Interfaces:**
- Consumes: the existing `issuedTokens` / `expiredTokens` auth model, `randomUUID`, `this.baseUrl`
- Produces on the class: `lineItemsUrlFor(courseId)`, `seedExistingLineItem(courseId, overrides?)`, `failNextAgsRequest(kind)`, `failNextScorePost(kind)`, `getLineItems(courseId)`, `getPostedScores(courseId)`
- Produces in `seed.ts`: `seedInstitutionAndCourse(db, platform, overrides & { agsLineitemsUrl?: string | null })`

- [ ] **Step 1: Write the failing self-test**

`server/tests/support/mock-canvas-ags.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockCanvasPlatform } from './mock-canvas.js';

async function mintToken(platform: MockCanvasPlatform): Promise<string> {
  const res = await fetch(platform.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'mock-assertion',
      scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem https://purl.imsglobal.org/spec/lti-ags/scope/score',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('MockCanvasPlatform AGS endpoints', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('401s a line-items request with no valid bearer token', async () => {
    const res = await fetch(platform.lineItemsUrlFor('c1'), { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('lists an empty collection, creates a line item, then lists + filters it by tag/resource_id', async () => {
    const token = await mintToken(platform);
    const authHeader = { authorization: `Bearer ${token}` };

    const empty = await fetch(platform.lineItemsUrlFor('c2'), { headers: authHeader });
    expect(await empty.json()).toEqual([]);

    const created = await fetch(platform.lineItemsUrlFor('c2'), {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/vnd.ims.lis.v2.lineitem+json' },
      body: JSON.stringify({ scoreMaximum: 100, label: 'Attendance', resourceId: 'attendance-cumulative-v1', tag: 'attendance' }),
    });
    const li = (await created.json()) as { id: string; resourceId: string; tag: string };
    expect(li.id).toMatch(/\/ags\/lineitems\//);
    expect(li.resourceId).toBe('attendance-cumulative-v1');

    const filtered = await fetch(`${platform.lineItemsUrlFor('c2')}?tag=attendance&resource_id=attendance-cumulative-v1`, { headers: authHeader });
    const list = (await filtered.json()) as unknown[];
    expect(list).toHaveLength(1);

    const noMatch = await fetch(`${platform.lineItemsUrlFor('c2')}?tag=nope`, { headers: authHeader });
    expect(await noMatch.json()).toEqual([]);
  });

  it('accepts a score POST to <lineItem>/scores and records it', async () => {
    const token = await mintToken(platform);
    const authHeader = { authorization: `Bearer ${token}` };
    const li = platform.seedExistingLineItem('c3');

    const res = await fetch(`${li}/scores`, {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/vnd.ims.lis.v1.score+json' },
      body: JSON.stringify({ userId: 'u1', scoreGiven: 87.5, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() }),
    });
    expect(res.ok).toBe(true);
    const scores = platform.getPostedScores('c3');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ userId: 'u1', scoreGiven: 87.5 });
  });

  it('failNextAgsRequest("rate-limited") makes the NEXT AGS request a one-shot 429 with retry-after', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('rate-limited');
    const res = await fetch(platform.lineItemsUrlFor('c4'), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    // one-shot: the following request succeeds
    const ok = await fetch(platform.lineItemsUrlFor('c4'), { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
  });

  it('failNextAgsRequest("client-error") -> one-shot 422; ("server-error") -> one-shot 500; ("auth") -> one-shot 401', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('client-error');
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(422);
    platform.failNextAgsRequest('server-error');
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(500);
    platform.failNextAgsRequest('auth');
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    // one-shot: the token is still otherwise valid
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('failNextScorePost fails ONLY the next score POST, leaving the line-items GET/POST alone', async () => {
    const token = await mintToken(platform);
    const authHeader = { authorization: `Bearer ${token}` };
    const li = platform.seedExistingLineItem('c6');

    platform.failNextScorePost('rate-limited');
    // The line-items GET is untouched by the score-only injector.
    expect((await fetch(platform.lineItemsUrlFor('c6'), { headers: authHeader })).status).toBe(200);

    const postScore = () =>
      fetch(`${li}/scores`, {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/vnd.ims.lis.v1.score+json' },
        body: JSON.stringify({ userId: 'u1', scoreGiven: 10, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() }),
      });
    const failed = await postScore();
    expect(failed.status).toBe(429);
    expect(failed.headers.get('retry-after')).toBe('1');
    expect((await postScore()).status).toBe(200); // one-shot
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`lineItemsUrlFor` not a function)

Run: `npm test -- server/tests/support/mock-canvas-ags.test.ts`

- [ ] **Step 3: Add the AGS surface to `MockCanvasPlatform`**

In `server/tests/support/mock-canvas.ts`, add these private fields next to the Phase 4 block (`// --- Phase 4 ...`):

```ts
  // --- Phase 6: AGS line items + scores ---
  private lineItems = new Map<string, Array<{ id: string; scoreMaximum: number; label: string; resourceId: string; tag: string }>>();
  private lineItemScores = new Map<string, Array<Record<string, unknown>>>(); // keyed by lineItemId (trailing segment)
  private agsFailOnce: 'rate-limited' | 'server-error' | 'client-error' | 'auth' | null = null;
  // Score-route-only one-shot, so a worker test can fail the score POST without failing
  // ensureLineItem's GET/POST in the same pass.
  private agsScoreFailOnce: 'rate-limited' | 'server-error' | 'client-error' | null = null;
```

In the constructor, **after** the existing `this.app.register(fastifyFormbody)` line, register the AGS vendor content-type parsers and routes:

```ts
    // Canvas AGS requires vendor content types Fastify's default JSON parser ignores.
    this.app.addContentTypeParser(
      ['application/vnd.ims.lis.v2.lineitem+json', 'application/vnd.ims.lis.v1.score+json'],
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, body ? JSON.parse(body as string) : {});
        } catch (err) {
          done(err as Error);
        }
      },
    );

    const agsAuthOk = (request: import('fastify').FastifyRequest): boolean => {
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      return this.issuedTokens.has(token) && !this.expiredTokens.has(token);
    };
    // Returns a reply if a one-shot failure is armed; caller returns it. Consumes the injection.
    const consumeAgsFailure = (reply: import('fastify').FastifyReply): import('fastify').FastifyReply | null => {
      const kind = this.agsFailOnce;
      if (!kind) return null;
      this.agsFailOnce = null;
      if (kind === 'rate-limited') {
        reply.header('retry-after', '1');
        return reply.code(429).send({ error: 'rate_limited' });
      }
      if (kind === 'server-error') return reply.code(500).send({ error: 'server_error' });
      if (kind === 'auth') return reply.code(401).send({ error: 'invalid_token' }); // one-shot revoked-token 401
      return reply.code(422).send({ error: 'unprocessable', errors: ['mock one-shot client error'] });
    };

    this.app.get('/ags/:courseId/lineitems', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { courseId } = request.params as { courseId: string };
      const query = request.query as { tag?: string; resource_id?: string };
      let items = this.lineItems.get(courseId) ?? [];
      if (query.tag !== undefined) items = items.filter((li) => li.tag === query.tag);
      if (query.resource_id !== undefined) items = items.filter((li) => li.resourceId === query.resource_id);
      return items;
    });

    this.app.post('/ags/:courseId/lineitems', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { courseId } = request.params as { courseId: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const created = this.createLineItem(courseId, {
        scoreMaximum: typeof body.scoreMaximum === 'number' ? body.scoreMaximum : 100,
        label: typeof body.label === 'string' ? body.label : 'Attendance',
        resourceId: typeof body.resourceId === 'string' ? body.resourceId : 'attendance-cumulative-v1',
        tag: typeof body.tag === 'string' ? body.tag : 'attendance',
      });
      return created;
    });

    this.app.post('/ags/lineitems/:lineItemId/scores', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      // Score-only one-shot first, so failNextScorePost never eats a line-items request.
      if (this.agsScoreFailOnce) {
        const scoreKind = this.agsScoreFailOnce;
        this.agsScoreFailOnce = null;
        if (scoreKind === 'rate-limited') {
          reply.header('retry-after', '1');
          return reply.code(429).send({ error: 'rate_limited' });
        }
        if (scoreKind === 'server-error') return reply.code(500).send({ error: 'server_error' });
        return reply.code(422).send({ error: 'unprocessable' });
      }
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { lineItemId } = request.params as { lineItemId: string };
      if (!this.lineItemScores.has(lineItemId)) return reply.code(404).send({ error: 'unknown_line_item' });
      this.lineItemScores.get(lineItemId)!.push((request.body ?? {}) as Record<string, unknown>);
      return reply.code(200).send({ resultUrl: `${this.baseUrl}/ags/lineitems/${lineItemId}/results/mock` });
    });
```

Add the helper + public methods to the class body (near the Phase 4 getters `nrpsUrlFor` / `setCourseMembers`):

```ts
  lineItemsUrlFor(courseId: string): string {
    return `${this.baseUrl}/ags/${courseId}/lineitems`;
  }

  private createLineItem(
    courseId: string,
    fields: { scoreMaximum: number; label: string; resourceId: string; tag: string },
  ): { id: string; scoreMaximum: number; label: string; resourceId: string; tag: string } {
    const lineItemId = randomUUID();
    const id = `${this.baseUrl}/ags/lineitems/${lineItemId}`;
    const record = { id, ...fields };
    const list = this.lineItems.get(courseId) ?? [];
    list.push(record);
    this.lineItems.set(courseId, list);
    this.lineItemScores.set(lineItemId, []);
    return record;
  }

  /** Pre-create a line item (bypasses the create route) so a reuse path can be exercised. */
  seedExistingLineItem(
    courseId: string,
    overrides: Partial<{ scoreMaximum: number; label: string; resourceId: string; tag: string }> = {},
  ): string {
    return this.createLineItem(courseId, {
      scoreMaximum: overrides.scoreMaximum ?? 100,
      label: overrides.label ?? 'Attendance',
      resourceId: overrides.resourceId ?? 'attendance-cumulative-v1',
      tag: overrides.tag ?? 'attendance',
    }).id;
  }

  /**
   * Arm a one-shot failure for the NEXT AGS request of any kind. `'auth'` -> a 401 `invalid_token`
   * (a revoked/rotated token), which grade-worker.ts handles by clearing the token cache and
   * re-minting once.
   */
  failNextAgsRequest(kind: 'rate-limited' | 'server-error' | 'client-error' | 'auth'): void {
    this.agsFailOnce = kind;
  }

  getLineItems(courseId: string): ReadonlyArray<{ id: string; scoreMaximum: number; label: string; resourceId: string; tag: string }> {
    return this.lineItems.get(courseId) ?? [];
  }

  /** Every score posted to any line item of this course, oldest first. */
  getPostedScores(courseId: string): Array<Record<string, unknown>> {
    const ids = (this.lineItems.get(courseId) ?? []).map((li) => li.id.split('/').pop()!);
    return ids.flatMap((id) => this.lineItemScores.get(id) ?? []);
  }
```

> If `this.baseUrl` is a `private get` in the shipped file, these methods (same class) can read it. If TypeScript complains that `import('fastify').FastifyRequest` inline types are noisy, add `FastifyReply` / `FastifyRequest` to the existing top `import ... from 'fastify'` and use the bare names.

- [ ] **Step 4: Add the `agsLineitemsUrl` override to `seedInstitutionAndCourse`**

In `server/tests/support/seed.ts`, widen the overrides parameter and set the column:

```ts
export async function seedInstitutionAndCourse(
  db: Database,
  platform: MockCanvasPlatform,
  overrides: SeedOverrides & { nrpsUrl?: string | null; agsLineitemsUrl?: string | null } = {},
): Promise<SeededCourse> {
  const seeded = await seedInstitutionAndRegistration(db, platform, overrides);
  const [course] = await db
    .insert(courses)
    .values({
      institutionId: seeded.institutionId,
      deploymentId: seeded.deploymentRowId,
      ltiContextId: `ctx-${randomUUID()}`,
      label: 'TEST-101',
      title: 'Test Course',
      nrpsUrl: overrides.nrpsUrl ?? null,
      agsLineitemsUrl: overrides.agsLineitemsUrl ?? null,
    })
    .returning();
  return { ...seeded, courseId: course.id };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm test -- server/tests/support/mock-canvas-ags.test.ts` — expected: PASS.
Run: `npm test` — expected: baseline (Phase 4 NRPS mock tests unaffected) + the new self-test, all green.
Run: `npm run lint && npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add server/tests/support/mock-canvas.ts server/tests/support/seed.ts server/tests/support/mock-canvas-ags.test.ts
git commit -m "$(cat <<'EOF'
test(phase6): add AGS line-item + score endpoints to MockCanvasPlatform

Additions only. Vendor content-type parsers, GET/POST /ags/:courseId/lineitems,
POST /ags/lineitems/:id/scores, one-shot failure injector, seed agsLineitemsUrl.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 6: `lti/ags.ts` — `ensureLineItem` + `postScore` (dumb authenticated HTTP)

**Files:**
- Create: `server/src/lti/ags.ts`
- Test: `server/tests/lti/ags.test.ts`

**Interfaces:**
- Consumes: `validateCanvasServiceUrl` (`service-url.ts`)
- Produces: `ATTENDANCE_RESOURCE_ID`, `ATTENDANCE_TAG`, `ATTENDANCE_LABEL`, `ATTENDANCE_SCORE_MAXIMUM`, `AgsErrorKind`, `AgsError`, `AgsResult<T>`, `EnsuredLineItem`, `ensureLineItem(lineItemsUrl, accessToken, deps?)`, `AgsScoreInput`, `postScore(lineItemUrl, accessToken, score, deps?)` — see the Fixed-contract block.

- [ ] **Step 1: Write the failing tests**

`server/tests/lti/ags.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { ensureLineItem, postScore, ATTENDANCE_RESOURCE_ID, ATTENDANCE_TAG } from '../../src/lti/ags.js';

async function mintToken(platform: MockCanvasPlatform): Promise<string> {
  const res = await fetch(platform.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'mock-assertion',
      scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem https://purl.imsglobal.org/spec/lti-ags/scope/score',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('ensureLineItem', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('creates a line item when none exists, with the stable resourceId/tag/maximum', async () => {
    const token = await mintToken(platform);
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-create'), token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resourceId).toBe(ATTENDANCE_RESOURCE_ID);
      expect(result.value.tag).toBe(ATTENDANCE_TAG);
      expect(result.value.scoreMaximum).toBe(100);
      expect(result.value.canvasLineItemUrl).toMatch(/\/ags\/lineitems\//);
      expect(result.value.canvasLineItemId).not.toContain('/');
    }
    expect(platform.getLineItems('c-create')).toHaveLength(1);
  });

  it('reuses an existing matching line item instead of creating a second (idempotent)', async () => {
    const token = await mintToken(platform);
    platform.seedExistingLineItem('c-reuse');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-reuse'), token);
    expect(result.ok).toBe(true);
    expect(platform.getLineItems('c-reuse')).toHaveLength(1); // no new line item
  });

  it('classifies a 429 as retryable rate-limited with retryAfterSeconds', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('rate-limited');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-429'), token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  it('classifies a 500 as retryable server-error', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('server-error');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-500'), token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'server-error', retryable: true });
  });

  it('classifies a 422 as PERMANENT client-error (never retried)', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('client-error');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-422'), token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'client-error', retryable: false, status: 422 });
  });

  it('classifies a thrown fetch as retryable network', async () => {
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await ensureLineItem('https://canvas.example.edu/api/lti/courses/1/line_items', 'tok', { fetchImpl: dead });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'network', retryable: true });
  });

  it('rejects a malformed line-items URL without a fetch', async () => {
    const result = await ensureLineItem('not a url', 'tok');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-service-url');
  });
});

describe('postScore', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('posts to <lineItemUrl>/scores with Completed / FullyGraded and records the score', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-score');
    const result = await postScore(lineItemUrl, token, {
      userId: 'u1',
      scoreGiven: 94.5,
      scoreMaximum: 100,
      timestamp: '2026-08-28T12:00:00.123Z',
    });
    expect(result.ok).toBe(true);
    const scores = platform.getPostedScores('c-score');
    expect(scores[0]).toMatchObject({
      userId: 'u1',
      scoreGiven: 94.5,
      scoreMaximum: 100,
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
      timestamp: '2026-08-28T12:00:00.123Z',
    });
  });

  it('classifies a 429 on the score post as retryable rate-limited', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-score429');
    platform.failNextAgsRequest('rate-limited');
    const result = await postScore(lineItemUrl, token, { userId: 'u1', scoreGiven: 10, scoreMaximum: 100, timestamp: new Date().toISOString() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('rate-limited');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`../../src/lti/ags.js` missing)

Run: `npm test -- server/tests/lti/ags.test.ts`

- [ ] **Step 3: Implement `server/src/lti/ags.ts`**

```ts
// server/src/lti/ags.ts
//
// Dumb authenticated HTTP against Canvas AGS (spec §27, §27.1, §27.3). Mirrors nrps.ts's
// fetchRawMembershipPages: this module never acquires a token (the caller passes one) and never
// retries (the caller — grade-worker.ts — owns the retry loop). It only performs one request and
// classifies the outcome into AgsResult. The line-items URL and every derived score URL come from
// the launch-persisted courses.ags_lineitems_url, used verbatim through validateCanvasServiceUrl
// (structural check only — spec §31.7 trust anchor is the signed launch's provenance).

import { validateCanvasServiceUrl } from './service-url.js';

export const ATTENDANCE_RESOURCE_ID = 'attendance-cumulative-v1';
export const ATTENDANCE_TAG = 'attendance';
export const ATTENDANCE_LABEL = 'Attendance';
export const ATTENDANCE_SCORE_MAXIMUM = 100;

export type AgsErrorKind =
  | 'invalid-service-url'
  | 'rate-limited'
  | 'auth'
  | 'client-error'
  | 'server-error'
  | 'network'
  | 'bad-json';

export interface AgsError {
  kind: AgsErrorKind;
  message: string;
  status?: number;
  retryAfterSeconds?: number;
  retryable: boolean;
}

export type AgsResult<T> = { ok: true; value: T } | { ok: false; error: AgsError };

export interface EnsuredLineItem {
  canvasLineItemId: string;
  canvasLineItemUrl: string;
  resourceId: string;
  tag: string;
  scoreMaximum: number;
}

export interface AgsScoreInput {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  timestamp: string;
}

const LINEITEM_CONTENT_TYPE = 'application/vnd.ims.lis.v2.lineitem+json';
const LINEITEM_CONTAINER_ACCEPT = 'application/vnd.ims.lis.v2.lineitemcontainer+json';
const SCORE_CONTENT_TYPE = 'application/vnd.ims.lis.v1.score+json';

// The thrown error is deliberately discarded: nothing from a fetch rejection (hostname, socket
// path, Canvas response detail) is safe to persist (spec §31.9). The param must be named `_err` to
// satisfy `@typescript-eslint/no-unused-vars`'s `argsIgnorePattern: '^_'` (eslint.config.js) —
// `args: 'after-used'` reports the last parameter when it is the only one and unused.
function networkError(_err: unknown): AgsResult<never> {
  return {
    ok: false,
    error: { kind: 'network', message: 'ags:network', retryable: true },
  };
}

function badJson(): AgsResult<never> {
  return { ok: false, error: { kind: 'bad-json', message: 'ags:bad-json', retryable: false } };
}

/** null => the response is a usable 2xx. Otherwise an AgsResult error to return. */
function classifyResponse(response: Response): AgsResult<never> | null {
  const status = response.status;
  if (status >= 200 && status < 300) return null;
  if (status >= 300 && status < 400) {
    return { ok: false, error: { kind: 'server-error', message: 'ags:redirect', status, retryable: true } };
  }
  if (status === 401) {
    return { ok: false, error: { kind: 'auth', message: 'ags:auth', status, retryable: true } };
  }
  if (status === 429) {
    const header = response.headers.get('retry-after');
    const retryAfterSeconds = header ? Number(header) : undefined;
    return {
      ok: false,
      error: {
        kind: 'rate-limited',
        message: 'ags:rate-limited',
        status,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        retryable: true,
      },
    };
  }
  if (status >= 500) {
    return { ok: false, error: { kind: 'server-error', message: 'ags:server-error', status, retryable: true } };
  }
  // Any other 4xx is a permanent validation error (spec §28: do not auto-retry).
  return { ok: false, error: { kind: 'client-error', message: 'ags:client-error', status, retryable: false } };
}

function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? url;
  } catch {
    return url;
  }
}

function toEnsured(raw: Record<string, unknown>): EnsuredLineItem {
  const url = String(raw.id);
  return {
    canvasLineItemId: lastSegment(url),
    canvasLineItemUrl: url,
    resourceId: typeof raw.resourceId === 'string' ? raw.resourceId : ATTENDANCE_RESOURCE_ID,
    tag: typeof raw.tag === 'string' ? raw.tag : ATTENDANCE_TAG,
    scoreMaximum: typeof raw.scoreMaximum === 'number' ? raw.scoreMaximum : ATTENDANCE_SCORE_MAXIMUM,
  };
}

export async function ensureLineItem(
  lineItemsUrl: string,
  accessToken: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AgsResult<EnsuredLineItem>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const urlCheck = validateCanvasServiceUrl(lineItemsUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: { kind: 'invalid-service-url', message: 'ags:invalid-service-url', retryable: false } };
  }

  // 1. Query existing tool line items by the stable tag + resourceId (spec §27.1 step 1).
  const separator = lineItemsUrl.includes('?') ? '&' : '?';
  const queryUrl = `${lineItemsUrl}${separator}tag=${encodeURIComponent(ATTENDANCE_TAG)}&resource_id=${encodeURIComponent(ATTENDANCE_RESOURCE_ID)}`;
  let listResponse: Response;
  try {
    listResponse = await fetchImpl(queryUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: LINEITEM_CONTAINER_ACCEPT },
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  const listError = classifyResponse(listResponse);
  if (listError) return listError;

  let listJson: unknown;
  try {
    listJson = await listResponse.json();
  } catch {
    return badJson();
  }
  const existing = Array.isArray(listJson) ? (listJson as Array<Record<string, unknown>>) : [];
  const match = existing.find(
    (li) => li && li.tag === ATTENDANCE_TAG && li.resourceId === ATTENDANCE_RESOURCE_ID && typeof li.id === 'string',
  );
  if (match) return { ok: true, value: toEnsured(match) }; // spec §27.1 step 2 — reuse

  // 2. Create only if none exists (spec §27.1 step 3). Canvas dedupes on resourceId, so a
  //    concurrent double-create still converges — this operation is idempotent.
  let createResponse: Response;
  try {
    createResponse = await fetchImpl(lineItemsUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': LINEITEM_CONTENT_TYPE },
      body: JSON.stringify({
        scoreMaximum: ATTENDANCE_SCORE_MAXIMUM,
        label: ATTENDANCE_LABEL,
        resourceId: ATTENDANCE_RESOURCE_ID,
        tag: ATTENDANCE_TAG,
      }),
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  const createError = classifyResponse(createResponse);
  if (createError) return createError;

  let createdJson: unknown;
  try {
    createdJson = await createResponse.json();
  } catch {
    return badJson();
  }
  if (!createdJson || typeof (createdJson as Record<string, unknown>).id !== 'string') {
    return badJson();
  }
  return { ok: true, value: toEnsured(createdJson as Record<string, unknown>) };
}

export async function postScore(
  lineItemUrl: string,
  accessToken: string,
  score: AgsScoreInput,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AgsResult<void>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const urlCheck = validateCanvasServiceUrl(lineItemUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: { kind: 'invalid-service-url', message: 'ags:invalid-service-url', retryable: false } };
  }
  const scoresUrl = `${lineItemUrl.replace(/\/$/, '')}/scores`;

  let response: Response;
  try {
    response = await fetchImpl(scoresUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': SCORE_CONTENT_TYPE },
      body: JSON.stringify({
        userId: score.userId,
        scoreGiven: score.scoreGiven,
        scoreMaximum: score.scoreMaximum,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        timestamp: score.timestamp,
      }),
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  const error = classifyResponse(response);
  if (error) return error;
  return { ok: true, value: undefined };
}
```

> `networkError`'s parameter is unused; it **must** be named `_err` to satisfy `@typescript-eslint/no-unused-vars`'s `argsIgnorePattern: '^_'` (eslint.config.js, `server/**/*.ts`). The rule IS active with `args: 'after-used'`, which flags the last (here: only) parameter when unused — reproduced with `npx eslint server/src/lti/ags.ts` during the pre-flight review.

- [ ] **Step 4: Run — expect PASS**; then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/ags.ts server/tests/lti/ags.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): add AGS line-item + score HTTP client

ensureLineItem (create-or-reuse by stable tag/resourceId, idempotent) and
postScore (Completed/FullyGraded to <lineItem>/scores). Dumb HTTP: no token
acquisition, no retry — those belong to grade-worker.ts. Error kinds split
retryable (429/5xx/network/401) from permanent (other 4xx/bad-json).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 7: `grade-sync-store.ts` — job upsert / claim / transitions / backoff / summary

**Files:**
- Create: `server/src/attendance/grade-sync-store.ts`
- Test: `server/tests/attendance/grade-sync-store.test.ts`

**Interfaces:**
- Consumes: `gradeSyncJobs` (`schema.ts`), `type GradeSyncJobRow`, `type Database`, `type Tx` (from `session-lifecycle.ts`)
- Produces: `MAX_GRADE_SYNC_ATTEMPTS`, `GRADE_SYNC_BASE_DELAY_MS`, `GRADE_SYNC_MAX_DELAY_MS`, `computeBackoff`, `upsertGradeSyncJobs`, `claimDueJobs`, `markJobSynced`, `markJobRetry`, `markJobFailed`, `GradeSyncSummary`, `getGradeSyncSummary`, `resetFailedJobs` — see the Fixed-contract block.

- [ ] **Step 1: Write the failing tests**

`server/tests/attendance/grade-sync-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { gradeSyncJobs } from '../../src/database/schema.js';
import {
  MAX_GRADE_SYNC_ATTEMPTS,
  GRADE_SYNC_BASE_DELAY_MS,
  GRADE_SYNC_MAX_DELAY_MS,
  computeBackoff,
  upsertGradeSyncJobs,
  claimDueJobs,
  markJobSynced,
  markJobRetry,
  markJobFailed,
  getGradeSyncSummary,
  resetFailedJobs,
} from '../../src/attendance/grade-sync-store.js';

const { db } = getTestDb();
const platform = new MockCanvasPlatform();
afterAll(() => closeTestDb());
beforeEach(async () => {
  await resetDb();
});

async function seedSessionAndCourse() {
  const { courseId } = await seedInstitutionAndCourse(db, platform, { agsLineitemsUrl: platform.lineItemsUrlFor('c') });
  const { attendanceSessions } = await import('../../src/database/schema.js');
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
  return { courseId, sessionId: session.id };
}

describe('computeBackoff', () => {
  const now = new Date('2026-08-28T00:00:00.000Z');
  it('grows exponentially from the 5-minute base and is capped at 1 hour', () => {
    const noJitter = () => 0.5; // 0.5 -> zero jitter (see impl: (rand*2 - 1))
    expect(computeBackoff(0, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_BASE_DELAY_MS);
    expect(computeBackoff(1, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_BASE_DELAY_MS * 2);
    expect(computeBackoff(2, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_BASE_DELAY_MS * 4);
    // 5min * 2^10 would be ~85h -> capped
    expect(computeBackoff(10, now, noJitter).getTime() - now.getTime()).toBe(GRADE_SYNC_MAX_DELAY_MS);
  });
  it('applies at most +/-20% jitter and never schedules in the past', () => {
    for (const r of [0, 1, 0.5, 0.9, 0.1]) {
      const delta = computeBackoff(1, now, () => r).getTime() - now.getTime();
      const base = GRADE_SYNC_BASE_DELAY_MS * 2;
      expect(delta).toBeGreaterThanOrEqual(base * 0.8 - 1);
      expect(delta).toBeLessThanOrEqual(base * 1.2 + 1);
      expect(delta).toBeGreaterThan(0);
    }
  });
});

describe('upsertGradeSyncJobs', () => {
  it('inserts one pending job per member, then UPDATES the same row on the next close (UNIQUE course+member)', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    const first = await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 40 }], ['u2', { scoreGiven: 100 }]]));
    expect(first).toBe(2);
    let rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(rows).toHaveLength(2);

    // simulate a prior failure on u1, then a re-close with a new score
    await markJobFailed(db, rows.find((r) => r.ltiUserId === 'u1')!.id, 'ags:client-error', new Date());
    const second = await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 55 }], ['u2', { scoreGiven: 100 }]]));
    expect(second).toBe(2);
    rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(rows).toHaveLength(2); // still 2 — upserted, not appended
    const u1 = rows.find((r) => r.ltiUserId === 'u1')!;
    expect(u1.score).toBeCloseTo(55);
    expect(u1.state).toBe('pending'); // reset from failed
    expect(u1.attemptCount).toBe(0);
    expect(u1.lastError).toBeNull();
  });

  it('accepts a transaction executor', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await db.transaction(async (tx) => {
      await upsertGradeSyncJobs(tx, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }]]));
    });
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(rows).toHaveLength(1);
  });
});

describe('claimDueJobs / markJob*', () => {
  it('claims only pending jobs whose next_attempt_at <= now, oldest first, up to the limit', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }], ['u3', { scoreGiven: 30 }]]));
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    // push u3 into the future
    await markJobRetry(db, rows.find((r) => r.ltiUserId === 'u3')!.id, 1, new Date(Date.now() + 60_000), 'ags:rate-limited', new Date());
    // mark u2 synced
    await markJobSynced(db, rows.find((r) => r.ltiUserId === 'u2')!.id, new Date());

    const due = await claimDueJobs(db, new Date(), 10);
    expect(due.map((j) => j.ltiUserId)).toEqual(['u1']);
  });
});

describe('getGradeSyncSummary', () => {
  it('reports none / pending / failed precedence and the latest failed error', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    expect(await getGradeSyncSummary(db, courseId)).toMatchObject({ state: 'none', counts: { pending: 0, synced: 0, failed: 0 } });

    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }]]));
    expect((await getGradeSyncSummary(db, courseId)).state).toBe('pending');

    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    await markJobSynced(db, rows[0].id, new Date());
    await markJobFailed(db, rows[1].id, 'ags:client-error', new Date());
    const summary = await getGradeSyncSummary(db, courseId);
    expect(summary.state).toBe('failed'); // failed outranks synced
    expect(summary.counts).toEqual({ pending: 0, synced: 1, failed: 1 });
    expect(summary.lastError).toBe('ags:client-error');
  });
});

describe('resetFailedJobs', () => {
  it('flips only failed jobs back to pending with a cleared error and attempt count', async () => {
    const { courseId, sessionId } = await seedSessionAndCourse();
    await upsertGradeSyncJobs(db, courseId, sessionId, new Map([['u1', { scoreGiven: 10 }], ['u2', { scoreGiven: 20 }]]));
    const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    await markJobFailed(db, rows[0].id, 'ags:server-error', new Date());
    await markJobSynced(db, rows[1].id, new Date());

    const count = await resetFailedJobs(db, courseId, new Date());
    expect(count).toBe(1);
    const after = await db.select().from(gradeSyncJobs).where(and(eq(gradeSyncJobs.courseId, courseId), eq(gradeSyncJobs.ltiUserId, 'u1')));
    expect(after[0]).toMatchObject({ state: 'pending', attemptCount: 0, lastError: null });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- server/tests/attendance/grade-sync-store.test.ts`

- [ ] **Step 3: Implement `server/src/attendance/grade-sync-store.ts`**

```ts
// server/src/attendance/grade-sync-store.ts
//
// The durable grade-sync outbox (spec §28). One gradeSyncJobs row per (course, member),
// UNIQUE(course_id, lti_user_id): each session close upserts the member's latest cumulative score
// and resets the row to pending. The worker (grade-worker.ts) claims due pending rows and drives
// pending -> synced / failed. Retry timing is exponential backoff with jitter (spec §28).

import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { Tx } from './session-lifecycle.js';
import { gradeSyncJobs, type GradeSyncJobRow } from '../database/schema.js';

export const MAX_GRADE_SYNC_ATTEMPTS = 6;
export const GRADE_SYNC_BASE_DELAY_MS = 5 * 60 * 1000; // spec §35.2 "Five-minute grade retry scheduling"
export const GRADE_SYNC_MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * Exponential backoff with +/-20% jitter, capped at GRADE_SYNC_MAX_DELAY_MS.
 * `rand` defaults to Math.random; jitter factor is (rand()*2 - 1) * 0.2, so rand()===0.5 => no jitter.
 */
export function computeBackoff(attemptCount: number, now: Date, rand: () => number = Math.random): Date {
  const base = Math.min(GRADE_SYNC_BASE_DELAY_MS * 2 ** attemptCount, GRADE_SYNC_MAX_DELAY_MS);
  const jitter = base * 0.2 * (rand() * 2 - 1);
  const delay = Math.max(1000, Math.round(base + jitter));
  return new Date(now.getTime() + delay);
}

export async function upsertGradeSyncJobs(
  executor: Database | Tx,
  courseId: string,
  attendanceSessionId: string,
  scores: Map<string, { scoreGiven: number }>,
): Promise<number> {
  let count = 0;
  for (const [ltiUserId, { scoreGiven }] of scores) {
    await executor
      .insert(gradeSyncJobs)
      .values({ courseId, attendanceSessionId, ltiUserId, score: scoreGiven })
      .onConflictDoUpdate({
        target: [gradeSyncJobs.courseId, gradeSyncJobs.ltiUserId],
        set: {
          score: scoreGiven,
          attendanceSessionId,
          state: 'pending',
          attemptCount: 0,
          lastError: null,
          nextAttemptAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    count += 1;
  }
  return count;
}

/**
 * Pending jobs whose next_attempt_at has passed, oldest-scheduled first.
 *
 * This is a plain SELECT, NOT a claim: it does no state transition and no `FOR UPDATE SKIP LOCKED`.
 * Running two passes concurrently would select the same rows and double-post to Canvas. The
 * single-process invariant is enforced by `npm run worker` being a one-shot entrypoint (Task 10);
 * multi-replica scheduling is a Phase 7 concern (see the Self-review note). AGS score posts are
 * idempotent-by-overwrite, so the worst case of an accidental overlap is wasted quota, not a wrong
 * grade. The name is kept as `claimDueJobs` for continuity with the Fixed contract.
 */
export function claimDueJobs(db: Database, now: Date, limit: number): Promise<GradeSyncJobRow[]> {
  return db
    .select()
    .from(gradeSyncJobs)
    .where(and(eq(gradeSyncJobs.state, 'pending'), lte(gradeSyncJobs.nextAttemptAt, now)))
    .orderBy(asc(gradeSyncJobs.nextAttemptAt))
    .limit(limit);
}

export async function markJobSynced(db: Database, jobId: string, now: Date): Promise<void> {
  await db
    .update(gradeSyncJobs)
    .set({ state: 'synced', lastError: null, updatedAt: now })
    .where(eq(gradeSyncJobs.id, jobId));
}

export async function markJobRetry(
  db: Database,
  jobId: string,
  attemptCount: number,
  nextAttemptAt: Date,
  lastError: string,
  now: Date,
): Promise<void> {
  await db
    .update(gradeSyncJobs)
    .set({ state: 'pending', attemptCount, nextAttemptAt, lastError, updatedAt: now })
    .where(eq(gradeSyncJobs.id, jobId));
}

export async function markJobFailed(db: Database, jobId: string, lastError: string, now: Date): Promise<void> {
  await db
    .update(gradeSyncJobs)
    .set({ state: 'failed', lastError, updatedAt: now })
    .where(eq(gradeSyncJobs.id, jobId));
}

export interface GradeSyncSummary {
  state: 'none' | 'synced' | 'pending' | 'failed';
  counts: { pending: number; synced: number; failed: number };
  lastError: string | null;
}

export async function getGradeSyncSummary(db: Database, courseId: string): Promise<GradeSyncSummary> {
  const rows = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
  const counts = { pending: 0, synced: 0, failed: 0 };
  let lastError: string | null = null;
  let lastErrorAt = 0;
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.state === 'failed') {
      const at = new Date(row.updatedAt).getTime();
      if (at >= lastErrorAt) {
        lastErrorAt = at;
        lastError = row.lastError ?? null;
      }
    }
  }
  const state: GradeSyncSummary['state'] =
    rows.length === 0 ? 'none' : counts.failed > 0 ? 'failed' : counts.pending > 0 ? 'pending' : 'synced';
  return { state, counts, lastError };
}

/** Re-queue every failed job for a course (spec §25.9 retry route). Returns the number reset. */
export async function resetFailedJobs(db: Database, courseId: string, now: Date): Promise<number> {
  const reset = await db
    .update(gradeSyncJobs)
    .set({ state: 'pending', attemptCount: 0, lastError: null, nextAttemptAt: now, updatedAt: now })
    .where(and(eq(gradeSyncJobs.courseId, courseId), eq(gradeSyncJobs.state, 'failed')))
    .returning({ id: gradeSyncJobs.id });
  return reset.length;
}
```

> `state` as an index into `counts` needs `row.state` to be `'pending' | 'synced' | 'failed'` — it is, because the column enum is declared that way in `schema.ts`. If TS widens it, add `counts[row.state as 'pending' | 'synced' | 'failed']`.

- [ ] **Step 4: Run — expect PASS**; then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/grade-sync-store.ts server/tests/attendance/grade-sync-store.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): add grade-sync outbox store

upsertGradeSyncJobs (UNIQUE course+member upsert), claimDueJobs, markJob{Synced,
Retry,Failed}, computeBackoff (exp + jitter, capped 1h), getGradeSyncSummary,
resetFailedJobs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 8: Extend `closeAttendanceSession` — compute + enqueue in the same transaction

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts` (`closeAttendanceSession` only — do NOT touch `createAttendanceSession` / `reopenAttendanceSession`)
- Test: `server/tests/attendance/session-lifecycle.test.ts` (append to the existing `closeAttendanceSession` describe)

**Interfaces:**
- Consumes: `DEFAULT_GRADING_POLICY` (Task 3), `computeCumulativeScores` + `SessionResolvedStatuses` (Task 4), `upsertGradeSyncJobs` (Task 7), `resolveCurrentRecord` (existing)
- Produces: no signature change — `closeAttendanceSession(db, sessionId, actorLtiUserId, requestId?): Promise<void>` still. New side effects: `grade_sync_jobs` rows upserted + one `grade_sync_requested` audit row, all inside the existing `db.transaction`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('closeAttendanceSession', ...)` in `server/tests/attendance/session-lifecycle.test.ts`. The file already imports `getRosterWithFallback` mock, `attendanceRecords`, `auditEvents`, `eq`, `seedInstitutionAndCourse`, and the `member()` helper. **Add** `gradeSyncJobs`, `courseMembers` to the `schema.js` import, `and` (and `inArray` if not present) to the `drizzle-orm` import, and `reopenAttendanceSession` is already imported (`session-lifecycle.test.ts:6`).

> **N1 ruling (2026-08-28):** the grade population is the course's **current roster** — `course_members` filtered to eligible — NOT the just-closed session's snapshot. In this test file `getRosterWithFallback` is mocked, so `createAttendanceSession` does NOT populate `course_members` (that write lives inside the real `getRosterWithFallback` → `refreshCourseRoster` → `upsertCourseMembers`). Each test therefore seeds `course_members` explicitly. Keep the `getRosterWithFallback` mock too — the snapshot it produces still drives `system_absence` marking at close.

Add this local helper at the top of the `describe('closeAttendanceSession', ...)` block:

```ts
// The N1 grade population reads course_members directly; seed it to match the mocked roster.
async function seedCourseMembers(courseId: string, ms: ReturnType<typeof member>[]) {
  await db.insert(courseMembers).values(
    ms.map((m) => ({
      courseId,
      ltiUserId: m.ltiUserId,
      institutionalId: m.institutionalId,
      displayName: m.displayName,
      givenName: m.givenName,
      familyName: m.familyName,
      email: m.email,
      roles: m.roles,
      status: m.status, // 'Active' -> eligible for a Learner; 'Inactive' -> not
    })),
  );
}
```

```ts
it('enqueues one pending grade_sync_job per eligible current-roster member and writes a grade_sync_requested audit row', async () => {
  const { courseId } = await seedInstitutionAndCourse(db, platform);
  const members = [
    member({ ltiUserId: 'u-present', institutionalId: '111' }),
    member({ ltiUserId: 'u-absent', institutionalId: '222' }),
    member({ ltiUserId: 'u-inelig', institutionalId: '333', eligibleForAttendance: false, status: 'Inactive' }),
  ];
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
  await seedCourseMembers(courseId, members);
  const session = await createAttendanceSession(db, courseId, 'i1', {}, 'req-open', { signingKey });

  // u-present scans present; u-absent never scans -> close marks them system_absence.
  await db.insert(attendanceRecords).values({
    attendanceSessionId: session.id, ltiUserId: 'u-present', institutionalId: '111',
    clientScanId: 's1', status: 'present', source: 'card', scannedAt: new Date(),
  });

  await closeAttendanceSession(db, session.id, 'i1', 'req-close');

  const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
  const byUser = new Map(jobs.map((j) => [j.ltiUserId, j]));
  expect(byUser.get('u-present')).toMatchObject({ state: 'pending', attemptCount: 0 });
  expect(byUser.get('u-present')!.score).toBeCloseTo(100);
  expect(byUser.get('u-absent')!.score).toBeCloseTo(0);
  expect(byUser.has('u-inelig')).toBe(false); // Inactive -> isEligibleForAttendance false -> not graded
  expect(byUser.get('u-present')!.attendanceSessionId).toBe(session.id);

  const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'));
  expect(audit).toMatchObject({ targetType: 'attendance_session', targetId: session.id, actorLtiUserId: 'i1', requestId: 'req-close' });
  expect(audit.newValue).toMatchObject({ jobCount: 2, closedSessionCount: 1 });
  expect(audit.institutionId).not.toBeNull();
});

it('recomputes cumulatively and UPDATES the same job rows when a second session in the course closes', async () => {
  const { courseId } = await seedInstitutionAndCourse(db, platform);
  const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
  await seedCourseMembers(courseId, members);

  // Session A: present -> 100
  const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
  await db.insert(attendanceRecords).values({ attendanceSessionId: a.id, ltiUserId: 'u1', institutionalId: '111', clientScanId: 'a1', status: 'present', source: 'card', scannedAt: new Date() });
  await closeAttendanceSession(db, a.id, 'i1', 'ra');

  // Session B: absent (system_absence at close) -> cumulative 1/2 -> 50
  const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
  await closeAttendanceSession(db, b.id, 'i1', 'rb');

  const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
  expect(jobs).toHaveLength(1); // upserted, not appended
  expect(jobs[0].score).toBeCloseTo(50);
  expect(jobs[0].state).toBe('pending');
  expect(jobs[0].attendanceSessionId).toBe(b.id); // stamped with the latest triggering session
});

it('excludes a reopened session from the cumulative denominator (spec §25.8, 2026-08-28 ruling)', async () => {
  const { courseId } = await seedInstitutionAndCourse(db, platform);
  const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
  await seedCourseMembers(courseId, members);

  // Session A: absent -> would drag the average to 1/2 = 50 if it were still counted.
  const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
  await closeAttendanceSession(db, a.id, 'i1', 'ra');
  await reopenAttendanceSession(db, a.id, 'i1', 'correcting', 'rr'); // A is now 'reopened'

  // Session B: present. Only B is 'closed', so the score is 1/1 -> 100.
  const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
  await db.insert(attendanceRecords).values({
    attendanceSessionId: b.id, ltiUserId: 'u1', institutionalId: '111',
    clientScanId: 'b1', status: 'present', source: 'card', scannedAt: new Date(),
  });
  await closeAttendanceSession(db, b.id, 'i1', 'rb');

  const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
  expect(jobs).toHaveLength(1);
  expect(jobs[0].score).toBeCloseTo(100);
  const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested')).orderBy(auditEvents.id);
  expect(audit).toBeTruthy();
});

it('enqueues no jobs (but still audits) when the current roster has no eligible members', async () => {
  const { courseId } = await seedInstitutionAndCourse(db, platform);
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
  // no seedCourseMembers -> course_members is empty
  const session = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });

  await closeAttendanceSession(db, session.id, 'i1', 'rc');

  expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId))).toHaveLength(0);
  const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'));
  expect(audit.newValue).toMatchObject({ jobCount: 0 });
});
```

> `reopenAttendanceSession`'s signature in the shipped file is `reopenAttendanceSession(db, sessionId, actorLtiUserId, reason, requestId?)` — confirm the arg order against `session-lifecycle.ts` when writing the reopened-exclusion test and adjust the call if it differs.

- [ ] **Step 2: Run — expect FAIL** (no `grade_sync_requested` audit row, no jobs)

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts`

- [ ] **Step 3: Extend `closeAttendanceSession`**

Add imports to `session-lifecycle.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm'; // add `and` + `inArray` to the existing `eq` import
import { DEFAULT_GRADING_POLICY } from './grade-policy.js';
import { computeCumulativeScores, type SessionResolvedStatuses } from './grade-calc.js';
import { upsertGradeSyncJobs } from './grade-sync-store.js';
import { getCachedRosterAsMembers } from './roster-store.js'; // `roster-store.js` is already imported for `getRosterWithFallback`
```

> Cycle note: `grade-sync-store.ts` does `import type { Tx } from './session-lifecycle.js'` — type-only, erased at compile (verified in the pre-flight review by importing both modules in both orders under `tsx`), so this value import from `session-lifecycle.ts` into `grade-sync-store.ts` is one-directional at runtime. Keep `import type` in `grade-sync-store.ts`.

Inside `closeAttendanceSession`'s `db.transaction` callback, **after** the existing `await tx.insert(auditEvents).values({ ... eventType: 'attendance_session_closed' ... })`, append:

```ts
    // --- Phase 6: cumulative grade calculation + durable grade-sync enqueue (spec §25.7 steps 3-4,
    //     §28 steps 2-3). NO Canvas call here — only the outbox is written, inside this same txn. ---

    // Population: the course's CURRENT roster (2026-08-28 ruling on pre-flight note N1). course_members
    // is genuinely current — every createAttendanceSession refreshes it via getRosterWithFallback ->
    // refreshCourseRoster -> upsertCourseMembers. getCachedRosterAsMembers computes eligibleForAttendance
    // per institution config, the same converter every cache read uses. Read via the outer `db`, not
    // `tx`: course_members / institutions / courses are not mutated in this transaction, so there is no
    // consistency concern, and getCachedRosterAsMembers is typed `db: Database` (not `Database | Tx`).
    const currentRoster = await getCachedRosterAsMembers(db, session.courseId);
    const eligibleLtiUserIds = (currentRoster?.members ?? [])
      .filter((m) => m.eligibleForAttendance)
      .map((m) => m.ltiUserId);

    // Every CLOSED session in the course (this one is already 'closed' within this txn). 'reopened'
    // sessions are deliberately excluded — they are mid-correction.
    const closedSessions = await tx
      .select({ id: attendanceSessions.id })
      .from(attendanceSessions)
      .where(and(eq(attendanceSessions.courseId, session.courseId), eq(attendanceSessions.state, 'closed')));
    const closedSessionIds = closedSessions.map((s) => s.id);

    const allRecords = closedSessionIds.length
      ? await tx.select().from(attendanceRecords).where(inArray(attendanceRecords.attendanceSessionId, closedSessionIds))
      : [];

    const resolvedBySession: SessionResolvedStatuses[] = closedSessionIds.map((closedId) => {
      const perUser = new Map<string, typeof allRecords>();
      for (const rec of allRecords) {
        if (rec.attendanceSessionId !== closedId || !rec.ltiUserId) continue;
        const list = perUser.get(rec.ltiUserId) ?? [];
        list.push(rec);
        perUser.set(rec.ltiUserId, list);
      }
      const statusByLtiUserId = new Map<string, 'present' | 'absent' | 'excused'>();
      for (const [ltiUserId, recs] of perUser) {
        const current = resolveCurrentRecord(recs);
        if (current && (current.status === 'present' || current.status === 'absent' || current.status === 'excused')) {
          statusByLtiUserId.set(ltiUserId, current.status);
        }
        // lookup_error / unexpected -> not gradeable (spec §24); left out of the map.
      }
      return { sessionId: closedId, statusByLtiUserId };
    });

    const scores = computeCumulativeScores(resolvedBySession, eligibleLtiUserIds, DEFAULT_GRADING_POLICY);
    const jobCount = await upsertGradeSyncJobs(
      tx,
      session.courseId,
      sessionId,
      new Map([...scores].map(([ltiUserId, s]) => [ltiUserId, { scoreGiven: s.scoreGiven }])),
    );

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'grade_sync_requested',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { jobCount, closedSessionCount: closedSessionIds.length, eligibleMemberCount: eligibleLtiUserIds.length },
      requestId: requestId ?? null,
    });
```

> `session-lifecycle.ts` currently imports only `eq` from `drizzle-orm` — widen to `import { and, eq, inArray } from 'drizzle-orm';`.
> `session`, `course`, and `members` are already in scope in `closeAttendanceSession` (loaded earlier for absent-marking + institutionId). `resolveCurrentRecord` is already imported. The Phase 6 block no longer uses `members` for the grade population (that now comes from `getCachedRosterAsMembers`) — `members` is still used by the pre-existing absent-marking code above, so leave it.

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts` — expected: PASS (new + existing close/reopen/create tests).
Run: `npm test` — expected: full suite green.
Run: `npm run lint && npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): compute cumulative scores and enqueue grade-sync jobs on close

closeAttendanceSession now folds every closed session's resolved per-member
status into a cumulative score, upserts one grade_sync_job per eligible member,
and writes a grade_sync_requested audit row — all inside the existing close
transaction (spec §28 step 3). No Canvas call.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 9: `grade-worker.ts` — `processGradeSyncJobs` orchestrator

**Files:**
- Create: `server/src/attendance/grade-worker.ts`
- Test: `server/tests/attendance/grade-worker.test.ts`

**Interfaces:**
- Consumes: `claimDueJobs`, `markJobSynced`, `markJobRetry`, `markJobFailed`, `computeBackoff`, `MAX_GRADE_SYNC_ATTEMPTS` (Task 7); `ensureLineItem`, `postScore` (Task 6); `getAccessToken`, `clearAccessTokenCache` (`token-client.ts`); `AGS_LINEITEM_SCOPE`, `AGS_SCORE_SCOPE` (Task 2); `validateCanvasServiceUrl` (`service-url.ts`); `gradeLineItems`, `auditEvents`, `courses`, `institutions`, `ltiDeployments`, `ltiRegistrations` (`schema.ts`)
- Produces: `ProcessGradeSyncJobsDeps`, `ProcessGradeSyncJobsResult`, `processGradeSyncJobs(db, deps)` — see the Fixed-contract block.

> The score-only one-shot injector `failNextScorePost(kind)` was added to `MockCanvasPlatform` in **Task 5 Step 3** (moved there so `mock-canvas.ts` is touched by exactly one Phase 6 commit). It is already available here — no mock changes in this task.

- [ ] **Step 1: Write the failing tests**

`server/tests/attendance/grade-worker.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { getActiveSigningKey, loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { gradeSyncJobs, gradeLineItems, auditEvents } from '../../src/database/schema.js';
import { processGradeSyncJobs } from '../../src/attendance/grade-worker.js';

const { db } = getTestDb();
let platform: MockCanvasPlatform;
let signingKey: ToolSigningKey;
afterAll(() => closeTestDb());

beforeAll(async () => {
  platform = new MockCanvasPlatform();
  await platform.start();
  signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
});
beforeEach(async () => {
  await resetDb();
});

// A unique mock course key per test keeps the mock's per-course line-item/score maps isolated.
let agsKey = 0;
async function seedCourseWithAgs(opts: { withUrl?: boolean } = {}) {
  const key = `gw-${agsKey++}`;
  const { courseId } = await seedInstitutionAndCourse(db, platform, {
    agsLineitemsUrl: opts.withUrl === false ? null : platform.lineItemsUrlFor(key),
  });
  return { courseId, key };
}
// NOTE: any test that injects a fixed `now` into processGradeSyncJobs MUST also pass an explicit
// past `nextAttemptAt` here — the column otherwise defaults to DB `now()` (real wall clock), and
// claimDueJobs's `lte(nextAttemptAt, injectedNow)` would then never claim the row. Tests that let
// `now` default to `new Date()` are safe because that is always after the insert.
async function insertJob(courseId: string, over: Partial<typeof gradeSyncJobs.$inferInsert>) {
  const [row] = await db.insert(gradeSyncJobs).values({ courseId, ltiUserId: 'u1', score: 100, ...over }).returning();
  return row;
}

describe('processGradeSyncJobs', () => {
  it('posts every due job, ensures the line item once, marks jobs synced, and audits grade_sync_completed', async () => {
    const { courseId, key } = await seedCourseWithAgs();
    await insertJob(courseId, { ltiUserId: 'u1', score: 100 });
    await insertJob(courseId, { ltiUserId: 'u2', score: 0 });

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ processed: 2, synced: 2, retried: 0, failed: 0 });
    const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(jobs.every((j) => j.state === 'synced')).toBe(true);

    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li.resourceId).toBe('attendance-cumulative-v1');
    expect(platform.getLineItems(key)).toHaveLength(1);

    const posted = platform.getPostedScores(key);
    expect(posted).toHaveLength(2);
    expect(posted.map((p) => p.scoreGiven).sort()).toEqual([0, 100]);
    expect(posted[0]).toMatchObject({ scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded' });

    const completed = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_completed'));
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({ targetType: 'grade_sync_job', actorLtiUserId: null, requestId: null });
  });

  it('reuses an existing Canvas line item instead of creating a second', async () => {
    const { courseId, key } = await seedCourseWithAgs();
    platform.seedExistingLineItem(key);
    await insertJob(courseId, { ltiUserId: 'u1', score: 50 });

    await processGradeSyncJobs(db, { signingKey });

    expect(platform.getLineItems(key)).toHaveLength(1); // no new line item
    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li).toBeTruthy();
  });

  it('a 429 on the score post schedules a retry (pending, attempt+1, future next_attempt_at) — no failure audit', async () => {
    const { courseId } = await seedCourseWithAgs();
    const now = new Date('2026-08-28T00:00:00.000Z');
    // next_attempt_at must be <= the injected `now`, or claimDueJobs skips the row (see insertJob note).
    const job = await insertJob(courseId, {
      ltiUserId: 'u1', score: 100, attemptCount: 0,
      nextAttemptAt: new Date(now.getTime() - 60_000),
    });
    platform.failNextScorePost('rate-limited');

    const result = await processGradeSyncJobs(db, { signingKey, now: () => now, rand: () => 0.5 });

    expect(result).toMatchObject({ processed: 1, synced: 0, retried: 1, failed: 0 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after.state).toBe('pending');
    expect(after.attemptCount).toBe(1);
    // First retry: computeBackoff is called with the PRE-increment attemptCount (0), so the delay
    // is GRADE_SYNC_BASE_DELAY_MS (5 min) — strictly after the injected now.
    expect(new Date(after.nextAttemptAt).getTime()).toBeGreaterThan(now.getTime());
    expect(after.lastError).toBe('ags:rate-limited');
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_failed'))).toHaveLength(0);
  });

  it('re-mints the AGS token once when Canvas 401s the line-items request, then succeeds', async () => {
    const { courseId, key } = await seedCourseWithAgs();
    await insertJob(courseId, { ltiUserId: 'u1', score: 100 });

    // Arm a one-shot 401 on the NEXT AGS request (the ensureLineItem GET). The worker must catch it,
    // clearAccessTokenCache + re-mint once (mirroring nrps.ts:297-300), retry ensureLineItem — which
    // now passes, one-shot consumed — and complete the score post. It must NOT fail the job.
    platform.failNextAgsRequest('auth'); // Task 5 extends failNextAgsRequest's union with 'auth' -> one-shot 401

    const result = await processGradeSyncJobs(db, { signingKey });
    expect(result).toMatchObject({ synced: 1, retried: 0, failed: 0 });
    expect(platform.getPostedScores(key)).toHaveLength(1);
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(after.state).toBe('synced');
  });

  it('a permanent 4xx on the score post fails the job immediately and audits grade_sync_failed', async () => {
    const { courseId } = await seedCourseWithAgs();
    const job = await insertJob(courseId, { ltiUserId: 'u1', score: 100 });
    platform.failNextScorePost('client-error');

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ synced: 0, retried: 0, failed: 1 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after.state).toBe('failed');
    expect(after.lastError).toBe('ags:client-error');
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_failed'));
    expect(audit).toMatchObject({ targetType: 'grade_sync_job', targetId: job.id });
    expect(audit.newValue).toMatchObject({ ltiUserId: 'u1', error: 'ags:client-error' });
  });

  it('a retryable failure at the attempt ceiling terminally fails the job', async () => {
    const { courseId } = await seedCourseWithAgs();
    const job = await insertJob(courseId, { ltiUserId: 'u1', score: 100, attemptCount: 5 }); // MAX is 6
    platform.failNextScorePost('server-error');

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ failed: 1, retried: 0 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after.state).toBe('failed');
  });

  it('fails a course whose ags_lineitems_url is missing, with ags:no-lineitems-url', async () => {
    const { courseId } = await seedCourseWithAgs({ withUrl: false });
    const job = await insertJob(courseId, { ltiUserId: 'u1', score: 100 });

    const result = await processGradeSyncJobs(db, { signingKey });

    expect(result).toMatchObject({ failed: 1 });
    const [after] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.id, job.id));
    expect(after).toMatchObject({ state: 'failed', lastError: 'ags:no-lineitems-url' });
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_failed'))).toHaveLength(1);
  });

  it('does not claim a job whose next_attempt_at is in the future', async () => {
    const { courseId } = await seedCourseWithAgs();
    await insertJob(courseId, { ltiUserId: 'u1', score: 100, nextAttemptAt: new Date(Date.now() + 3_600_000) });

    const result = await processGradeSyncJobs(db, { signingKey });
    expect(result).toMatchObject({ processed: 0, synced: 0 });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`../../src/attendance/grade-worker.js` missing)

Run: `npm test -- server/tests/attendance/grade-worker.test.ts`

- [ ] **Step 3: Implement `server/src/attendance/grade-worker.ts`**

```ts
// server/src/attendance/grade-worker.ts
//
// The retry worker's one pass (spec §28, §35.2). Claims due pending grade_sync_jobs, and for each
// course: acquires ONE AGS token, ensures the cumulative line item ONCE, then posts each member's
// score SEQUENTIALLY (spec §28 "mostly sequential ... to avoid throttling"). Retryable failures
// (429 / 5xx / network / 401) are rescheduled with exponential-backoff-with-jitter up to
// MAX_GRADE_SYNC_ATTEMPTS, then terminally failed; permanent 4xx / bad-json fail immediately
// (spec §28 "Do not automatically retry permanent 4xx"). Every terminal outcome writes an audit row.
//
// This module is invoked by server/src/worker.ts (a standalone entrypoint) — it is NOT wired into
// the Fastify web process.

import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import {
  auditEvents,
  courses,
  gradeLineItems,
  institutions,
  ltiDeployments,
  ltiRegistrations,
  type GradeSyncJobRow,
} from '../database/schema.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import { AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE } from '../lti/scopes.js';
import { getAccessToken, clearAccessTokenCache } from '../lti/token-client.js';
import { validateCanvasServiceUrl } from '../lti/service-url.js';
import { ensureLineItem, postScore, ATTENDANCE_SCORE_MAXIMUM } from '../lti/ags.js';
import {
  claimDueJobs,
  computeBackoff,
  markJobFailed,
  markJobRetry,
  markJobSynced,
  MAX_GRADE_SYNC_ATTEMPTS,
} from './grade-sync-store.js';

export interface ProcessGradeSyncJobsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxJobs?: number;
  rand?: () => number;
}

export interface ProcessGradeSyncJobsResult {
  processed: number;
  synced: number;
  retried: number;
  failed: number;
}

interface CourseAgsContext {
  courseId: string;
  institutionId: string;
  agsLineitemsUrl: string | null;
  registration: { id: string; clientId: string; tokenEndpoint: string; tokenAudience: string };
}

async function loadCourseAgsContext(db: Database, courseId: string): Promise<CourseAgsContext | null> {
  const rows = await db
    .select({
      courseId: courses.id,
      institutionId: courses.institutionId,
      agsLineitemsUrl: courses.agsLineitemsUrl,
      registrationId: ltiRegistrations.id,
      registrationClientId: ltiRegistrations.clientId,
      registrationTokenEndpoint: ltiRegistrations.tokenEndpoint,
      registrationTokenAudience: ltiRegistrations.tokenAudience,
    })
    .from(courses)
    .innerJoin(institutions, eq(courses.institutionId, institutions.id))
    .innerJoin(ltiDeployments, eq(courses.deploymentId, ltiDeployments.id))
    .innerJoin(ltiRegistrations, eq(ltiDeployments.registrationId, ltiRegistrations.id))
    .where(eq(courses.id, courseId));

  const row = rows[0];
  if (!row) return null;
  return {
    courseId: row.courseId,
    institutionId: row.institutionId,
    agsLineitemsUrl: row.agsLineitemsUrl,
    registration: {
      id: row.registrationId,
      clientId: row.registrationClientId,
      tokenEndpoint: row.registrationTokenEndpoint,
      tokenAudience: row.registrationTokenAudience,
    },
  };
}

export async function processGradeSyncJobs(
  db: Database,
  deps: ProcessGradeSyncJobsDeps,
): Promise<ProcessGradeSyncJobsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const rand = deps.rand ?? Math.random;
  const result: ProcessGradeSyncJobsResult = { processed: 0, synced: 0, retried: 0, failed: 0 };

  const due = await claimDueJobs(db, now, deps.maxJobs ?? 50);
  if (due.length === 0) return result;

  const byCourse = new Map<string, GradeSyncJobRow[]>();
  for (const job of due) {
    const list = byCourse.get(job.courseId) ?? [];
    list.push(job);
    byCourse.set(job.courseId, list);
  }

  async function writeAudit(
    eventType: 'grade_sync_completed' | 'grade_sync_failed',
    ctx: CourseAgsContext,
    job: GradeSyncJobRow,
    newValue: Record<string, unknown>,
  ): Promise<void> {
    await db.insert(auditEvents).values({
      institutionId: ctx.institutionId,
      courseId: ctx.courseId,
      attendanceSessionId: job.attendanceSessionId,
      actorLtiUserId: null,
      eventType,
      targetType: 'grade_sync_job',
      targetId: job.id,
      newValue,
      requestId: null,
    });
  }

  // Retryable failure of `job`: reschedule with backoff, or terminally fail at the attempt ceiling.
  async function scheduleRetryOrFail(ctx: CourseAgsContext, job: GradeSyncJobRow, errorCode: string): Promise<void> {
    const attemptCount = job.attemptCount + 1; // stored on the row + audit
    if (attemptCount >= MAX_GRADE_SYNC_ATTEMPTS) {
      await markJobFailed(db, job.id, errorCode, now);
      await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, attemptCount, error: errorCode });
      result.failed += 1;
    } else {
      // computeBackoff gets the PRE-increment count (2026-08-28 ruling on pre-flight note N2): a job
      // that has never been retried (job.attemptCount === 0) waits GRADE_SYNC_BASE_DELAY_MS = 5 min
      // (spec §35.2), then 10, 20, 40, 60, 60.
      await markJobRetry(db, job.id, attemptCount, computeBackoff(job.attemptCount, now, rand), errorCode, now);
      result.retried += 1;
    }
  }

  const AGS_SCOPES = [AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE];

  for (const [courseId, courseJobs] of byCourse) {
    const ctx = await loadCourseAgsContext(db, courseId);

    // Q3: distinguish "no URL was ever persisted" from "a malformed URL was persisted at launch" —
    // an operator chases these two differently. Both are terminal (never retried).
    const failCourse = async (code: string) => {
      for (const job of courseJobs) {
        result.processed += 1;
        await markJobFailed(db, job.id, code, now);
        if (ctx) await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, error: code });
        result.failed += 1;
      }
    };
    if (!ctx || !ctx.agsLineitemsUrl) {
      await failCourse('ags:no-lineitems-url');
      continue;
    }
    if (!validateCanvasServiceUrl(ctx.agsLineitemsUrl).ok) {
      await failCourse('ags:invalid-service-url');
      continue;
    }
    const agsLineitemsUrl = ctx.agsLineitemsUrl; // narrowed to string

    const registration = {
      id: ctx.registration.id,
      clientId: ctx.registration.clientId,
      tokenEndpoint: ctx.registration.tokenEndpoint,
      tokenAudience: ctx.registration.tokenAudience,
    };
    const mintToken = () =>
      getAccessToken(registration, AGS_SCOPES, { signingKey: deps.signingKey, fetchImpl });

    // One AGS token per course per pass (token-client caches it process-wide anyway).
    let token: string;
    try {
      token = await mintToken();
    } catch {
      for (const job of courseJobs) {
        result.processed += 1;
        await scheduleRetryOrFail(ctx, job, 'ags:token');
      }
      continue;
    }

    // B3: a 401 means our cached token was revoked/rotated. Drop it and re-mint ONCE per course per
    // pass, mirroring nrps.ts:297-300. Without this the process-global cache (token-client.ts) hands
    // the same dead token to every retry for up to an hour and walks the whole course to the ceiling.
    let authRetried = false;
    const remintOnce = async (): Promise<boolean> => {
      if (authRetried) return false;
      authRetried = true;
      clearAccessTokenCache(registration.id, AGS_SCOPES);
      try {
        token = await mintToken();
        return true;
      } catch {
        return false;
      }
    };

    // One ensureLineItem per course per pass (retried once on a 401).
    let li = await ensureLineItem(agsLineitemsUrl, token, { fetchImpl });
    if (!li.ok && li.error.kind === 'auth' && (await remintOnce())) {
      li = await ensureLineItem(agsLineitemsUrl, token, { fetchImpl });
    }
    if (!li.ok) {
      for (const job of courseJobs) {
        result.processed += 1;
        if (li.error.retryable) await scheduleRetryOrFail(ctx, job, li.error.message);
        else {
          await markJobFailed(db, job.id, li.error.message, now);
          await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, error: li.error.message });
          result.failed += 1;
        }
      }
      continue;
    }

    await db
      .insert(gradeLineItems)
      .values({
        courseId,
        canvasLineItemId: li.value.canvasLineItemId,
        canvasLineItemUrl: li.value.canvasLineItemUrl,
        resourceId: li.value.resourceId,
        tag: li.value.tag,
        scoreMaximum: li.value.scoreMaximum,
      })
      .onConflictDoUpdate({
        target: gradeLineItems.courseId,
        set: {
          canvasLineItemId: li.value.canvasLineItemId,
          canvasLineItemUrl: li.value.canvasLineItemUrl,
          resourceId: li.value.resourceId,
          tag: li.value.tag,
          scoreMaximum: li.value.scoreMaximum,
          updatedAt: now,
        },
      });

    // Scores: strictly sequential per course (spec §28).
    const lineItemUrl = li.value.canvasLineItemUrl;
    for (const job of courseJobs) {
      result.processed += 1;
      const scorePayload = {
        userId: job.ltiUserId,
        scoreGiven: job.score,
        scoreMaximum: ATTENDANCE_SCORE_MAXIMUM,
        timestamp: now.toISOString(),
      };
      let post = await postScore(lineItemUrl, token, scorePayload, { fetchImpl });
      if (!post.ok && post.error.kind === 'auth' && (await remintOnce())) {
        post = await postScore(lineItemUrl, token, scorePayload, { fetchImpl });
      }
      if (post.ok) {
        await markJobSynced(db, job.id, now);
        await writeAudit('grade_sync_completed', ctx, job, { ltiUserId: job.ltiUserId, score: job.score });
        result.synced += 1;
      } else if (post.error.retryable) {
        await scheduleRetryOrFail(ctx, job, post.error.message);
      } else {
        await markJobFailed(db, job.id, post.error.message, now);
        await writeAudit('grade_sync_failed', ctx, job, { ltiUserId: job.ltiUserId, error: post.error.message });
        result.failed += 1;
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run — expect PASS** (`npm test -- server/tests/attendance/grade-worker.test.ts`), then `npm test`, then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/grade-worker.ts server/tests/attendance/grade-worker.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): add grade-sync retry worker

processGradeSyncJobs claims due jobs, acquires one AGS token per course,
ensures the cumulative line item once, posts scores sequentially, and applies
exponential-backoff-with-jitter retry / terminal-failure transitions with
grade_sync_completed / grade_sync_failed audit rows.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 10: `server/src/worker.ts` entrypoint + `npm run worker`

**Files:**
- Create: `server/src/worker.ts`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `loadEnv` (`config/env.js`), `createDbClient` / `applyMigrations` (`database/client.js`), `loadSigningKeysFromEnv` / `getActiveSigningKey` (`lti/signing-keys.js`), `processGradeSyncJobs` (Task 9)
- Produces: a runnable one-pass worker process. **No automated test** — this is a thin top-level-`await` entrypoint that mirrors `server/src/index.ts` (which likewise has no integration test; the testable-entrypoint extraction is deferred to Phase 7, whole-branch follow-up #8). All logic is covered by Task 9. The controller reviews this diff inline.

- [ ] **Step 1: Create `server/src/worker.ts`**

```ts
// server/src/worker.ts
//
// The attendance-grade-worker process (spec §35.2). Runs ONE grade-sync pass and exits — a
// scheduler (Phase 7) invokes it about every five minutes (spec §35.2 "Five-minute grade retry
// scheduling is sufficient"). Deploys as the same image as the web server with a different command.
// Deliberately NOT wired into the Fastify process (2026-08-28 user ruling).
//
// Like server/src/index.ts this is an unwrapped top-level-await entrypoint. Phase 7 decides whether
// the web or the worker owns `applyMigrations` at deploy time; for local `npm run worker` the worker
// applies pending migrations so a fresh DB works out of the box. No automated test — the
// testable `runWorkerOnce()` extraction is whole-branch follow-up #8 (Phase 7); all worker logic is
// covered by Task 9's suite and Task 13's integration test.

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeysFromEnv, getActiveSigningKey } from './lti/signing-keys.js';
import { processGradeSyncJobs } from './attendance/grade-worker.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
await applyMigrations(dbClient);
const { db, pool } = dbClient;

const signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON));

try {
  const result = await processGradeSyncJobs(db, { signingKey });
  // Tally only — no member ids, scores, tokens, or URLs (spec §31.8).
  console.log(`[grade-worker] ${JSON.stringify(result)}`);
} catch (err) {
  // Server-side log only; never reaches a client. Every Canvas error is captured as an opaque code
  // inside processGradeSyncJobs, so anything caught here is a DB/config fault — log the message only,
  // not the error object, to stay clear of spec §31.8 (no tokens, no service URLs).
  console.error('[grade-worker] pass failed', err instanceof Error ? err.message : 'unknown error');
  await pool.end();
  process.exit(1);
}

await pool.end();
process.exit(0);
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, add after `"dev"`:

```json
    "worker": "tsx server/src/worker.ts",
```

- [ ] **Step 3: Smoke it manually**

Run (Postgres up): `npm run worker`
Expected: prints `[grade-worker] {"processed":0,"synced":0,"retried":0,"failed":0}` against an empty outbox and exits 0.

- [ ] **Step 4: Verify the suite + toolchain unaffected**

Run: `npm test` — expected: unchanged count, green (no new test file).
Run: `npm run lint && npm run typecheck` — clean (the entrypoint is under `server/**/*.ts`, so it IS type-checked and linted).

- [ ] **Step 5: Commit**

```bash
git add server/src/worker.ts package.json
git commit -m "$(cat <<'EOF'
feat(phase6): add standalone grade-sync worker entrypoint

server/src/worker.ts runs one processGradeSyncJobs pass and exits; `npm run
worker` runs it locally. Not wired into the Fastify process (spec §35.2).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 11: routes — `gradeSync` summary on `GET :id` + `POST :id/grade-sync` retry

**Files:**
- Modify: `server/src/routes/attendance-sessions.ts`
- Test: `server/tests/routes/attendance-sessions.test.ts` (append)

**Interfaces:**
- Consumes: `getGradeSyncSummary`, `resetFailedJobs` (Task 7)
- Produces: `GET /api/attendance-sessions/:id` response gains `gradeSync: GradeSyncSummary`; new `POST /api/attendance-sessions/:id/grade-sync` → `{ ok: true, retried: number }` (spec §25.9). No new error code.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/routes/attendance-sessions.test.ts` (add `gradeSyncJobs` to the `schema.js` import):

```ts
describe('grade-sync', () => {
  it('GET :id includes a gradeSync summary (state "none" when no jobs exist)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open' }).returning();

    const res = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${session.id}`, headers: CSRF });
    expect(res.statusCode).toBe(200);
    expect(res.json().gradeSync).toMatchObject({ state: 'none', counts: { pending: 0, synced: 0, failed: 0 } });
  });

  it('POST :id/grade-sync re-queues the course\'s failed jobs and audits grade_sync_requested', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    await db.insert(gradeSyncJobs).values([
      { courseId, ltiUserId: 'u1', score: 50, state: 'failed', lastError: 'ags:server-error', attemptCount: 6 },
      { courseId, ltiUserId: 'u2', score: 100, state: 'synced' },
    ]);

    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/grade-sync`, headers: CSRF });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, retried: 1 });

    const [u1] = await db.select().from(gradeSyncJobs).where(and(eq(gradeSyncJobs.courseId, courseId), eq(gradeSyncJobs.ltiUserId, 'u1')));
    expect(u1).toMatchObject({ state: 'pending', attemptCount: 0, lastError: null });
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'));
    expect(audit).toMatchObject({ targetType: 'attendance_session', targetId: session.id, actorLtiUserId: 'instructor-1' });
    expect(audit.newValue).toMatchObject({ retriedJobCount: 1, trigger: 'manual' });
  });

  it('POST :id/grade-sync without a CSRF token is 403', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/grade-sync` });
    expect(res.statusCode).toBe(403);
  });

  it('POST :id/grade-sync for a session in another course is 404 (never 403)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const other = await seedInstitutionAndCourse(db, platform, { clientId: 'other-client-id' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [foreign] = await db.insert(attendanceSessions).values({ courseId: other.courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${foreign.id}/grade-sync`, headers: CSRF });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm test -- server/tests/routes/attendance-sessions.test.ts`

- [ ] **Step 3: Wire the route + summary**

In `server/src/routes/attendance-sessions.ts`:

Add the import:

```ts
import { getGradeSyncSummary, resetFailedJobs } from '../attendance/grade-sync-store.js';
```

In the `GET /api/attendance-sessions/:id` handler, **append one property** to the existing return object (leave its shape and its `// B3:` comment above `unmatchedRecords` untouched — do NOT paste a full replacement object):

```ts
      // Phase 6: cumulative grade-sync status for this session's course (spec §28 UI states).
      // Use `row.courseId` — the session row being served; `loadSessionScopedToCourse` already
      // tenant-scoped it, so it equals the session's course.
      gradeSync: await getGradeSyncSummary(db, row.courseId),
```

Add the retry route next to `close` / `reopen` (spec §25.9):

```ts
  app.post('/api/attendance-sessions/:id/grade-sync', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });

    const retried = await resetFailedJobs(db, row.courseId, new Date());
    const [course] = await db.select().from(courses).where(eq(courses.id, row.courseId));
    await db.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: row.courseId,
      attendanceSessionId: id,
      actorLtiUserId: session.ltiSubject,
      eventType: 'grade_sync_requested',
      targetType: 'attendance_session',
      targetId: id,
      newValue: { retriedJobCount: retried, trigger: 'manual' },
      requestId: request.id,
    });
    return { ok: true, retried };
  });
```

- [ ] **Step 4: Run — expect PASS** (`npm test -- server/tests/routes/attendance-sessions.test.ts`), then `npm test`, then `npm run lint && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/attendance-sessions.ts server/tests/routes/attendance-sessions.test.ts
git commit -m "$(cat <<'EOF'
feat(phase6): grade-sync status on GET :id and POST :id/grade-sync retry route

GET :id gains a gradeSync summary (none|synced|pending|failed + counts +
lastError); POST :id/grade-sync re-queues the course's failed jobs and audits
grade_sync_requested (spec §25.9). CSRF-gated, tenant-scoped 404.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 12: web UI — grade-sync status + retry button

**Files:**
- Modify: `web/index.html` (`#session-panel`)
- Modify: `web/ui.js` (`elements`, new `renderGradeSyncState`)
- Modify: `web/attendance-session.js` (new `retryGradeSync`)
- Modify: `web/app.js` (render after close / on resume; wire the retry button)
- Test: `web/tests/attendance-session.test.js` (append — `retryGradeSync`)

> `web/` is not type-checked and `app.js` / `ui.js` have no unit tests. The real functional gate for this layer is Task 13's integration test plus the deferred Phase 7 Playwright pass. Keep the wiring minimal and defensive (every server value optional-chained).

**Interfaces:**
- Consumes: `apiFetch` via `attendance-session.js`'s `request()` helper; the `gradeSync` field added to `GET :id` in Task 11
- Produces: `retryGradeSync(sessionId)` in `attendance-session.js`; `ui.renderGradeSyncState(summary)` in `ui.js`

- [ ] **Step 1: Write the failing test**

Append to `web/tests/attendance-session.test.js` (it already `vi.mock('../api-client.js')` and imports from `../attendance-session.js`):

The file stubs `apiFetch` with **plain objects** (`{ ok, status, json: () => Promise.resolve(...) }`), not `new Response(...)` — match that:

```js
import { retryGradeSync } from '../attendance-session.js';

it('retryGradeSync POSTs to /grade-sync and returns ok on 200', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, retried: 2 }) });
  const result = await retryGradeSync('sess-1');
  expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/sess-1/grade-sync', { method: 'POST' });
  expect(result).toEqual({ ok: true, retried: 2 });
});

it('retryGradeSync surfaces a non-ok response as {ok:false}', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) });
  const result = await retryGradeSync('sess-1');
  expect(result.ok).toBe(false);
});
```

> The `toHaveBeenCalledWith('/api/attendance-sessions/sess-1/grade-sync', { method: 'POST' })` assertion is correct — `request()` forwards a non-empty `init` verbatim. If the file's actual mock helper differs (a shared `mockApiFetch()` factory, a different resolved shape), mirror it exactly and mirror the sibling `closeAttendanceSession` test's assertions.

- [ ] **Step 2: Run — expect FAIL** (`retryGradeSync` not exported)

Run: `npm test -- web/tests/attendance-session.test.js`

- [ ] **Step 3: `attendance-session.js` — add `retryGradeSync`**

After `reopenAttendanceSession`:

```js
/**
 * Re-queues this course's failed grade-sync jobs (spec §25.9). Never throws.
 * @param {string} sessionId
 * @returns {Promise<{ok: true, retried: number}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function retryGradeSync(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}/grade-sync`, { method: 'POST' });
  if (!result.ok) return result;
  return { ok: true, retried: Number(result.body?.retried ?? 0) };
}
```

- [ ] **Step 4: `index.html` — add the grade-sync panel**

Inside `<section id="session-panel">`, after the button row (`#btn-reopen-session`'s container), add:

```html
      <div id="grade-sync-panel" hidden>
        <p id="grade-sync-status-text">Grades pending</p>
        <button id="btn-retry-grade-sync" type="button" class="secondary" hidden>Retry grade sync</button>
      </div>
```

- [ ] **Step 5: `ui.js` — elements + `renderGradeSyncState`**

Add to the `elements` object:

```js
  gradeSyncPanel: document.getElementById('grade-sync-panel'),
  gradeSyncStatusText: document.getElementById('grade-sync-status-text'),
  retryGradeSyncBtn: document.getElementById('btn-retry-grade-sync'),
```

Add an exported function next to `renderSessionState`:

```js
const GRADE_SYNC_TEXT = {
  synced: 'Grades synchronized',
  pending: 'Grades pending',
  failed: 'Grade synchronization failed',
};

/** @param {{state?: string, counts?: {pending:number,synced:number,failed:number}, lastError?: string|null}} [summary] */
export function renderGradeSyncState(summary) {
  const state = summary?.state ?? 'none';
  if (state === 'none') {
    elements.gradeSyncPanel.hidden = true;
    elements.retryGradeSyncBtn.hidden = true;
    return;
  }
  elements.gradeSyncPanel.hidden = false;
  const base = GRADE_SYNC_TEXT[state] ?? state;
  elements.gradeSyncStatusText.textContent =
    state === 'failed' && summary?.lastError ? `${base} (${summary.lastError})` : base;
  elements.retryGradeSyncBtn.hidden = state !== 'failed';
}
```

- [ ] **Step 6: `app.js` — render + wire**

Add `retryGradeSync` to the `./attendance-session.js` import block. Add a helper and calls:

```js
async function refreshGradeSync(sessionId) {
  if (!sessionId) return;
  const detail = await getAttendanceSession(sessionId);
  if (detail.ok) ui.renderGradeSyncState(detail.body?.gradeSync);
}
```

- In `closeSession()`, after `ui.renderSessionState({ state: 'closed' })`, add `await refreshGradeSync(currentAttendanceSessionId);` — `currentAttendanceSessionId` is the module var the shipped `closeSession()` / `reopenSession()` handlers already read (`web/app.js`).
- In `reopenSession()`, after `ui.renderSessionState({ state: 'reopened' })`, add `ui.renderGradeSyncState(undefined);` (reopen does not change jobs; hide the panel until the next close)
- In `resumeOpenSessionIfAny()`, after `ui.renderSessionState({ state: chosen.state, label: chosen.label })`, add `ui.renderGradeSyncState(detail.body?.gradeSync);` (the `detail` fetched there already carries it)
- Near the other button listeners (`elements.closeSessionBtn.addEventListener(...)`):

```js
elements.retryGradeSyncBtn.addEventListener('click', async () => {
  const sessionId = currentAttendanceSessionId;
  if (!sessionId) return;
  elements.retryGradeSyncBtn.disabled = true;
  try {
    const result = await retryGradeSync(sessionId);
    if (!result.ok) ui.showAppMessage('error', 'Could not re-queue grade sync.');
    await refreshGradeSync(sessionId);
  } finally {
    elements.retryGradeSyncBtn.disabled = false;
  }
});
```

> Pre-flight-verified identifiers (all present in the shipped `web/*.js`): `currentAttendanceSessionId` (the current-session module var), `ui.showAppMessage`, `getAttendanceSession` (already imported in `app.js`), `elements.closeSessionBtn`, `resumeOpenSessionIfAny` (and its local `detail` is in scope at the `renderSessionState` call). Still cross-check the exact names when editing — `web/` is not type-checked.

- [ ] **Step 7: Run — expect PASS** (`npm test -- web/tests/attendance-session.test.js`), then `npm test`, then `npm run lint` (web is linted; `npm run typecheck` does not cover `web/`).

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/ui.js web/attendance-session.js web/app.js web/tests/attendance-session.test.js
git commit -m "$(cat <<'EOF'
feat(phase6): show grade-sync status + retry button in the session panel

renderGradeSyncState maps the GET :id gradeSync summary to the spec §28 UI
strings; retryGradeSync hits POST :id/grade-sync. Rendered after close and on
session resume.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 13: full integration test — launch → close → worker → Canvas Gradebook (exit criterion)

**Files:**
- Create: `server/tests/routes/grade-sync-integration.test.ts`

**Interfaces:**
- Consumes: everything above, end to end, on a locally-composed Fastify (mirrors `server/tests/routes/course-roster-integration.test.ts` — real `registerLtiLoginRoute` + `registerLtiLaunchRoute` + `registerAttendanceSessionsRoute`, no `server/src/index.ts` import), plus a direct `processGradeSyncJobs` call.

- [ ] **Step 1: Write the test**

`server/tests/routes/grade-sync-integration.test.ts`. **B1 (pre-flight):** `course-roster-integration.test.ts` has NO reusable `loginAndLaunch` helper — its launch plumbing is inline in the one `it()` block (`:76-115`), needs no CSRF, and never calls `/api/me`. This task therefore extracts that plumbing into a local `loginAndLaunch` and adds a `/api/me` fetch for the CSRF token, and its `buildApp` must register `@fastify/formbody` (both `/lti/login` and `/lti/launch` are form-encoded → 415 without it) and `registerMeRoute` (the only source of `csrfToken`, `me.ts:26`). Every mutating `inject` must carry an `origin` header equal to `APP_BASE_URL` — `createRequireCsrf` checks the Origin **in addition to** the token (`middleware.ts:48-53` + `csrf.ts:12-14`, exact `===`).

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { getActiveSigningKey, loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { createDefaultJwksCache } from '../../src/lti/jwks-cache.js';
import { findEnabledDeployment } from '../../src/lti/registrations.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { createAllowlist } from '../../src/lti/login.js';
import { registerLtiLoginRoute } from '../../src/routes/lti-login.js';
import { registerLtiLaunchRoute } from '../../src/routes/lti-launch.js';
import { registerAttendanceSessionsRoute } from '../../src/routes/attendance-sessions.js';
import { registerMeRoute } from '../../src/routes/me.js';
import { createRequireSession, createRequireCsrf } from '../../src/auth/middleware.js';
import { MockIdentityResolver } from '../../src/identity/mock-resolver.js';
import { processGradeSyncJobs } from '../../src/attendance/grade-worker.js';
import { gradeSyncJobs, gradeLineItems, auditEvents } from '../../src/database/schema.js';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';
const APP_BASE_URL = 'http://localhost:3000'; // an origin, no path
const TARGET = `${APP_BASE_URL}/index.html`;
const MOCK_COURSE = 'grade-int-course';

const { db } = getTestDb();
let platform: MockCanvasPlatform;
let signingKey: ToolSigningKey;
afterAll(() => closeTestDb());

beforeAll(async () => {
  platform = new MockCanvasPlatform();
  await platform.start();
  signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
});
beforeEach(async () => {
  await resetDb();
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyFormbody); // POST /lti/login and /lti/launch are form-encoded
  const requireSession = createRequireSession(db);
  const requireCsrf = createRequireCsrf(APP_BASE_URL);
  registerLtiLoginRoute(app, {
    appBaseUrl: APP_BASE_URL,
    allowedTargetLinkUris: createAllowlist([TARGET]),
    findEnabledDeployment: (iss, clientId, deploymentId) => findEnabledDeployment(db, iss, clientId, deploymentId),
    createTransaction: (params) => createOidcTransaction(db, { ...params, ttlSeconds: 300 }),
  });
  registerLtiLaunchRoute(app, {
    db,
    jwksCache: createDefaultJwksCache(),
    clockSkewSeconds: 60,
    sessionTtlHours: 12,
    appBaseUrl: APP_BASE_URL,
  });
  registerMeRoute(app, { requireSession, db }); // the ONLY source of csrfToken (me.ts:26)
  registerAttendanceSessionsRoute(app, { db, resolver: new MockIdentityResolver(), requireSession, requireCsrf, signingKey });
  return app;
}

// Extracted from course-roster-integration.test.ts:76-115 (inline there, not a function) and
// extended with the /api/me csrfToken fetch that file never needed (its roster GET is read-only).
// Adjust `registerMeRoute`'s deps arg order and the me-route dep shape against the shipped
// `server/src/routes/me.ts` when writing this — this plan assumes `{ requireSession, db }`.
async function loginAndLaunch(
  app: FastifyInstance,
  platform: MockCanvasPlatform,
  seeded: { clientId: string; deploymentId: string },
  extraClaims: Record<string, unknown>,
  contextId = MOCK_COURSE,
): Promise<{ cookie: string; csrfToken: string }> {
  const loginRes = await app.inject({
    method: 'POST',
    url: '/lti/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      iss: platform.issuer,
      login_hint: 'instructor-1',
      target_link_uri: TARGET,
      client_id: seeded.clientId,
      deployment_id: seeded.deploymentId,
    }).toString(),
  });
  expect(loginRes.statusCode).toBe(302);
  const redirect = new URL(loginRes.headers.location as string);
  const state = redirect.searchParams.get('state')!;
  const nonce = redirect.searchParams.get('nonce')!;

  const idToken = await platform.mintIdToken({
    nonce,
    sub: 'instructor-1',
    deploymentId: seeded.deploymentId,
    contextId,
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
    extraClaims,
  });

  const launchRes = await app.inject({
    method: 'POST',
    url: '/lti/launch',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ state, id_token: idToken }).toString(),
  });
  expect(launchRes.statusCode).toBe(303);
  const setCookie = Array.isArray(launchRes.headers['set-cookie'])
    ? launchRes.headers['set-cookie'].join(';')
    : String(launchRes.headers['set-cookie']);
  const sessionToken = /attendance_session=([^;]+)/.exec(setCookie)?.[1];
  expect(sessionToken).toBeTruthy();
  const cookie = `attendance_session=${sessionToken}`;

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  expect(me.statusCode).toBe(200);
  return { cookie, csrfToken: me.json().csrfToken as string };
}

describe('Phase 6 exit criterion: closing attendance updates the Canvas Gradebook column', () => {
  it('launch -> start -> scan present -> close -> worker -> AGS score posted to one line item', async () => {
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const app = await buildApp();

    platform.setCourseMembers(MOCK_COURSE, [
      { user_id: 'learner-1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '1000001' },
      { user_id: 'learner-2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '1000002' },
    ]);

    const { cookie, csrfToken } = await loginAndLaunch(app, platform, seeded, {
      [NRPS_CLAIM]: { context_memberships_url: platform.nrpsUrlFor(MOCK_COURSE) },
      [AGS_CLAIM]: { lineitems: platform.lineItemsUrlFor(MOCK_COURSE), scope: [] },
    });
    // Mutating injects need the Origin header too (createRequireCsrf checks it, exact ===).
    const auth = { cookie, 'x-csrf-token': csrfToken, origin: APP_BASE_URL };

    const created = await app.inject({ method: 'POST', url: '/api/attendance-sessions', headers: auth, payload: {} });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id;

    // learner-1's card resolves to institutionalId 1000001 -> present. Use a card code the
    // MockIdentityResolver hashes onto that id, or PATCH learner-1 present via the manual route:
    await app.inject({
      method: 'PATCH',
      url: `/api/attendance-sessions/${sessionId}/members/learner-1`,
      headers: auth,
      payload: { status: 'present' },
    });

    const closed = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${sessionId}/close`, headers: auth });
    expect(closed.statusCode).toBe(200);

    // Grades are queued, not yet in Canvas.
    const beforeWorker = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${sessionId}`, headers: auth });
    expect(beforeWorker.json().gradeSync.state).toBe('pending');
    expect(platform.getPostedScores(MOCK_COURSE)).toHaveLength(0);

    // Run the worker.
    const result = await processGradeSyncJobs(db, { signingKey });
    expect(result).toMatchObject({ synced: 2, failed: 0 });

    // One line item, persisted; two scores in Canvas; learner-1 = 100, learner-2 = 0.
    expect(platform.getLineItems(MOCK_COURSE)).toHaveLength(1);
    const [li] = await db.select().from(gradeLineItems);
    expect(li.tag).toBe('attendance');
    const posted = platform.getPostedScores(MOCK_COURSE);
    expect(posted).toHaveLength(2);
    // getPostedScores returns Array<Record<string, unknown>> — tuple-assert so `new Map` typechecks.
    const byUser = new Map(posted.map((p) => [p.userId as string, p.scoreGiven as number] as const));
    expect(byUser.get('learner-1')).toBe(100);
    expect(byUser.get('learner-2')).toBe(0);

    const afterWorker = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${sessionId}`, headers: auth });
    expect(afterWorker.json().gradeSync).toMatchObject({ state: 'synced', counts: { synced: 2, pending: 0, failed: 0 } });

    expect(await db.select().from(gradeSyncJobs)).toHaveLength(2);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_completed'))).toHaveLength(2);
    expect((await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'))).length).toBeGreaterThanOrEqual(1);
  });
});
```

> Implementation notes for the engineer:
> - The `loginAndLaunch` helper above is the extraction of `course-roster-integration.test.ts:76-115` — cross-check the current line range and the `platform.mintIdToken` / `platform.issuer` / `seedInstitutionAndRegistration` return shapes against that file when writing it; do not reinvent the OIDC state/nonce/cookie plumbing.
> - The launch is instructor-role (the helper hard-codes the Instructor role URI). Both roster members are `Learner` and eligible.
> - Extra claims are passed as the 4th positional arg to `loginAndLaunch` and forwarded to `mintIdToken({ extraClaims })`.
> - Confirm `registerMeRoute`'s deps shape against `server/src/routes/me.ts` — this plan assumes `registerMeRoute(app, { requireSession, db })`; adjust if the shipped signature differs.
> - `PATCH .../members/learner-1 { status: 'present' }` is the deterministic way to make learner-1 present without depending on the `MockIdentityResolver` hash. learner-2 gets a `system_absence` row at close.
> - The N1 population reads `course_members`; `setCourseMembers` + the NRPS claim make the launch's roster refresh populate it, so no extra seeding is needed here. With one closed session: learner-1 present → 1/1 → 100; learner-2 absent → 0/1 → 0.
> - `beforeWorker.json().gradeSync.state` is `'pending'`; after `processGradeSyncJobs` it is `'synced'` with `counts.synced === 2`.

- [ ] **Step 2: Run — expect PASS**

Run: `npm test -- server/tests/routes/grade-sync-integration.test.ts`
Then `npm test` (full suite), `npm run lint && npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add server/tests/routes/grade-sync-integration.test.ts
git commit -m "$(cat <<'EOF'
test(phase6): end-to-end launch -> close -> worker -> Canvas Gradebook

The Phase 6 exit criterion: an instructor launch, a present scan, a close, and
one worker pass post the expected cumulative scores to a single AGS line item
on the mock Canvas platform.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

### Task 14: docs — mark Phase 6 complete in `docs/canvas-lti/progress.md`

**Files:**
- Modify: `docs/canvas-lti/progress.md`

- [ ] **Step 1: Flip the checklist item**

Change the Phase 6 bullet from `- [ ]` to `- [x]` and append `✅ met.` to its exit-criterion line (match the Phase 4 / Phase 5 formatting exactly).

- [ ] **Step 2: Add a "what actually happened" section**

Immediately after the `## Phase 5 — what actually happened` section, add a `## Phase 6 — what actually happened` section at the same detail level as the Phase 2 / Phase 5 sections. Cover: the two new tables + migration `0004`; `grade-policy.ts` / `grade-calc.ts` (pure, default policy, per-institution config deferred to Phase 8); the close-transaction extension (compute + `upsertGradeSyncJobs` + `grade_sync_requested` audit, no Canvas call); `ags.ts` (create-or-reuse line item, `postScore`, retryable vs permanent error split); `grade-sync-store.ts` (UNIQUE course+member upsert, backoff, summary, `resetFailedJobs`); `grade-worker.ts` + `server/src/worker.ts` + `npm run worker` (standalone, not wired into Fastify); `GET :id` `gradeSync` summary + `POST :id/grade-sync`; the AGS scope constants; `MockCanvasPlatform` AGS additions; the web status panel; the integration test as the exit-criterion proof. List the deferred items: per-institution grading policy (Phase 8), the worker's schedule/deploy + migrate ownership (Phase 7), real-Canvas AGS verification (Phase 7), and the four whole-branch follow-ups still open.

- [ ] **Step 3: Verify + commit**

Run: `npm test && npm run lint && npm run typecheck` — all green/clean (docs-only change).

```bash
git add docs/canvas-lti/progress.md
git commit -m "$(cat <<'EOF'
docs(phase6): mark Phase 6 (AGS grading) complete

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Self-review notes

**Spec coverage** — every Phase 6 spec requirement maps to a task:

| Spec | Task(s) |
| --- | --- |
| §25.7 close steps 3–4 (cumulative recalc, queue grade sync) | 8 |
| §25.8 reopen leaves grades alone; reopened session excluded from the denominator (2026-08-28 ruling) | 8 — reopen writes nothing to `grade_sync_jobs`; the "excludes a reopened session from the cumulative denominator" test pins it |
| §25.9 `POST /grade-sync` retry route | 11 |
| §26 `grade_line_items`, `grade_sync_jobs` tables | 1 |
| §27 one cumulative line item per course | 1 (`UNIQUE(course_id)`), 6 (`ensureLineItem`) |
| §27.1 create-or-reuse by stable tag/resourceId, idempotent, persist id/URL | 6, 9 (persist to `grade_line_items`) |
| §27.2 grade calculation, configurable by institution, denominator 0 → no score | 3 (policy + default), 4 (calc) — per-institution surface deferred to Phase 8, seam left via the `GradingPolicy` param |
| §27.3 AGS Score fields, NRPS `user_id` as AGS id, ISO subsecond timestamp, Completed/FullyGraded | 6 (`postScore`), 9 (`now.toISOString()`) |
| §27.3 "Canvas rejects score updates older than the existing result" | 9 — every worker pass stamps `timestamp` from a fresh `now`, so a retried job always carries a strictly-later timestamp than its previous attempt; no explicit last-timestamp bookkeeping needed |
| §27.3 "grades for students who never launched" | 8/9 — scores are keyed by `course_members.ltiUserId` (NRPS `user_id`); no launch required |
| §28 durable outbox, same-txn enqueue, async processing, UI states, retry matrix, exp backoff + jitter, sequential writes | 7, 8, 9 |
| §33 `grade_sync_requested` / `grade_sync_completed` / `grade_sync_failed` audit rows | 8, 9, 11 |
| §16 / §16.1 client-credentials + token cache for AGS | 9 (reuses `getAccessToken` with the AGS scope set) |
| §10 AGS `lineitem` + `score` scopes (no Result read) | 2 |
| §35.2 worker: same image, different command, periodic, processes `grade_sync_jobs` | 10 (OIDC/session/retention purge tasks named in §35.2 are other phases — the Phase 6 line is grades only) |
| §31.7 SSRF: `ags_lineitems_url` verbatim from the signed launch | Global Constraints, 6 |
| §31.9 opaque errors | 11, and `last_error` / `lastError` are short codes only (7, 9) |

**Accepted deviation from "No Placeholders"** (pre-flight-reviewed):

1. **Task 12** wires four un-type-checked, un-unit-tested `web/*.js` files. All identifiers it references have now been verified against the shipped source (`currentAttendanceSessionId`, `ui.showAppMessage`, `getAttendanceSession`, `elements.closeSessionBtn`, `resumeOpenSessionIfAny`); the one genuinely open point is the `#grade-sync-panel` markup placement (resolved: inside `<section id="session-panel">`, immediately after the button-row `</div>`). The functional gate for this layer is Task 13's integration test plus the deferred Phase 7 Playwright pass. The plan keeps the wiring deliberately thin. *(The former deviation #1 — "lift `loginAndLaunch` verbatim from `course-roster-integration.test.ts`" — was DELETED: that helper does not exist there; Task 13 now spells out the extraction. See Revision log B1.)*

**Type consistency** — checked across tasks: `computeBackoff` (7→9, called with the pre-increment `attemptCount` per N2), `upsertGradeSyncJobs` `Map<string,{scoreGiven}>` (7←8), `markJobRetry` 6-arg (7←9), `AgsResult`/`EnsuredLineItem` field names (6→9), `getGradeSyncSummary` shape (7→11→web), `processGradeSyncJobs` deps (9). `session-lifecycle.ts` gains `and` + `inArray` in its `drizzle-orm` import and a `getCachedRosterAsMembers` import (Task 8). `schema.test.ts` (Task 1) gains `seedInstitutionAndCourse` + `MockCanvasPlatform` imports (confirmed absent).

**Design points (pre-flight dispositions):**

- **Grade population = the course's CURRENT roster (`course_members` filtered to eligible).** 2026-08-28 user ruling on pre-flight note N1: this is literally what "current roster × all closed sessions" says, and `course_members` is genuinely current (every `createAttendanceSession` refreshes it via `getRosterWithFallback → refreshCourseRoster → upsertCourseMembers`). Read with the outer `db` inside the close txn via `getCachedRosterAsMembers`; denominator still walks all `state='closed'` sessions; denominator 0 → member omitted. A student who has dropped since a session stops being graded; a student who enrolled since is graded over the sessions they have records in. *(The earlier plan used the just-closed session's snapshot; that is superseded — see Revision log B6/N1.)*
- **`claimDueJobs` does not use `SELECT ... FOR UPDATE SKIP LOCKED`.** Accepted (pre-flight N3): the worker is a one-shot entrypoint (`npm run worker`) with no in-process concurrency, and AGS score posts are idempotent-by-overwrite so an accidental overlap wastes quota, not grades. Multi-replica scheduling is a Phase 7 follow-up. The `claimDueJobs` doc comment states the invariant explicitly.
- **`grade_line_items` is upserted on every worker pass.** Accepted (pre-flight N4). Cheap, idempotent under `UNIQUE(course_id)`, keeps the persisted URL fresh.
- **`worker.ts` has no automated test.** Accepted (pre-flight N5). Top-level-await entrypoint mirroring `index.ts`; the testable `runWorkerOnce()` extraction is whole-branch follow-up #8 (Phase 7). All logic is covered by Task 9's suite + Task 13's integration test.
- **Permanent (non-429) 4xx is never auto-retried.** Accepted (pre-flight N6) — stricter than §28's "not … indefinitely", but §25.9's manual `POST /:id/grade-sync` is the sanctioned escape hatch and Task 12 surfaces a retry button on `failed`.

**Deferred quality items (from the pre-flight review — recorded for the Phase-6-range review, NOT fixed now):**

- **Q4** — the terminal-failure path (`markJobFailed`) leaves `attempt_count` at its pre-increment value while the audit `newValue` says `attemptCount: attemptCount+1`. Harmless (nothing reads the row after terminal failure); tidy by adding an optional 5th arg to `markJobFailed` if a later diff touches it.
- **Q9** — `getGradeSyncSummary` shape is fine, but Task 11's GET return-object edit is by "append one property", relying on the implementer to preserve the existing `// B3:` comment. Called out in Task 11's Step 3 text.
- **Q10** — `getGradeSyncSummary` loads every job row for the course to compute three counters. Fine at classroom scale; a `count(*) GROUP BY state` is tidier.
- **Q11** — `failNextAgsRequest` / `failNextScorePost` are process-global one-shots, unlike Phase 4's per-course `rateLimitNextRequest(courseId)`. Fine under `singleFork: true`; documented in the method comments.
- **Q14** — Task 6's `postScore` tests don't include a bare 401→`auth` classification case (429/500/422/network/malformed-URL are covered). The `auth` path is exercised end-to-end by Task 9's re-mint test and Task 5's self-test; a dedicated `postScore` unit case would pin the classifier.
- **Q15** — Task 11's retry route writes a `grade_sync_requested` audit row even when `retried === 0` (nothing failed). Harmless; an audit row for a no-op.

**Not in Phase 6** (unchanged from the brief): real-Canvas Developer Key registration + AGS verification, Azure/Bicep/CI/CD, the worker's production schedule and web-vs-worker migrate ownership — all Phase 7. Per-institution grading-policy config + editor — Phase 8. Dependency review / rate-limit / key-rotation — Phase 8.

---

## Revision log

Revised 2026-08-28 per `.superpowers/sdd/phase6-plan-review-findings.md` (single independent
pre-flight reviewer, opus) + user rulings on **N1** (grade population → `course_members` filtered to
eligible) and **N2** (`computeBackoff` gets the pre-increment `attemptCount` → first retry at 5 min).
The reviewer reproduced the migration generation, `tsc`, `eslint`, an import-cycle check, and a
Fastify-5 mock harness; verdict "7 blockers, all mechanically fixable — architecture sound".

### BLOCKERS

- **B1** (Task 13 unbuildable four ways — `loginAndLaunch` does not exist in `course-roster-integration.test.ts` (plumbing is inline at `:76-115`, no CSRF, no `/api/me`); `buildApp` omitted `@fastify/formbody` → 415 on login/launch; omitted `registerMeRoute` → no `csrfToken` source; `auth` headers omitted `origin` → 403 on every mutation; `new Map(posted.map(...))` TS2769) → **fixed.** Task 13 now: imports `fastifyFormbody` + `registerMeRoute`; `buildApp` registers both; a full `loginAndLaunch` helper (extracted from `:76-115`, plus a `/api/me` csrf fetch) is written out in the plan; every mutating inject carries `origin: APP_BASE_URL`; the score map uses `[p.userId as string, p.scoreGiven as number] as const`. Self-review "Accepted deviation #1" DELETED. Implementation-notes bullets rewritten.
- **B2** (Task 9 "429 → retry" test can never claim its job — inserts with DB-default `now()` then injects a past fixed `now`; `claimDueJobs`'s `lte(nextAttemptAt, now)` excludes the row) → **fixed.** That test now seeds `nextAttemptAt: new Date(now.getTime() - 60_000)` and hoists `const now`. Added a note to `insertJob` that any fixed-`now` test must pin `nextAttemptAt`.
- **B3** (worker never calls `clearAccessTokenCache` on a 401, though the Fixed contract says it does; a revoked token would 401 every retry for ~1 h and walk every job to the ceiling) → **fixed.** Task 9 imports `clearAccessTokenCache`; a per-course `remintOnce()` helper (`authRetried` guard) re-mints once after an `auth`-kind failure on `ensureLineItem` **or** a score post, mirroring `nrps.ts:297-300`. New test "re-mints the AGS token once when Canvas 401s the line-items request, then succeeds" using a new mock injector `failNextAgsRequest('auth')` (one-shot 401), added to Task 5 with its own self-test assertion.
- **B4** (Task 6 `ags.ts` code fails `npm run lint` — `networkError(err)` unused param; the plan's note about it was backwards) → **fixed.** Param renamed `_err` with an accurate comment; the L1440-era note replaced with the correct statement (the rule IS active; `args: 'after-used'` flags the only/last param).
- **B5** (Task 1 Step 1 test calls `seedInstitutionAndCourse` + `MockCanvasPlatform`, which `schema.test.ts` does not import) → **fixed.** Step 1 preamble now spells out the three imports to add. *(Applied by the interrupted first reviser pass; confirmed.)*
- **B6** (Task 8 grade-population rationale factually wrong — claimed `course_members` "may be empty"; it is refreshed on every `createAttendanceSession`) → **superseded by N1.** Task 8 now reads the current roster from `course_members` via `getCachedRosterAsMembers(db, session.courseId)` (outer `db`, read-only in the close txn); the Self-review design bullet and the Global Constraint rewritten to describe the real tradeoff (population/records guaranteed consistent vs. re-closing an old session grading against a since-changed roster).
- **B7** (Global Constraints promise a `reopened`-exclusion behaviour no task tested; an engineer writing `ne(state,'open')` passes every stated test) → **fixed.** Added Task 8 test "excludes a reopened session from the cumulative denominator" (close A absent → reopen A → close B present → score is 1/1 = 100, not 1/2 = 50).

### SPEC GAPS

- **SG1** (§27.2 "grading policy configurable by institution") — **accepted deferral to Phase 8**, no plan change. `GradingPolicy` is a parameter of both pure functions (the seam); only `DEFAULT_GRADING_POLICY` is wired. Named in the Task 14 deferred list.
- **SG2** (§27.2 `late` default 1) — no `late` status exists in `attendance_records.status` this phase (deliberate, documented at plan L23/L527). Carries forward from Phase 5. No change.
- **SG3** (§28 "not … indefinitely" read as "never auto-retry non-429 4xx") — stricter than the spec but defensible; §25.9's manual retry route is the escape hatch. Recorded (see also N6). No change.
- **SG4** (§28 backoff vs §35.2 five-minute base — the 5-min base was unreachable because Task 9 passed the incremented `attemptCount`) → **resolved by the N2 ruling.** `computeBackoff(job.attemptCount, now, rand)`; first retry now lands at `GRADE_SYNC_BASE_DELAY_MS`. `scheduleRetryOrFail` still stores `attemptCount + 1` on the row and audit.
- **SG5** (§31.9 opaque errors) — swept clean: every persisted / returned error value is one of the fixed `ags:*` short codes; `status` / `retryAfterSeconds` are in-memory only. Recorded. The only raw-error surface, `worker.ts`'s catch, is tightened (Q12).
- **SG6** (§26 audit PII-minimization) — worker audit `newValue` carries `ltiUserId` (opaque LTI subject, already unhashed in `audit_events.actor_lti_user_id` across Phases 3–5) and `score` (the point of a grade audit). Consistent and deliberate. No change.
- **SG7** (§10 scope identifiers from Canvas docs, not app strings) — Task 2 hard-codes the two URIs exactly as Phase 4 did for the NRPS scope; real-Canvas verification is a listed Phase 7 item. No change.

### QUALITY ITEMS

*Applied now:*
- **Q1** — Task 1 Step 5 expected-migration text corrected (two `CREATE TABLE` with **inline** UNIQUE + **three** FK `ADD CONSTRAINT`; `score` renders `double precision NOT NULL`; `state` `text DEFAULT 'pending' NOT NULL`, no CHECK). *(reviser pass; confirmed against a scratch `drizzle-kit generate`.)*
- **Q2** — `gradeSyncJobs` schema comment notes the `enum` narrows the TS type only; `score` column comment gains a "do not switch to numeric" rationale. *(reviser pass.)*
- **Q3** — Task 9's no-URL branch split: `!ctx || !ctx.agsLineitemsUrl` → `ags:no-lineitems-url`; `!validateCanvasServiceUrl(...).ok` → `ags:invalid-service-url`. Both terminal.
- **Q5** — `claimDueJobs` doc comment strengthened: it is a plain SELECT, not a claim; the single-process invariant comes from `npm run worker` being one-shot; multi-replica is Phase 7.
- **Q6** — Task 12 uses `currentAttendanceSessionId` (the shipped current-session var), not `scanPipeline.sessionId`; all other Task 12 identifiers pre-flight-verified against `web/*.js`.
- **Q7** — Task 12's web test uses the file's plain-object `apiFetch` mock style, not `new Response(...)`.
- **Q8** — line-number "§" refs replaced with real section numbers (`§1127` → `§24`; `§344-345`/`§350` → `§10`). *(reviser pass.)*
- **Q12** — `worker.ts` catch logs `err.message` only (spec §31.8), with a comment; the file comment cites whole-branch follow-up #8 for the untested-entrypoint deferral.
- **Q13** — the `failNextScorePost` mock addition (was Task 9 Step 0) folded into Task 5 Step 3, with its own Task 5 self-test; Task 9 Step 0 removed, Task 9's `git add` line drops `mock-canvas.ts`. *(reviser pass + this pass.)*

*Deferred to the Phase-6-range review* (recorded in Self-review notes): **Q4** (terminal fail leaves stale `attempt_count`), **Q9** (Task 11 GET edit relies on preserving the B3 comment), **Q10** (`getGradeSyncSummary` loads all rows), **Q11** (global vs per-course mock one-shots), **Q14** (no bare `postScore` 401 unit case), **Q15** (retry route audits a no-op).

### Notes left for re-review

- **N1 → USER RULING: switch to `course_members`.** Applied in Task 8 (population via `getCachedRosterAsMembers`), Global Constraints, `grade-calc.ts` module comment, the Task 8 tests (seed `course_members` explicitly since `getRosterWithFallback` is mocked), and the Self-review design bullet. Task 13 relies on the launch's roster refresh to populate `course_members`.
- **N2 → USER RULING: pass `job.attemptCount`.** Applied in `scheduleRetryOrFail` (Task 9) with a comment; retry cadence is now 5, 10, 20, 40, 60, 60 min. No stated test asserts the delay value, so no test changed beyond a clarifying comment in the 429 test.
- **N3** (`claimDueJobs` no `SKIP LOCKED`) — acceptable as-is; Q5 comment adopted; multi-replica is a Phase 7 follow-up.
- **N4** (`grade_line_items` upserted every pass) — acceptable as-is.
- **N5** (`worker.ts` untested) — acceptable as-is; Task 10 comment cites follow-up #8.
- **N6** (permanent 4xx never auto-retried) — acceptable as-is; recorded in Self-review notes.
- **N7** (Task 12 identifier hedging) — narrowed: all identifiers verified; the one open point (grade-sync panel markup placement → inside `#session-panel` after the button row) is now stated in Task 12 Step 4 and the Self-review deviation.
