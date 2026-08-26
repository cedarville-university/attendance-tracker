# Canvas LTI Phase 5 — Persistent Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every scan, manual correction, and session close/reopen a durable server-side home in PostgreSQL, so closing or reopening the browser never loses server-accepted attendance — the literal Phase 5 exit criterion (spec §54/§23).

**Architecture:** Three new Drizzle tables (`attendance_sessions`, `attendance_session_members`, `attendance_records`) plus the `audit_events` table shared with Phase 4. A session snapshots Phase 4's roster verbatim at creation time (roster-snapshot immutability — spec §23's "historical attendance must not retroactively change"). Every scan, manual correction, and removal appends a new `attendance_records` row rather than mutating an existing one; "current status" is always resolved by `member-status.ts`'s "most-recent-record-wins" rule, so there is exactly one source of truth for an attendance outcome. `POST .../scans` is idempotent via a `(attendanceSessionId, clientScanId)` unique constraint plus `ON CONFLICT DO NOTHING RETURNING *` with a `SELECT` fallback on a lost race. The browser's `scan-pipeline.js` keeps 100% of its existing concurrency/dedup state machine (suppression window, in-flight tracking, stale-lookup-doesn't-clobber-latest, deletion-while-pending) — only the transport (`submitScan(sessionId, clientScanId, cardCode)` instead of `submitScan(cardCode)`) and the source of `status`/`rosterStatus` (trusted verbatim from the server response, not recomputed locally) change.

**Tech Stack:** Fastify 5, Drizzle ORM + `pg` (from Phase 3), Zod, Vitest, plain ES modules on the browser side (no framework). No new npm dependencies this phase.

## Global Constraints

- No new npm dependencies (`drizzle-orm`, `pg`, `zod`, `fastify` already present from Phases 1–4). `web/` stays framework-free plain ES modules.
- Raw card codes MUST NOT be logged, written to audit logs, or persisted in `attendance_records` by default (spec §22). Only a fingerprint (`HMAC-SHA256(rawCardCode, secret)`) may be persisted, and only when explicitly enabled — never the raw code itself.
- `attendance_session_members.status` is the *roster* status captured at snapshot time and is **never mutated** after creation. The attendance *outcome* lives only in the append-only `attendance_records` table.
- Every mutation that changes attendance state (manual correction, record removal, session close, session reopen) MUST write an `audit_events` row (spec §33): `attendance_manual_change`, `attendance_record_removed`, `attendance_session_closed`, `attendance_session_reopened`.
- Every route under `/api/attendance-sessions/*` requires `requireSession` (spec §25: "All `/api/*` routes require an authenticated instructor application session unless explicitly documented otherwise"), and every session/member/record lookup MUST verify the resource belongs to the authenticated session's institution/course — cross-tenant access returns `404`, never `403` (avoids leaking that a resource exists in another tenant).
- Ambiguous card-to-roster matches (more than one `attendance_session_members` row matches a resolved `institutionalId`) MUST resolve to `status: 'unexpected'`, never `'present'` (spec §20).
- Matches happen against **this session's roster snapshot** (`attendance_session_members`), never against the live `course_members` table — that is what makes the snapshot immutable.
- `late`/`excused` are manual-correction-only outcomes this phase; the automated scan pipeline only ever produces `present` / `unexpected` / `lookup_error`. No auto-cutoff policy exists yet.
- Follow the existing `registerXRoute(app, deps)` convention (`server/src/routes/scans.ts`) and the existing Fastify-`inject` test pattern (`server/tests/routes/scans.test.ts`) for every new route and its tests.
- **Grounding note:** this plan is written against Phase 3's and Phase 4's module interfaces exactly as documented in the design doc (`requireSession`/`requireCsrf`/`appSession` shape from Phase 3; `CourseRosterMember`/`refreshCourseRoster`/`findCourseMembersByInstitutionalId` from Phase 4). Before writing any task's code, re-confirm those exact exports against the real Phase 3/4 source in this repo (they will exist by the time this plan executes) and adapt this plan's call sites if the real signatures differ even slightly. Never change Phase 3/4's already-shipped public interfaces to fit this plan — fix the mismatch here instead.

---

## File structure

```
server/src/attendance/
  session-lifecycle.ts     # createSession / closeSession / reopenSession — state machine + audit writes
  scan-service.ts            # submitScan() — idempotency, identity+roster-snapshot matching
  member-status.ts            # resolveCurrentRecord() — "most-recent-record-wins" resolution
  manual-correction.ts         # applyManualCorrection() — always appends, never mutates
  csv-export.ts                 # buildAttendanceCsv() — server-side port of web/csv.js's csvEscapeField
  card-fingerprint.ts            # computeCardFingerprint() — HMAC-SHA256(cardCode, secret), spec §22

server/src/routes/
  attendance-sessions.ts   # POST/GET/close/reopen/scans/members-PATCH/records-DELETE/export.csv

server/src/database/
  schema.ts                # MODIFIED: adds attendanceSessions/attendanceSessionMembers/attendanceRecords,
                            #   confirms/extends auditEvents with the attendanceSessionId FK

web/
  attendance-session.js    # NEW: client session lifecycle (create/close/reopen/status)
  scan-pipeline.js         # MODIFIED: submitScan(sessionId, clientScanId, cardCode); server status trusted verbatim
  app.js                   # MODIFIED: Start/Close/Reopen wiring, roster panel sourced from GET /api/course/roster
  ui.js                    # MODIFIED: session-state rendering (Start/Close/Reopen button states, session label)
  index.html                # MODIFIED: new session-control markup

server/tests/attendance/{session-lifecycle,scan-service,member-status,manual-correction,csv-export,card-fingerprint}.test.ts
server/tests/routes/attendance-sessions.test.ts
web/tests/scan-pipeline.test.js   # MODIFIED: transport assertions updated, all existing cases preserved
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

// attendanceRecords -- append-only. "Current status" for a member is resolved by
// member-status.ts's resolveCurrentRecord(), never by mutating a row in place.
export const attendanceRecords = pgTable(
  'attendance_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attendanceSessionId: uuid('attendance_session_id').notNull().references(() => attendanceSessions.id),
    ltiUserId: text('lti_user_id'),
    institutionalId: text('institutional_id'),
    clientScanId: text('client_scan_id'),
    status: text('status', { enum: ['present', 'absent', 'late', 'excused', 'lookup_error', 'unexpected'] }).notNull(),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
    source: text('source', { enum: ['card', 'manual', 'system_absence', 'import'] }).notNull(),
    cardFingerprint: text('card_fingerprint'),
    lookupErrorKind: text('lookup_error_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The idempotency mechanism: a retried submission with the same clientScanId
    // never creates a second row. clientScanId is nullable (manual/system_absence
    // records have none), so this constraint only actually de-duplicates 'card' scans.
    uniqueSessionClientScanId: uniqueIndex('attendance_records_session_client_scan_id_key').on(
      table.attendanceSessionId,
      table.clientScanId
    ),
  })
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

```ts
// server/src/attendance/member-status.ts
export function resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null;

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
  sessionId: string,
  input: SubmitScanInput,
  deps: SubmitScanDeps
): Promise<AttendanceRecordRow>;

// server/src/attendance/session-lifecycle.ts
export async function createSession(
  courseId: string,
  startedByLtiUserId: string,
  body: { label?: string; meetingAt?: string }
): Promise<AttendanceSessionRow>;
export async function closeSession(sessionId: string, actorLtiUserId: string): Promise<void>;
export async function reopenSession(sessionId: string, actorLtiUserId: string, reason?: string): Promise<void>;

// server/src/attendance/manual-correction.ts
export async function applyManualCorrection(
  sessionId: string,
  ltiUserId: string,
  input: { status: 'present' | 'absent' | 'late' | 'excused'; note?: string },
  actorLtiUserId: string
): Promise<AttendanceRecordRow>;

// server/src/attendance/csv-export.ts
export function buildAttendanceCsv(rows: AttendanceExportRow[]): string;

// server/src/attendance/card-fingerprint.ts
export function computeCardFingerprint(cardCode: string, secret: string): string;
```

`AttendanceRecordRow` is the Drizzle-inferred row type of `attendanceRecords` (i.e. `typeof attendanceRecords.$inferSelect`). `AttendanceSessionRow` is `typeof attendanceSessions.$inferSelect`. These come from `server/src/database/schema.ts` — every task imports them from there rather than redefining them.

---

## Task 0: Verify `docker-compose.yml` Postgres is reachable and Phase 3/4 exports exist

**Files:**
- Read (no changes): `server/src/database/schema.ts`, `server/src/database/client.ts`, `server/src/auth/middleware.ts`, `server/src/lti/nrps.ts`, `server/src/attendance/roster-store.ts`
- Read (no changes): `docker-compose.yml`

**Interfaces:**
- Consumes: nothing new — this is a pre-flight check.
- Produces: confirmation that `requireSession`, `requireCsrf`, `refreshCourseRoster`, `CourseRosterMember`, `findCourseMembersByInstitutionalId`, and the Phase 3/4 Drizzle tables (`institutions`, `courses`, `courseMembers`, `appSessions`) exist with the shapes this plan assumes. If any differ, note the actual shape here before continuing — every later task in this plan must use the real shape, not the assumed one.

- [ ] **Step 1: Start Postgres and confirm connectivity**

Run: `docker compose up -d postgres && sleep 2 && docker compose exec postgres pg_isready -U attendance_tracker`
Expected: `/var/run/postgresql:5432 - accepting connections`

- [ ] **Step 2: Read the real Phase 3/Phase 4 exports**

Open `server/src/database/schema.ts` and confirm it exports `institutions`, `courses`, `courseMembers` (or the Phase 4 equivalent name), and (if Phase 4 already ran) `auditEvents`. Open `server/src/auth/middleware.ts` and confirm `requireSession`/`requireCsrf` preHandler signatures and what they decorate onto `request` (this plan assumes `request.appSession: { id, institutionId, courseId, ltiSubject, roles, csrfSecret }`). Open `server/src/lti/nrps.ts` and confirm `refreshCourseRoster(courseId): Promise<CourseRosterResult>` and the `CourseRosterMember` shape. Open `server/src/attendance/roster-store.ts` and confirm `findCourseMembersByInstitutionalId(courseId, institutionalId)`.

If every shape matches this plan's Global Constraints section and the signatures above, proceed unchanged. If anything differs (a renamed field, a different decorator name), write down the actual shape as a one-line comment at the top of this plan file before continuing, and use the real shape in every subsequent task — do not modify Phase 3/4 source to match this plan.

- [ ] **Step 3: Confirm whether `audit_events` already exists**

Run: `docker compose exec -T postgres psql -U attendance_tracker -d attendance_tracker -c "\d audit_events"`
Expected: either `Did not find any relation named "audit_events".` (Phase 4 hasn't run migrations yet, or ran before this session) or a full table description (Phase 4 already created it). Either outcome is fine — Task 1's migration is written to handle both.

---

## Task 1: Schema — add attendance tables, extend `audit_events`

**Files:**
- Modify: `server/src/database/schema.ts`
- Create/modify: a new file under `/migrations` (exact name assigned by `drizzle-kit generate`, referenced below as `<phase5-migration>.sql`)
- Test: `server/tests/database/schema.test.ts` (extend the existing Phase 3 smoke test file; if it doesn't exist yet under this name, create it following the same pattern Phase 3 used for `institutions`/`courses`)

**Interfaces:**
- Consumes: `institutions`, `courses` (Phase 3), `auditEvents` (Phase 4, if present) from `server/src/database/schema.ts`.
- Produces: `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords`, and (if not already present from Phase 4) `auditEvents`, all exported from `server/src/database/schema.ts`, plus their Drizzle-inferred row types `AttendanceSessionRow`, `AttendanceSessionMemberRow`, `AttendanceRecordRow`.

- [ ] **Step 1: Write the failing schema test**

```ts
// server/tests/database/schema.test.ts (append if the file already exists from Phase 3)
import { describe, it, expect } from 'vitest';
import { db } from '../../src/database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents } from '../../src/database/schema.js';

describe('Phase 5 schema', () => {
  it('attendance_sessions, attendance_session_members, attendance_records, audit_events exist and are queryable', async () => {
    await expect(db.select().from(attendanceSessions).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(attendanceSessionMembers).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(attendanceRecords).limit(1)).resolves.toEqual([]);
    await expect(db.select().from(auditEvents).limit(1)).resolves.toEqual([]);
  });

  it('rejects a second attendance_records row with the same (attendanceSessionId, clientScanId)', async () => {
    // Depends on a seeded institution/course/session existing -- see
    // server/tests/support/seed.ts's seedInstitutionAndRegistration and this
    // task's own local seedCourseAndSession helper below.
    const { sessionId } = await seedCourseAndSession();
    await db.insert(attendanceRecords).values({
      attendanceSessionId: sessionId,
      ltiUserId: 'user-1',
      institutionalId: '1000000',
      clientScanId: 'scan-abc',
      status: 'present',
      scannedAt: new Date().toISOString(),
      source: 'card',
    });
    await expect(
      db.insert(attendanceRecords).values({
        attendanceSessionId: sessionId,
        ltiUserId: 'user-1',
        institutionalId: '1000000',
        clientScanId: 'scan-abc',
        status: 'present',
        scannedAt: new Date().toISOString(),
        source: 'card',
      })
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });
});

async function seedCourseAndSession() {
  const [institution] = await db
    .insert((await import('../../src/database/schema.js')).institutions)
    .values({ slug: `schema-test-${Date.now()}`, displayName: 'Schema Test U', timezone: 'UTC', enabled: true })
    .returning();
  const { courses } = await import('../../src/database/schema.js');
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: institution.id, ltiContextId: 'ctx-1', label: 'TEST101', title: 'Test Course' })
    .returning();
  const [session] = await db
    .insert(attendanceSessions)
    .values({ courseId: course.id, startedByLtiUserId: 'instructor-1' })
    .returning();
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
git add server/src/database/schema.ts migrations/ server/tests/database/schema.test.ts
git commit -m "feat: add attendance_sessions/attendance_session_members/attendance_records schema"
```

---

## Task 2: `member-status.ts` — most-recent-record-wins resolution

**Files:**
- Create: `server/src/attendance/member-status.ts`
- Test: `server/tests/attendance/member-status.test.ts`

**Interfaces:**
- Consumes: `AttendanceRecordRow` from `server/src/database/schema.ts`.
- Produces: `resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null` — used by `scan-service.ts` (duplicate detection reads the winning record for a `clientScanId`), `session-lifecycle.ts` (`closeSession` needs to know who already has a record), and the `GET /api/attendance-sessions/{id}` route (renders current status per member).

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
// route handlers and closeSession() both call this function rather than
// re-deriving the rule.

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

## Task 4: `session-lifecycle.ts::createSession` — snapshots the roster

**Files:**
- Create: `server/src/attendance/session-lifecycle.ts` (this task only implements `createSession`; `closeSession`/`reopenSession` are Tasks 8–9)
- Test: `server/tests/attendance/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `refreshCourseRoster(courseId): Promise<CourseRosterResult>` and `CourseRosterMember` from Phase 4's `server/src/lti/nrps.ts` (per Task 0's grounding check); `db` from `server/src/database/client.ts`; `attendanceSessions`, `attendanceSessionMembers`, `auditEvents` from `server/src/database/schema.ts`.
- Produces: `createSession(courseId, startedByLtiUserId, body): Promise<AttendanceSessionRow>` — used by `routes/attendance-sessions.ts`'s `POST /api/attendance-sessions` handler.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/session-lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { createSession } from '../../src/attendance/session-lifecycle.js';
import { db } from '../../src/database/client.js';
import { attendanceSessionMembers } from '../../src/database/schema.js';
import { eq } from 'drizzle-orm';
import * as nrps from '../../src/lti/nrps.js';

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
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

describe('createSession', () => {
  it('snapshots every roster member verbatim into attendance_session_members', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    const members = [member(), member({ ltiUserId: 'user-2', institutionalId: '2000000', eligibleForAttendance: false, status: 'Inactive' })];
    vi.spyOn(nrps, 'refreshCourseRoster').mockResolvedValue({ ok: true, members, fetchedAt: new Date().toISOString() });

    const session = await createSession(courseId, 'instructor-1', {});

    const rows = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, session.id));
    expect(rows).toHaveLength(2);
    const row1 = rows.find((r) => r.ltiUserId === 'user-1');
    expect(row1.institutionalId).toBe('1000000');
    expect(row1.eligibleForAttendance).toBe(true);
    expect(row1.status).toBe('Active');
    expect(row1.snapshotData).toEqual(members[0]);
  });

  it('sets state=open, startedByLtiUserId, and optional label/meetingAt from the request body', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    vi.spyOn(nrps, 'refreshCourseRoster').mockResolvedValue({ ok: true, members: [], fetchedAt: new Date().toISOString() });

    const session = await createSession(courseId, 'instructor-1', { label: 'Monday lecture', meetingAt: '2026-08-26T14:00:00Z' });

    expect(session.state).toBe('open');
    expect(session.startedByLtiUserId).toBe('instructor-1');
    expect(session.label).toBe('Monday lecture');
    expect(session.courseId).toBe(courseId);
  });

  it('propagates a roster-refresh failure rather than creating an empty-snapshot session', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    vi.spyOn(nrps, 'refreshCourseRoster').mockResolvedValue({ ok: false, error: { kind: 'network', message: 'boom', retryable: true } });

    await expect(createSession(courseId, 'instructor-1', {})).rejects.toThrow(/roster refresh failed/i);
  });
});
```

Add `seedInstitutionAndCourse()` to `server/tests/support/seed.ts` if it doesn't already exist from Phase 3/4 (it should — reuse it; do not redefine it here if present):

```ts
// server/tests/support/seed.ts (add only if not already present)
export async function seedInstitutionAndCourse() {
  const [institution] = await db.insert(institutions).values({ slug: `test-${Date.now()}-${Math.random()}`, displayName: 'Test U', timezone: 'UTC', enabled: true }).returning();
  const [course] = await db.insert(courses).values({ institutionId: institution.id, deploymentId: institution.id, ltiContextId: `ctx-${Date.now()}`, label: 'TEST101', title: 'Test Course' }).returning();
  return { institutionId: institution.id, courseId: course.id };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `createSession`**

```ts
// server/src/attendance/session-lifecycle.ts
import { db } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, auditEvents, type AttendanceSessionRow } from '../database/schema.js';
import { refreshCourseRoster } from '../lti/nrps.js';

export async function createSession(
  courseId: string,
  startedByLtiUserId: string,
  body: { label?: string; meetingAt?: string }
): Promise<AttendanceSessionRow> {
  const roster = await refreshCourseRoster(courseId);
  if (!roster.ok) {
    throw new Error(`Cannot start an attendance session: roster refresh failed (${roster.error.kind}: ${roster.error.message})`);
  }

  return db.transaction(async (tx) => {
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
        }))
      );
    }

    return session;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts server/tests/support/seed.ts
git commit -m "feat: add createSession, snapshotting the Canvas roster into attendance_session_members"
```

---

## Task 5: `scan-service.ts` — valid scan produces a `present` record

**Files:**
- Create: `server/src/attendance/scan-service.ts`
- Test: `server/tests/attendance/scan-service.test.ts`

**Interfaces:**
- Consumes: `IdentityResolver`/`IdentityResolution` from `server/src/identity/types.ts` (Phase 2, unchanged); `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords` from `server/src/database/schema.ts`; `computeCardFingerprint` from Task 3.
- Produces: `submitScan(sessionId, input, deps): Promise<AttendanceRecordRow>` per the fixed signature in this plan's header — used by `routes/attendance-sessions.ts`'s `POST .../scans` handler.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/scan-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { submitScan } from '../../src/attendance/scan-service.js';
import { db } from '../../src/database/client.js';
import { attendanceSessions, attendanceSessionMembers } from '../../src/database/schema.js';
import type { IdentityResolver, IdentityResolution } from '../../src/identity/types.js';

beforeEach(async () => {
  await resetDb();
});

function successResolution(overrides: Partial<IdentityResolution> = {}): IdentityResolution {
  return { ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null, ...overrides };
}

async function seedOpenSessionWithMember(institutionalId = '1000000') {
  const { institutionId, courseId } = await seedInstitutionAndCourse();
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
      sessionId,
      { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() },
      { resolver, institution: { id: institutionId, cardFingerprintEnabled: true } }
    );

    expect(record.cardFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects scan submission with a 409-mapped error when the session is closed', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const resolver: IdentityResolver = { resolveCard: async () => successResolution() };

    await expect(
      submitScan(session.id, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } })
    ).rejects.toMatchObject({ code: 'session_closed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the valid-scan and closed-session paths**

```ts
// server/src/attendance/scan-service.ts
//
// The scan pipeline's server-side counterpart. Every branch here is
// release-blocking per spec §47: identity resolution failures must become a
// recorded 'lookup_error' scan, not a lost/silently-dropped one, and an
// ambiguous roster match must never resolve to 'present' (spec §20).

import { and, eq } from 'drizzle-orm';
import { db } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, type AttendanceRecordRow } from '../database/schema.js';
import type { IdentityResolver } from '../identity/types.js';
import { computeCardFingerprint } from './card-fingerprint.js';

export interface SubmitScanInput {
  clientScanId: string;
  cardCode: string;
  scannedAt: string;
}
export interface SubmitScanDeps {
  resolver: IdentityResolver;
  institution: { id: string; cardFingerprintEnabled: boolean };
}

class SessionClosedError extends Error {
  code = 'session_closed' as const;
  constructor() {
    super('Attendance session is closed; scans are not accepted.');
  }
}

export async function submitScan(sessionId: string, input: SubmitScanInput, deps: SubmitScanDeps): Promise<AttendanceRecordRow> {
  // Step 1: idempotency -- a retried submission with the same clientScanId
  // returns the existing record without calling the resolver again.
  const [existing] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, input.clientScanId)));
  if (existing) return existing;

  const [session] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
  if (!session) throw new SessionClosedError(); // treated the same as closed by the route (404 vs this distinguished in the route handler)
  if (session.state === 'closed') throw new SessionClosedError();

  const resolution = await deps.resolver.resolveCard(input.cardCode);

  let status: AttendanceRecordRow['status'];
  let ltiUserId: string | null = null;
  let institutionalId: string | null = null;
  let lookupErrorKind: string | null = null;

  if (!resolution.ok) {
    status = 'lookup_error';
    lookupErrorKind = resolution.error?.kind ?? 'unknown';
  } else {
    institutionalId = resolution.universityId;
    const matches = await db
      .select()
      .from(attendanceSessionMembers)
      .where(and(eq(attendanceSessionMembers.attendanceSessionId, sessionId), eq(attendanceSessionMembers.institutionalId, institutionalId ?? '')));

    if (matches.length === 1) {
      status = 'present';
      ltiUserId = matches[0].ltiUserId;
    } else {
      // Zero matches (not on roster) or more than one (ambiguous) both
      // resolve to 'unexpected' -- an ambiguous match must never become
      // 'present' (spec §20).
      status = 'unexpected';
    }
  }

  const cardFingerprint = deps.institution.cardFingerprintEnabled ? computeCardFingerprint(input.cardCode, cardFingerprintSecretFor(deps.institution.id)) : null;

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

  // Lost the race to a concurrent identical submission (e.g. the HTTP
  // response was lost and the client retried while the first request was
  // still committing) -- the winner is already there; return it.
  const [winner] = await db
    .select()
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, input.clientScanId)));
  return winner;
}

// Card-fingerprint secrets are app-wide (via env var), not per-institution,
// since only one institution is live at this stage -- see this plan's
// "Risks / open items" for the migration path if that changes.
function cardFingerprintSecretFor(_institutionId: string): string {
  const secret = process.env.CARD_FINGERPRINT_SECRET;
  if (!secret) throw new Error('CARD_FINGERPRINT_SECRET must be set when card fingerprinting is enabled.');
  return secret;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS — 4 tests green. (The `institution: { id: institutionId, cardFingerprintEnabled: true }` test requires `CARD_FINGERPRINT_SECRET` to be set in the test environment — add `CARD_FINGERPRINT_SECRET=test-secret-do-not-use-in-prod` to `server/tests/support/db.ts`'s test env setup, or to a `.env.test` loaded by `vitest.config.ts`'s `test.env`, whichever pattern Phase 3 already established for test env vars.)

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/scan-service.ts server/tests/attendance/scan-service.test.ts
git commit -m "feat: add submitScan — valid scan, closed-session rejection, idempotency skeleton"
```

---

## Task 6: `scan-service.ts` — identity not on roster, ambiguous match, lookup error

**Files:**
- Modify: `server/tests/attendance/scan-service.test.ts` (append; no source changes needed — Task 5's implementation already handles these branches, this task is the verification pass required by spec §47/§45's "do not consider done until these tests exist" standard)

**Interfaces:**
- Consumes: `submitScan` from Task 5 (unchanged signature).
- Produces: nothing new — additional test coverage only.

- [ ] **Step 1: Write the failing tests**

```ts
// append to server/tests/attendance/scan-service.test.ts

describe('submitScan -- roster matching edge cases', () => {
  it('marks a resolved identity not present in the session snapshot as unexpected, not present', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000'); // only 1000000 is on the roster
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '9999999' }) };

    const record = await submitScan(sessionId, { clientScanId: 'scan-1', cardCode: 'CARD999', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('unexpected');
    expect(record.ltiUserId).toBeNull();
    expect(record.institutionalId).toBe('9999999');
  });

  it('marks an ambiguous match (duplicate institutionalId in the snapshot) as unexpected, never present', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane A', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'user-2', institutionalId: '1000000', displayName: 'Jane B', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
    ]);
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };

    const record = await submitScan(session.id, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('unexpected');
    expect(record.ltiUserId).toBeNull();
  });

  it('records a lookup_error status (with lookupErrorKind) when the resolver fails, rather than dropping the scan', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember();
    const resolver: IdentityResolver = { resolveCard: async () => ({ ok: false, universityId: null, firstName: null, lastName: null, email: null, raw: null, error: { kind: 'timeout', message: 'Lookup timed out' } }) };

    const record = await submitScan(sessionId, { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(record.status).toBe('lookup_error');
    expect(record.lookupErrorKind).toBe('timeout');
    expect(record.ltiUserId).toBeNull();
    expect(record.institutionalId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: these three should already PASS given Task 5's implementation (this task exists to make each §47/§20 case an explicit, named, independently-readable test rather than an implicit side effect of Task 5's code). If any fails, fix `scan-service.ts`'s matching branch (Task 5, Step 3) — do not weaken the test.

- [ ] **Step 3: Confirm full suite still green**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS — 7 tests total green.

- [ ] **Step 4: Commit**

```bash
git add server/tests/attendance/scan-service.test.ts
git commit -m "test: cover unexpected/ambiguous-match/lookup_error scan-service cases explicitly"
```

---

## Task 7: `scan-service.ts` — duplicate `clientScanId` and lost-response race

**Files:**
- Modify: `server/tests/attendance/scan-service.test.ts` (append)

**Interfaces:**
- Consumes: `submitScan` from Task 5 (unchanged signature — the `ON CONFLICT DO NOTHING` + `SELECT`-fallback logic was already written in Task 5, Step 3; this task verifies both the sequential-retry and the genuinely concurrent case).
- Produces: nothing new — test coverage for spec §21's idempotency requirement and §47's "duplicate API submission with same `clientScanId`" / "network response lost then retried" cases.

- [ ] **Step 1: Write the failing tests**

```ts
// append to server/tests/attendance/scan-service.test.ts

describe('submitScan -- idempotency', () => {
  it('returns the same record, without calling the resolver again, for a duplicate clientScanId submitted sequentially', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolveCard = vi.fn().mockResolvedValue(successResolution({ universityId: '1000000' }));
    const resolver: IdentityResolver = { resolveCard };

    const first = await submitScan(sessionId, { clientScanId: 'dup-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });
    const second = await submitScan(sessionId, { clientScanId: 'dup-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() }, { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } });

    expect(second.id).toBe(first.id);
    expect(resolveCard).toHaveBeenCalledTimes(1); // second call short-circuits before ever calling the resolver
  });

  it('when two concurrent requests race on the same clientScanId (lost-response-then-retried), exactly one attendance_records row is created and both callers see it', async () => {
    const { institutionId, sessionId } = await seedOpenSessionWithMember('1000000');
    const resolver: IdentityResolver = { resolveCard: async () => successResolution({ universityId: '1000000' }) };
    const input = { clientScanId: 'race-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() };
    const deps = { resolver, institution: { id: institutionId, cardFingerprintEnabled: false } };

    const [a, b] = await Promise.all([submitScan(sessionId, input, deps), submitScan(sessionId, input, deps)]);

    expect(a.id).toBe(b.id);
    const allRows = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.clientScanId, 'race-1')));
    expect(allRows).toHaveLength(1);
  });
});
```

Add `import { vi } from 'vitest';` and `import { attendanceRecords } from '../../src/database/schema.js';` and `import { and, eq } from 'drizzle-orm';` to this test file's imports if not already present from earlier tasks.

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS — both new cases exercise logic already implemented in Task 5. If the concurrent-race test flakes or fails, the most likely cause is the initial idempotency `SELECT` (Task 5 Step 3's first block) racing ahead of the `INSERT ... ON CONFLICT` under real Postgres transaction isolation; if that happens, remove the pre-check `SELECT` short-circuit for the concurrent path is not needed since the `ON CONFLICT DO NOTHING` + fallback `SELECT` already guarantees single-row correctness — the initial `SELECT` is purely an optimization to skip a resolver call on an already-known duplicate, and its absence/race does not affect correctness, only whether the resolver is called an extra time under a true concurrent race (acceptable — the resolver being idempotent from the caller's perspective is not required, only the database write is).

- [ ] **Step 3: Confirm full suite still green**

Run: `npx vitest run server/tests/attendance/scan-service.test.ts`
Expected: PASS — 9 tests total green.

- [ ] **Step 4: Commit**

```bash
git add server/tests/attendance/scan-service.test.ts
git commit -m "test: cover clientScanId idempotency under sequential retry and concurrent race"
```

---

## Task 8: `session-lifecycle.ts::closeSession` — marks unscanned members absent, writes audit

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts`
- Modify: `server/tests/attendance/session-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: `resolveCurrentRecord` from Task 2; `attendanceSessions`, `attendanceSessionMembers`, `attendanceRecords`, `auditEvents` from schema.
- Produces: `closeSession(sessionId, actorLtiUserId): Promise<void>` — used by `routes/attendance-sessions.ts`'s `POST .../close` handler.

- [ ] **Step 1: Write the failing tests**

```ts
// append to server/tests/attendance/session-lifecycle.test.ts
import { closeSession } from '../../src/attendance/session-lifecycle.js';
import { attendanceRecords, auditEvents } from '../../src/database/schema.js';

describe('closeSession', () => {
  it('inserts a system_absence record for every eligible member with zero existing records, sets state=closed, and writes an audit event', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values([
      { attendanceSessionId: session.id, ltiUserId: 'scanned-user', institutionalId: '1000000', displayName: 'Scanned', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'unscanned-user', institutionalId: '2000000', displayName: 'Unscanned', eligibleForAttendance: true, status: 'Active', snapshotData: {} },
      { attendanceSessionId: session.id, ltiUserId: 'ineligible-user', institutionalId: '3000000', displayName: 'Ineligible', eligibleForAttendance: false, status: 'Inactive', snapshotData: {} },
    ]);
    await db.insert(attendanceRecords).values({
      attendanceSessionId: session.id,
      ltiUserId: 'scanned-user',
      institutionalId: '1000000',
      clientScanId: 'scan-1',
      status: 'present',
      scannedAt: new Date().toISOString(),
      source: 'card',
    });

    await closeSession(session.id, 'instructor-1');

    const [closed] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(closed.state).toBe('closed');
    expect(closed.closedAt).not.toBeNull();

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    const absenceRecords = records.filter((r) => r.source === 'system_absence');
    expect(absenceRecords).toHaveLength(1);
    expect(absenceRecords[0].ltiUserId).toBe('unscanned-user');
    expect(absenceRecords[0].status).toBe('absent');

    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_closed'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
  });

  it('is idempotent to the eligible-member scan: a scanned-but-later-unexpected member is not marked system_absence', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    // Simulate: this member's card resolved to someone else's ID, so their
    // own attendance_records entry is a manual 'excused' correction, not a scan.
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: null, status: 'excused', scannedAt: new Date().toISOString(), source: 'manual' });

    await closeSession(session.id, 'instructor-1');

    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, session.id));
    expect(records.filter((r) => r.source === 'system_absence')).toHaveLength(0); // already has a record; not absent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — `closeSession is not a function`.

- [ ] **Step 3: Implement `closeSession`**

Append to `server/src/attendance/session-lifecycle.ts`:

```ts
import { resolveCurrentRecord } from './member-status.js';

export async function closeSession(sessionId: string, actorLtiUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);

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
        scannedAt: now,
        source: 'system_absence' as const,
      }));

    if (absentInserts.length > 0) {
      await tx.insert(attendanceRecords).values(absentInserts);
    }

    await tx.update(attendanceSessions).set({ state: 'closed', closedAt: now, updatedAt: now }).where(eq(attendanceSessions.id, sessionId));

    await tx.insert(auditEvents).values({
      institutionId: (await tx.select().from(attendanceSessionMembers)) && session.courseId ? await courseInstitutionId(tx, session.courseId) : null,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_closed',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { markedAbsentCount: absentInserts.length },
    });
  });
}

async function courseInstitutionId(tx: typeof db, courseId: string): Promise<string> {
  const { courses } = await import('../database/schema.js');
  const [course] = await tx.select().from(courses).where(eq(courses.id, courseId));
  return course.institutionId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS — 5 tests total green.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "feat: add closeSession — marks unscanned eligible members absent, writes audit event"
```

---

## Task 9: `session-lifecycle.ts::reopenSession` — audited reopen

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts`
- Modify: `server/tests/attendance/session-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: `attendanceSessions`, `auditEvents` from schema.
- Produces: `reopenSession(sessionId, actorLtiUserId, reason?): Promise<void>` — used by `routes/attendance-sessions.ts`'s `POST .../reopen` handler.

- [ ] **Step 1: Write the failing tests**

```ts
// append to server/tests/attendance/session-lifecycle.test.ts
import { reopenSession } from '../../src/attendance/session-lifecycle.js';

describe('reopenSession', () => {
  it('sets state=reopened, clears closedAt, and writes an audit event including the reason', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed', closedAt: new Date() }).returning();

    await reopenSession(session.id, 'instructor-1', 'Student reported a missed scan');

    const [reopened] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(reopened.state).toBe('reopened');

    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_reopened'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].newValue).toMatchObject({ reason: 'Student reported a missed scan' });
  });

  it('accepts scans again once reopened (state=reopened is a scan-accepting state, not closed)', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    await reopenSession(session.id, 'instructor-1');

    const [reopened] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(reopened.state).not.toBe('closed'); // scan-service.ts's closed-session check only rejects state==='closed'
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — `reopenSession is not a function`.

- [ ] **Step 3: Implement `reopenSession`**

Append to `server/src/attendance/session-lifecycle.ts`:

```ts
export async function reopenSession(sessionId: string, actorLtiUserId: string, reason?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);

    await tx.update(attendanceSessions).set({ state: 'reopened', closedAt: null, updatedAt: new Date() }).where(eq(attendanceSessions.id, sessionId));

    await tx.insert(auditEvents).values({
      institutionId: await courseInstitutionId(tx, session.courseId),
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_reopened',
      targetType: 'attendance_session',
      targetId: sessionId,
      newValue: { reason: reason ?? null },
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
git commit -m "feat: add reopenSession — audited reopen, scans accepted again"
```

---

## Task 10: `manual-correction.ts` — always appends, never mutates

**Files:**
- Create: `server/src/attendance/manual-correction.ts`
- Test: `server/tests/attendance/manual-correction.test.ts`

**Interfaces:**
- Consumes: `attendanceRecords`, `auditEvents` from schema; `resolveCurrentRecord` from Task 2 (to look up the previous status for the audit event's `oldValue`).
- Produces: `applyManualCorrection(sessionId, ltiUserId, input, actorLtiUserId): Promise<AttendanceRecordRow>` — used by `routes/attendance-sessions.ts`'s `PATCH .../members/{ltiUserId}` handler.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/manual-correction.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { resetDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { applyManualCorrection } from '../../src/attendance/manual-correction.js';
import { db } from '../../src/database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents } from '../../src/database/schema.js';

beforeEach(async () => {
  await resetDb();
});

async function seedSessionWithScannedMember() {
  const { courseId } = await seedInstitutionAndCourse();
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
  await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
  await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date().toISOString(), source: 'card' });
  return session.id;
}

describe('applyManualCorrection', () => {
  it('inserts a new source=manual record rather than mutating the existing one', async () => {
    const sessionId = await seedSessionWithScannedMember();

    const result = await applyManualCorrection(sessionId, 'user-1', { status: 'excused', note: 'Institution-approved absence' }, 'instructor-1');

    expect(result.status).toBe('excused');
    expect(result.source).toBe('manual');
    const allRecords = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.attendanceSessionId, sessionId), eq(attendanceRecords.ltiUserId, 'user-1')));
    expect(allRecords).toHaveLength(2); // original 'present' card scan untouched, new 'excused' manual record appended
    expect(allRecords.some((r) => r.status === 'present' && r.source === 'card')).toBe(true);
  });

  it('writes an attendance_manual_change audit event with the note in newValue and no note column on attendance_records', async () => {
    const sessionId = await seedSessionWithScannedMember();

    const result = await applyManualCorrection(sessionId, 'user-1', { status: 'late', note: 'Bus was delayed' }, 'instructor-1');

    expect(Object.keys(result)).not.toContain('note'); // matches spec §26's literal column list
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_manual_change'));
    expect(events).toHaveLength(1);
    expect(events[0].actorLtiUserId).toBe('instructor-1');
    expect(events[0].targetId).toBe('user-1');
    expect(events[0].oldValue).toMatchObject({ status: 'present' });
    expect(events[0].newValue).toMatchObject({ status: 'late', note: 'Bus was delayed' });
  });

  it('works for a member with no prior record (oldValue is null)', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-2', institutionalId: '2000000', displayName: 'No Scan', eligibleForAttendance: true, status: 'Active', snapshotData: {} });

    const result = await applyManualCorrection(session.id, 'user-2', { status: 'excused' }, 'instructor-1');

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
// stays the single rule everywhere, with no second code path to keep in
// sync. The correction note lives only in audit_events.new_value (JSONB);
// there is deliberately no `note` column on attendance_records (matches
// spec §26's literal column list).

import { and, eq } from 'drizzle-orm';
import { db } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, courses, type AttendanceRecordRow } from '../database/schema.js';
import { resolveCurrentRecord } from './member-status.js';

export async function applyManualCorrection(
  sessionId: string,
  ltiUserId: string,
  input: { status: 'present' | 'absent' | 'late' | 'excused'; note?: string },
  actorLtiUserId: string
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
        scannedAt: new Date(),
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
- Produces: `buildAttendanceCsv(rows: AttendanceExportRow[]): string` — used by `routes/attendance-sessions.ts`'s `GET .../export.csv` handler.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/csv-export.test.ts
import { describe, it, expect } from 'vitest';
import { buildAttendanceCsv } from '../../src/attendance/csv-export.js';

describe('buildAttendanceCsv', () => {
  it('produces a header row plus one row per member, CRLF-joined', () => {
    const csv = buildAttendanceCsv([
      { ltiUserId: 'u1', institutionalId: '1000000', displayName: 'Jane Smith', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'card' },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('institutionalId,displayName,status,source,scannedAt');
    expect(lines[1]).toBe('1000000,Jane Smith,present,card,2026-08-26T10:00:00.000Z');
  });

  it('quotes a field containing a comma, double quote, or newline, and doubles embedded quotes (RFC 4180)', () => {
    const csv = buildAttendanceCsv([{ ltiUserId: 'u1', institutionalId: '1000000', displayName: 'Smith, "Jane"', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'manual' }]);
    expect(csv).toContain('"Smith, ""Jane"""');
  });

  it('renders a null field as an empty string, matching web/csv.js\'s csvEscapeField', () => {
    const csv = buildAttendanceCsv([{ ltiUserId: 'u1', institutionalId: null, displayName: null, status: 'lookup_error', scannedAt: '2026-08-26T10:00:00.000Z', source: 'card' }]);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toBe(',,lookup_error,card,2026-08-26T10:00:00.000Z');
  });

  it('returns just the header row for an empty record set', () => {
    const csv = buildAttendanceCsv([]);
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
  scannedAt: string;
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

export function buildAttendanceCsv(rows: AttendanceExportRow[]): string {
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
git commit -m "feat: add server-side CSV export, byte-identical escaping to web/csv.js"
```

---

## Task 12: `routes/attendance-sessions.ts` — wire every route, tenant isolation

**Files:**
- Create: `server/src/routes/attendance-sessions.ts`
- Test: `server/tests/routes/attendance-sessions.test.ts`
- Modify: `server/src/index.ts` (register the new route)

**Interfaces:**
- Consumes: `createSession`/`closeSession`/`reopenSession` (Tasks 4/8/9), `submitScan` (Task 5), `applyManualCorrection` (Task 10), `buildAttendanceCsv` (Task 11), `resolveCurrentRecord` (Task 2); `requireSession`/`requireCsrf` from Phase 3's `server/src/auth/middleware.ts` (per Task 0's grounding check); `MockIdentityResolver`/`createHttpIdentityResolverFromEnv` from Phase 2's `server/src/identity/*` (same fallback pattern as `server/src/index.ts` already uses for `registerScansRoute`).
- Produces: `registerAttendanceSessionsRoute(app, deps)` following the existing `registerXRoute(app, deps)` convention, mounted in `server/src/index.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/routes/attendance-sessions.test.ts
import Fastify from 'fastify';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { resetDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { registerAttendanceSessionsRoute } from '../../src/routes/attendance-sessions.js';
import { db } from '../../src/database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords } from '../../src/database/schema.js';
import * as nrps from '../../src/lti/nrps.js';
import type { IdentityResolver } from '../../src/identity/types.js';

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});

function buildTestApp({ resolver, appSession }: { resolver: IdentityResolver; appSession: { id: string; institutionId: string; courseId: string; ltiSubject: string; roles: string[] } }) {
  const app = Fastify({ logger: false });
  // Stand-in for Phase 3's real requireSession preHandler: decorates a
  // fixed session for every request in this test, matching the shape
  // Task 0 confirmed appSession has.
  app.addHook('preHandler', async (request) => {
    (request as any).appSession = appSession;
  });
  registerAttendanceSessionsRoute(app, { resolver });
  return app;
}

describe('attendance-sessions routes', () => {
  it('POST /api/attendance-sessions creates a session scoped to the caller\'s course', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    vi.spyOn(nrps, 'refreshCourseRoster').mockResolvedValue({ ok: true, members: [], fetchedAt: new Date().toISOString() });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'POST', url: '/api/attendance-sessions', payload: {} });

    expect(response.statusCode).toBe(201);
    expect(response.json().courseId).toBe(courseId);
  });

  it('GET /api/attendance-sessions/{id} on another institution\'s session returns 404, not 403', async () => {
    const { courseId: ownCourseId, institutionId: ownInstitutionId } = await seedInstitutionAndCourse();
    const { courseId: otherCourseId } = await seedInstitutionAndCourse();
    const [otherSession] = await db.insert(attendanceSessions).values({ courseId: otherCourseId, startedByLtiUserId: 'someone-else', state: 'open' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId: ownInstitutionId, courseId: ownCourseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'GET', url: `/api/attendance-sessions/${otherSession.id}` });

    expect(response.statusCode).toBe(404);
  });

  it('POST .../scans records a scan and returns the normalized record', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null }) };
    const app = buildTestApp({ resolver, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, payload: { clientScanId: 'scan-1', cardCode: 'CARD001', scannedAt: new Date().toISOString() } });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('present');
  });

  it('POST .../scans never echoes the raw cardCode back in the response or in the request logger', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const resolver: IdentityResolver = { resolveCard: vi.fn().mockResolvedValue({ ok: true, universityId: '1000000', firstName: 'Jane', lastName: 'Smith', email: 'jane@example.edu', raw: {}, error: null }) };
    const app = buildTestApp({ resolver, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/scans`, payload: { clientScanId: 'scan-1', cardCode: 'SUPERSECRETCARD42', scannedAt: new Date().toISOString() } });

    expect(JSON.stringify(response.json())).not.toContain('SUPERSECRETCARD42');
  });

  it('POST .../close closes the session and marks unscanned eligible members absent', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/close` });

    expect(response.statusCode).toBe(200);
    const [closed] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
    expect(closed.state).toBe('closed');
  });

  it('POST .../reopen reopens a closed session', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'closed' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/reopen`, payload: { reason: 'Missed scans' } });

    expect(response.statusCode).toBe(200);
  });

  it('PATCH .../members/{ltiUserId} applies a manual correction', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'PATCH', url: `/api/attendance-sessions/${session.id}/members/user-1`, payload: { status: 'excused', note: 'Approved absence' } });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('excused');
  });

  it('DELETE .../members/{ltiUserId}/records/{recordId} removes a mis-scanned record and writes an audit event', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    const [record] = await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: new Date().toISOString(), source: 'card' }).returning();
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

    const response = await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${session.id}/members/user-1/records/${record.id}` });

    expect(response.statusCode).toBe(204);
    const remaining = await db.select().from(attendanceRecords).where(eq(attendanceRecords.id, record.id));
    expect(remaining).toHaveLength(0);
    const { auditEvents } = await import('../../src/database/schema.js');
    const events = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_record_removed'));
    expect(events).toHaveLength(1);
  });

  it('GET .../export.csv returns a CSV body with the current-record status per member', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse();
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'instructor-1', state: 'open' }).returning();
    await db.insert(attendanceSessionMembers).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', displayName: 'Jane Smith', eligibleForAttendance: true, status: 'Active', snapshotData: {} });
    await db.insert(attendanceRecords).values({ attendanceSessionId: session.id, ltiUserId: 'user-1', institutionalId: '1000000', clientScanId: 'scan-1', status: 'present', scannedAt: '2026-08-26T10:00:00.000Z', source: 'card' });
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, appSession: { id: 's1', institutionId, courseId, ltiSubject: 'instructor-1', roles: [] } });

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
// Every route here requires request.appSession (decorated by Phase 3's
// requireSession preHandler -- mounted on this router's prefix in
// server/src/index.ts, not re-implemented here). Every session/record
// lookup is scoped to request.appSession.courseId; a resource belonging to
// a different course returns 404 (never 403) to avoid leaking existence
// across tenants.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../database/client.js';
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, courses, type AttendanceRecordRow } from '../database/schema.js';
import { createSession, closeSession, reopenSession } from '../attendance/session-lifecycle.js';
import { submitScan } from '../attendance/scan-service.js';
import { applyManualCorrection } from '../attendance/manual-correction.js';
import { buildAttendanceCsv } from '../attendance/csv-export.js';
import { resolveCurrentRecord } from '../attendance/member-status.js';
import type { IdentityResolver } from '../identity/types.js';

const createSessionSchema = z.object({ label: z.string().optional(), meetingAt: z.string().datetime().optional() });
const scanSchema = z.object({ clientScanId: z.string().min(1), cardCode: z.string().min(1), scannedAt: z.string().datetime() });
const manualCorrectionSchema = z.object({ status: z.enum(['present', 'absent', 'late', 'excused']), note: z.string().optional() });
const reopenSchema = z.object({ reason: z.string().optional() }).optional();

async function loadSessionScopedToCourse(sessionId: string, courseId: string) {
  const [session] = await db.select().from(attendanceSessions).where(and(eq(attendanceSessions.id, sessionId), eq(attendanceSessions.courseId, courseId)));
  return session ?? null;
}

export function registerAttendanceSessionsRoute(app: FastifyInstance, deps: { resolver: IdentityResolver }): void {
  app.post('/api/attendance-sessions', async (request, reply) => {
    const parsed = createSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body.' });

    const { courseId, ltiSubject } = (request as any).appSession;
    try {
      const session = await createSession(courseId, ltiSubject, parsed.data);
      return reply.code(201).send(session);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/attendance-sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { courseId } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    const members = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, id));
    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, id));
    const recordsByLtiUserId = new Map<string, AttendanceRecordRow[]>();
    for (const record of records) {
      if (!record.ltiUserId) continue;
      const list = recordsByLtiUserId.get(record.ltiUserId) ?? [];
      list.push(record);
      recordsByLtiUserId.set(record.ltiUserId, list);
    }

    return {
      ...session,
      members: members.map((m) => ({
        ltiUserId: m.ltiUserId,
        displayName: m.displayName,
        eligibleForAttendance: m.eligibleForAttendance,
        currentRecord: resolveCurrentRecord(recordsByLtiUserId.get(m.ltiUserId) ?? []),
      })),
    };
  });

  app.post('/api/attendance-sessions/:id/scans', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { courseId, institutionId } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body: expected { clientScanId, cardCode, scannedAt }.' });

    try {
      const record = await submitScan(id, parsed.data, { resolver: deps.resolver, institution: { id: institutionId, cardFingerprintEnabled: process.env.CARD_FINGERPRINT_SECRET != null } });
      return record;
    } catch (err) {
      if ((err as { code?: string }).code === 'session_closed') return reply.code(409).send({ error: 'Attendance session is closed.' });
      throw err;
    }
  });

  app.patch('/api/attendance-sessions/:id/members/:ltiUserId', async (request, reply) => {
    const { id, ltiUserId } = request.params as { id: string; ltiUserId: string };
    const { courseId, ltiSubject } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    const parsed = manualCorrectionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body.' });

    const record = await applyManualCorrection(id, ltiUserId, parsed.data, ltiSubject);
    return record;
  });

  app.delete('/api/attendance-sessions/:id/members/:ltiUserId/records/:recordId', async (request, reply) => {
    const { id, ltiUserId, recordId } = request.params as { id: string; ltiUserId: string; recordId: string };
    const { courseId, ltiSubject } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    const [record] = await db.select().from(attendanceRecords).where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.attendanceSessionId, id), eq(attendanceRecords.ltiUserId, ltiUserId)));
    if (!record) return reply.code(404).send({ error: 'Attendance record not found.' });

    const [course] = await db.select().from(courses).where(eq(courses.id, session.courseId));
    await db.transaction(async (tx) => {
      await tx.delete(attendanceRecords).where(eq(attendanceRecords.id, recordId));
      await tx.insert(auditEvents).values({
        institutionId: course.institutionId,
        courseId: session.courseId,
        attendanceSessionId: id,
        actorLtiUserId: ltiSubject,
        eventType: 'attendance_record_removed',
        targetType: 'attendance_record',
        targetId: recordId,
        oldValue: { status: record.status, source: record.source },
      });
    });

    return reply.code(204).send();
  });

  app.post('/api/attendance-sessions/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { courseId, ltiSubject } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    await closeSession(id, ltiSubject);
    return { ok: true };
  });

  app.post('/api/attendance-sessions/:id/reopen', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { courseId, ltiSubject } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    const parsed = reopenSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body.' });

    await reopenSession(id, ltiSubject, parsed.data?.reason);
    return { ok: true };
  });

  app.get('/api/attendance-sessions/:id/export.csv', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { courseId } = (request as any).appSession;
    const session = await loadSessionScopedToCourse(id, courseId);
    if (!session) return reply.code(404).send({ error: 'Attendance session not found.' });

    const members = await db.select().from(attendanceSessionMembers).where(eq(attendanceSessionMembers.attendanceSessionId, id));
    const records = await db.select().from(attendanceRecords).where(eq(attendanceRecords.attendanceSessionId, id));
    const recordsByLtiUserId = new Map<string, AttendanceRecordRow[]>();
    for (const record of records) {
      if (!record.ltiUserId) continue;
      const list = recordsByLtiUserId.get(record.ltiUserId) ?? [];
      list.push(record);
      recordsByLtiUserId.set(record.ltiUserId, list);
    }

    const exportRows = members.map((m) => {
      const current = resolveCurrentRecord(recordsByLtiUserId.get(m.ltiUserId) ?? []);
      return {
        ltiUserId: m.ltiUserId,
        institutionalId: m.institutionalId,
        displayName: m.displayName,
        status: current?.status ?? 'absent',
        scannedAt: current?.scannedAt ? new Date(current.scannedAt).toISOString() : '',
        source: current?.source ?? '',
      };
    });

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    return buildAttendanceCsv(exportRows);
  });
}
```

- [ ] **Step 4: Mount the route in `server/src/index.ts`**

```ts
// server/src/index.ts -- add alongside the existing registerScansRoute wiring
import { registerAttendanceSessionsRoute } from './routes/attendance-sessions.js';
// ... after: registerScansRoute(app, identityResolver);
registerAttendanceSessionsRoute(app, { resolver: identityResolver });
```

Note: this task does not add the real `requireSession`/`requireCsrf` preHandlers to `server/src/index.ts`'s registration call — that wiring belongs to whatever pattern Phase 3 already established for protecting routes (e.g. a `{ preHandler: [requireSession] }` route option, or an `app.register` plugin boundary). Confirm the real pattern from Phase 3's `me.ts` route registration (per Task 0) and apply the same pattern here before this task is considered done — the test file's `buildTestApp` helper stands in for it during unit tests, but production wiring must use the real preHandler, not the test's fake hook.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/routes/attendance-sessions.test.ts`
Expected: PASS — 9 tests green.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green, no new errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/attendance-sessions.ts server/src/index.ts server/tests/routes/attendance-sessions.test.ts
git commit -m "feat: wire attendance-sessions routes (create/get/scan/correct/delete/close/reopen/export)"
```

---

## Task 13: `web/scan-pipeline.js` — session-scoped transport, server status trusted verbatim

**Files:**
- Modify: `web/scan-pipeline.js`
- Modify: `web/tests/scan-pipeline.test.js`

**Interfaces:**
- Consumes: nothing new from other client modules — `roster.js`'s `isExpected`/`getRosterRow` import is removed from this file (still exported from `roster.js` itself for the standalone/demo-mode path, per this plan's Global Constraints).
- Produces: `ScanPipeline` now constructed with a `sessionId` and calls `submitScan(sessionId, clientScanId, cardCode)`; every `ScanRecord`'s `status`/`rosterStatus` comes directly from the server response.

- [ ] **Step 1: Update the failing/changed tests first**

Replace the top of `web/tests/scan-pipeline.test.js` (the `global.fetch` mock and `successResult`/`errorResult` helpers) so the mocked transport matches the new endpoint and payload shape, and so server responses carry `status`/`clientScanId` directly (no more client-computed `rosterStatus`):

```js
// web/tests/scan-pipeline.test.js -- replace the existing global.fetch mock and result helpers
global.fetch = vi.fn((url, init) => {
  const body = JSON.parse(init.body);
  expect(url).toBe(`/api/attendance-sessions/${TEST_SESSION_ID}/scans`);
  return lookupCardMock(body.cardCode).then((result) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(result),
  }));
});

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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/tests/scan-pipeline.test.js`
Expected: FAIL — `submitScan is not defined` / URL mismatch, since `scan-pipeline.js` hasn't changed yet.

- [ ] **Step 3: Update `web/scan-pipeline.js`**

Replace lines 14–67 (the imports and `submitScan`/`performSubmit` functions) with:

```js
import { DUPLICATE_SUPPRESS_WINDOW_MS } from './config.js';
import { logEvent } from './diagnostics.js';

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
    response = await fetch(`/api/attendance-sessions/${sessionId}/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientScanId, cardCode, scannedAt: new Date().toISOString() }),
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

Update `_processCandidateScan` (old lines 163–174) to drop the `rosterState`/`rosterStatus` initialization:

```js
    /** @type {ScanRecord} */
    const record = {
      id: `scan-${this.nextId++}`,
      timestamp: new Date().toISOString(),
      rawCardCode: cardCode,
      institutionalId: null,
      clientScanId: `client-${this.sessionId}-${this.nextId}-${Date.now()}`,
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

Everything else in the file (`handleParsedReport`, the duplicate-suppression time-window logic in `_processCandidateScan`, `getStats`/`getRecords`/`getDuplicateCounters`/`removeRecord`/`clearAll`) is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/tests/scan-pipeline.test.js`
Expected: PASS — all 13 cases green (11 original + the 2 rewritten roster-trust cases).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass, no regressions in `web/tests/omnikey-parser.test.js` or `web/tests/roster.test.js` (untouched by this task).

- [ ] **Step 6: Commit**

```bash
git add web/scan-pipeline.js web/tests/scan-pipeline.test.js
git commit -m "refactor: scan-pipeline.js submits to a session-scoped endpoint, trusts server status verbatim"
```

---

## Task 14: `web/attendance-session.js` — client session lifecycle

**Files:**
- Create: `web/attendance-session.js`
- Create: `web/tests/attendance-session.test.js`

**Interfaces:**
- Consumes: nothing from other client modules (pure `fetch` wrapper, mirroring `scan-pipeline.js`'s never-throws convention).
- Produces: `createAttendanceSession(body)`, `closeAttendanceSession(sessionId)`, `reopenAttendanceSession(sessionId, reason)`, `getAttendanceSession(sessionId)` — used by `web/app.js`'s Start/Close/Reopen button handlers (Task 15).

- [ ] **Step 1: Write the failing test**

```js
// web/tests/attendance-session.test.js
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession, getAttendanceSession } from '../attendance-session.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('attendance-session.js', () => {
  it('createAttendanceSession POSTs to /api/attendance-sessions and returns the parsed session on success', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ id: 'session-1', state: 'open' }) });

    const result = await createAttendanceSession({ label: 'Monday lecture' });

    expect(global.fetch).toHaveBeenCalledWith('/api/attendance-sessions', expect.objectContaining({ method: 'POST' }));
    expect(result).toEqual({ ok: true, session: { id: 'session-1', state: 'open' } });
  });

  it('createAttendanceSession never throws on a network failure -- returns a normalized error result', async () => {
    global.fetch.mockRejectedValue(new Error('offline'));

    const result = await createAttendanceSession({});

    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('network');
  });

  it('createAttendanceSession returns a normalized error result on a non-2xx response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 502, json: () => Promise.resolve({ error: 'roster refresh failed' }) });

    const result = await createAttendanceSession({});

    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
    expect(result.error.message).toContain('502');
  });

  it('closeAttendanceSession POSTs to the close endpoint', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });

    const result = await closeAttendanceSession('session-1');

    expect(global.fetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1/close', expect.objectContaining({ method: 'POST' }));
    expect(result.ok).toBe(true);
  });

  it('reopenAttendanceSession POSTs to the reopen endpoint with a reason', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });

    await reopenAttendanceSession('session-1', 'Missed a scan');

    expect(global.fetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1/reopen', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reason: 'Missed a scan' }) }));
  });

  it('getAttendanceSession GETs the session by id', async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ id: 'session-1', state: 'open', members: [] }) });

    const result = await getAttendanceSession('session-1');

    expect(global.fetch).toHaveBeenCalledWith('/api/attendance-sessions/session-1');
    expect(result.ok).toBe(true);
    expect(result.session.id).toBe('session-1');
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
// reopen, and re-fetch. Follows the same never-throws convention as
// scan-pipeline.js's submitScan() -- every function here returns a
// normalized {ok, ...} or {ok: false, error} result rather than throwing,
// so callers in app.js can always render a visible error message instead
// of hitting an unhandled rejection.

/** @param {string} url @param {RequestInit} init */
async function request(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      // response body wasn't JSON; fall through with an empty detail
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
  const result = await request('/api/attendance-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  const result = await request(`/api/attendance-sessions/${sessionId}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * @param {string} sessionId
 * @returns {Promise<{ok: true, session: object}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function getAttendanceSession(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}`);
  if (!result.ok) return result;
  return { ok: true, session: result.body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/tests/attendance-session.test.js`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add web/attendance-session.js web/tests/attendance-session.test.js
git commit -m "feat: add client-side attendance session lifecycle module"
```

---

## Task 15: `app.js`/`ui.js`/`index.html` — Start/Close/Reopen wiring

**Files:**
- Modify: `web/index.html`
- Modify: `web/ui.js`
- Modify: `web/app.js`

**Interfaces:**
- Consumes: `createAttendanceSession`/`closeAttendanceSession`/`reopenAttendanceSession`/`getAttendanceSession` from Task 14; `ScanPipeline` from Task 13 (now constructed with `sessionId`).
- Produces: no new exports — this is orchestration wiring, verified manually per this plan's Definition of Done (there is no existing `web/tests/app.test.js` in this codebase; `app.js`/`ui.js`/`index.html` wiring has been verified manually via Playwright in every prior phase per `docs/canvas-lti/progress.md`, and this task follows that same convention).

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
      ui.renderStats(stats);
      schedulePersist();
    },
  },
});
```

Note: `ScanPipeline`'s `sessionId` is set at construction and read via `this.sessionId` inside `_resolveScan` (Task 13) — since a real session doesn't exist until `Start Attendance` succeeds, `startSession()` below reassigns `scanPipeline.sessionId` directly after creation, rather than requiring a full pipeline reconstruction.

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

Add the initial render call to `init()` (alongside the existing `ui.renderStats(...)` call):

```js
  ui.renderSessionState({ state: 'none' });
```

This task deliberately does not remove the existing CSV-upload roster panel or its wiring (`elements.loadRosterBtn`, `elements.rosterFileInput`, etc.) — per spec §51/§29, that flow remains for the standalone/demo mode and is out of this plan's scope (see "Risks / open items" below). The `getRosterState`/`isExpected`/`getRosterRow`-based local roster matching that scan-pipeline.js used to call is gone (Task 13); this CSV roster panel, if left enabled by an instructor during an LTI-mode session, no longer affects `status` — it becomes purely a display aid until a future phase decides to wire it to something. Note this explicitly as a UX follow-up, not a Phase 5 blocker (the exit criterion is about persistence, not roster-panel UX).

- [ ] **Step 5: Manual verification (no automated test file for app.js/ui.js wiring, matching this project's existing convention)**

Run: `npm run dev`, then in a browser: click **Start Attendance**, confirm the panel updates to "Session open" and the Close button becomes enabled; simulate a scan via the browser console (`window.__scanPipelineForTesting?.handleParsedReport(...)` is not exposed — instead, exercise via the existing synthetic-HID-report technique used in Phases 1–2's manual verification, calling into the real `ScanPipeline` instance through a temporary breakpoint or an exposed test hook if one already exists); click **Close Attendance**, confirm the status changes to "Session closed" and the Reopen button appears; click **Reopen Attendance**, confirm scans are accepted again. Confirm via the Network tab that `cardCode` never appears in any response body (only `institutionalId`/`status`).

- [ ] **Step 6: Run the automated test suite and lint/typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green (this task added no new automated tests, so the count is unchanged from Task 14).

- [ ] **Step 7: Commit**

```bash
git add web/index.html web/ui.js web/app.js
git commit -m "feat: wire Start/Close/Reopen attendance session controls into app.js/ui.js"
```

---

## Task 16: Update `docs/canvas-lti/progress.md`

**Files:**
- Modify: `docs/canvas-lti/progress.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — documentation only.

- [ ] **Step 1: Check the Phase 5 box and add a "what actually happened" section**

Change the Phase 5 line in the "Phase checklist" section from `- [ ] **Phase 5 — Persistent attendance**` to `- [x] **Phase 5 — Persistent attendance**`, and append a new `## Phase 5 — what actually happened` section (after the existing `## Phase 2` section, matching that section's level of detail) summarizing: the four new tables and the `audit_events` FK addition; `submitScan`'s idempotency mechanism and ambiguous-match handling; `closeSession`'s system_absence insertion; the append-only manual-correction design and where the note lives; the DELETE-record route; CSV export parity with `web/csv.js`; the `scan-pipeline.js` transport/vocabulary change and which tests were rewritten vs. preserved; the deferred/out-of-scope items (standalone-mode CSV roster panel not wired to the new backend; card-fingerprint secret is app-wide, not per-institution; no rate limiting on the scan API yet — that's Phase 8).

- [ ] **Step 2: Commit**

```bash
git add docs/canvas-lti/progress.md
git commit -m "docs: mark Phase 5 complete in progress.md"
```

---

## Risks / open items

- **Standalone/demo mode (spec §51) is not wired to the new persisted-session backend.** The CSV-upload roster panel and its `roster.js` matching helpers (`isExpected`/`getRosterRow`) remain in the codebase (unchanged) but are no longer consulted by `scan-pipeline.js`, since `submitScan`'s status now always comes from the server. A future session should decide whether standalone mode gets its own lightweight session concept or is retired in favor of always requiring an LTI launch.
- **Card-fingerprint secret is a single app-wide `CARD_FINGERPRINT_SECRET` env var, not a per-institution database column.** The design doc's `institutions` table (Phase 3) has no fingerprint-secret column, and only one institution is live at this stage — this is a deliberate YAGNI scope reduction, flagged for revisit if/when a second institution with different fingerprinting needs is onboarded.
- **Rate limiting on the scan API (spec §31.10, ~120–240 req/min/session) is explicitly deferred to Phase 8 hardening**, not this phase, per the design doc.
- **Grade calculation/synchronization (spec §27–28) is explicitly out of scope.** `closeSession` writes the `attendance_session_closed` audit event as the intended Phase 6 extension point but does not itself touch `grade_line_items`/`grade_sync_jobs` — those tables don't exist until Phase 6.
- **`audit_events` migration ordering** (Task 1) depends on whether Phase 4 already ran its migration when this plan executes; Task 1 Step 5 handles both orderings, but this must be re-verified against the actual generated SQL at execution time, not assumed from this plan alone.

---

## Self-review notes

- **Spec coverage:** §21 (browser scan flow → Tasks 5–7, 13), §22 (raw card handling → Task 3, and the "never persists the raw card code" tests in Tasks 5/12/13), §23 (session states open/closed/reopened → Tasks 4/8/9; historical immutability → Task 2's most-recent-wins design), §24 (statuses present/absent/late/excused/lookup_error/unexpected → Task 5's `status` union, Task 10's manual-correction status enum), §25.3–25.10 (routes → Task 12), §26 (schema → Task 1), §29 (frontend refactor → Tasks 13–15), §33 (audit events → Tasks 8/9/10/12's DELETE handler), §47 (every named case mapped: "valid report creates one scan" → Task 5; "invalid report ignored/logged" and "report without card payload ignored" → pre-existing `handleParsedReport` behavior, unchanged by this plan, already covered by `web/tests/omnikey-parser.test.js`'s upstream parsing tests feeding `handleParsedReport`; "duplicate within suppression window"/"duplicate after lookup success"/"duplicate after lookup failure retries lookup"/"two different cards scanned rapidly"/"second lookup resolves before first"/"first response does not overwrite second as latest"/"record deleted while lookup pending" → Task 13's preserved `web/tests/scan-pipeline.test.js` cases; "lookup timeout" → Task 6; "identity not on roster" → Task 6; "duplicate API submission with same clientScanId" → Task 7; "network response lost then retried" → Task 7), §55 DoD items relevant to this phase ("Attendance is persisted in PostgreSQL" → Task 1; "Instructor can correct attendance" → Task 10; "Changes are audited" → Tasks 8/9/10/12; "Closing a session marks unscanned eligible students absent" → Task 8; "Raw card codes are not persisted by default" → Tasks 3/5).
- **Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" patterns found; every code step above contains complete, runnable code.
- **Type/signature consistency:** `submitScan(sessionId, input, deps)` and `AttendanceRecordRow` are used identically across Tasks 5, 6, 7, and 12 (route handler). `resolveCurrentRecord(records)` is used identically across Tasks 2, 8, 10, and 12. `createSession`/`closeSession`/`reopenSession`/`applyManualCorrection` signatures match this plan's header contract in every task that calls them. Client-side `ScanPipeline`'s constructor shape (`{ sessionId, callbacks }`) is consistent between Task 13's implementation and Task 15's `app.js` usage.
