# Canvas LTI Phase 5 — Persistent Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every scan, manual correction, and session close/reopen a durable server-side home in PostgreSQL, so closing or reopening the browser never loses server-accepted attendance — the literal Phase 5 exit criterion (spec §54/§23).

**Architecture:** Three new Drizzle tables (`attendance_sessions`, `attendance_session_members`, `attendance_records`) plus the `audit_events` table shared with Phase 4. A session snapshots Phase 4's roster verbatim at creation time (roster-snapshot immutability — spec §23's "historical attendance must not retroactively change"). Every scan, manual correction, and removal appends a new `attendance_records` row rather than mutating an existing one; "current status" is always resolved by `member-status.ts`'s "most-recent-record-wins" rule, so there is exactly one source of truth for an attendance outcome. `POST .../scans` is idempotent via a `(attendanceSessionId, clientScanId)` unique constraint plus `ON CONFLICT DO NOTHING RETURNING *` with a `SELECT` fallback on a lost race — with the single documented exception that a prior `lookup_error` row for the same `clientScanId` is re-resolved and updated in place, so a card-API outage followed by a retry can still land the student `present` (spec §47 "duplicate after lookup failure retries lookup"). The browser's `scan-pipeline.js` keeps 100% of its existing concurrency/dedup state machine (suppression window, in-flight tracking, stale-lookup-doesn't-clobber-latest, deletion-while-pending) — only the transport (`submitScan(sessionId, clientScanId, cardCode)` instead of `submitScan(cardCode)`) and the source of `status` (trusted verbatim from the server response, not recomputed locally) change.

**Dependency injection (matches shipped Phase 3 — verified against `server/src/database/client.ts`):** there is **no importable `db` singleton**. `client.ts` exports only `createDbClient(url) -> { db, pool }`, the `Database` type, and `applyMigrations`. Every attendance **lib module** function that touches the DB takes `db: Database` as its **first parameter** (the `oidc-transactions.ts` / `session.ts` style). Every **route module** is `registerXRoute(app, deps)` where `deps` carries `db` plus the injected preHandlers/collaborators (`me.ts` style). `server/src/index.ts` is the only place that calls `createDbClient(...)` and threads `db` everywhere. Every DB-touching **test** does `const { db } = getTestDb();` (from `server/tests/support/db.ts`) and has a file-scope `afterAll(() => closeTestDb())`; no test imports a DB handle from `client.js`.

**Tech Stack:** Fastify 5, Drizzle ORM + `pg` (from Phase 3), Zod, Vitest, plain ES modules on the browser side (no framework). No new npm dependencies this phase.

## Global Constraints

- No new npm dependencies (`drizzle-orm`, `pg`, `zod`, `fastify` already present from Phases 1–4). `web/` stays framework-free plain ES modules. Import `randomUUID`/`randomBytes`/`createHmac` from `node:crypto` explicitly (no unqualified global) server-side; `crypto.randomUUID()` is the browser global on the `web/` side.
- **No importable `db`.** Thread `db: Database` as the first parameter of every DB-touching lib function and as a field of every route `deps` object (see the Dependency-injection note above). No module-level DB handle anywhere in Phase 5 source or tests.
- Raw card codes MUST NOT be logged, written to audit logs, or persisted in `attendance_records` by default (spec §22). Only a fingerprint (`HMAC-SHA256(rawCardCode, institution-specific secret)`) may be persisted, and only when explicitly enabled — never the raw code itself. <!-- reviser note (S3): the fingerprint secret is app-wide (`CARD_FINGERPRINT_SECRET`) this phase because `institutions` has no secret column and only one institution is live; the `institutionId` parameter is kept in the signature and the per-institution migration path is documented in code. Needs an explicit user ruling that app-wide is acceptable for Phase 5. -->
- `attendance_session_members.status` is the *roster* status captured at snapshot time and is **never mutated** after creation. The attendance *outcome* lives only in the append-only `attendance_records` table.
- Every mutation that changes attendance state MUST write an `audit_events` row (spec §33) with `institutionId` (always non-null, from the session's course), `actorLtiUserId`, and `requestId` (from the Fastify `request.id` correlation id): `attendance_session_created` (on `createAttendanceSession`), `attendance_manual_change`, `attendance_record_removed`, `attendance_session_closed`, `attendance_session_reopened`.
- Every route under `/api/attendance-sessions/*` requires `requireSession`; every mutation (POST/PATCH/DELETE) additionally requires `requireCsrf`. Built in `index.ts` as `createRequireSession(db)` + `createRequireCsrf(env.APP_BASE_URL)`, threaded into the route `deps` object, applied as `preHandler: [requireSession, requireCsrf]` on mutations and `preHandler: requireSession` on GETs (spec §25 / §15). Every session/member/record lookup MUST verify the resource belongs to the authenticated session's institution/course — cross-tenant access returns `404`, never `403`.
- Ambiguous card-to-roster matches (more than one `attendance_session_members` row matches a resolved `institutionalId`) MUST resolve to `status: 'unexpected'`, never `'present'` (spec §20).
- A resolver result of `ok: true` but `universityId == null` is a lookup failure, NOT an unexpected student: record `status: 'lookup_error'` with `lookupErrorKind: 'missing-university-id'` (spec §20).
- Matches happen against **this session's roster snapshot** (`attendance_session_members`), never against the live `course_members` table — that is what makes the snapshot immutable.
- `late` status is **deferred this phase** (settled decision): it is not in the `attendance_records` status enum, not in `manualCorrectionSchema`, and not accepted by any route. `excused` is the only manual-correction-only outcome; the automated scan pipeline only ever produces `present` / `unexpected` / `lookup_error`. No auto-cutoff policy exists yet.
- Session state transitions are guarded (spec §23): `closeAttendanceSession` rejects a session already `closed` (409 `session_already_closed`); `reopenAttendanceSession` rejects a session that is not `closed` (409 `session_not_closed`).
- Roster acquisition for **Start Attendance** goes through Phase 4's shared `getRosterWithFallback(db, courseId)` helper (`server/src/attendance/roster-store.ts`), NEVER `refreshCourseRoster` directly — a transient Canvas failure with a `< 24h` cache degrades to that cache with `stale: true` rather than hard-failing (settled decision / spec §18.4). Only a transient failure with no `< 24h` cache is fatal.
- Production error responses map to opaque codes and include the `request.id` correlation id; never echo an internal `Error.message`, SQL, hostname, or secret to the client (spec §31.9).
- Follow the existing `registerXRoute(app, deps)` convention (`server/src/routes/me.ts`) and the existing Fastify-`inject` test pattern for every new route and its tests.
- **Grounding note:** every interface below has been reconciled against the REAL shipped Phase 3 source in this repo (`client.ts`, `schema.ts`, `auth/middleware.ts`, `auth/session.ts`, `auth/csrf.ts`, `routes/me.ts`, `routes/scans.ts`, `index.ts`, `tests/support/{db,seed,mock-canvas}.ts`) and against the Phase 4 fixed contract + the shared revision-constraints doc (D1–D12). Phase 4 is being revised in parallel: rely on the constraints doc for `refreshCourseRoster(db, courseId)` / `getRosterWithFallback(db, courseId)` / `seedInstitutionAndCourse(db)` shapes, not on Phase 4's in-flight plan text. The `CourseRosterMember` fields are NOT changing. Never change a Phase 3/4 shipped public interface to fit this plan — adapt the call site here. Modifying `server/src/index.ts` route wiring and deleting `server/src/routes/scans.ts` + `server/tests/routes/scans.test.ts` is expected and in scope (Task 17).

---

## File structure

```
server/src/attendance/
  session-lifecycle.ts     # createAttendanceSession / closeAttendanceSession / reopenAttendanceSession — state machine + audit writes
  scan-service.ts            # submitScan(db, sessionId, input, deps) — idempotency (+ lookup_error re-resolution), identity+roster-snapshot matching
  member-status.ts            # resolveCurrentRecord() — "most-recent-record-wins" resolution (pure)
  manual-correction.ts         # applyManualCorrection() — always appends, never mutates
  csv-export.ts                 # buildAttendanceSessionCsv() — server-side port of web/csv.js's csvEscapeField
  card-fingerprint.ts            # computeCardFingerprint() — HMAC-SHA256(cardCode, secret), spec §22 (pure)

server/src/routes/
  attendance-sessions.ts   # POST/GET/close/reopen/scans/members-PATCH/records-DELETE/export.csv — deps: { db, resolver, requireSession, requireCsrf }

server/src/database/
  schema.ts                # MODIFIED: adds attendanceSessions/attendanceSessionMembers/attendanceRecords,
                            #   confirms/extends auditEvents with the attendanceSessionId FK
server/src/index.ts        # MODIFIED: build createRequireCsrf(env.APP_BASE_URL); register attendance-sessions
                            #   route on the ROOT app with real preHandlers; Task 17 removes registerScansRoute
server/tests/support/db.ts # MODIFIED: add the 4 new tables to TRUNCATE_ORDER (Task 1)
server/tests/support/seed.ts # MODIFIED: add seedInstitutionAndCourse(db) building the real deployment chain (Task 4)

server/src/routes/scans.ts        # DELETED in Task 17 (POST /api/scans retired per D8 / index.ts standing note)
server/tests/routes/scans.test.ts # DELETED in Task 17

web/
  api-client.js            # NEW: reads csrfToken from GET /api/me; apiFetch() sets x-csrf-token + JSON on every mutation
  attendance-session.js    # NEW: client session lifecycle (create/close/reopen/status) — uses api-client.js
  scan-pipeline.js         # MODIFIED: submitScan(sessionId, clientScanId, cardCode) via api-client.js; server status trusted verbatim
  app.js                   # MODIFIED: bootstrap CSRF in init(); Start/Close/Reopen wiring; scans gated on an active session
  ui.js                    # MODIFIED: session-state rendering (Start/Close/Reopen button states, session label); status-vocab maps
  index.html                # MODIFIED: new session-control markup

server/tests/attendance/{session-lifecycle,scan-service,member-status,manual-correction,csv-export,card-fingerprint}.test.ts
server/tests/routes/attendance-sessions.test.ts
web/tests/scan-pipeline.test.js   # MODIFIED: transport assertions updated, all existing cases preserved
web/tests/api-client.test.js      # NEW
web/tests/attendance-session.test.js   # NEW
```

Files kept substantially intact per spec §29 and this plan: `hid-reader.js`, `omnikey-parser.js`, `diagnostics.js`, `storage.js`, `roster.js` (CSV parsing stays — retained for the standalone/demo mode of spec §51; this plan does not wire it into the LTI session flow), `csv.js` (client-side download helper, unchanged; `csv-export.ts` is a server-side port of its escaping logic, not a replacement of it).

---

### Drizzle schema (verbatim spec §26, plus the DELETE-route audit type)

```ts
// attendanceSessions
export const attendanceSessions = pgTable('attendance_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  courseId: uuid('course_id').notNull().references(() => courses.id),
  startedByLtiUserId: text('started_by_lti_user_id').notNull(),
  label: text('label'),
  meetingAt: timestamp('meeting_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  state: text('state', { enum: ['open', 'closed', 'reopened'] }).notNull().default('open'),
  rosterSnapshotVersion: integer('roster_snapshot_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// attendanceSessionMembers -- the roster snapshot; status here is the ROSTER status at
// snapshot time, never the attendance outcome, and is never mutated after insert.
export const attendanceSessionMembers = pgTable('attendance_session_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  attendanceSessionId: uuid('attendance_session_id').notNull().references(() => attendanceSessions.id),
  ltiUserId: text('lti_user_id').notNull(),
  institutionalId: text('institutional_id'),
  displayName: text('display_name'),
  eligibleForAttendance: boolean('eligible_for_attendance').notNull(),
  status: text('status').notNull(), // raw roster status AT SNAPSHOT TIME (e.g. 'Active'/'Inactive')
  snapshotData: jsonb('snapshot_data').notNull(), // a Phase 4 CourseRosterMember, stored verbatim
});

// attendanceRecords -- append-only (with the single documented exception that a
// prior 'lookup_error' row for the same clientScanId is re-resolved and updated
// in place -- see scan-service.ts / spec §47). "Current status" for a member is
// resolved by member-status.ts's resolveCurrentRecord(), never by mutating a row.
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attendanceSessionId: uuid('attendance_session_id').notNull().references(() => attendanceSessions.id),
    ltiUserId: text('lti_user_id'),
    institutionalId: text('institutional_id'),
    clientScanId: text('client_scan_id'),
    // 'late' is deliberately omitted -- deferred this phase (settled decision).
    status: text('status', { enum: ['present', 'absent', 'excused', 'lookup_error', 'unexpected'] }).notNull(),
    // Nullable to match spec §26 ("scanned_at nullable"): manual / system_absence
    // rows were never "scanned at" an instant and store null here.
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    source: text('source', { enum: ['card', 'manual', 'system_absence', 'import'] }).notNull(),
    cardFingerprint: text('card_fingerprint'),
    lookupErrorKind: text('lookup_error_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Array form -- matches shipped schema.ts (`(t) => [unique().on(...)]`); the
  // object-return form is deprecated by drizzle-kit.
  (table) => [
    // The idempotency mechanism: a retried submission with the same clientScanId
    // never creates a second row. clientScanId is nullable (manual/system_absence
    // records have none), so this constraint only actually de-duplicates 'card' scans.
    uniqueIndex('attendance_records_session_client_scan_id_key').on(table.attendanceSessionId, table.clientScanId),
  ]
);

// auditEvents -- shared with Phase 4. Phase 5 adds the attendanceSessionId FK.
// See Task 1 for the exact migration-ordering handling (works whether or not
// Phase 4's migration already created this table).
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id),
  courseId: uuid('course_id').references(() => courses.id),
  attendanceSessionId: uuid('attendance_session_id').references(() => attendanceSessions.id),
  actorLtiUserId: text('actor_lti_user_id'),
  eventType: text('event_type').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  requestId: text('request_id'),
});
```

### Core module signatures (fixed contract — every task below must match these exactly)

Every DB-touching function takes `db: Database` (from `server/src/database/client.js`) as its FIRST parameter (D1). `resolveCurrentRecord`, `buildAttendanceSessionCsv`, and `computeCardFingerprint` are pure and take no `db`.

```ts
// server/src/attendance/member-status.ts  (pure)
export function resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null;

// Shared transaction type alias -- Phase 3 ships no db.transaction() precedent, so
// helpers that receive `tx` type it as this rather than falling back to `typeof db`.
// (Placed in server/src/attendance/session-lifecycle.ts and imported where needed.)
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// server/src/attendance/scan-service.ts
export interface SubmitScanInput {
  clientScanId: string;
  cardCode: string;
  scannedAt: string; // ISO timestamp
}
export interface SubmitScanDeps {
  resolver: IdentityResolver; // from server/src/identity/types.ts (Phase 2, unchanged)
  institution: { id: string; cardFingerprintEnabled: boolean };
}
export async function submitScan(
  db: Database,
  sessionId: string,
  input: SubmitScanInput,
  deps: SubmitScanDeps
): Promise<AttendanceRecordRow>;

// server/src/attendance/session-lifecycle.ts
export async function createAttendanceSession(
  db: Database,
  courseId: string,
  startedByLtiUserId: string,
  body: { label?: string; meetingAt?: string },
  requestId?: string
): Promise<AttendanceSessionRow>;
export async function closeAttendanceSession(db: Database, sessionId: string, actorLtiUserId: string, requestId?: string): Promise<void>;
export async function reopenAttendanceSession(db: Database, sessionId: string, actorLtiUserId: string, reason?: string, requestId?: string): Promise<void>;

// server/src/attendance/manual-correction.ts
export async function applyManualCorrection(
  db: Database,
  sessionId: string,
  ltiUserId: string,
  input: { status: 'present' | 'absent' | 'excused'; note?: string },
  actorLtiUserId: string,
  requestId?: string
): Promise<AttendanceRecordRow>;

// server/src/attendance/csv-export.ts  (pure)
export function buildAttendanceSessionCsv(rows: AttendanceExportRow[]): string;

// server/src/attendance/card-fingerprint.ts  (pure)
export function computeCardFingerprint(cardCode: string, secret: string): string;
```

Error contract for the lifecycle/scan functions (mapped to HTTP codes by the route layer, Task 12):
`SessionClosedError` (`code: 'session_closed'`) → 409; `SessionAlreadyClosedError` (`code: 'session_already_closed'`) → 409; `SessionNotClosedError` (`code: 'session_not_closed'`) → 409; `RosterUnavailableError` (`code: 'roster_unavailable'`, thrown only when `getRosterWithFallback` itself throws — no fetch AND no `< 24h` cache) → 502. A missing session inside a service function throws a plain `Error`; the route resolves tenancy first and returns 404 before ever calling the service, so that plain `Error` is a defensive guard only.

`AttendanceRecordRow` is `typeof attendanceRecords.$inferSelect`; `AttendanceSessionRow` is `typeof attendanceSessions.$inferSelect`; `AttendanceSessionMemberRow` is `typeof attendanceSessionMembers.$inferSelect`. All three are exported from `server/src/database/schema.ts` — every task imports them from there rather than redefining them.

---

## Task 0: Verify Postgres is reachable and Phase 3/4 exports match this plan

**Files:**
- Read (no changes): `server/src/database/schema.ts`, `server/src/database/client.ts`, `server/src/auth/middleware.ts`, `server/src/auth/session.ts`, `server/src/routes/me.ts`, `server/src/index.ts`, `server/src/lti/nrps.ts`, `server/src/attendance/roster-store.ts`, `server/tests/support/{db,seed,mock-canvas}.ts`
- Read (no changes): `docker-compose.yml`

**Interfaces:**
- Consumes: nothing new — this is a pre-flight check.
- Produces: confirmation the real shapes match this plan. If any differ, write the actual shape as a one-line comment at the top of this plan file before continuing and use the real shape in every later task — do NOT modify Phase 3/4 source to match this plan.

- [ ] **Step 1: Start Postgres and confirm connectivity**

Run: `docker compose up -d postgres && sleep 2 && docker compose exec postgres pg_isready -U attendance_tracker`
Expected: `/var/run/postgresql:5432 - accepting connections`

- [ ] **Step 2: Confirm the dependency-injection surface (D1)**

- `server/src/database/client.ts` exports ONLY `createDbClient`, `Database`, `DbClient`, `applyMigrations` — **no `db`**. Every DB-touching function in this plan takes `db: Database` first.
- `server/src/auth/middleware.ts` exports the FACTORIES `createRequireSession(db: Database)` and `createRequireCsrf(expectedOrigin: string)`; `FastifyRequest.appSession?: AppSession` is already augmented there (no `as any` needed).
- `server/src/auth/session.ts` `AppSession = { id, institutionId, deploymentId, ltiSubject, displayName, courseId, roles, csrfSecret }`.
- `server/src/routes/me.ts` shows the deps convention: `MeRouteDeps { requireSession; db }`, route registered `{ preHandler: deps.requireSession }`, and it already returns `csrfToken: session.csrfSecret` on `GET /api/me`.
- `server/src/index.ts` builds `const { db } = dbClient;` and `const requireSession = createRequireSession(db)` once — this is where Task 12 adds `const requireCsrf = createRequireCsrf(env.APP_BASE_URL)`.
- `server/tests/support/db.ts` exports `getTestDb()` (`-> { db, pool }`), `resetDb()`, `closeTestDb()`, and a `TRUNCATE_ORDER` array (6 names currently — Task 1 extends it).
- `server/tests/support/seed.ts` exports `seedInstitutionAndRegistration(db, platform, overrides?)` -> `SeededRegistration` (with `deploymentRowId`). There is **no** `seedInstitutionAndCourse` — Task 4 adds it.
- `courses.deploymentId` is a NOT NULL FK to `lti_deployments.id` (a ROW UUID), NOT `institutions.id`.

- [ ] **Step 3: Confirm the Phase 4 roster contract (per the constraints doc, D2/D9)**

Confirm (or note the real shape of): `server/src/lti/nrps.ts` `refreshCourseRoster(db, courseId): Promise<CourseRosterResult>` (raw fetch, returns `{ ok:false, error }` on a transient failure, never throws) and `CourseRosterMember` (`{ ltiUserId, institutionalId, displayName, givenName, familyName, email, roles, status, eligibleForAttendance }` — unchanged); `server/src/attendance/roster-store.ts` `getRosterWithFallback(db, courseId): Promise<{ members: CourseRosterMember[]; fetchedAt: string; stale: boolean }>` (fresh fetch, else `< 24h` cache with `stale: true`, else throws). Phase 5 consumes `getRosterWithFallback`, never `refreshCourseRoster` directly. If Phase 4 has not executed yet, Task 4 still writes against this exact signature — Phase 4's revised plan is committed to it (D9).

- [ ] **Step 4: Confirm whether `audit_events` already exists**

Run: `docker compose exec -T postgres psql -U attendance_tracker -d attendance_tracker -c "\d audit_events"`
Expected: either `Did not find any relation named "audit_events".` or a full table description. Either is fine — Task 1's migration handles both.

---

## Task 1: Schema — add attendance tables, extend `audit_events`

**Files:**
- Modify: `server/src/database/schema.ts`
- Modify: `server/tests/support/db.ts` (add the 4 new tables to `TRUNCATE_ORDER`, D10/Q1)
- Create/modify: a new file under `/migrations` (exact name assigned by `drizzle-kit generate`)
- Test: `server/tests/database/schema.test.ts` (extend the existing Phase 3 smoke test file)

**Interfaces:**
- Consumes: `institutions`, `courses`, `ltiRegistrations`, `ltiDeployments` (Phase 3), `auditEvents` (Phase 4, if present) from `server/src/database/schema.ts`.
- Produces: `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords`, and (if not already present from Phase 4) `auditEvents`, all exported from `server/src/database/schema.ts`, plus `AttendanceSessionRow`, `AttendanceSessionMemberRow`, `AttendanceRecordRow`.

- [ ] **Step 1: Write the failing schema test**

```ts
// server/tests/database/schema.test.ts (append if the file already exists from Phase 3)
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import {
  institutions, ltiRegistrations, ltiDeployments, courses,
  attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents,
} from '../../src/database/schema.js';

const { db } = getTestDb();

afterAll(() => closeTestDb());

describe('Phase 5 schema', () => {
  it('attendance_sessions, attendance_session_members, attendance_records, audit_events exist and are queryable', async () => {
    await expect(db.select().from(attendanceSessions).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(attendanceSessionMembers).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(attendanceRecords).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(auditEvents).limit(1)).resolves.toEqual([]);
  });

  it('rejects a second attendance_records row with the same (attendanceSessionId, clientScanId)', async () => {
    await resetDb();
    const { sessionId } = await seedCourseAndSession();
    await db.insert(attendanceRecords).values({
      attendanceSessionId: sessionId, ltiUserId: 'user-1', institutionalId: '1000000',
      clientScanId: 'scan-abc', status: 'present', scannedAt: new Date(), source: 'card',
    });
    await expect(
      db.insert(attendanceRecords).values({
        attendanceSessionId: sessionId, ltiUserId: 'user-1', institutionalId: '1000000',
        clientScanId: 'scan-abc', status: 'present', scannedAt: new Date(), source: 'card',
      })
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('accepts a manual record with a null scanned_at (spec §26 — scanned_at is nullable)', async () => {
    await resetDb();
    const { sessionId } = await seedCourseAndSession();
    const [row] = await db.insert(attendanceRecords).values({
      attendanceSessionId: sessionId, ltiUserId: 'user-1', institutionalId: '1000000',
      clientScanId: null, status: 'excused', scannedAt: null, source: 'manual',
    }).returning();
    expect(row.scannedAt).toBeNull();
  });
});

// Builds the real FK chain institutions -> lti_registrations -> lti_deployments -> courses,
// so courses.deployment_id points at an lti_deployments.id ROW UUID (never institutions.id).
async function seedCourseAndSession() {
  const s = randomUUID();
  const [institution] = await db.insert(institutions)
    .values({ slug: `schema-test-${s}`, displayName: 'Schema Test U', timezone: 'UTC', enabled: true }).returning();
  const [registration] = await db.insert(ltiRegistrations).values({
    institutionId: institution.id, issuer: `https://canvas-${s}.test`, clientId: `client-${s}`,
    oidcAuthEndpoint: 'https://canvas.test/auth', tokenEndpoint: 'https://canvas.test/token',
    tokenAudience: 'https://canvas.test/token', platformJwksUri: 'https://canvas.test/jwks', enabled: true,
  }).returning();
  const [deployment] = await db.insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: `dep-${s}`, enabled: true, configuration: {} }).returning();
  const [course] = await db.insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: `ctx-${s}`, label: 'TEST101', title: 'Test Course' }).returning();
  const [session] = await db.insert(attendanceSessions)
    .values({ courseId: course.id, startedByLtiUserId: 'instructor-1' }).returning();
  return { sessionId: session.id };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/database/schema.test.ts`
Expected: FAIL — `attendanceSessions is not exported` (or similar module-resolution error), since the tables don't exist yet.

- [ ] **Step 3: Add the table definitions to `schema.ts`**

Append the full "Drizzle schema" block from this plan's header section (above) to `server/src/database/schema.ts`, using whatever `pgTable`/`uuid`/`text`/`jsonb`/`timestamp`/`boolean`/`integer`/`uniqueIndex` imports Phase 3/4 already established from `drizzle-orm/pg-core` at the top of that file (add any of those specific imports this block needs that aren't already imported). If Phase 4 already defined `auditEvents` in this file, do **not** redefine it — instead add the missing `attendanceSessionId: uuid('attendance_session_id').references(() => attendanceSessions.id)` column to Phase 4's existing definition (Phase 4's version has this column as a bare `uuid` with no FK — this task is what adds the FK reference now that `attendanceSessions` exists). If Phase 4 has not yet run, add the full `auditEvents` definition exactly as shown above.

Then add the inferred row types at the bottom of the file:

```ts
export type AttendanceSessionRow = typeof attendanceSessions.$inferSelect;
export type AttendanceSessionMemberRow = typeof attendanceSessionMembers.$inferSelect;
export type AttendanceRecordRow = typeof attendanceRecords.$inferSelect;
```

- [ ] **Step 3b: Add the new tables to `server/tests/support/db.ts`'s reset set (D10/Q1)**

`resetDb()` truncates a curated list; a new table missing from it silently accumulates rows across test files (shared DB + `singleFork`). Prepend the four Phase 5 tables to `TRUNCATE_ORDER` (children before parents; `CASCADE` still covers FK order, but list them explicitly per the Phase 3 convention). Only add a name that is not already present — if Phase 4 already added `audit_events` (or `course_members`) here, do not duplicate it (a repeated name makes `TRUNCATE TABLE a, a` fail):

```ts
const TRUNCATE_ORDER = [
  'audit_events',
  'attendance_records',
  'attendance_session_members',
  'attendance_sessions',
  'app_sessions',
  'courses',
  'oidc_transactions',
  'lti_deployments',
  'lti_registrations',
  'institutions',
];
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new file appears at `/migrations/<NNNN>_<generated-name>.sql`. Note its exact filename for the next step.

- [ ] **Step 5: Hand-edit the generated migration for the `audit_events` idempotency requirement**

Open the generated migration file. If it contains a `CREATE TABLE "audit_events" (...)` statement (i.e. Phase 4 had not yet created this table when you ran `generate`), change that single line from:

```sql
CREATE TABLE "audit_events" (
```

to:

```sql
CREATE TABLE IF NOT EXISTS "audit_events" (
```

If the generated migration instead contains only an `ALTER TABLE "audit_events" ADD COLUMN "attendance_session_id" uuid REFERENCES "attendance_sessions"("id")` (because Phase 4's `audit_events` table already exists), leave it as-is — that's already correct and idempotent under normal migration-runner semantics (a migration only runs once, tracked by the runner's own migrations-applied table), and no `IF NOT EXISTS` edit is needed for an `ALTER`.

- [ ] **Step 6: Apply the migration and run the tests**

Run: `npx drizzle-kit migrate && npx vitest run server/tests/database/schema.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 7: Commit**

```bash
git add server/src/database/schema.ts migrations/ server/tests/database/schema.test.ts server/tests/support/db.ts
git commit -m "feat: add attendance_sessions/attendance_session_members/attendance_records schema"
```

---

## Task 2: `member-status.ts` — most-recent-record-wins resolution

**Files:**
- Create: `server/src/attendance/member-status.ts`
- Test: `server/tests/attendance/member-status.test.ts`

**Interfaces:**
- Consumes: `AttendanceRecordRow` from `server/src/database/schema.ts`.
- Produces: `resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null` — used by `scan-service.ts`, `session-lifecycle.ts` (`closeAttendanceSession` needs to know who already has a qualifying record), and the `GET /api/attendance-sessions/{id}` route (renders current status per member). Pure — takes no `db`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/member-status.test.ts
import { describe, it, expect } from 'vitest';
import { resolveCurrentRecord } from '../../src/attendance/member-status.js';
import type { AttendanceRecordRow } from '../../src/database/schema.js';

function record(overrides: Partial<AttendanceRecordRow>): AttendanceRecordRow {
  return {
    id: 'rec-1',
    attendanceSessionId: 'session-1',
    ltiUserId: 'user-1',
    institutionalId: '1000000',
    clientScanId: null,
    status: 'present',
    scannedAt: new Date('2026-08-26T10:00:00Z'),
    source: 'card',
    cardFingerprint: null,
    lookupErrorKind: null,
    createdAt: new Date('2026-08-26T10:00:00Z'),
    updatedAt: new Date('2026-08-26T10:00:00Z'),
    ...overrides,
  } as AttendanceRecordRow;
}

describe('resolveCurrentRecord', () => {
  it('returns null for an empty record list', () => {
    expect(resolveCurrentRecord([])).toBeNull();
  });

  it('returns the only record when there is exactly one', () => {
    const r = record({ id: 'only' });
    expect(resolveCurrentRecord([r])).toBe(r);
  });

  it('returns the record with the latest createdAt when multiple exist, regardless of insertion order', () => {
    const older = record({ id: 'older', status: 'present', createdAt: new Date('2026-08-26T10:00:00Z') });
    const newer = record({ id: 'newer', status: 'excused', createdAt: new Date('2026-08-26T10:05:00Z') });
    expect(resolveCurrentRecord([older, newer]).id).toBe('newer');
    expect(resolveCurrentRecord([newer, older]).id).toBe('newer'); // order-independent
  });

  it('breaks a createdAt tie by id, deterministically, rather than by array order', () => {
    const tiedTime = new Date('2026-08-26T10:00:00Z');
    const a = record({ id: 'aaa', createdAt: tiedTime });
    const b = record({ id: 'bbb', createdAt: tiedTime });
    expect(resolveCurrentRecord([a, b]).id).toBe(resolveCurrentRecord([b, a]).id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/member-status.test.ts`
Expected: FAIL — `Cannot find module '../../src/attendance/member-status.js'`

- [ ] **Step 3: Implement**

```ts
// server/src/attendance/member-status.ts
//
// "Most-recent-record-wins" is the single rule for turning the append-only
// attendance_records table into one current status per member. Nothing else
// in this codebase should compute a member's current attendance status --
// route handlers and closeAttendanceSession() both call this function rather
// than re-deriving the rule.

import type { AttendanceRecordRow } from '../database/schema.js';

export function resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null {
  if (records.length === 0) return null;

  return records.reduce((latest, candidate) => {
    const latestTime = new Date(latest.createdAt).getTime();
    const candidateTime = new Date(candidate.createdAt).getTime();
    if (candidateTime > latestTime) return candidate;
    if (candidateTime < latestTime) return latest;
    // Deterministic tie-break: higher id string wins. createdAt has only
    // millisecond precision, so two records inserted in the same millisecond
    // (e.g. a manual correction immediately following a scan) need a
    // stable, order-independent tiebreaker.
    return candidate.id > latest.id ? candidate : latest;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/member-status.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/member-status.ts server/tests/attendance/member-status.test.ts
git commit -m "feat: add most-recent-record-wins attendance status resolution"
```

---

## Task 3: `card-fingerprint.ts` — HMAC card reference (spec §22)

**Files:**
- Create: `server/src/attendance/card-fingerprint.ts`
- Test: `server/tests/attendance/card-fingerprint.test.ts`

**Interfaces:**
- Consumes: Node's built-in `node:crypto`.
- Produces: `computeCardFingerprint(cardCode: string, secret: string): string` — used by `scan-service.ts` only when `deps.institution.cardFingerprintEnabled` is true.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/card-fingerprint.test.ts
import { describe, it, expect } from 'vitest';
import { computeCardFingerprint } from '../../src/attendance/card-fingerprint.js';

describe('computeCardFingerprint', () => {
  it('is deterministic for the same card code and secret', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).toBe(computeCardFingerprint('CARD001', 'secret-a'));
  });

  it('differs for different card codes under the same secret', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).not.toBe(computeCardFingerprint('CARD002', 'secret-a'));
  });

  it('differs for the same card code under different secrets (no cross-institution correlation)', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).not.toBe(computeCardFingerprint('CARD001', 'secret-b'));
  });

  it('never contains the raw card code as a substring', () => {
    expect(computeCardFingerprint('CARD001', 'secret-a')).not.toContain('CARD001');
  });

  it('returns a 64-character lowercase hex string (SHA-256 digest)', () => {
    const fp = computeCardFingerprint('CARD001', 'secret-a');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/card-fingerprint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/attendance/card-fingerprint.ts
//
// spec §22: a raw card code must not be persisted by default. If an
// institution needs a durable card reference for diagnostics, this HMAC
// fingerprint is what gets stored instead -- never the raw code. Treat the
// fingerprint itself as sensitive/pseudonymous data (it still lets you tell
// "same card scanned twice" apart from "different card"), just not as
// sensitive as the raw code.

import { createHmac } from 'node:crypto';

export function computeCardFingerprint(cardCode: string, secret: string): string {
  return createHmac('sha256', secret).update(cardCode, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/card-fingerprint.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/card-fingerprint.ts server/tests/attendance/card-fingerprint.test.ts
git commit -m "feat: add HMAC-based card fingerprint for optional diagnostics reference"
```

---

## Task 4: `session-lifecycle.ts::createAttendanceSession` — snapshots the roster (degrades to <24h cache)

**Files:**
- Create: `server/src/attendance/session-lifecycle.ts` (this task only implements `createAttendanceSession` + the `Tx` alias + the error classes; close/reopen are Tasks 8–9)
- Modify: `server/tests/support/seed.ts` (add `seedInstitutionAndCourse(db)`, D10/B4)
- Test: `server/tests/attendance/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `getRosterWithFallback(db, courseId)` from Phase 4's `server/src/attendance/roster-store.ts` (per D9 — NOT `refreshCourseRoster` directly); `Database` from `server/src/database/client.ts`; `attendanceSessions`, `attendanceSessionMembers`, `auditEvents`, `courses` from `server/src/database/schema.ts`.
- Produces: `createAttendanceSession(db, courseId, startedByLtiUserId, body, requestId?): Promise<AttendanceSessionRow>` (writes an `attendance_session_created` audit event, S1) — used by `routes/attendance-sessions.ts`'s `POST /api/attendance-sessions` handler. Also exports `Tx`, `SessionClosedError`, `SessionAlreadyClosedError`, `SessionNotClosedError`, `RosterUnavailableError`.

- [ ] **Step 1: Add `seedInstitutionAndCourse(db)` to `server/tests/support/seed.ts` (D10/B4)**

`seedInstitutionAndRegistration` needs a running `MockCanvasPlatform`; this lighter helper does not. It builds the FULL FK chain so `courses.deploymentId` is an `lti_deployments.id` ROW UUID (never `institutions.id` — that FK violation is B4). If Phase 4's revised plan has already added `seedInstitutionAndCourse` to this file, REUSE it — verify it takes `db` as its first arg and builds the real deployment chain per D10; only add this definition if the export is absent.

```ts
// server/tests/support/seed.ts — add alongside seedInstitutionAndRegistration
import { courses } from '../../src/database/schema.js'; // add to the existing import line

export interface SeededCourse {
  institutionId: string;
  registrationId: string;
  deploymentRowId: string;
  courseId: string;
}

export async function seedInstitutionAndCourse(db: Database): Promise<SeededCourse> {
  const s = randomUUID();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: `test-${s}`, displayName: 'Test U', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: `https://canvas-${s}.test`,
      clientId: `client-${s}`,
      oidcAuthEndpoint: 'https://canvas.test/api/lti/authorize_redirect',
      tokenEndpoint: 'https://canvas.test/login/oauth2/token',
      tokenAudience: 'https://canvas.test/login/oauth2/token',
      platformJwksUri: 'https://canvas.test/api/lti/security/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: `dep-${s}`, enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({
      institutionId: institution.id,
      deploymentId: deployment.id, // ROW UUID, not institution.id
      ltiContextId: `ctx-${s}`,
      label: 'TEST101',
      title: 'Test Course',
    })
    .returning();
  return { institutionId: institution.id, registrationId: registration.id, deploymentRowId: deployment.id, courseId: course.id };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// server/tests/attendance/session-lifecycle.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { createAttendanceSession } from '../../src/attendance/session-lifecycle.js';
import { attendanceSessionMembers, auditEvents } from '../../src/database/schema.js';

// D9: Start Attendance goes through the shared fallback helper, so that is what we mock.
// vi.mock (not vi.spyOn) — an ESM named-export spy throws "Cannot redefine property"
// under some esbuild interop settings; Phase 4's route tests also use vi.mock (Q3).
vi.mock('../../src/attendance/roster-store.js', () => ({
  getRosterWithFallback: vi.fn(),
}));
import { getRosterWithFallback } from '../../src/attendance/roster-store.js';

const { db } = getTestDb();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
  vi.mocked(getRosterWithFallback).mockReset();
});

function member(overrides: Partial<import('../../src/lti/nrps.js').CourseRosterMember> = {}) {
  return {
    ltiUserId: 'user-1',
    institutionalId: '1000000',
    displayName: 'Jane Smith',
    givenName: 'Jane',
    familyName: 'Smith',
    email: 'jane@example.edu',
    roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    status: 'Active',
    eligibleForAttendance: true,
    ...overrides,
  };
}

describe('createAttendanceSession', () => {
  it('snapshots every roster member verbatim into attendance_session_members and writes an attendance_session_created audit event', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const members = [member(), member({ ltiUserId: 'user-2', institutionalId: '2000000', eligibleForAttendance: false, status: 'Inactive' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false });

    const session = await createAttendanceSession(db, courseId, 'instructor-1', {}, 'req-1');

    const rows = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, session.id));
    expect(rows).toHaveLength(2);
    const row1 = rows.find((r) => r.ltiUserId === 'user-1')!;
    expect(row1.institutionalId).toBe('1000000');
    expect(row1.eligibleForAttendance).toBe(true);
    expect(row1.status).toBe('Active');
    expect(row1.snapshotData).toEqual(members[0]);

    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_created'));
    expect(event.actorLtiUserId).toBe('instructor-1');
    expect(event.requestId).toBe('req-1');
    expect(event.institutionId).not.toBeNull();
    expect(event.newValue).toMatchObject({ memberCount: 2, stale: false });
  });

  it('sets state=open, startedByLtiUserId, and optional label/meetingAt from the request body', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false });

    const session = await createAttendanceSession(db, courseId, 'instructor-1', { label: 'Monday lecture', meetingAt: '2026-08-26T14:00:00Z' });

    expect(session.state).toBe('open');
    expect(session.startedByLtiUserId).toBe('instructor-1');
    expect(session.label).toBe('Monday lecture');
    expect(session.courseId).toBe(courseId);
  });

  it('degrades to a <24h cache: creates the session from the stale roster and records stale=true in the audit event (S2)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [member()], fetchedAt: '2026-08-26T09:00:00.000Z', stale: true });

    const session = await createAttendanceSession(db, courseId, 'instructor-1', {});

    const rows = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, session.id));
    expect(rows).toHaveLength(1);
    const [event] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_created'));
    expect(event.newValue).toMatchObject({ stale: true, rosterFetchedAt: '2026-08-26T09:00:00.000Z' });
  });

  it('hard-fails (RosterUnavailableError) only when getRosterWithFallback itself throws — no fetch AND no <24h cache', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    vi.mocked(getRosterWithFallback).mockRejectedValue(new Error('canvas down, cache is 3 days old'));

    await expect(createAttendanceSession(db, courseId, 'instructor-1', {})).rejects.toMatchObject({ code: 'roster_unavailable' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `createAttendanceSession` + shared types/errors**

```ts
// server/src/attendance/session-lifecycle.ts
import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, auditEvents, courses, type AttendanceSessionRow } from '../database/schema.js';
import { getRosterWithFallback } from './roster-store.js';

// Phase 3 ships no db.transaction() precedent, so helpers that receive `tx` type it
// as this alias rather than the non-existent `typeof db` (Q15 / B5 defect 3).
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export class SessionClosedError extends Error {
  code = 'session_closed' as const;
  constructor() { super('Attendance session is closed; scans are not accepted.'); }
}
export class SessionAlreadyClosedError extends Error {
  code = 'session_already_closed' as const;
  constructor() { super('Attendance session is already closed.'); }
}
export class SessionNotClosedError extends Error {
  code = 'session_not_closed' as const;
  constructor() { super('Only a closed attendance session can be reopened.'); }
}
export class RosterUnavailableError extends Error {
  code = 'roster_unavailable' as const;
  constructor(cause: unknown) {
    super('Cannot start an attendance session: the course roster is unavailable and no recent cache exists.');
    this.cause = cause;
  }
}

export async function createAttendanceSession(
  db: Database,
  courseId: string,
  startedByLtiUserId: string,
  body: { label?: string; meetingAt?: string },
  requestId?: string,
): Promise<AttendanceSessionRow> {
  // D9/S2: getRosterWithFallback returns a fresh fetch, else a <24h cache with
  // stale:true, and only THROWS when there is neither. A transient Canvas 429
  // mid-class must not block Start Attendance.
  let roster: { members: import('../lti/nrps.js').CourseRosterMember[]; fetchedAt: string; stale: boolean };
  try {
    roster = await getRosterWithFallback(db, courseId);
  } catch (err) {
    throw new RosterUnavailableError(err);
  }

  return db.transaction(async (tx) => {
    const [course] = await tx.select().from(courses).where(eq(courses.id, courseId));
    if (!course) throw new Error(`Course ${courseId} not found.`);

    const [session] = await tx
      .insert(attendanceSessions)
      .values({
        courseId,
        startedByLtiUserId,
        label: body.label ?? null,
        meetingAt: body.meetingAt ? new Date(body.meetingAt) : null,
        state: 'open',
      })
      .returning();

    if (roster.members.length > 0) {
      await tx.insert(attendanceSessionMembers).values(
        roster.members.map((m) => ({
          attendanceSessionId: session.id,
          ltiUserId: m.ltiUserId,
          institutionalId: m.institutionalId,
          displayName: m.displayName,
          eligibleForAttendance: m.eligibleForAttendance,
          status: m.status,
          snapshotData: m,
        })),
      );
    }

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId,
      attendanceSessionId: session.id,
      actorLtiUserId: startedByLtiUserId,
      eventType: 'attendance_session_created',
      targetType: 'attendance_session',
      targetId: session.id,
      newValue: { memberCount: roster.members.length, stale: roster.stale, rosterFetchedAt: roster.fetchedAt },
      requestId: requestId ?? null,
    });

    return session;
  });
}
```

<!-- reviser note (S2): staleness is recorded on the attendance_session_created audit event's newValue, not on a new attendance_sessions column, to avoid schema churn beyond spec §26's literal column list. Re-review: confirm that is an acceptable home for the stale flag, or add a nullable `roster_stale` column. -->

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts server/tests/support/seed.ts
git commit -m "feat: add createAttendanceSession — roster snapshot with <24h stale-cache degradation + creation audit event"
```

---

## Task 5: `scan-service.ts` — valid scan produces a `present` record

**Files:**
- Create: `server/src/attendance/scan-service.ts`
- Test: `server/tests/attendance/scan-service.test.ts`

**Interfaces:**
- Consumes: `Database` from `server/src/database/client.ts`; `IdentityResolver`/`IdentityResolution` from `server/src/identity/types.ts` (Phase 2, unchanged); `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords` from `server/src/database/schema.ts`; `computeCardFingerprint` from Task 3; `SessionClosedError` from `session-lifecycle.ts` (Task 4).
- Produces: `submitScan(db, sessionId, input, deps): Promise<AttendanceRecordRow>` per the fixed signature in this plan's header — used by `routes/attendance-sessions.ts`'s `POST .../scans` handler.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/scan-service.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { submitScan } from '../../src/attendance/scan-service.js';
import { attendanceSessions, attendanceSessionMembers } from '../../src/database/schema.js';
import type { IdentityResolver, IdentityResolution } from '../../src/identity/types.js';

const { db } = getTestDb();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
});

function successResolution(overrides: Partial<IdentityResolution> = {}): IdentityResolution {
  return { ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null, ...overrides };
}

async function seedOpenSessionWithMember(institutionalId = '1000000') {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db);
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
  await db.insert(attendanceSessionMembers).values({
    attendanceSessionId: session.id,
    ltiUserId: 'user-1',
    institutionalId,
    displayName: 'Jane Smith',
    eligibleForAttendance: true,
    status: 'Active',
    snapshotData: {},
  });
  return { institutionId, sessionId: session.id };
}

describe('submitScan', () => {
  it('creates a present record for a card that resolves to exactly one roster-snapshot member', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } }
    );

    expect(record.status).toBe('present');
    expect(record.ltiUserId).toBe('user-1');
    expect(record.institutionalId).toBe('1000000');
    expect(record.source).toBe('card');
    expect(record.cardFingerprint).toBeNull();
    expect(record.attendanceSessionId).toBe(sessionId);
  });

  it('never persists the raw card code anywhere on the returned record', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'SUPERSECRETCARD42', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } }
    );

    expect(JSON.stringify(record)).not.toContain('SUPERSECRETCARD42');
  });

  it('computes and stores a card fingerprint (never the raw code) when the institution enables it', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: true } }
    );

    expect(record.cardFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records a lookup_error with lookupErrorKind=missing-university-id when the resolver returns ok:true but universityId:null (spec §20, Q6)', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: null }) };

    const record = await submitScan(
      db,
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } }
    );

    expect(record.status).toBe('lookup_error');
    expect(record.lookupErrorKind).toBe('missing-university-id');
    expect(record.ltiUserId).toBeNull();
  });

  it('rejects scan submission with a 409-mapped error when the session is closed', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const resolver: IdentityResolver = { resolveCard: async () => successResolution() };

    await expect(
      submitScan(db, session.id, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } })
    ).rejects.toMatchObject({ code: 'session_closed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the valid-scan, closed-session, and lookup_error-retry-in-place paths**

```ts
// server/src/attendance/scan-service.ts
//
// The scan pipeline's server-side counterpart. Every branch here is
// release-blocking per spec §47: identity resolution failures must become a
// recorded 'lookup_error' scan, not a lost/silently-dropped one; an
// ambiguous roster match must never resolve to 'present' (spec §20); and a
// retry of a scan that previously landed as 'lookup_error' MUST be able to
// recover to 'present'/'unexpected' (spec §47 "duplicate after lookup
// failure retries lookup").

import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, type AttendanceRecordRow } from '../database/schema.js';
import type { IdentityResolver } from '../identity/types.js';
import { computeCardFingerprint } from './card-fingerprint.js';
import { SessionClosedError } from './session-lifecycle.js';

export interface SubmitScanInput {
  clientScanId: string;
  cardCode: string;
  scannedAt: string;
}
export interface SubmitScanDeps {
  resolver: IdentityResolver;
  institution: { id: string; cardFingerprintEnabled: boolean };
}

export async function submitScan(
  db: Database,
  sessionId: string,
  input: SubmitScanInput,
  deps: SubmitScanDeps,
): Promise<AttendanceRecordRow> {
  // Idempotency (spec §21/§47): a retried submission with the same clientScanId
  // returns the existing record WITHOUT calling the resolver again -- UNLESS
  // that existing record is a 'lookup_error'. A lookup_error is not a settled
  // outcome; a retry must re-run resolution and update the row in place so the
  // student can still land 'present' after a card-API outage (B6). The
  // (attendanceSessionId, clientScanId) unique index forbids a second row, so
  // re-resolution updates the same row rather than inserting.
  const [existing] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, input.clientScanId)));
  if (existing && existing.status !== 'lookup_error') return existing;

  const [session] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
  // Defensive only: the route resolves tenancy and returns 404 before calling this.
  if (!session) throw new SessionClosedError();
  if (session.state === 'closed') throw new SessionClosedError();

  const resolution = await deps.resolver.resolveCard(input.cardCode);

  let status: AttendanceRecordRow['status'];
  let ltiUserId: string | null = null;
  let institutionalId: string | null = null;
  let lookupErrorKind: string | null = null;

  if (!resolution.ok) {
    status = 'lookup_error';
    lookupErrorKind = resolution.error?.kind ?? 'unknown';
  } else if (resolution.universityId == null) {
    // ok:true with no university id is a lookup FAILURE, not an unexpected
    // student (spec §20 -- "a card lookup failure is not the same as an
    // unexpected student").
    status = 'lookup_error';
    lookupErrorKind = 'missing-university-id';
  } else {
    institutionalId = resolution.universityId;
    const matches = await db
      .select()
      .from(attendanceSessionMembers)
      .where(and(eq(attendanceSessionMembers.attendanceSessionId, sessionId), eq(attendanceSessionMembers.institutionalId, institutionalId)));

    if (matches.length === 1) {
      status = 'present';
      ltiUserId = matches[0].ltiUserId;
    } else {
      // Zero matches (not on roster) or more than one (ambiguous) both resolve
      // to 'unexpected' -- an ambiguous match must never become 'present' (spec §20).
      status = 'unexpected';
    }
  }

  const cardFingerprint = deps.institution.cardFingerprintEnabled
    ? computeCardFingerprint(input.cardCode, cardFingerprintSecretFor(deps.institution.id))
    : null;

  // Re-resolution of a prior lookup_error: update that row in place.
  if (existing) {
    const [updated] = await db
      .update(attendanceRecords)
      .set({ status, ltiUserId, institutionalId, lookupErrorKind, cardFingerprint, scannedAt: new Date(input.scannedAt), updatedAt: new Date() })
      .where(eq(attendanceRecords.id, existing.id))
      .returning();
    return updated;
  }

  const inserted = await db
    .insert(attendanceRecords)
    .values({
      attendanceSessionId: sessionId,
      ltiUserId,
      institutionalId,
      clientScanId: input.clientScanId,
      status,
      scannedAt: new Date(input.scannedAt),
      source: 'card',
      cardFingerprint,
      lookupErrorKind,
    })
    .onConflictDoNothing({ target: [attendanceRecords.attendanceSessionId, attendanceRecords.clientScanId] })
    .returning();

  if (inserted.length === 1) return inserted[0];

  // Lost the race to a concurrent identical submission (HTTP response lost, client
  // retried while the first request was still committing) -- the winner is already
  // there; return it.
  const [winner] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, input.clientScanId)));
  return winner;
}

// Card-fingerprint secret is app-wide (env var), not per-institution, since only
// one institution is live at this stage. The institutionId parameter is retained
// so a future per-institution secret is a one-function change -- see "Risks /
// open items" for the migration path.  (S3: needs a user ruling.)
function cardFingerprintSecretFor(_institutionId: string): string {
  const secret = process.env.CARD_FINGERPRINT_SECRET;
  if (!secret) throw new Error('CARD_FINGERPRINT_SECRET must be set when card fingerprinting is enabled.');
  return secret;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS — 5 tests green. (The `cardFingerprintEnabled: true` test requires `CARD_FINGERPRINT_SECRET` in the test env — add `CARD_FINGERPRINT_SECRET=test-secret-do-not-use-in-prod` to whichever test-env mechanism Phase 3 established, e.g. `vitest.config.ts`'s `test.env` or the global setup in `server/tests/support/db.ts`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/scan-service.ts server/tests/attendance/scan-service.test.ts
git commit -m "feat: add submitScan — valid scan, closed-session rejection, lookup_error re-resolution, idempotency"
```

---

## Task 6: `scan-service.ts` — not-on-roster, ambiguous match, lookup error, lookup_error retry recovers

**Files:**
- Modify: `server/tests/attendance/scan-service.test.ts` (append)

These tests lock in branches Task 5 already implements — plus the B6 recovery path. State that plainly; this is not a red→green step (Q13).

**Interfaces:**
- Consumes: `submitScan(db, ...)` from Task 5 (unchanged signature).
- Produces: nothing new — additional test coverage for spec §47/§20.

- [ ] **Step 1: Append the tests**

```ts
// append to server/tests/attendance/scan-service.test.ts
import { and, eq } from 'drizzle-orm';
import { attendanceRecords } from '../../src/database/schema.js';

describe('submitScan -- roster matching edge cases', () => {
  it('marks a resolved identity not present in the session snapshot as unexpected, not present', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000'); // only 1000000 is on the roster
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '9999999' }) };

    const record = await submitScan(db, sessionId, { clientScanId: 'scan-1', cardCode: 'CARD999', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('unexpected');
    expect(record.ltiUserId).toBeNull();
    expect(record.institutionalId).toBe('9999999');
  });

  it('marks an ambiguous match (duplicate institutionalId in the snapshot) as unexpected, never present', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane A', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'user-2', institutionalId: '1000000', displayName: 'Jane B', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
    ]);
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(db, session.id, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('unexpected');
    expect(record.ltiUserId).toBeNull();
  });

  it('records a lookup_error status (with lookupErrorKind) when the resolver fails, rather than dropping the scan', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember();
    const resolver: IdentityResolver = { resolveCard: async () => ({ ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'Lookup timed out' } }) };

    const record = await submitScan(db, sessionId, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('lookup_error');
    expect(record.lookupErrorKind).toBe('timeout');
    expect(record.ltiUserId).toBeNull();
    expect(record.institutionalId).toBeNull();
  });

  it('re-resolves a prior lookup_error on retry (same clientScanId) and updates the SAME row to present — no dead end (spec §47, B6)', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    let attempt = 0;
    const resolver: IdentityResolver = {
      resolveCard: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'down' } }
          : successResolution({ universityId: '1000000' });
      },
    };
    const input = { clientScanId: 'retry-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };
    const deps = { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } };

    const first = await submitScan(db, sessionId, input, deps);
    expect(first.status).toBe('lookup_error');

    const second = await submitScan(db, sessionId, input, deps);
    expect(second.id).toBe(first.id); // updated in place, not a new row
    expect(second.status).toBe('present');
    expect(second.ltiUserId).toBe('user-1');

    const rows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, 'retry-1')));
    expect(rows).toHaveLength(1);
    expect(attempt).toBe(2); // resolver WAS called again on the retry
  });
});
```

- [ ] **Step 2: Run the file — every case should pass against Task 5's implementation**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS. If the retry-recovery case fails, the bug is in Task 5 Step 3's idempotency short-circuit (`existing.status !== 'lookup_error'`) or the in-place update branch — fix `scan-service.ts`, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add server/tests/attendance/scan-service.test.ts
git commit -m "test: cover unexpected/ambiguous/lookup_error + lookup_error-retry-recovery scan-service cases"
```

---

## Task 7: `scan-service.ts` — duplicate `clientScanId` and lost-response race

**Files:**
- Modify: `server/tests/attendance/scan-service.test.ts` (append)

These verify the `ON CONFLICT DO NOTHING` + `SELECT`-fallback logic already written in Task 5. Not a red→green step (Q13).

**Interfaces:**
- Consumes: `submitScan(db, ...)` from Task 5.
- Produces: nothing new — coverage for spec §21 idempotency and §47's "duplicate API submission with same `clientScanId`" / "network response lost then retried".

- [ ] **Step 1: Append the tests**

```ts
// append to server/tests/attendance/scan-service.test.ts (vi is already imported; and/eq/attendanceRecords imported in Task 6)
import { vi } from 'vitest';

describe('submitScan -- idempotency', () => {
  it('returns the same settled record, without calling the resolver again, for a duplicate clientScanId submitted sequentially', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolveCard = vi.fn().mockResolvedValue(successResolution({ universityId: '1000000' }));
    const resolver: IdentityResolver = { resolveCard };

    const first = await submitScan(db, sessionId, { clientScanId: 'dup-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });
    const second = await submitScan(db, sessionId, { clientScanId: 'dup-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(second.id).toBe(first.id);
    expect(resolveCard).toHaveBeenCalledTimes(1); // 'present' is settled -> second call short-circuits before the resolver
  });

  it('when two concurrent requests race on the same clientScanId (lost-response-then-retried), exactly one attendance_records row exists and both callers see it', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };
    const input = { clientScanId: 'race-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };
    const deps = { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } };

    const [a, b] = await Promise.all([submitScan(db, sessionId, input, deps), submitScan(db, sessionId, input, deps)]);

    expect(a.id).toBe(b.id);
    const allRows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, 'race-1')));
    expect(allRows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the file**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS. The concurrent case is single-row-correct via `ON CONFLICT DO NOTHING` + the fallback `SELECT` regardless of whether the pre-check `SELECT` wins the race; the pre-check only saves a redundant resolver call in the common sequential case.

- [ ] **Step 3: Commit**

```bash
git add server/tests/attendance/scan-service.test.ts
git commit -m "test: cover clientScanId idempotency under sequential retry and concurrent race"
```

---

## Task 8: `session-lifecycle.ts::closeAttendanceSession` — marks unscanned members absent, writes audit

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts`
- Modify: `server/tests/attendance/session-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: `resolveCurrentRecord` from Task 2; `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords`, `auditEvents`, `courses` from schema.
- Produces: `closeAttendanceSession(db, sessionId, actorLtiUserId, requestId?): Promise<void>` — used by `routes/attendance-sessions.ts`'s `POST .../close` handler.

<!-- reviser note (S6): this task implements spec §25.7 steps 1–2 (transactional finalize + mark remaining members absent). Steps 3–4 (recalculate cumulative attendance, queue Canvas grade synchronization) are Phase 6 per spec §54 — Phase 5 writes the `attendance_session_closed` audit event as the Phase 6 extension point and touches no grade tables (which do not exist yet). -->

- [ ] **Step 1: Append the failing tests**

```ts
// append to server/tests/attendance/session-lifecycle.test.ts
import { closeAttendanceSession } from '../../src/attendance/session-lifecycle.js';
import { attendanceRecords } from '../../src/database/schema.js';

describe('closeAttendanceSession', () => {
  it('inserts a system_absence record (scannedAt null) for every eligible member with no qualifying record, sets state=closed, and writes an audit event with requestId', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'scanned-user', institutionalId: '1000000', displayName: 'Scanned', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'unscanned-user', institutionalId: '2000000', displayName: 'Unscanned', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'ineligible-user', institutionalId: '3000000', displayName: 'Ineligible', eligibleForAttendance: false, status: 'Inactive', snapshotData: {} },
    ]);
    await db.insert(attendanceRecords).values({
      attendanceSessionId: session.id, ltiUserId: 'scanned-user', institutionalId: '1000000',
      clientScanId: 'scan-1', status: 'present', scannedAt: new Date(), source: 'card',
    });

    await closeAttendanceSession(db, session.id, 'instructor-1', 'req-close');

    const [closed] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(closed.state).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    const absenceRecords = records.filter((r) => r.source === 'system_absence');
    expect(absenceRecords).toHaveLength(1);
    expect(absenceRecords[0].ltiUserId).toBe('unscanned-user');
    expect(absenceRecords[0].status).toBe('absent');
    expect(absenceRecords[0].scannedAt).toBeNull();

    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_closed'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].requestId).toBe('req-close');
    expect(events[0].institutionId).not.toBeNull();
  });

  it('does not mark system_absence for a member who already has a qualifying record (e.g. a manual excused correction)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: null, status: 'excused', scannedAt: null, source: 'manual' });

    await closeAttendanceSession(db, session.id, 'instructor-1');

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    expect(records.filter((r) => r.source === 'system_absence')).toHaveLength(0);
  });

  it('rejects a second close with a 409-mapped error (state guard, Q7)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();

    await expect(closeAttendanceSession(db, session.id, 'instructor-1')).rejects.toMatchObject({ code: 'session_already_closed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — `closeAttendanceSession is not a function`.

- [ ] **Step 3: Implement `closeAttendanceSession`**

Append to `server/src/attendance/session-lifecycle.ts` (`resolveCurrentRecord` import added at the top of the file alongside the others):

```ts
import { resolveCurrentRecord } from './member-status.js';

export async function closeAttendanceSession(
  db: Database,
  sessionId: string,
  actorLtiUserId: string,
  requestId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);
    if (session.state === 'closed') throw new SessionAlreadyClosedError(); // Q7 state guard

    // B5: load the course once and use course.institutionId unconditionally
    // (audit_events.institutionId is NOT NULL).
    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId));

    const members = await tx.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, sessionId));
    const records = await tx.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, sessionId));
    const recordsByLtiUserId = new Map<string, typeof records>();
    for (const record of records) {
      if (!record.ltiUserId) continue;
      const list = recordsByLtiUserId.get(record.ltiUserId) ?? [];
      list.push(record);
      recordsByLtiUserId.set(record.ltiUserId, list);
    }

    const now = new Date();
    const absentInserts = members
      .filter((m) => m.eligibleForAttendance)
      .filter((m) => resolveCurrentRecord(recordsByLtiUserId.get(m.ltiUserId) ?? []) === null)
      .map((m) => ({
        attendanceSessionId: sessionId,
        ltiUserId: m.ltiUserId,
        institutionalId: m.institutionalId,
        clientScanId: null,
        status: 'absent' as const,
        scannedAt: null, // system_absence rows were never "scanned at" an instant (spec §26)
        source: 'system_absence' as const,
      }));

    if (absentInserts.length > 0) {
      await tx.insert(attendanceRecords).values(absentInserts);
    }

    await tx.update(attendanceSessions).set({ state: 'closed', closedAt: now, updatedAt: now }).where(eq(attendanceSessions.id, sessionId));

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_closed',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { markedAbsentCount: absentInserts.length },
      requestId: requestId ?? null,
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS — 7 tests total green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "feat: add closeAttendanceSession — marks unscanned eligible members absent, writes audit event"
```

---

## Task 9: `session-lifecycle.ts::reopenAttendanceSession` — audited reopen

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts`
- Modify: `server/tests/attendance/session-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: `attendanceSessions`, `auditEvents`, `courses` from schema.
- Produces: `reopenAttendanceSession(db, sessionId, actorLtiUserId, reason?, requestId?): Promise<void>` — used by `routes/attendance-sessions.ts`'s `POST .../reopen` handler.

- [ ] **Step 1: Append the failing tests**

```ts
// append to server/tests/attendance/session-lifecycle.test.ts
import { reopenAttendanceSession } from '../../src/attendance/session-lifecycle.js';

describe('reopenAttendanceSession', () => {
  it('sets state=reopened, clears closedAt, and writes an audit event including reason + requestId', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed', closedAt: new Date() }).returning();

    await reopenAttendanceSession(db, session.id, 'instructor-1', 'Student reported a missed scan', 'req-reopen');

    const [reopened] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(reopened.state).toBe('reopened');
    expect(reopened.closedAt).toBeNull();

    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_reopened'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].requestId).toBe('req-reopen');
    expect(events[0].newValue).toMatchObject({ reason: 'Student reported a missed scan' });
  });

  it('reopened is a scan-accepting state (not closed)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    await reopenAttendanceSession(db, session.id, 'instructor-1');

    const [reopened] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(reopened.state).not.toBe('closed');
  });

  it('rejects reopening a session that is not closed with a 409-mapped error (state guard, Q7)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();

    await expect(reopenAttendanceSession(db, session.id, 'instructor-1')).rejects.toMatchObject({ code: 'session_not_closed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — `reopenAttendanceSession is not a function`.

- [ ] **Step 3: Implement `reopenAttendanceSession`**

Append to `server/src/attendance/session-lifecycle.ts`:

```ts
export async function reopenAttendanceSession(
  db: Database,
  sessionId: string,
  actorLtiUserId: string,
  reason?: string,
  requestId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);
    if (session.state !== 'closed') throw new SessionNotClosedError(); // Q7 state guard

    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId)); // B5

    await tx.update(attendanceSessions).set({ state: 'reopened', closedAt: null, updatedAt: new Date() }).where(eq(attendanceSessions.id, sessionId));

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_reopened',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { reason: reason ?? null },
      requestId: requestId ?? null,
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS — 10 tests total green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "feat: add reopenAttendanceSession — audited reopen with state guard, scans accepted again"
```

---

## Task 10: `manual-correction.ts` — always appends, never mutates

**Files:**
- Create: `server/src/attendance/manual-correction.ts`
- Test: `server/tests/attendance/manual-correction.test.ts`

**Interfaces:**
- Consumes: `Database` from `client.ts`; `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords`, `auditEvents`, `courses` from schema; `resolveCurrentRecord` from Task 2 (previous status for the audit event's `oldValue`).
- Produces: `applyManualCorrection(db, sessionId, ltiUserId, input, actorLtiUserId, requestId?): Promise<AttendanceRecordRow>` — used by `routes/attendance-sessions.ts`'s `PATCH .../members/{ltiUserId}` handler. `input.status` is `'present' | 'absent' | 'excused'` — **no `'late'`** (deferred, settled decision / S4).

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/manual-correction.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { applyManualCorrection } from '../../src/attendance/manual-correction.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents } from '../../src/database/schema.js';

const { db } = getTestDb();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
});

async function seedSessionWithScannedMember() {
  const { courseId } = await seedInstitutionAndCourse(db);
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
  await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
  await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date(), source: 'card' });
  return session.id;
}

describe('applyManualCorrection', () => {
  it('inserts a new source=manual record (scannedAt null) rather than mutating the existing one', async () => {
    const sessionId = await seedSessionWithScannedMember();

    const result = await applyManualCorrection(db, sessionId, 'user-1', { status: 'excused', note: 'Institution-approved absence' }, 'instructor-1');

    expect(result.status).toBe('excused');
    expect(result.source).toBe('manual');
    expect(result.scannedAt).toBeNull();
    const allRecords = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.ltiUserId, 'user-1')));
    expect(allRecords).toHaveLength(2); // original 'present' card scan untouched, new 'excused' manual record appended
    expect(allRecords.some((r) => r.status === 'present' && r.source === 'card')).toBe(true);
  });

  it('writes an attendance_manual_change audit event with actor/prev-status/new-status/note/requestId and no note column on attendance_records', async () => {
    const sessionId = await seedSessionWithScannedMember();

    const result = await applyManualCorrection(db, sessionId, 'user-1', { status: 'absent', note: 'Left early, unexcused' }, 'instructor-1', 'req-mc');

    expect(Object.keys(result)).not.toContain('note'); // matches spec §26's literal column list
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_manual_change'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].targetId).toBe('user-1');
    expect(events[0].requestId).toBe('req-mc');
    expect(events[0].oldValue).toMatchObject({ status: 'present' });
    expect(events[0].newValue).toMatchObject({ status: 'absent', note: 'Left early, unexcused' });
  });

  it('works for a member with no prior record (oldValue is null)', async () => {
    const { courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-2', institutionalId: '2000000', displayName: 'No Scan', eligibleForAttendance: true, status: 'Active', snapshotData: {} });

    const result = await applyManualCorrection(db, session.id, 'user-2', { status: 'excused' }, 'instructor-1');

    expect(result.status).toBe('excused');
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_manual_change'));
    expect(events[0].oldValue).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/manual-correction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/attendance/manual-correction.ts
//
// Manual corrections always INSERT a new attendance_records row -- never
// UPDATE an existing one -- so member-status.ts's "most recent record wins"
// stays the single rule everywhere. The correction note lives only in
// audit_events.new_value (JSONB); there is deliberately no `note` column on
// attendance_records (spec §26's literal column list). 'late' is NOT an
// accepted status this phase (deferred, settled decision).

import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, courses, type AttendanceRecordRow } from '../database/schema.js';
import { resolveCurrentRecord } from './member-status.js';

export async function applyManualCorrection(
  db: Database,
  sessionId: string,
  ltiUserId: string,
  input: { status: 'present' | 'absent' | 'excused'; note?: string },
  actorLtiUserId: string,
  requestId?: string,
): Promise<AttendanceRecordRow> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);

    const [member] = await tx
      .select()
      .from(attendanceSessionMembers)
      .where(and(eq(attendanceSessionMembers.attendanceSessionId, sessionId), eq(attendanceSessionMembers.ltiUserId, ltiUserId)));
    if (!member) throw new Error(`No roster-snapshot member ${ltiUserId} in session ${sessionId}.`);

    const priorRecords = await tx
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.ltiUserId, ltiUserId)));
    const priorCurrent = resolveCurrentRecord(priorRecords);

    const [inserted] = await tx
      .insert(attendanceRecords)
      .values({
        attendanceSessionId: sessionId,
        ltiUserId,
        institutionalId: member.institutionalId,
        clientScanId: null,
        status: input.status,
        scannedAt: null, // a manual correction was not "scanned at" this instant (spec §26)
        source: 'manual',
      })
      .returning();

    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId));
    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_manual_change',
      targetType: 'attendance_session_member',
      targetId: ltiUserId,
      oldValue: priorCurrent ? { status: priorCurrent.status } : null,
      newValue: { status: input.status, note: input.note ?? null },
      requestId: requestId ?? null,
    });

    return inserted;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/manual-correction.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/manual-correction.ts server/tests/attendance/manual-correction.test.ts
git commit -m "feat: add applyManualCorrection — append-only, audited, note in JSONB only"
```

---

## Task 11: `csv-export.ts` — parity with `web/csv.js`

**Files:**
- Create: `server/src/attendance/csv-export.ts`
- Test: `server/tests/attendance/csv-export.test.ts`

**Interfaces:**
- Consumes: nothing from the database — pure function over already-fetched rows.
- Produces: `buildAttendanceSessionCsv(rows: AttendanceExportRow[]): string` — used by `routes/attendance-sessions.ts`'s `GET .../export.csv` handler. Renamed from `buildAttendanceCsv` to avoid a name collision with `web/csv.js`'s unrelated client-side `buildAttendanceCsv` (Q4).

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/csv-export.test.ts
import { describe, it, expect } from 'vitest';
import { buildAttendanceSessionCsv } from '../../src/attendance/csv-export.js';

describe('buildAttendanceSessionCsv', () => {
  it('produces a header row plus one row per member, CRLF-joined', () => {
    const csv = buildAttendanceSessionCsv([
      { ltiUserId: 'u1', institutionalId: '1000000', displayName: 'Jane Smith', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'card' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('institutionalId,displayName,status,source,scannedAt');
    expect(lines[1]).toBe('1000000,Jane Smith,present,card,2026-08-26T10:00:00.000Z');
  });

  it('quotes a field containing a comma, double quote, or newline, and doubles embedded quotes (RFC 4180)', () => {
    const csv = buildAttendanceSessionCsv([{ ltiUserId: 'u1', institutionalId: '1000000', displayName: 'Smith, "Jane"', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'manual' }]);
    expect(csv).toContain('"Smith, ""Jane"""');
  });

  it('renders a null field as an empty string, matching web/csv.js\'s csvEscapeField (a manual row has scannedAt null)', () => {
    const csv = buildAttendanceSessionCsv([{ ltiUserId: 'u1', institutionalId: null, displayName: null, status: 'excused', scannedAt: null, source: 'manual' }]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toBe(',,excused,manual,');
  });

  it('returns just the header row for an empty record set', () => {
    const csv = buildAttendanceSessionCsv([]);
    expect(csv).toBe('institutionalId,displayName,status,source,scannedAt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/csv-export.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/attendance/csv-export.ts
//
// Server-side port of web/csv.js's csvEscapeField, operating on
// AttendanceExportRow (already-resolved-to-current-status DB rows) instead
// of in-memory ScanRecord objects. The escaping rule is copied verbatim so
// exports produced before/after the Phase 5 migration are byte-identical
// for any field whose content doesn't change.

const COLUMNS = ['institutionalId', 'displayName', 'status', 'source', 'scannedAt'] as const;

export interface AttendanceExportRow {
  ltiUserId: string;
  institutionalId: string | null;
  displayName: string | null;
  status: string;
  scannedAt: string | null;
  source: string;
}

/** Verbatim port of web/csv.js's csvEscapeField. */
function csvEscapeField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildAttendanceSessionCsv(rows: AttendanceExportRow[]): string {
  const lines = [COLUMNS.map(csvEscapeField).join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => csvEscapeField(row[column])).join(','));
  }
  return lines.join('\r\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/csv-export.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/csv-export.ts server/tests/attendance/csv-export.test.ts
git commit -m "feat: add server-side buildAttendanceSessionCsv, byte-identical escaping to web/csv.js"
```

---

## Task 12: `routes/attendance-sessions.ts` — wire every route, real auth, tenant isolation

**Files:**
- Create: `server/src/routes/attendance-sessions.ts`
- Test: `server/tests/routes/attendance-sessions.test.ts`
- Modify: `server/src/index.ts` (build `createRequireCsrf`, register the route on the ROOT app with real preHandlers)

**Interfaces:**
- Consumes: `createAttendanceSession`/`closeAttendanceSession`/`reopenAttendanceSession` (Tasks 4/8/9), `submitScan` (Task 5), `applyManualCorrection` (Task 10), `buildAttendanceSessionCsv` (Task 11), `resolveCurrentRecord` (Task 2); `Database` from `client.ts`; the preHandler functions produced by `createRequireSession(db)` / `createRequireCsrf(env.APP_BASE_URL)` (`server/src/auth/middleware.ts`); `IdentityResolver` from `server/src/identity/types.ts` (the `createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver()` already built in `index.ts`).
- Produces: `registerAttendanceSessionsRoute(app, deps)` where `deps: AttendanceSessionsRouteDeps { db: Database; resolver: IdentityResolver; requireSession: preHandler; requireCsrf: preHandler }` (D1/D6). Mounted on the ROOT `app` in `index.ts` (like `/api/me`), NOT inside the `/lti/*` rate-limit plugin scope — `POST .../scans` must inherit no rate limit (spec §31.10).

Route → preHandler map (D6):
| route | preHandler |
| --- | --- |
| `POST /api/attendance-sessions` | `[requireSession, requireCsrf]` |
| `GET /api/attendance-sessions/:id` | `requireSession` |
| `POST /api/attendance-sessions/:id/scans` | `[requireSession, requireCsrf]` |
| `PATCH /api/attendance-sessions/:id/members/:ltiUserId` | `[requireSession, requireCsrf]` |
| `DELETE /api/attendance-sessions/:id/members/:ltiUserId/records/:recordId` | `[requireSession, requireCsrf]` |
| `POST /api/attendance-sessions/:id/close` | `[requireSession, requireCsrf]` |
| `POST /api/attendance-sessions/:id/reopen` | `[requireSession, requireCsrf]` |
| `GET /api/attendance-sessions/:id/export.csv` | `requireSession` |

Error mapping (S5): every handler maps a thrown `code` to an opaque body `{ error: <code>, requestId: request.id }` and logs the real error via `request.log.error({ err, reqId: request.id })`. `session_closed` → 409, `session_already_closed` → 409, `session_not_closed` → 409, `roster_unavailable` → 502, anything else → rethrow (Fastify's default 500, which does not leak internals in production) after logging. Never send `Error.message` to the client.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/routes/attendance-sessions.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { registerAttendanceSessionsRoute } from '../../src/routes/attendance-sessions.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents } from '../../src/database/schema.js';
import type { IdentityResolver } from '../../src/identity/types.js';

// createAttendanceSession degrades through the shared helper -> mock it (Q3).
vi.mock('../../src/attendance/roster-store.js', () => ({ getRosterWithFallback: vi.fn() }));
import { getRosterWithFallback } from '../../src/attendance/roster-store.js';

const { db } = getTestDb();
afterAll(() => closeTestDb());

beforeEach(async () => {
  await resetDb();
  vi.mocked(getRosterWithFallback).mockReset();
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false });
});

type FakeSession = { id: string; institutionId: string; deploymentId: string; ltiSubject: string; displayName: string | null; courseId: string; roles: string[]; csrfSecret: string };

// Fakes for the two real preHandlers. requireSession copies the fixed session
// onto request.appSession (or 401 if `session` is null). requireCsrf 403s a
// mutation whose x-csrf-token header != session.csrfSecret. This mirrors the
// real middleware.ts contract closely enough to exercise route wiring.
function fakeRequireSession(session: FakeSession | null) {
  return async (request: any, reply: any) => {
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });
    request.appSession = session;
  };
}
function fakeRequireCsrf() {
  return async (request: any, reply: any) => {
    const provided = request.headers['x-csrf-token'];
    if (provided !== request.appSession?.csrfSecret) return reply.code(403).send({ error: 'csrf_check_failed' });
  };
}

function buildTestApp({ resolver, session }: { resolver: IdentityResolver; session: FakeSession | null }): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAttendanceSessionsRoute(app, {
    db,
    resolver,
    requireSession: fakeRequireSession(session),
    requireCsrf: fakeRequireCsrf(),
  });
  return app;
}

function makeSession(over: Partial<FakeSession> & Pick<FakeSession, 'institutionId' | 'courseId'>): FakeSession {
  return { id: 's1', deploymentId: 'dep-1', ltiSubject: 'instructor-1', displayName: 'Prof', roles: [], csrfSecret: 'secret-xyz', ...over };
}
const CSRF = { 'x-csrf-token': 'secret-xyz' };

describe('attendance-sessions routes — auth wiring', () => {
  it('an unauthenticated request (no session) returns 401', async () => {
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: null });
    const response = await app.inject({ method: 'GET', url: '/api/attendance-sessions/00000000-0000-0000-0000-000000000000' });
    expect(response.statusCode).toBe(401);
  });

  it('a mutation without a valid x-csrf-token returns 403', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const response = await app.inject({ method: 'POST', url: '/api/attendance-sessions', payload: {} }); // no CSRF header
    expect(response.statusCode).toBe(403);
  });
});

describe('attendance-sessions routes', () => {
  it('POST /api/attendance-sessions creates a session scoped to the caller\'s course and returns a normalized body', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: '/api/attendance-sessions', headers: CSRF, payload: {} });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.courseId).toBe(courseId);
    expect(body).not.toHaveProperty('rosterSnapshotVersion'); // normalized, not the raw Drizzle row (Q14)
  });

  it('GET /api/attendance-sessions/{id} on another institution\'s session returns 404, not 403', async () => {
    const { courseId: ownCourseId, institutionId: ownInstitutionId } = await seedInstitutionAndCourse(db);
    const { courseId: otherCourseId } = await seedInstitutionAndCourse(db);
    const [otherSession] = await db.insert(attendanceSessions).values({ courseId: otherCourseId, startedByLtiUserId: 'someone-else', state: 'open' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId: ownInstitutionId, courseId: ownCourseId }) });

    const response = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${otherSession.id}` });

    expect(response.statusCode).toBe(404);
  });

  it('POST .../scans records a scan and returns the normalized record', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null }) };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload: { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() } });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('present');
    expect(response.json()).not.toHaveProperty('cardFingerprint'); // Q14
  });

  it('POST .../scans never echoes the raw cardCode back in the response', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null }) };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload: { clientScanId: 'scan-1', cardCode: 'SUPERSECRETCARD42', scannedAt: new Date().toISOString() } });

    expect(JSON.stringify(response.json())).not.toContain('SUPERSECRETCARD42');
  });

  it('POST .../scans: a lookup_error followed by a successful retry (same clientScanId) yields a present current record (B6, route-level)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    let n = 0;
    const resolver: IdentityResolver = {
      resolveCard: vi.fn().mockImplementation(async () => {
        n += 1;
        return n === 1
          ? { ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'down' } }
          : { ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: null, raw: {}, error: null };
      }),
    };
    const app = buildTestApp({ resolver, session: makeSession({ institutionId, courseId }) });
    const payload = { clientScanId: 'retry-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };

    const first = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload });
    expect(first.json().status).toBe('lookup_error');
    const second = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, headers: CSRF, payload });
    expect(second.json().status).toBe('present');

    const rows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, session.id), eq(attendanceRecords.clientScanId, 'retry-1')));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('present');
  });

  it('POST .../close closes the session and marks unscanned eligible members absent', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/close`, headers: CSRF });

    expect(response.statusCode).toBe(200);
    const [closed] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(closed.state).toBe('closed');
  });

  it('POST .../close on an already-closed session returns 409', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/close`, headers: CSRF });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'session_already_closed' });
    expect(response.json().requestId).toBeTruthy();
  });

  it('POST .../reopen reopens a closed session; reopening an open session returns 409', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [closedSession] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const [openSession] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    expect((await app.inject({ method: 'POST', url: `/api/attendance-sessions/${closedSession.id}/reopen`, headers: CSRF, payload: { reason: 'Missed scans' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/attendance-sessions/${openSession.id}/reopen`, headers: CSRF })).statusCode).toBe(409);
  });

  it('PATCH .../members/{ltiUserId} applies a manual correction; a "late" status is rejected 400 (deferred)', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const ok = await app.inject({ method: 'PATCH', url: `/api/attendance-sessions/${session.id}/members/user-1`, headers: CSRF, payload: { status: 'excused', note: 'Approved absence' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('excused');

    const late = await app.inject({ method: 'PATCH', url: `/api/attendance-sessions/${session.id}/members/user-1`, headers: CSRF, payload: { status: 'late' } });
    expect(late.statusCode).toBe(400);
  });

  it('DELETE .../members/{ltiUserId}/records/{recordId} removes a mis-scanned record and writes an audit event with requestId', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    const [record] = await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date(), source: 'card' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${session.id}/members/user-1/records/${record.id}`, headers: CSRF });

    expect(response.statusCode).toBe(204);
    expect(await db.select().from(attendanceRecords).where(eq(attendanceRecords.id, record.id))).toHaveLength(0);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_record_removed'));
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBeTruthy();
  });

  it('GET .../export.csv returns a CSV body with the current-record status per member', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db);
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane Smith', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date('2026-08-26T10:00:00.000Z'), source: 'card' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

    const response = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${session.id}/export.csv` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('1000000,Jane Smith,present,card');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/routes/attendance-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route module**

```ts
// server/src/routes/attendance-sessions.ts
//
// Every route requires request.appSession (from the injected requireSession
// preHandler); every mutation also requires requireCsrf. Every session/record
// lookup is scoped to request.appSession.courseId; a resource in a different
// course returns 404 (never 403) to avoid leaking existence across tenants.
// Errors are mapped to opaque codes + request.id (spec §31.9) -- no internal
// Error.message reaches the client.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, courses, type AttendanceRecordRow, type AttendanceSessionRow } from '../database/schema.js';
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession } from '../attendance/session-lifecycle.js';
import { submitScan } from '../attendance/scan-service.js';
import { applyManualCorrection } from '../attendance/manual-correction.js';
import { buildAttendanceSessionCsv } from '../attendance/csv-export.js';
import { resolveCurrentRecord } from '../attendance/member-status.js';
import type { IdentityResolver } from '../identity/types.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface AttendanceSessionsRouteDeps {
  db: Database;
  resolver: IdentityResolver;
  requireSession: PreHandler;
  requireCsrf: PreHandler;
}

const createSessionSchema = z.object({ label: z.string().optional(), meetingAt: z.string().datetime().optional() });
const scanSchema = z.object({ clientScanId: z.string().min(1), cardCode: z.string().min(1), scannedAt: z.string().datetime() });
// 'late' deliberately omitted -- deferred this phase (settled decision / S4).
const manualCorrectionSchema = z.object({ status: z.enum(['present', 'absent', 'excused']), note: z.string().optional() });
const reopenSchema = z.object({ reason: z.string().optional() }).optional();

// Q14: never return the raw Drizzle row -- serialize an explicit shape.
function serializeSession(s: AttendanceSessionRow) {
  return { id: s.id, courseId: s.courseId, state: s.state, label: s.label, meetingAt: s.meetingAt, openedAt: s.openedAt, closedAt: s.closedAt, startedByLtiUserId: s.startedByLtiUserId };
}
function serializeRecord(r: AttendanceRecordRow) {
  return { id: r.id, attendanceSessionId: r.attendanceSessionId, ltiUserId: r.ltiUserId, institutionalId: r.institutionalId, clientScanId: r.clientScanId, status: r.status, source: r.source, scannedAt: r.scannedAt, lookupErrorKind: r.lookupErrorKind };
}

const HTTP_FOR_CODE: Record<string, number> = { session_closed: 409, session_already_closed: 409, session_not_closed: 409, roster_unavailable: 502 };

/** Map a thrown service error to an opaque response, or rethrow for Fastify's 500. */
function replyForError(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  const code = (err as { code?: string }).code;
  request.log.error({ err, reqId: request.id }, 'attendance-sessions route error');
  if (code && HTTP_FOR_CODE[code]) return reply.code(HTTP_FOR_CODE[code]).send({ error: code, requestId: request.id });
  throw err;
}

/** request.appSession is augmented by middleware.ts; guard the undefined case (Q5). */
function sessionOf(request: FastifyRequest, reply: FastifyReply) {
  const s = request.appSession;
  if (!s) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  return s;
}

export function registerAttendanceSessionsRoute(app: FastifyInstance, deps: AttendanceSessionsRouteDeps): void {
  const { db } = deps;
  const mutation = { preHandler: [deps.requireSession, deps.requireCsrf] as PreHandler[] };
  const readOnly = { preHandler: deps.requireSession };

  async function loadSessionScopedToCourse(sessionId: string, courseId: string) {
    const [session] = await db.select().from(attendanceSessions).where(and(eq(attendanceSessions.id, sessionId), eq(attendanceSessions.courseId, courseId)));
    return session ?? null;
  }

  app.post('/api/attendance-sessions', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const created = await createAttendanceSession(db, session.courseId, session.ltiSubject, parsed.data, request.id);
      return reply.code(201).send(serializeSession(created));
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.get('/api/attendance-sessions/:id', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const members = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, id));
    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, id));
    const byUser = groupRecordsByUser(records);

    return {
      session: serializeSession(row),
      members: members.map((m) => ({
        ltiUserId: m.ltiUserId,
        displayName: m.displayName,
        institutionalId: m.institutionalId,
        eligibleForAttendance: m.eligibleForAttendance,
        currentRecord: mapCurrent(resolveCurrentRecord(byUser.get(m.ltiUserId) ?? [])),
      })),
    };
  });

  app.post('/api/attendance-sessions/:id/scans', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    try {
      const record = await submitScan(db, id, parsed.data, {
        resolver: deps.resolver,
        institution: { id: session.institutionId, cardFingerprintEnabled: process.env.CARD_FINGERPRINT_SECRET != null },
      });
      return serializeRecord(record);
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.patch('/api/attendance-sessions/:id/members/:ltiUserId', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id, ltiUserId } = request.params as { id: string; ltiUserId: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const parsed = manualCorrectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    try {
      const record = await applyManualCorrection(db, id, ltiUserId, parsed.data, session.ltiSubject, request.id);
      return serializeRecord(record);
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.delete('/api/attendance-sessions/:id/members/:ltiUserId/records/:recordId', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id, ltiUserId, recordId } = request.params as { id: string; ltiUserId: string; recordId: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const [record] = await db
      .select()
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.attendanceSessionId, id), eq(attendanceRecords.ltiUserId, ltiUserId)));
    if (!record) return reply.code(404).send({ error: 'not_found' });

    const [course] = await db.select().from(courses).where(eq(courses.id, row.courseId));
    await db.transaction(async (tx) => {
      await tx.delete(attendanceRecords).where(eq(attendanceRecords.id, recordId));
      await tx.insert(auditEvents).values({
        institutionId: course.institutionId,
        courseId: row.courseId,
        attendanceSessionId: id,
        actorLtiUserId: session.ltiSubject,
        eventType: 'attendance_record_removed',
        targetType: 'attendance_record',
        targetId: recordId,
        oldValue: { status: record.status, source: record.source },
        requestId: request.id,
      });
    });

    return reply.code(204).send();
  });

  app.post('/api/attendance-sessions/:id/close', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    try {
      await closeAttendanceSession(db, id, session.ltiSubject, request.id);
      return { ok: true };
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.post('/api/attendance-sessions/:id/reopen', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const parsed = reopenSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      await reopenAttendanceSession(db, id, session.ltiSubject, parsed.data?.reason, request.id);
      return { ok: true };
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.get('/api/attendance-sessions/:id/export.csv', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found' });

    const members = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, id));
    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, id));
    const byUser = groupRecordsByUser(records);

    const exportRows = members.map((m) => {
      const current = resolveCurrentRecord(byUser.get(m.ltiUserId) ?? []);
      return {
        ltiUserId: m.ltiUserId,
        institutionalId: m.institutionalId,
        displayName: m.displayName,
        status: current?.status ?? 'absent',
        scannedAt: current?.scannedAt ? new Date(current.scannedAt).toISOString() : null,
        source: current?.source ?? '',
      };
    });

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    return buildAttendanceSessionCsv(exportRows);
  });
}

function groupRecordsByUser(records: AttendanceRecordRow[]): Map<string, AttendanceRecordRow[]> {
  const byUser = new Map<string, AttendanceRecordRow[]>();
  for (const record of records) {
    if (!record.ltiUserId) continue;
    const list = byUser.get(record.ltiUserId) ?? [];
    list.push(record);
    byUser.set(record.ltiUserId, list);
  }
  return byUser;
}
function mapCurrent(r: AttendanceRecordRow | null) {
  return r ? serializeRecord(r) : null;
}
```

- [ ] **Step 4: Mount the route in `server/src/index.ts` with real auth (D6)**

`index.ts` already builds `const requireSession = createRequireSession(db)`. Add the CSRF factory and register on the ROOT `app` (like `registerMeRoute`), NOT inside the `/lti/*` rate-limit plugin scope:

```ts
// server/src/index.ts
import { createRequireSession, createRequireCsrf } from './auth/middleware.js'; // extend the existing import
import { registerAttendanceSessionsRoute } from './routes/attendance-sessions.js';

// ...where requireSession is currently built:
const requireSession = createRequireSession(db);
const requireCsrf = createRequireCsrf(env.APP_BASE_URL);
registerMeRoute(app, { requireSession, db });
registerAttendanceSessionsRoute(app, { db, resolver: identityResolver, requireSession, requireCsrf });
// NOTE: identityResolver must be constructed BEFORE this call -- move the
// `const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();`
// line above this registration (it is currently just above registerScansRoute).
```

`registerScansRoute(app, identityResolver)` and its DELIBERATE comment stay for now — Task 17 removes them once the UI is migrated.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/routes/attendance-sessions.test.ts`
Expected: PASS — 13 tests green.

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green, no new errors. `server/tests/routes/hardening.test.ts` is unaffected (it references neither `/api/scans` nor the attendance routes).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/attendance-sessions.ts server/src/index.ts server/tests/routes/attendance-sessions.test.ts
git commit -m "feat: wire attendance-sessions routes behind requireSession/requireCsrf with tenant isolation + opaque errors"
```

---

## Task 13: `web/api-client.js` — CSRF bootstrap + shared authenticated `fetch` wrapper

Once Task 12 protects every mutation with `requireCsrf`, an unadorned `fetch` from the browser 403s (`csrf_check_failed`). `GET /api/me` already returns `csrfToken` (= `session.csrfSecret`). This task adds one small module every Phase 5 client mutation goes through (D7/B3). It must land before Task 14 (scan-pipeline) and Task 15 (attendance-session.js), which consume it.

**Files:**
- Create: `web/api-client.js`
- Create: `web/tests/api-client.test.js`

**Interfaces:**
- Consumes: `GET /api/me` (Phase 3, unchanged).
- Produces:
  - `bootstrapSession(): Promise<{ ok: boolean, me?: object, error?: object }>` — `GET /api/me`, caches `csrfToken` + the `me` payload module-side; call once from `app.js`'s `init()`.
  - `getCsrfToken(): string | null` — the cached token.
  - `apiFetch(url, { method?, body?, headers? }): Promise<Response>` — thin `fetch` wrapper that, for any non-GET method, sets `Content-Type: application/json`, JSON-stringifies `body`, and attaches `x-csrf-token: <cached token>`. GETs pass through untouched. Never form-encodes. Does not swallow errors — callers (`scan-pipeline.js`, `attendance-session.js`) keep their own never-throws handling.

- [ ] **Step 1: Write the failing test**

```js
// web/tests/api-client.test.js
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { bootstrapSession, getCsrfToken, apiFetch } from '../api-client.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('api-client', () => {
  it('bootstrapSession GETs /api/me and caches csrfToken for later apiFetch calls', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-123', course: { id: 'c1' } }) });

    const result = await bootstrapSession();

    expect(global.fetch).toHaveBeenCalledWith('/api/me', expect.objectContaining({ method: 'GET' }));
    expect(result.ok).toBe(true);
    expect(getCsrfToken()).toBe('tok-123');
  });

  it('apiFetch attaches x-csrf-token and a JSON content-type on a mutation', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-123' }) });
    await bootstrapSession();
    global.fetch.mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({}) });

    await apiFetch('/api/attendance-sessions', { method: 'POST', body: { label: 'x' } });

    const [, init] = global.fetch.mock.calls.at(-1);
    expect(init.method).toBe('POST');
    expect(init.headers['x-csrf-token']).toBe('tok-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ label: 'x' }));
  });

  it('apiFetch leaves a GET untouched (no csrf header, no body)', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await apiFetch('/api/attendance-sessions/s1');
    const [, init] = global.fetch.mock.calls.at(-1);
    expect(init?.headers?.['x-csrf-token']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('bootstrapSession returns a normalized error result on a non-2xx /api/me (never throws)', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({ error: 'unauthenticated' }) });
    const result = await bootstrapSession();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/tests/api-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// web/api-client.js
//
// One place that knows the CSRF token and how to send an authenticated
// mutation. Every Phase 5 client mutation goes through apiFetch(); without
// the x-csrf-token header the server (Task 12's requireCsrf) returns 403.

let csrfToken = null;
let me = null;

/** GET /api/me; cache csrfToken + payload. Never throws. Call once from app.js init(). */
export async function bootstrapSession() {
  let response;
  try {
    response = await fetch('/api/me', { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `GET /api/me failed: ${err.message}` } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `GET /api/me returned HTTP ${response.status}` } };
  }
  try {
    me = await response.json();
  } catch (err) {
    return { ok: false, error: { kind: 'bad-json', message: `GET /api/me returned invalid JSON: ${err.message}` } };
  }
  csrfToken = me?.csrfToken ?? null;
  return { ok: true, me };
}

export function getCsrfToken() {
  return csrfToken;
}

/**
 * fetch() wrapper: for a non-GET method, sets a JSON content type, JSON-encodes
 * `body`, and attaches x-csrf-token. GET requests pass straight through.
 * @param {string} url
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 * @returns {Promise<Response>}
 */
export function apiFetch(url, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    return fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
  }
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-csrf-token': csrfToken ?? '',
      ...(options.headers ?? {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/tests/api-client.test.js`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/api-client.js web/tests/api-client.test.js
git commit -m "feat: add web api-client — CSRF bootstrap from /api/me + authenticated apiFetch wrapper"
```

---

## Task 14: `web/scan-pipeline.js` — session-scoped transport, server status trusted verbatim

**Files:**
- Modify: `web/scan-pipeline.js`
- Modify: `web/tests/scan-pipeline.test.js`

**Interfaces:**
- Consumes: `apiFetch` from `web/api-client.js` (Task 13); `roster.js`'s `isExpected`/`getRosterRow` import is removed from this file (still exported from `roster.js` itself for the standalone/demo-mode path, per this plan's Global Constraints).
- Produces: `ScanPipeline` now constructed with a `sessionId` and calls `submitScan(sessionId, clientScanId, cardCode)` (which POSTs via `apiFetch`); every `ScanRecord`'s `status` comes directly from the server response; `clientScanId` is a `crypto.randomUUID()` (Q11).

- [ ] **Step 1: Update the failing/changed tests first**

Replace the top of `web/tests/scan-pipeline.test.js` so the mocked transport is `api-client.js`'s `apiFetch` (not raw `fetch`), matching the new endpoint/payload, and so server responses carry `status`/`clientScanId` directly (no more client-computed `rosterStatus`):

```js
// web/tests/scan-pipeline.test.js -- mock the api-client wrapper (Task 13) instead of global.fetch
vi.mock('../api-client.js', () => ({
  apiFetch: vi.fn((url, init) => {
    expect(url).toBe(`/api/attendance-sessions/${TEST_SESSION_ID}/scans`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    return lookupCardMock(body.cardCode).then((result) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(result),
    }));
  }),
}));

const TEST_SESSION_ID = 'session-under-test';

function successResult(overrides = {}) {
  return {
    id: 'record-1',
    attendanceSessionId: TEST_SESSION_ID,
    ltiUserId: 'user-1',
    institutionalId: '1000000',
    status: 'present',
    lookupErrorKind: null,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

function errorResult(kind, overrides = {}) {
  return {
    id: 'record-1',
    attendanceSessionId: TEST_SESSION_ID,
    ltiUserId: null,
    institutionalId: null,
    status: 'lookup_error',
    lookupErrorKind: kind,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

function unexpectedResult(overrides = {}) {
  return {
    id: 'record-1',
    attendanceSessionId: TEST_SESSION_ID,
    ltiUserId: null,
    institutionalId: '9999999',
    status: 'unexpected',
    lookupErrorKind: null,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}
```

Update `makePipeline` to pass `sessionId`, and remove `rosterEnabled`/`rosterIndex` from every test (the server now decides `status`, so there is no client-side roster branch to exercise this way):

```js
function makePipeline() {
  const callbacks = {
    onRecordCreated: vi.fn(),
    onRecordUpdated: vi.fn(),
    onLatestScanUpdate: vi.fn(),
    onStatsChanged: vi.fn(),
  };
  const pipeline = new ScanPipeline({ sessionId: TEST_SESSION_ID, callbacks });
  return { pipeline, callbacks };
}
```

Update every existing assertion of `updated.status).toBe('accepted')`/`'lookup-error'` to the new server-vocabulary values (`'present'`/`'lookup_error'`), and every `pipeline.getStats().totalAccepted`/`.expected`/`.unexpected`/`.lookupErrors` assertion stays conceptually the same but now keys off `result.status` directly rather than a locally-recomputed `rosterStatus`. Replace the two roster-matching tests (`'marks an identity resolved but not present on the roster as unexpected'` and `'marks an identity present on the roster as expected and attaches the roster row'`) with:

```js
it('trusts the server-provided status verbatim rather than recomputing a roster match locally', async () => {
  const { pipeline, callbacks } = makePipeline();
  lookupCardMock.mockReturnValueOnce(Promise.resolve(unexpectedResult()));

  pipeline.handleParsedReport(parsedReport('CARD001'));
  await flushAsync();

  const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
  expect(updated.status).toBe('unexpected');
  expect(pipeline.getStats().unexpected).toBe(1);
});

it('marks an identity resolved and matched on the server as present', async () => {
  const { pipeline, callbacks } = makePipeline();
  lookupCardMock.mockReturnValueOnce(Promise.resolve(successResult({ institutionalId: '1000000' })));

  pipeline.handleParsedReport(parsedReport('CARD001'));
  await flushAsync();

  const updated = callbacks.onRecordUpdated.mock.calls.at(-1)[0];
  expect(updated.status).toBe('present');
  expect(pipeline.getStats().totalAccepted).toBe(1);
});
```

Every other existing test (two-cards-rapidly, stale-lookup-doesn't-clobber-latest, suppress-within-window, suppress-after-removal-within-window, accept-after-window-elapses, retry-in-place-after-lookup-error, deleted-while-pending) keeps its structure — only its `successResult()`/`errorResult()` payload shape and `status`-value assertions change per the mapping above (`'accepted'` → `'present'`, `'lookup-error'` → `'lookup_error'`).

Add one case for the Q9 guard:

```js
it('ignores a parsed report when no attendance session is active (sessionId null) and does not call the transport', async () => {
  const callbacks = { onRecordCreated: vi.fn(), onRecordUpdated: vi.fn(), onLatestScanUpdate: vi.fn(), onStatsChanged: vi.fn() };
  const pipeline = new ScanPipeline({ sessionId: null, callbacks });

  pipeline.handleParsedReport(parsedReport('CARD001'));
  await flushAsync();

  expect(callbacks.onRecordCreated).not.toHaveBeenCalled();
  const { apiFetch } = await import('../api-client.js');
  expect(apiFetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/tests/scan-pipeline.test.js`
Expected: FAIL — `apiFetch` not called with the new URL / `submitScan` still uses raw `fetch`, since `scan-pipeline.js` hasn't changed yet.

- [ ] **Step 3: Update `web/scan-pipeline.js`**

Replace lines 14–67 (the imports and `submitScan`/`performSubmit` functions) with:

```js
import { DUPLICATE_SUPPRESS_WINDOW_MS } from './config.js';
import { logEvent } from './diagnostics.js';
import { apiFetch } from './api-client.js';

/**
 * Submits a scanned card code to this attendance session's backend endpoint
 * (POST /api/attendance-sessions/{sessionId}/scans) and returns the server's
 * normalized attendance record. Per spec §29, this replaces the old
 * cardCode-only submitScan(): the server now also resolves roster matching
 * (against this session's immutable roster snapshot), so the returned
 * `status` is trusted verbatim -- this module no longer recomputes it
 * against a local roster index. Like the function it replaces, this never
 * throws or rejects: a network failure or non-2xx response is folded into a
 * normalized 'lookup_error' shape so a failed request still yields a
 * recordable, visible row rather than an unhandled rejection.
 * @param {string} sessionId
 * @param {string} clientScanId
 * @param {string} cardCode
 * @returns {Promise<{status: string, ltiUserId: string|null, institutionalId: string|null, lookupErrorKind: string|null, scannedAt: string}>}
 */
async function submitScan(sessionId, clientScanId, cardCode) {
  logEvent('lookup-request', { cardCode });

  const result = await performSubmit(sessionId, clientScanId, cardCode);

  // Diagnostics intentionally omit any name/email the server might echo,
  // to limit incidental exposure of student PII in copyable diagnostics
  // text; institutionalId and status are the most useful fields for
  // debugging a scan failure.
  logEvent('lookup-result', { cardCode, status: result.status, institutionalId: result.institutionalId, lookupErrorKind: result.lookupErrorKind });

  return result;
}

/**
 * @param {string} sessionId
 * @param {string} clientScanId
 * @param {string} cardCode
 */
async function performSubmit(sessionId, clientScanId, cardCode) {
  let response;
  try {
    // apiFetch attaches x-csrf-token + JSON content type (Task 13). Without it
    // the server's requireCsrf preHandler (Task 12) returns 403.
    response = await apiFetch(`/api/attendance-sessions/${sessionId}/scans`, {
      method: 'POST',
      body: { clientScanId, cardCode, scannedAt: new Date().toISOString() },
    });
  } catch (err) {
    return { status: 'lookup_error', ltiUserId: null, institutionalId: null, lookupErrorKind: 'network', scannedAt: new Date().toISOString() };
  }

  if (!response.ok) {
    return { status: 'lookup_error', ltiUserId: null, institutionalId: null, lookupErrorKind: 'http-status', scannedAt: new Date().toISOString() };
  }

  try {
    return await response.json();
  } catch (err) {
    return { status: 'lookup_error', ltiUserId: null, institutionalId: null, lookupErrorKind: 'bad-json', scannedAt: new Date().toISOString() };
  }
}
```

Update the `ScanRecord` typedef (previously at old lines 69–79) to drop `lookupData`/`rosterData`/`rosterStatus` in favor of the server vocabulary:

```js
/**
 * @typedef {Object} ScanRecord
 * @property {string} id
 * @property {string} timestamp - ISO 8601.
 * @property {string} rawCardCode
 * @property {string|null} institutionalId
 * @property {string|null} clientScanId
 * @property {'pending'|'present'|'unexpected'|'lookup_error'} status
 */
```

Update the `ScanPipeline` constructor to accept `sessionId` and drop `getRosterState` (old lines 85–110):

```js
export class ScanPipeline {
  /**
   * @param {Object} options
   * @param {string} options.sessionId
   * @param {Object} options.callbacks
   * @param {(record: ScanRecord) => void} options.callbacks.onRecordCreated
   * @param {(record: ScanRecord) => void} options.callbacks.onRecordUpdated
   * @param {(record: ScanRecord) => void} options.callbacks.onLatestScanUpdate - only fired when the resolving scan is still the most recently created one
   * @param {(stats: object) => void} options.callbacks.onStatsChanged
   */
  constructor({ sessionId, callbacks }) {
    this.sessionId = sessionId;
    this.callbacks = callbacks;

    /** @type {ScanRecord[]} */
    this.records = [];
    /** @type {Map<string, ScanRecord>} */
    this.recordsById = new Map();
    /** @type {Map<string, number>} last-accepted timestamp (ms) per card code, for duplicate suppression */
    this.lastAcceptedByCode = new Map();
    /** @type {Map<string, string>} current live record id per card code */
    this.recordIdByCardCode = new Map();
    this.latestScanId = null;
    this.nextId = 1;
    this.stats = emptyStats();
  }
```

Update `_processCandidateScan` (old lines 163–174) to drop the `rosterState`/`rosterStatus` initialization and mint a spec-§21 `<UUID>` `clientScanId` (Q11 — `crypto.randomUUID()` is a browser global; the old `client-${this.sessionId}-${this.nextId}-${Date.now()}` template was also off-by-one on `nextId`):

```js
    /** @type {ScanRecord} */
    const record = {
      id: `scan-${this.nextId++}`,
      timestamp: new Date().toISOString(),
      rawCardCode: cardCode,
      institutionalId: null,
      clientScanId: crypto.randomUUID(),
      status: 'pending',
    };
```

Update `_retryLookup` (old lines 201–218) to drop `rosterData`/`rosterStatus`:

```js
    this._decrementStatsForRecord(record);

    record.institutionalId = null;
    record.status = 'pending';

    this.callbacks.onRecordUpdated(record);
    this.callbacks.onStatsChanged(this.getStats());

    this._resolveScan(recordId, cardCode, record.clientScanId);
```

Update `_resolveScan` (old lines 220–267) to call the new `submitScan` signature and trust the server's status verbatim:

```js
  /** @private */
  async _resolveScan(scanId, cardCode, clientScanId) {
    const result = await submitScan(this.sessionId, clientScanId, cardCode);

    // The record may have been deleted (e.g. the professor removed the
    // row, or cleared the session) while the lookup was in flight.
    const record = this.recordsById.get(scanId);
    if (!record) return;

    record.institutionalId = result.institutionalId;
    record.status = result.status;

    if (result.status === 'lookup_error') {
      this.stats.lookupErrors += 1;
    } else if (result.status === 'present') {
      this.stats.totalAccepted += 1;
      this.stats.expected += 1;
    } else if (result.status === 'unexpected') {
      this.stats.totalAccepted += 1;
      this.stats.unexpected += 1;
    }

    // Always update this scan's own row, regardless of recency.
    this.callbacks.onRecordUpdated(record);
    this.callbacks.onStatsChanged(this.getStats());

    // Only touch the prominent "latest scan" panel (and by extension any
    // sound alert) if no newer scan has started since this one did -- this
    // is what stops a slow, older lookup from clobbering a fresher scan's
    // display.
    if (scanId === this.latestScanId) {
      this.callbacks.onLatestScanUpdate(record);
    }
  }
```

Update the two call sites of `_resolveScan` inside `_processCandidateScan` (old line 186) and the retry path (already shown above) to pass `record.clientScanId`:

```js
    // Deliberately not awaited: the caller (hid-reader's report handler)
    // must return immediately so the next inputreport -- possibly a
    // different card -- is never blocked behind this lookup.
    this._resolveScan(record.id, cardCode, record.clientScanId);
```

Update `_decrementStatsForRecord` (old lines 305–311) to key off the new status vocabulary:

```js
  /** @private */
  _decrementStatsForRecord(record) {
    if (record.status === 'present') { this.stats.totalAccepted -= 1; this.stats.expected -= 1; }
    if (record.status === 'unexpected') { this.stats.totalAccepted -= 1; this.stats.unexpected -= 1; }
    if (record.status === 'lookup_error') this.stats.lookupErrors -= 1;
  }
```

Update `restoreState` (old lines 331–369) similarly — a record still `'pending'` at save time normalizes to `'lookup_error'` (unchanged concept, new vocabulary), and the stats recomputation loop uses the new fields:

```js
    for (const record of this.records) {
      if (record.status === 'pending') {
        record.status = 'lookup_error';
      }
    }
    this.recordsById = new Map(this.records.map((r) => [r.id, r]));
    this.recordIdByCardCode = new Map(this.records.map((r) => [r.rawCardCode, r.id]));
    this.latestScanId = this.records.length ? this.records[this.records.length - 1].id : null;

    let maxSeen = 0;
    for (const record of this.records) {
      const match = /^scan-(\d+)$/.exec(record.id);
      if (match) maxSeen = Math.max(maxSeen, Number(match[1]));
    }
    this.nextId = maxSeen + 1;

    const stats = emptyStats((duplicateCounters && duplicateCounters.suppressed) || 0);
    for (const record of this.records) {
      if (record.status === 'present') { stats.totalAccepted += 1; stats.expected += 1; }
      if (record.status === 'unexpected') { stats.totalAccepted += 1; stats.unexpected += 1; }
      if (record.status === 'lookup_error') stats.lookupErrors += 1;
    }
    this.stats = stats;
```

Add a guard at the very top of `handleParsedReport` (Q9) so a card tapped before **Start Attendance** never fires a request against `/api/attendance-sessions/null/scans`:

```js
  handleParsedReport(parsed) {
    if (!this.sessionId) {
      logEvent('scan-ignored-no-session', {});
      return; // no active attendance session; app.js keeps the Start button prompting
    }
    // ...existing body unchanged
```

Everything else in the file (the rest of `handleParsedReport`, the duplicate-suppression time-window logic in `_processCandidateScan`, `getStats`/`getRecords`/`getDuplicateCounters`/`removeRecord`/`clearAll`) is unchanged. `app.js` (Task 16) reassigns `scanPipeline.sessionId` after **Start Attendance** succeeds.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/tests/scan-pipeline.test.js`
Expected: PASS — all 14 cases green (11 original + 2 rewritten roster-trust cases + the no-session guard case).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass, no regressions in `web/tests/omnikey-parser.test.js` or `web/tests/roster.test.js` (untouched by this task).

- [ ] **Step 6: Commit**

```bash
git add web/scan-pipeline.js web/tests/scan-pipeline.test.js
git commit -m "refactor: scan-pipeline.js submits to a session-scoped endpoint, trusts server status verbatim"
```

---

## Task 15: `web/attendance-session.js` — client session lifecycle

**Files:**
- Create: `web/attendance-session.js`
- Create: `web/tests/attendance-session.test.js`

**Interfaces:**
- Consumes: `apiFetch` from `web/api-client.js` (Task 13) — so every mutation carries `x-csrf-token` + a JSON body. Mirrors `scan-pipeline.js`'s never-throws convention.
- Produces: `createAttendanceSession(body)`, `closeAttendanceSession(sessionId)`, `reopenAttendanceSession(sessionId, reason)`, `getAttendanceSession(sessionId)` — used by `web/app.js`'s Start/Close/Reopen button handlers (Task 16).

- [ ] **Step 1: Write the failing test**

```js
// web/tests/attendance-session.test.js
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../api-client.js', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '../api-client.js';
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession, getAttendanceSession } from '../attendance-session.js';

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('attendance-session.js', () => {
  it('createAttendanceSession POSTs via apiFetch and returns the parsed session on success', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ id: 'session-1', state: 'open' }) });

    const result = await createAttendanceSession({ label: 'Monday lecture' });

    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions', expect.objectContaining({ method: 'POST', body: { label: 'Monday lecture' } }));
    expect(result).toEqual({ ok: true, session: { id: 'session-1', state: 'open' } });
  });

  it('createAttendanceSession never throws on a network failure -- returns a normalized error result', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const result = await createAttendanceSession({});
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('network');
  });

  it('createAttendanceSession returns a normalized error result on a non-2xx response', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 502, json: () => Promise.resolve({ error: 'roster_unavailable', requestId: 'r1' }) });
    const result = await createAttendanceSession({});
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
    expect(result.error.message).toContain('502');
  });

  it('closeAttendanceSession POSTs to the close endpoint via apiFetch', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    const result = await closeAttendanceSession('session-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1/close', expect.objectContaining({ method: 'POST' }));
    expect(result.ok).toBe(true);
  });

  it('reopenAttendanceSession POSTs to the reopen endpoint with a reason', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    await reopenAttendanceSession('session-1', 'Missed a scan');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1/reopen', expect.objectContaining({ method: 'POST', body: { reason: 'Missed a scan' } }));
  });

  it('getAttendanceSession GETs the session by id', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ session: { id: 'session-1', state: 'open' }, members: [] }) });
    const result = await getAttendanceSession('session-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1');
    expect(result.ok).toBe(true);
    expect(result.body.session.id).toBe('session-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/tests/attendance-session.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// attendance-session.js
//
// Client-side lifecycle for a persisted attendance session: create, close,
// reopen, re-fetch. Same never-throws convention as scan-pipeline.js's
// submitScan(): every function returns a normalized {ok, ...} / {ok:false,
// error} result. Every request goes through api-client.js's apiFetch so a
// mutation carries x-csrf-token + a JSON body (Task 13 / D7).

import { apiFetch } from './api-client.js';

/** @param {string} url @param {{method?: string, body?: unknown}} [init] */
async function request(url, init = {}) {
  let response;
  try {
    response = await apiFetch(url, init);
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // body wasn't JSON; empty detail
    }
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` } };
  }

  try {
    return { ok: true, body: await response.json() };
  } catch (err) {
    return { ok: false, error: { kind: 'bad-json', message: `${url} returned a response that was not valid JSON: ${err.message}` } };
  }
}

/**
 * @param {{label?: string, meetingAt?: string}} body
 * @returns {Promise<{ok: true, session: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function createAttendanceSession(body) {
  const result = await request('/api/attendance-sessions', { method: 'POST', body });
  if (!result.ok) return result;
  return { ok: true, session: result.body };
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function closeAttendanceSession(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}/close`, { method: 'POST' });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * @param {string} sessionId
 * @param {string} [reason]
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function reopenAttendanceSession(sessionId, reason) {
  const result = await request(`/api/attendance-sessions/${sessionId}/reopen`, { method: 'POST', body: { reason } });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ok: true, body: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function getAttendanceSession(sessionId) {
  return request(`/api/attendance-sessions/${sessionId}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/tests/attendance-session.test.js`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/attendance-session.js web/tests/attendance-session.test.js
git commit -m "feat: add client-side attendance session lifecycle module (via api-client)"
```

---

## Task 16: `app.js`/`ui.js`/`index.html` — CSRF bootstrap + Start/Close/Reopen wiring

**Files:**
- Modify: `web/index.html`
- Modify: `web/ui.js`
- Modify: `web/app.js`

**Interfaces:**
- Consumes: `bootstrapSession` from `web/api-client.js` (Task 13); `createAttendanceSession`/`closeAttendanceSession`/`reopenAttendanceSession`/`getAttendanceSession` from Task 15; `ScanPipeline` from Task 14 (constructed with `sessionId: null`, reassigned after Start).
- Produces: no new exports — orchestration wiring, verified manually (there is no `web/tests/app.test.js`; `app.js`/`ui.js`/`index.html` wiring is verified manually via Playwright each phase per `docs/canvas-lti/progress.md`).

- [ ] **Step 0: Enumerate and confirm every `ui.*` / `elements.*` symbol this task touches (Q10)**

Before editing, open the REAL `web/ui.js` and `web/app.js` and confirm each symbol below exists with the stated signature; adjust the code in the following steps to the real names if any differ. Verified against the shipped files at plan-revision time:
- `ui.elements` object literal — add the four new `session*` entries (Step 2).
- `ui.showAppMessage(kind, text)` — exists.
- `ui.renderStats(stats, rosterEnabled)` — **2-arg**. Keep passing `rosterState.enabled` as the 2nd arg at every call site (do NOT drop it — Q10).
- `ui.addAttendanceRow(record, onRemove)`, `ui.updateAttendanceRow(record)`, `ui.renderLatestScanPending(record)`, `ui.renderLatestScanResult(record)` — exist; they read `record.status`. Update `ui.js`'s latest-scan/status string maps (the `LATEST_SCAN_*` / status-label constants near the top of `ui.js`) so the server vocabulary (`present` / `unexpected` / `lookup_error` / `pending`) renders, replacing the old client vocabulary (`accepted` / `expected` / `unchecked` / `lookup-error`). <!-- reviser note (Q10): the exact `ui.js` constant names must be confirmed at execution; this task has no automated test, so Step 5's manual Playwright pass is the gate. -->
- `playUnexpectedTone()` — defined in `app.js`.
- `elements.soundAlertsToggle` — exists.
- `ui.renderSessionState(sessionInfo)` — NEW, added in Step 3.

- [ ] **Step 1: Add session-control markup to `index.html`**

Insert a new panel immediately before the existing `<section id="latest-scan-panel" ...>` (around line 94 in the current file):

```html
<section id="session-panel" class="panel" aria-labelledby="session-heading">
  <h2 id="session-heading">Attendance Session</h2>
  <p id="session-status-text">No session started.</p>
  <div class="button-row">
    <button id="btn-start-session" type="button" class="primary">Start Attendance</button>
    <button id="btn-close-session" type="button" class="secondary" disabled>Close Attendance</button>
    <button id="btn-reopen-session" type="button" class="secondary" hidden>Reopen Attendance</button>
  </div>
</section>
```

- [ ] **Step 2: Add the new elements to `ui.js`'s `elements` export**

Insert after the existing `readerProductName` entry (around line 15):

```js
  sessionStatusText: document.getElementById('session-status-text'),
  startSessionBtn: document.getElementById('btn-start-session'),
  closeSessionBtn: document.getElementById('btn-close-session'),
  reopenSessionBtn: document.getElementById('btn-reopen-session'),
```

- [ ] **Step 3: Add a session-state render function to `ui.js`**

Append near the other `render*`/`set*` functions:

```js
/**
 * Renders the Attendance Session panel's controls for the given session
 * state (or the no-session-yet state before Start Attendance is clicked).
 * @param {{state: 'none'|'open'|'closed'|'reopened', label?: string|null} } sessionInfo
 */
export function renderSessionState(sessionInfo) {
  if (sessionInfo.state === 'none') {
    elements.sessionStatusText.textContent = 'No session started.';
    elements.startSessionBtn.hidden = false;
    elements.startSessionBtn.disabled = false;
    elements.closeSessionBtn.hidden = true;
    elements.reopenSessionBtn.hidden = true;
    return;
  }

  const label = sessionInfo.label ? ` — ${sessionInfo.label}` : '';
  if (sessionInfo.state === 'open' || sessionInfo.state === 'reopened') {
    elements.sessionStatusText.textContent = `Session ${sessionInfo.state}${label}`;
    elements.startSessionBtn.hidden = true;
    elements.closeSessionBtn.hidden = false;
    elements.closeSessionBtn.disabled = false;
    elements.reopenSessionBtn.hidden = true;
  } else if (sessionInfo.state === 'closed') {
    elements.sessionStatusText.textContent = `Session closed${label}`;
    elements.startSessionBtn.hidden = true;
    elements.closeSessionBtn.hidden = true;
    elements.reopenSessionBtn.hidden = false;
    elements.reopenSessionBtn.disabled = false;
  }
}
```

- [ ] **Step 4: Wire the buttons in `app.js`**

Add the import and session state near the top (after the existing `import * as ui from './ui.js';`):

```js
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession } from './attendance-session.js';

let currentAttendanceSessionId = null;
```

Change the `scanPipeline` construction (currently `getRosterState: () => (...)`) to take `sessionId` instead, matching Task 13's new constructor shape:

```js
const scanPipeline = new ScanPipeline({
  sessionId: null, // set once Start Attendance succeeds; see startSession() below
  callbacks: {
    onRecordCreated: (record) => {
      ui.addAttendanceRow(record, handleRemoveRecord);
      ui.renderLatestScanPending(record);
      schedulePersist();
    },
    onRecordUpdated: (record) => {
      ui.updateAttendanceRow(record);
      schedulePersist();
    },
    onLatestScanUpdate: (record) => {
      ui.renderLatestScanResult(record);
      if (record.status === 'unexpected' && elements.soundAlertsToggle.checked) {
        playUnexpectedTone();
      }
    },
    onStatsChanged: (stats) => {
      ui.renderStats(stats, rosterState.enabled); // keep the 2-arg signature (Q10)
      schedulePersist();
    },
  },
});
```

Note: `ScanPipeline`'s `sessionId` is set at construction and read via `this.sessionId` inside `_resolveScan` and the `handleParsedReport` guard (Task 14) — since a real session doesn't exist until `Start Attendance` succeeds, `startSession()` below reassigns `scanPipeline.sessionId` directly after creation, rather than requiring a full pipeline reconstruction. Until then, `handleParsedReport` no-ops (Q9), so a card tapped before Start is ignored with a diagnostics entry rather than hitting `/api/attendance-sessions/null/scans`.

Add the button handlers near the other button wiring (after the reader connect/disconnect handlers):

```js
// ---- Attendance session lifecycle ------------------------------------------

async function startSession() {
  elements.startSessionBtn.disabled = true;
  const result = await createAttendanceSession({});
  if (!result.ok) {
    elements.startSessionBtn.disabled = false;
    ui.showAppMessage('error', `Could not start attendance: ${result.error.message}`);
    return;
  }
  currentAttendanceSessionId = result.session.id;
  scanPipeline.sessionId = result.session.id;
  ui.renderSessionState({ state: result.session.state, label: result.session.label });
  ui.showAppMessage('info', 'Attendance session started.');
}

async function closeSession() {
  if (!currentAttendanceSessionId) return;
  elements.closeSessionBtn.disabled = true;
  const result = await closeAttendanceSession(currentAttendanceSessionId);
  if (!result.ok) {
    elements.closeSessionBtn.disabled = false;
    ui.showAppMessage('error', `Could not close attendance: ${result.error.message}`);
    return;
  }
  ui.renderSessionState({ state: 'closed' });
  ui.showAppMessage('info', 'Attendance session closed. Unscanned students were marked absent.');
}

async function reopenSession() {
  if (!currentAttendanceSessionId) return;
  const reason = window.prompt('Reason for reopening this session (optional):') || undefined;
  elements.reopenSessionBtn.disabled = true;
  const result = await reopenAttendanceSession(currentAttendanceSessionId, reason);
  if (!result.ok) {
    elements.reopenSessionBtn.disabled = false;
    ui.showAppMessage('error', `Could not reopen attendance: ${result.error.message}`);
    return;
  }
  ui.renderSessionState({ state: 'reopened' });
  ui.showAppMessage('info', 'Attendance session reopened. Scans are accepted again.');
}

elements.startSessionBtn.addEventListener('click', startSession);
elements.closeSessionBtn.addEventListener('click', closeSession);
elements.reopenSessionBtn.addEventListener('click', reopenSession);
```

Bootstrap the CSRF token at startup. In `init()`, before any mutation can fire (and before `ui.renderSessionState`), call `bootstrapSession()` (Task 13) so `apiFetch` has the `csrfToken` from `GET /api/me`; on failure show a blocking app message and leave **Start Attendance** disabled:

```js
import { bootstrapSession } from './api-client.js';
// ...in init():
  const boot = await bootstrapSession();
  if (!boot.ok) {
    ui.showAppMessage('error', 'Could not load your session. Reload the page from Canvas.');
    elements.startSessionBtn.disabled = true;
  }
  ui.renderSessionState({ state: 'none' });
```

This task deliberately does not remove the existing CSV-upload roster panel or its wiring (`elements.loadRosterBtn`, `elements.rosterFileInput`, etc.) — per spec §51/§29, that flow remains for the standalone/demo mode and is out of this plan's scope (see "Risks / open items"). The `getRosterState`/`isExpected`/`getRosterRow` local roster matching that scan-pipeline.js used to call is gone (Task 14); this CSV roster panel no longer affects `status` — it is a display aid until a future phase wires it to something. A UX follow-up, not a Phase 5 blocker.

- [ ] **Step 5: Manual verification (no automated test file for app.js/ui.js wiring, matching this project's existing convention)**

Run: `npm run dev`, then in a browser launched from Canvas: confirm `GET /api/me` runs on load and `Start Attendance` is enabled; click **Start Attendance**, confirm the panel updates to "Session open", the Close button enables, and the `POST /api/attendance-sessions` request carried an `x-csrf-token` header (Network tab) and returned 201; simulate a scan via the existing synthetic-HID-report technique from Phases 1–2's manual verification; click **Close Attendance**, confirm "Session closed" and the Reopen button appears; click **Reopen Attendance**, confirm scans are accepted again. Confirm via the Network tab that `cardCode` never appears in any response body (only `institutionalId`/`status`), and that a card tapped before Start produces no `/api/attendance-sessions/null/scans` request.

- [ ] **Step 6: Run the automated test suite and lint/typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green (this task added no new automated tests, so the count is unchanged from Task 15).

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/ui.js web/app.js
git commit -m "feat: bootstrap CSRF + wire Start/Close/Reopen attendance session controls into app.js/ui.js"
```

---

## Task 17: Retire `POST /api/scans` (D8 / B7)

Shipped `server/src/index.ts` carries a standing instruction that Phase 5 retires `POST /api/scans` in favour of `POST /api/attendance-sessions/{id}/scans` behind `requireSession` + `requireCsrf`, and migrates the UI "at the same time". Tasks 12 + 14 have now built the replacement route and migrated the browser, so this task removes the old unauthenticated route. Sequenced last-but-one so nothing depends on `/api/scans` when it goes.

**Files:**
- Modify: `server/src/index.ts` (remove `registerScansRoute` import + call + the DELIBERATE comment; keep `identityResolver`)
- Delete: `server/src/routes/scans.ts`
- Delete: `server/tests/routes/scans.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `/api/scans` no longer exists; `POST /api/attendance-sessions/{id}/scans` (Task 12) is the only scan endpoint.

- [ ] **Step 1: Confirm nothing else references `/api/scans`**

Run: `grep -rn "api/scans\|registerScansRoute" server/ web/ | grep -v node_modules`
Expected (after Tasks 12/14): only `server/src/index.ts`, `server/src/routes/scans.ts`, `server/tests/routes/scans.test.ts`. `web/scan-pipeline.js` now targets `/api/attendance-sessions/${sessionId}/scans` (Task 14). `server/tests/routes/hardening.test.ts` contains no `/api/scans` reference (verified) and needs no change.

- [ ] **Step 2: Remove the route from `server/src/index.ts`**

- Delete `import { registerScansRoute } from './routes/scans.js';`.
- Delete the `// DELIBERATE: POST /api/scans stays UNAUTHENTICATED ...` comment block and the `registerScansRoute(app, identityResolver);` line.
- KEEP `const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();` — Task 12's `registerAttendanceSessionsRoute(app, { db, resolver: identityResolver, requireSession, requireCsrf })` still needs it. (Task 12 Step 4 already moved this line above that registration.)
- The `/lti/*` rate-limit plugin scope comment still mentions `/api/scans`; update it to read: `// ... so the limit doesn't apply to POST /api/attendance-sessions/{id}/scans (classroom bursts, spec §31.10).`

- [ ] **Step 3: Delete the dead files**

Run: `git rm server/src/routes/scans.ts server/tests/routes/scans.test.ts`
The new route does NOT reuse `registerScansRoute`'s wiring (it has its own `deps.resolver` plumbing), so both files go entirely.

- [ ] **Step 4: Run the full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. Test-file count drops by one (`scans.test.ts` gone); no other test references the removed symbols.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/routes/scans.ts server/tests/routes/scans.test.ts
git commit -m "refactor: retire unauthenticated POST /api/scans; the session-scoped scan route replaces it"
```

---

## Task 18: Update `docs/canvas-lti/progress.md`

**Files:**
- Modify: `docs/canvas-lti/progress.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — documentation only.

- [ ] **Step 1: Check the Phase 5 box and add a "what actually happened" section**

Change the Phase 5 line in the "Phase checklist" section from `- [ ] **Phase 5 — Persistent attendance**` to `- [x] **Phase 5 — Persistent attendance**`, and append a new `## Phase 5 — what actually happened` section (after the existing `## Phase 2` section, matching that section's level of detail) summarizing: the four new tables and the `audit_events` FK addition; the DI re-thread (`db` param everywhere) and the `getRosterWithFallback` <24h stale-cache degradation for Start Attendance; `submitScan`'s idempotency mechanism, ambiguous-match handling, and lookup_error re-resolution on retry; `closeAttendanceSession`'s system_absence insertion (steps 3–4 deferred to Phase 6); the append-only manual-correction design and where the note lives; the DELETE-record route (hard delete + audit event); the state-transition 409 guards; CSV export parity with `web/csv.js`; the new `web/api-client.js` CSRF bootstrap + `apiFetch` wrapper and the `scan-pipeline.js` transport/vocabulary change (which tests were rewritten vs preserved); **the retirement of `POST /api/scans`** (route + `scans.ts` + `scans.test.ts` removed, `index.ts` comment updated); the deferred/out-of-scope items (`late` status deferred; standalone-mode CSV roster panel not wired to the new backend; card-fingerprint secret app-wide not per-institution; no scan-API rate limiting yet — Phase 8).

- [ ] **Step 2: Commit**

```bash
git add docs/canvas-lti/progress.md
git commit -m "docs: mark Phase 5 complete in progress.md"
```

---

## Risks / open items

- **Standalone/demo mode (spec §51) is not wired to the new persisted-session backend.** The CSV-upload roster panel and its `roster.js` matching helpers (`isExpected`/`getRosterRow`) remain in the codebase (unchanged) but are no longer consulted by `scan-pipeline.js`, since `submitScan`'s status now always comes from the server. A future session should decide whether standalone mode gets its own lightweight session concept or is retired in favor of always requiring an LTI launch.
- **Card-fingerprint secret is a single app-wide `CARD_FINGERPRINT_SECRET` env var, not a per-institution database column.** The design doc's `institutions` table (Phase 3) has no fingerprint-secret column, and only one institution is live at this stage — this is a deliberate YAGNI scope reduction, flagged for revisit if/when a second institution with different fingerprinting needs is onboarded.
- **Rate limiting on the scan API (spec §31.10, ~120–240 req/min/session) is explicitly deferred to Phase 8 hardening**, not this phase, per the design doc. The Phase 5 scan route is registered on the ROOT `app` (D6), outside the `/lti/*` rate-limit plugin scope, so it inherits no limit — a class must scan through quickly.
- **Grade calculation/synchronization (spec §27–28) is out of scope.** `closeAttendanceSession` implements spec §25.7 steps 1–2 only; steps 3–4 (cumulative recalculation, grade-sync queue) are Phase 6 per §54. It writes the `attendance_session_closed` audit event as the Phase 6 extension point and touches no `grade_*` tables (which do not exist until Phase 6).
- **DELETE-record route is a hard delete, not a tombstone-append.** This is in tension with the append-only invariant; `resolveCurrentRecord` will fall back to an older row (or `null`) after a delete, and the only history is the `attendance_record_removed` audit event's `oldValue`. The user approved "a DELETE route that writes an audit event"; a future ruling may switch this to a tombstone-append that `resolveCurrentRecord` understands. <!-- reviser note (Q8): flagged for a ruling; kept as a hard delete per the settled decision text. -->
- **`late` status is deferred (settled decision):** not in the `attendance_records` enum, `manualCorrectionSchema`, or any route. Re-enabling it is a schema migration + schema/enum change later.
- **Card-fingerprint secret is app-wide (S3):** kept the `institutionId` param + documented migration path in code; needs an explicit user ruling that app-wide is acceptable for Phase 5.
- **`audit_events` migration ordering** (Task 1) depends on whether Phase 4 already ran its migration when this plan executes; Task 1 Step 5 handles both orderings, but re-verify against the actual generated SQL at execution time.
- **`seedInstitutionAndCourse` may also be added by Phase 4's revised plan** (D10). Task 4 Step 1 adds it only if absent and requires the `db`-first, real-deployment-chain shape either way.

---

## Self-review notes

- **Task list (19 tasks, 0–18):** 0 pre-flight · 1 schema + `db.ts` reset set · 2 `member-status.ts` (pure) · 3 `card-fingerprint.ts` (pure) · 4 `createAttendanceSession` + `seedInstitutionAndCourse` + `<24h` degradation + creation audit · 5 `submitScan` (valid/closed/lookup_error-retry/missing-university-id) · 6 scan-service edge cases + retry-recovery test · 7 scan-service idempotency tests · 8 `closeAttendanceSession` + state guard · 9 `reopenAttendanceSession` + state guard · 10 `applyManualCorrection` (no `late`) · 11 `buildAttendanceSessionCsv` · 12 routes behind `requireSession`/`requireCsrf`, tenant isolation, opaque errors, serializers, `index.ts` wiring · 13 `web/api-client.js` CSRF bootstrap + `apiFetch` · 14 `web/scan-pipeline.js` transport + `randomUUID` clientScanId + no-session guard · 15 `web/attendance-session.js` via `apiFetch` · 16 `app.js`/`ui.js`/`index.html` CSRF bootstrap + Start/Close/Reopen wiring · 17 retire `POST /api/scans` · 18 `progress.md`.
- **Spec coverage:** §15 (form-encoded rejection → `requireCsrf`, Task 12) · §20 (ambiguous → `unexpected`; `missing-university-id` → `lookup_error`, Tasks 5–6) · §21/§47 (scan flow + all named cases → Tasks 5–7, 14; retry-after-lookup-failure re-resolves → Tasks 5/6/12) · §22 (raw card never persisted → Tasks 3/5/12) · §23 (states + guards → Tasks 4/8/9; immutability → Task 2) · §24 (`late` deferred; statuses `present`/`absent`/`excused`/`lookup_error`/`unexpected`) · §25.3–25.10 (routes → Task 12) · §26 (schema, `scanned_at` nullable → Task 1) · §31.9 (opaque errors + `request.id` correlation, `audit_events.request_id` populated → Tasks 4/8/9/10/12) · §31.10 (scan route not rate-limited → Task 12 mount) · §33 (audit events incl. `attendance_session_created` → Tasks 4/8/9/10/12).
- **DI:** no `import { db }` anywhere; every DB function takes `db: Database` first; every DB test uses `getTestDb().db` + file-scope `afterAll(closeTestDb)`; route deps carry `{ db, resolver, requireSession, requireCsrf }`.
- **`CourseRosterMember` / `snapshot_data`:** Task 4 snapshots each `CourseRosterMember` verbatim into `attendance_session_members.snapshotData` (jsonb) and maps `ltiUserId`/`institutionalId`/`displayName`/`eligibleForAttendance`/`status` to columns — matches Phase 4's fixed contract (fields unchanged).
- **Placeholder scan:** every code step contains complete, runnable code; no "TBD"/"similar to Task N".

---

## Revision log

Applied per `.superpowers/sdd/plan-revision-constraints.md` (D1–D12) against the pre-flight findings in `.superpowers/sdd/phase5-plan-review-findings.md`. Task count: **17 → 19** (added Task 13 `web/api-client.js` for D7/B3; added Task 17 `POST /api/scans` retirement for D8/B7; old Tasks 13–16 became 14–16 & 18).

### BLOCKERS — all fixed
- **B1 (DI, no `db` singleton):** Architecture note + Global Constraint added. Every lib fn takes `db: Database` first (`createAttendanceSession`, `submitScan`, `closeAttendanceSession`, `reopenAttendanceSession`, `applyManualCorrection`); pure fns (`resolveCurrentRecord`, `computeCardFingerprint`, `buildAttendanceSessionCsv`) take none. Route module gets `deps: { db, resolver, requireSession, requireCsrf }`. Every DB test: `const { db } = getTestDb()` + file-scope `afterAll(() => closeTestDb())`. `import { db }` removed from Tasks 1/4/5/6/7/8/9/10/12 code + all 9 test files. Core-signatures block + File Structure updated.
- **B2 (auth never wired):** D6 map in Task 12 — `preHandler: [requireSession, requireCsrf]` on mutations, `preHandler: requireSession` on GETs; `deps` carries both + `db`. `index.ts` builds `createRequireCsrf(env.APP_BASE_URL)`, registers on ROOT `app` (not the rate-limit scope). Task 12 tests add 401-unauthenticated and 403-missing-CSRF cases. Task 12 Step 4 "does not add real preHandlers" punt removed.
- **B3 (web client never sends CSRF):** new **Task 13 `web/api-client.js`** — `bootstrapSession()` reads `csrfToken` from `GET /api/me`; `apiFetch()` sets `x-csrf-token` + JSON body on every mutation; `web/tests/api-client.test.js` asserts the header. `scan-pipeline.js` (Task 14) and `attendance-session.js` (Task 15) route through `apiFetch`; `app.js` (Task 16) calls `bootstrapSession()` in `init()`.
- **B4 (seed FK violation / missing helper):** Task 4 Step 1 adds `seedInstitutionAndCourse(db)` to `server/tests/support/seed.ts` building institutions→lti_registrations→lti_deployments→courses, `courses.deploymentId` = `lti_deployments.id` ROW UUID. Task 1's local `seedCourseAndSession` rewritten to the same chain (was `deploymentId: institution.id`). All call sites pass `db`.
- **B5 (`closeSession` audit insert broken):** `courseInstitutionId(tx: typeof db)` helper + the `tx.select()...&& ... ? ... : null` ternary deleted. `closeAttendanceSession` / `reopenAttendanceSession` now load the course once (`tx.select().from(courses)`) and set `institutionId: course.institutionId` unconditionally (NOT NULL satisfied). `Tx` type alias added to the contract for any tx-typed helper (Q15).
- **B6 (retry-after-`lookup_error` dead end):** `submitScan` idempotency short-circuit is now `if (existing && existing.status !== 'lookup_error') return existing;`; a prior `lookup_error` row is re-resolved and `UPDATE`d in place (same row id, unique constraint respected). Scan-service test (Task 6) + route-level test (Task 12) assert `lookup_error` → successful retry yields one `present` row and the resolver is called again.
- **B7 (`POST /api/scans` not retired):** new **Task 17** — removes `registerScansRoute` import+call + the DELIBERATE comment from `index.ts`, updates the rate-limit-scope comment, `git rm`s `server/src/routes/scans.ts` + `server/tests/routes/scans.test.ts`, keeps `identityResolver` for the new route. Sequenced after Tasks 12 + 14. `hardening.test.ts` confirmed to need no change. Task 18 `progress.md` lists the retirement.

### SPEC GAPS — all fixed
- **S1:** `createAttendanceSession` writes an `attendance_session_created` audit event in-transaction (`actor`, `requestId`, `newValue: { memberCount, stale, rosterFetchedAt }`); Global Constraint list + test updated.
- **S2:** `createAttendanceSession` calls the shared `getRosterWithFallback(db, courseId)` (D9), not `refreshCourseRoster`; degrades to a `< 24h` cache (`stale: true`) and only throws `RosterUnavailableError` (→ 502) when the helper itself throws. The old "propagates a roster-refresh failure" test replaced with a stale-cache-degradation test + a no-cache hard-fail test. Reviser note left re: staleness stored on the audit event vs a new column.
- **S3:** Judgment call — kept app-wide `CARD_FINGERPRINT_SECRET`, kept the `institutionId` param, documented the per-institution migration path in code + Risks; reviser note flags it needs a user ruling.
- **S4:** `late` removed from the `attendance_records` status enum, from `applyManualCorrection`'s input type, and from `manualCorrectionSchema` (`z.enum(['present','absent','excused'])`); the Task 10 test that used `{ status: 'late' }` changed to `absent`; a Task 12 test asserts `status:'late'` → 400. Global Constraint reworded.
- **S5:** Task 12 error mapping — `replyForError` maps `code` → opaque `{ error: <code>, requestId: request.id }`, logs the real error server-side, rethrows unknowns to Fastify's 500. `request.id` threaded into every `auditEvents.values({ ... requestId })` (Tasks 4/8/9/10/12). No `Error.message` reaches the client.
- **S6:** Reviser note added at Task 8 — `closeAttendanceSession` is spec §25.7 steps 1–2; steps 3–4 are Phase 6 per §54.
- **S7:** `attendance_records.scannedAt` made nullable (matches spec §26). `system_absence` + `manual` rows store `null`; schema test, CSV test, close/manual-correction tests updated; `AttendanceExportRow.scannedAt` is `string | null`.

### QUALITY — 13 fixed, 2 carry a note
- **Q1** fixed (4 tables prepended to `TRUNCATE_ORDER` in Task 1 Step 3b, dedupe-aware; `db.ts` in File Structure). **Q2** fixed (`afterAll(closeTestDb)` + `getTestDb().db` in every DB test). **Q3** fixed (`vi.mock('.../roster-store.js')`, not `vi.spyOn`). **Q4** fixed (`createAttendanceSession`/`closeAttendanceSession`/`reopenAttendanceSession`, `buildAttendanceSessionCsv`). **Q5** fixed (`request.appSession` + `sessionOf()` 401 guard; no `as any`). **Q6** fixed (`ok:true` + `universityId==null` → `lookup_error` kind `missing-university-id`, with test). **Q7** fixed (`SessionAlreadyClosedError`/`SessionNotClosedError` → 409, service guards + route mapping + tests). **Q9** fixed (`handleParsedReport` no-session guard + test; `app.js` bootstrap gating). **Q10** fixed as far as mechanical — Task 16 Step 0 enumerates every `ui.*`/`elements.*` symbol, keeps `renderStats(stats, rosterEnabled)` 2-arg; reviser note that exact `ui.js` status-map constant names are confirmed at execution (no automated test for that file). **Q11** fixed (`crypto.randomUUID()` clientScanId; off-by-one gone). **Q12** fixed (array-form table extras). **Q13** fixed (Task 6/7 red→green wording dropped). **Q14** fixed (`serializeSession`/`serializeRecord`; GET returns `{ session, members }`, not `...session`; tests assert internal columns absent). **Q15** fixed (`Tx` type alias in the contract; B5 removed the `typeof db` helper).
- **Q8 (hard delete vs tombstone):** kept as a hard delete per the settled "DELETE route + audit event" decision; reviser note in Risks flags it for a ruling.
- **Q10** partial note as above.

### Cross-plan
`CourseRosterMember` fields unchanged; Task 4 stores the whole object in `attendance_session_members.snapshotData` and maps the five columns — shape-compatible with Phase 4's fixed contract. Phase 5 consumes `getRosterWithFallback(db, courseId)` / `refreshCourseRoster(db, courseId)` / `seedInstitutionAndCourse(db)` per the constraints doc, not Phase 4's in-flight text.

### Constraints-doc rulings vs shipped code
No unworkable ruling found. All of D1–D12 apply cleanly against shipped Phase 3 (`createRequireSession`/`createRequireCsrf` factories, `AppSession` shape, `getTestDb`/`resetDb`/`closeTestDb`, `seedInstitutionAndRegistration`, `MockCanvasPlatform`, `mintIdToken(overrides, options)` all verified). Two cross-plan items depend on Phase 4 having executed first (its `roster-store.ts` `getRosterWithFallback` and, optionally, its own `seedInstitutionAndCourse`) — this is the pre-existing, documented Phase 4→5 ordering dependency, handled in Task 0 Step 3 and Task 4 Step 1, not a conflict.
