# Attendance Session Review, Reopen & Soft Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an instructor reach a past attendance session from the main screen — review who was present/absent/excused, reopen it to correct it, or soft-delete an accidental one (restorable) — without breaking Canvas cumulative grades.

**Architecture:** Add two nullable columns (`deleted_at`, `deleted_by_lti_user_id`) to `attendance_sessions`. Extract the cumulative-grade recompute currently inline in `closeAttendanceSession` into a shared `recomputeCourseGrades()` so close, soft-delete, and restore all call it. Add three routes: `GET /api/attendance-sessions/history`, `DELETE /api/attendance-sessions/:id`, `POST /api/attendance-sessions/:id/restore`. On the web side, add a self-contained "Past sessions" `<details>` panel (`web/session-history.js`) that lists sessions and drives Resume / Reopen / Delete / Restore; editing itself reuses the existing "reopen → correct → close" flow untouched.

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM (drizzle-kit migrations), PostgreSQL, Vitest (Node env, single-fork, shared test DB), Playwright e2e, vanilla ES-module frontend (no framework, no bundler).

## Global Constraints

- **Node ESM throughout.** Every relative import ends in `.js` even from `.ts` sources (e.g. `import { x } from './grade-recompute.js'`).
- **Tenant scoping.** Every session/record lookup is scoped to `request.appSession.courseId`. A resource in another course returns **404, never 403** (`routes/attendance-sessions.ts` header comment).
- **Opaque errors.** No internal `Error.message` reaches the client. Business errors carry a `.code` string mapped through `HTTP_FOR_CODE` / `replyForError` and always include `requestId: request.id`.
- **Mutations are CSRF-gated.** Use the `mutation` preHandler bundle (`[requireSession, requireCsrf]`); reads use `readOnly` (`requireSession` only).
- **Never return a raw Drizzle row.** Serialize an explicit shape (existing `serializeSession` / `serializeRecord` precedent, Q14).
- **Append-only attendance model.** Manual corrections INSERT a new `attendance_records` row; "current status" is resolved by `resolveCurrentRecord()`. Do not mutate records. Delete/restore only touch `attendance_sessions` columns + `audit_events` + `grade_sync_jobs` (via the shared recompute).
- **Audit every lifecycle change.** Write an `audit_events` row (actor, timestamp, target, old/new) for delete and restore, in the same transaction.
- **Test DB is shared and truncated per test.** `beforeEach` calls `resetDb()`. Vitest runs files serially in one fork (`vitest.config.ts`). New migrations are auto-applied by the test global setup (`server/tests/support/global-setup.ts` → `migrate()`).
- **Frontend module boundaries.** Pure logic in a dedicated module (pattern: `absentees.js`, `manual-present.js`), DOM writes via `textContent` never `innerHTML`, destructive buttons use `bindInlineConfirm` from `web/confirm-inline.js` (no `window.confirm`). Client API functions never throw — they return `{ ok: true, ... }` / `{ ok: false, error: { kind, message } }` (pattern: `web/attendance-session.js`).
- **`npm test`** runs the whole Vitest suite; **`npm run typecheck`** is `tsc --noEmit`; **`npm run lint`** is `eslint .`; **`npm run test:e2e`** is Playwright. All four must pass before a task is done.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `server/src/attendance/grade-recompute.ts` | The single implementation of "recompute every eligible member's cumulative attendance score for a course from its non-deleted closed sessions, upsert the grade-sync outbox, write a `grade_sync_requested` audit row." Called by close, soft-delete, restore. |
| `server/migrations/0006_*.sql` (+ `meta/` updates) | Generated migration adding the two columns. |
| `web/session-history.js` | The "Past sessions" panel: a pure view-model builder (`buildHistoryView`, `formatOpenedAt`) plus a `mountSessionHistory()` DOM binder. Self-contained; `app.js` calls `mountSessionHistory` once. |
| `web/tests/session-history.test.js` | Unit tests for the pure view-model functions. |
| `e2e/session-review.spec.ts` | End-to-end: launch → start → close → reopen-from-panel → close → delete-from-panel → restore. |

**Modified files**

| Path | Change |
|---|---|
| `server/src/database/schema.ts` | Add `deletedAt`, `deletedByLtiUserId` to `attendanceSessions`. |
| `server/src/attendance/session-lifecycle.ts` | `closeAttendanceSession` delegates the grade block to `recomputeCourseGrades`; new `softDeleteAttendanceSession` / `restoreAttendanceSession` + two error classes; move `seedCourseMembers`… (test only). Import trim. |
| `server/src/routes/attendance-sessions.ts` | New `history` / `DELETE /:id` / `restore` routes; `serializeSessionHistory`; `deleted_at IS NULL` on the resume list; new error codes. |
| `web/attendance-session.js` | `listSessionHistory`, `deleteSession`, `restoreSession`. |
| `web/app.js` | Extract `attachToServerSession()` from `resumeOpenSessionIfAny`; track `currentSessionState`; call `mountSessionHistory` and `history.refresh()` at the right moments. |
| `web/index.html` | The `<details id="session-history-panel">` block + a row `<template>`. |
| `web/styles.css` | A few rules for the deleted-row look / panel actions (reuse existing classes otherwise). |
| `server/tests/attendance/session-lifecycle.test.ts` | New tests for delete/restore + "deleted session excluded from a later close." |
| `server/tests/routes/attendance-sessions.test.ts` | New tests for the three routes + resume-list exclusion. |
| `server/tests/database/schema.test.ts` | Column smoke test. |
| `web/tests/attendance-session.test.js` | Tests for the three new client functions. |
| `docs/canvas-lti/spec.md` | §33 audit list + a §25.11 note. |
| `docs/canvas-lti/progress.md` | One log line. |

---

## Task 1: Schema + migration for soft-delete columns

**Files:**
- Modify: `server/src/database/schema.ts` (the `attendanceSessions` table, around line 148-160)
- Modify (generated): `server/migrations/0006_*.sql`, `server/migrations/meta/_journal.json`, `server/migrations/meta/0006_snapshot.json`
- Test: `server/tests/database/schema.test.ts`

**Interfaces:**
- Produces: `attendanceSessions.deletedAt` (`timestamp with time zone`, nullable, Drizzle type `Date | null`) and `attendanceSessions.deletedByLtiUserId` (`text`, nullable, `string | null`). `AttendanceSessionRow` gains both fields automatically.

- [ ] **Step 1: Write the failing test**

In `server/tests/database/schema.test.ts`, add `import { eq } from 'drizzle-orm';` to the existing import block (it is not currently imported). Then add this `describe` at the end of the file, after the `Phase 6 schema` describe:

```ts
describe('Session review schema (soft delete)', () => {
  it('attendance_sessions has nullable deleted_at / deleted_by_lti_user_id, defaulting to null', async () => {
    const { db } = getTestDb();
    await resetDb();
    const { sessionId } = await seedCourseAndSession();

    const [fresh] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    expect(fresh.deletedAt).toBeNull();
    expect(fresh.deletedByLtiUserId).toBeNull();

    const when = new Date('2026-09-01T15:00:00.000Z');
    await db
      .update(attendanceSessions)
      .set({ deletedAt: when, deletedByLtiUserId: 'instructor-9' })
      .where(eq(attendanceSessions.id, sessionId));

    const [updated] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId));
    expect(updated.deletedAt?.toISOString()).toBe(when.toISOString());
    expect(updated.deletedByLtiUserId).toBe('instructor-9');
  });
});
```

`seedCourseAndSession()` already exists at the bottom of this file and returns `{ sessionId }`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- server/tests/database/schema.test.ts`
Expected: FAIL — the `.select()` or `.update()` throws a Postgres error `column attendance_sessions.deleted_at does not exist` (the TS type also won't have the fields yet, so `tsc` in the test run flags `deletedAt`).

- [ ] **Step 3: Add the columns to the schema**

In `server/src/database/schema.ts`, in the `attendanceSessions` table definition, add the two columns immediately after `updatedAt`:

```ts
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
  // Session review: soft delete for an accidentally-created session. Null = live. Restore nulls both.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedByLtiUserId: text('deleted_by_lti_user_id'),
});
```

- [ ] **Step 4: Generate the migration**

Run from the repo root: `npx drizzle-kit generate`
Expected: creates `server/migrations/0006_<random-slug>.sql` whose body is exactly:

```sql
ALTER TABLE "attendance_sessions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD COLUMN "deleted_by_lti_user_id" text;
```

and appends an `idx: 6` entry to `server/migrations/meta/_journal.json` plus a new `server/migrations/meta/0006_snapshot.json`. Do not hand-edit these; if the SQL differs materially, stop and re-check Step 3.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- server/tests/database/schema.test.ts`
Expected: PASS. The Vitest global setup applies `0006` to the test DB before the run.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/database/schema.ts server/migrations/ server/tests/database/schema.test.ts
git commit -m "feat(phase7): add soft-delete columns to attendance_sessions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 2: Extract `recomputeCourseGrades`

**Files:**
- Create: `server/src/attendance/grade-recompute.ts`
- Modify: `server/src/attendance/session-lifecycle.ts` (imports at line 1-17; `closeAttendanceSession` grade block at lines ~191-254)
- Test: `server/tests/attendance/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `attendanceSessions.deletedAt` (Task 1). `Tx` type exported from `session-lifecycle.ts` (`export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];`, line 31). `upsertGradeSyncJobs(executor: Database | Tx, courseId: string, attendanceSessionId: string, scores: Map<string, { scoreGiven: number }>): Promise<number>`. `getCachedRosterAsMembers(db: Database, courseId: string): Promise<{ members: CourseRosterMember[]; rosterCachedAt: Date | null } | null>`. `computeCumulativeScores(closedSessions: SessionResolvedStatuses[], rosterLtiUserIds: string[], policy: GradingPolicy): Map<string, CumulativeScore>`. `resolveCurrentRecord(records: AttendanceRecordRow[]): AttendanceRecordRow | null`. `DEFAULT_GRADING_POLICY`.
- Produces: `recomputeCourseGrades(tx: Tx, db: Database, courseId: string, triggeringSessionId: string, actorLtiUserId: string, requestId: string | undefined): Promise<{ jobCount: number; closedSessionCount: number; eligibleMemberCount: number }>`. Contract: the caller MUST have already applied its own state change to the triggering session **inside `tx`** before calling (close → `state='closed'`; delete → `deletedAt` set; restore → `deletedAt` cleared), because this function's closed-session scan filters `state='closed' AND deleted_at IS NULL`. It writes exactly one `grade_sync_requested` audit row.

- [ ] **Step 1: Write the failing test**

In `server/tests/attendance/session-lifecycle.test.ts`, first **move `seedCourseMembers` to file scope** so later tasks' describes can reuse it. Cut the nested `async function seedCourseMembers(courseId, ms) { ... }` (currently inside the `describe('closeAttendanceSession', ...)` block near line 182) and paste it at file scope directly below the `member()` helper (near line 48). It references `db` and `courseMembers`, both already imported/file-scoped.

Then add this test inside the existing `describe('closeAttendanceSession', ...)` block, after the "excludes a reopened session" test:

```ts
it('excludes a SOFT-DELETED closed session from a later close\'s cumulative recompute', async () => {
  const { courseId } = await seedInstitutionAndCourse(db, platform);
  const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
  vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
  await seedCourseMembers(courseId, members);

  // Session A: closed with an ABSENT outcome (system_absence at close) -> would drag to 50 if counted.
  const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
  await closeAttendanceSession(db, a.id, 'i1', 'ra');
  // Soft-delete A directly (Task 3 wires the real path; here we only need the column set).
  await db.update(attendanceSessions).set({ deletedAt: new Date() }).where(eq(attendanceSessions.id, a.id));

  // Session B: present. Only B is a live closed session -> score is 1/1 -> 100.
  const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
  await db.insert(attendanceRecords).values({
    attendanceSessionId: b.id, ltiUserId: 'u1', institutionalId: '111',
    clientScanId: 'b1', status: 'present', source: 'card', scannedAt: new Date(),
  });
  await closeAttendanceSession(db, b.id, 'i1', 'rb');

  const jobs = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
  expect(jobs).toHaveLength(1);
  expect(jobs[0].score).toBeCloseTo(100);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts -t "SOFT-DELETED"`
Expected: FAIL — the current `closeAttendanceSession` closed-session query has no `deleted_at` filter, so session A is still counted and `jobs[0].score` is `50`, not `100`.

- [ ] **Step 3: Create `grade-recompute.ts`**

Create `server/src/attendance/grade-recompute.ts` with exactly this content:

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { Tx } from './session-lifecycle.js';
import { attendanceSessions, attendanceRecords, auditEvents, courses } from '../database/schema.js';
import { getCachedRosterAsMembers } from './roster-store.js';
import { resolveCurrentRecord } from './member-status.js';
import { DEFAULT_GRADING_POLICY } from './grade-policy.js';
import { computeCumulativeScores, type SessionResolvedStatuses } from './grade-calc.js';
import { upsertGradeSyncJobs } from './grade-sync-store.js';

export interface RecomputeResult {
  jobCount: number;
  closedSessionCount: number;
  eligibleMemberCount: number;
}

/**
 * The single implementation of the Phase 6 cumulative-grade recompute (spec §25.7 steps 3-4,
 * §28 steps 2-3). Extracted from closeAttendanceSession so close, soft-delete, and restore all
 * behave identically.
 *
 * Population = the course's CURRENT roster (course_members, refreshed on every Start Attendance).
 * Denominator = every non-deleted CLOSED session in the course. 'reopened' sessions are excluded
 * (mid-correction) and soft-deleted sessions are excluded (deleted_at IS NULL).
 *
 * CALLER CONTRACT: apply your own state change to the triggering session INSIDE `tx` before
 * calling — close sets state='closed'; soft-delete sets deleted_at; restore clears deleted_at —
 * so the scan below sees the correct set. Writes one `grade_sync_requested` audit row.
 *
 * `tx` runs every write and the session/record reads (transactional consistency). `db` is only
 * for getCachedRosterAsMembers, which is typed `db: Database` and reads tables this txn never
 * mutates (course_members / institutions / courses).
 */
export async function recomputeCourseGrades(
  tx: Tx,
  db: Database,
  courseId: string,
  triggeringSessionId: string,
  actorLtiUserId: string,
  requestId: string | undefined,
): Promise<RecomputeResult> {
  const [course] = await tx.select().from(courses).where(eq(courses.id, courseId));

  const currentRoster = await getCachedRosterAsMembers(db, courseId);
  const eligibleLtiUserIds = (currentRoster?.members ?? [])
    .filter((m) => m.eligibleForAttendance)
    .map((m) => m.ltiUserId);

  const closedSessions = await tx
    .select({ id: attendanceSessions.id })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.courseId, courseId),
        eq(attendanceSessions.state, 'closed'),
        isNull(attendanceSessions.deletedAt),
      ),
    );
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
    }
    return { sessionId: closedId, statusByLtiUserId };
  });

  const scores = computeCumulativeScores(resolvedBySession, eligibleLtiUserIds, DEFAULT_GRADING_POLICY);
  const jobCount = await upsertGradeSyncJobs(
    tx,
    courseId,
    triggeringSessionId,
    new Map([...scores].map(([ltiUserId, s]) => [ltiUserId, { scoreGiven: s.scoreGiven }])),
  );

  await tx.insert(auditEvents).values({
    institutionId: course.institutionId,
    courseId,
    attendanceSessionId: triggeringSessionId,
    actorLtiUserId,
    eventType: 'grade_sync_requested',
    targetType: 'attendance_session',
    targetId: triggeringSessionId,
    newValue: { jobCount, closedSessionCount: closedSessionIds.length, eligibleMemberCount: eligibleLtiUserIds.length },
    requestId: requestId ?? null,
  });

  return { jobCount, closedSessionCount: closedSessionIds.length, eligibleMemberCount: eligibleLtiUserIds.length };
}
```

- [ ] **Step 4: Delegate from `closeAttendanceSession`**

In `server/src/attendance/session-lifecycle.ts`:

1. Change the drizzle import (line 1) from `import { and, eq, inArray } from 'drizzle-orm';` to `import { eq } from 'drizzle-orm';` (after the extraction `and` / `inArray` are unused here).
2. Add after the existing attendance imports (after line 17): `import { recomputeCourseGrades } from './grade-recompute.js';`
3. In `closeAttendanceSession`, delete the entire block from the comment `// --- Phase 6: cumulative grade calculation ...` down to and including the final `await tx.insert(auditEvents).values({ ... eventType: 'grade_sync_requested' ... });` (the block that currently spans roughly lines 191-254). Replace it with:

```ts
    // Phase 6 cumulative recompute + durable enqueue (spec §25.7 steps 3-4, §28 steps 2-3),
    // shared with soft delete / restore. `state='closed'` is already applied above in this txn.
    await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
```

The earlier part of `closeAttendanceSession` (row-lock, state guard, `system_absence` inserts, the `attendance_session_closed` audit row, the `state='closed'` update) is unchanged.

- [ ] **Step 5: Run the full lifecycle + route suites**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts server/tests/routes/attendance-sessions.test.ts server/tests/routes/grade-sync-integration.test.ts`
Expected: PASS, including the new "SOFT-DELETED" test and every pre-existing close/grade test (the extraction is behaviour-preserving).

- [ ] **Step 6: Typecheck + lint + full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/attendance/grade-recompute.ts server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "refactor(phase7): extract recomputeCourseGrades; exclude soft-deleted sessions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 3: `softDeleteAttendanceSession` + `restoreAttendanceSession`

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts`
- Test: `server/tests/attendance/session-lifecycle.test.ts`

**Interfaces:**
- Consumes: `recomputeCourseGrades` (Task 2). `Tx`, `attendanceSessions`, `courses`, `auditEvents`.
- Produces:
  - `class SessionAlreadyDeletedError extends Error { code = 'session_already_deleted' as const }`
  - `class SessionNotDeletedError extends Error { code = 'session_not_deleted' as const }`
  - `softDeleteAttendanceSession(db: Database, sessionId: string, actorLtiUserId: string, requestId?: string): Promise<{ gradeRecompute: boolean; jobCount: number }>` — row-locks; throws the plain `Error` "not found" if missing; throws `SessionAlreadyDeletedError` if `deletedAt` already set; sets `deletedAt=now()`, `deletedByLtiUserId=actor`; if `state==='closed'` calls `recomputeCourseGrades`; writes an `attendance_session_deleted` audit row.
  - `restoreAttendanceSession(db: Database, sessionId: string, actorLtiUserId: string, requestId?: string): Promise<{ gradeRecompute: boolean; jobCount: number }>` — mirror; throws `SessionNotDeletedError` if `deletedAt` is null; nulls both columns; if `state==='closed'` calls `recomputeCourseGrades`; writes an `attendance_session_restored` audit row.

- [ ] **Step 1: Write the failing tests**

In `server/tests/attendance/session-lifecycle.test.ts`, add the new imports to the existing top-of-file import of `../../src/attendance/session-lifecycle.js`:

```ts
import {
  createAttendanceSession,
  closeAttendanceSession,
  reopenAttendanceSession,
  softDeleteAttendanceSession,
  restoreAttendanceSession,
  SessionAlreadyDeletedError,
  SessionNotDeletedError,
} from '../../src/attendance/session-lifecycle.js';
```

Add a new describe at the end of the file:

```ts
describe('softDeleteAttendanceSession / restoreAttendanceSession', () => {
  it('soft-deletes an OPEN session: sets deleted_at/by, no grade recompute, audits attendance_session_deleted', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });

    const result = await softDeleteAttendanceSession(db, s.id, 'instructor-7', 'req-del');

    expect(result).toEqual({ gradeRecompute: false, jobCount: 0 });
    const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, s.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByLtiUserId).toBe('instructor-7');
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_deleted'));
    expect(audit).toMatchObject({ actorLtiUserId: 'instructor-7', targetType: 'attendance_session', targetId: s.id, requestId: 'req-del' });
    expect(audit.newValue).toMatchObject({ gradeRecompute: false, jobCount: 0 });
    // no grade_sync_requested audit row for an open-session delete
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_sync_requested'))).toHaveLength(0);
  });

  it('soft-deleting a CLOSED session recomputes the course grades without it', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    // A: present -> 100.  B: absent -> cumulative 50.
    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await db.insert(attendanceRecords).values({ attendanceSessionId: a.id, ltiUserId: 'u1', institutionalId: '111', clientScanId: 'a1', status: 'present', source: 'card', scannedAt: new Date() });
    await closeAttendanceSession(db, a.id, 'i1', 'ra');
    const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, b.id, 'i1', 'rb');
    expect((await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId)))[0].score).toBeCloseTo(50);

    // Delete B -> only A counts -> 100.
    const result = await softDeleteAttendanceSession(db, b.id, 'i1', 'req-del');
    expect(result.gradeRecompute).toBe(true);
    const [job] = await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId));
    expect(job.score).toBeCloseTo(100);
  });

  it('rejects a double delete with SessionAlreadyDeletedError', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await softDeleteAttendanceSession(db, s.id, 'i1');
    await expect(softDeleteAttendanceSession(db, s.id, 'i1')).rejects.toBeInstanceOf(SessionAlreadyDeletedError);
  });

  it('restore clears the columns, audits attendance_session_restored, and recomputes for a closed session', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);

    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, a.id, 'i1', 'ra'); // absent -> job score 0
    await softDeleteAttendanceSession(db, a.id, 'i1');   // no live closed sessions now

    const result = await restoreAttendanceSession(db, a.id, 'instructor-3', 'req-res');
    expect(result.gradeRecompute).toBe(true);
    const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, a.id));
    expect(row.deletedAt).toBeNull();
    expect(row.deletedByLtiUserId).toBeNull();
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_restored'));
    expect(audit).toMatchObject({ actorLtiUserId: 'instructor-3', targetId: a.id, requestId: 'req-res' });
  });

  it('rejects restoring a session that is not deleted with SessionNotDeletedError', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await expect(restoreAttendanceSession(db, s.id, 'i1')).rejects.toBeInstanceOf(SessionNotDeletedError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts -t "softDeleteAttendanceSession"`
Expected: FAIL — `softDeleteAttendanceSession` / `restoreAttendanceSession` / the error classes are not exported.

- [ ] **Step 3: Implement the two functions + error classes**

In `server/src/attendance/session-lifecycle.ts`, add two error classes next to the existing ones (after `SessionRosterUnavailableError`, ~line 61):

```ts
export class SessionAlreadyDeletedError extends Error {
  code = 'session_already_deleted' as const;
  constructor() {
    super('Attendance session is already deleted.');
  }
}
export class SessionNotDeletedError extends Error {
  code = 'session_not_deleted' as const;
  constructor() {
    super('Only a deleted attendance session can be restored.');
  }
}
```

Then add both functions at the end of the file (after `reopenAttendanceSession`):

```ts
export async function softDeleteAttendanceSession(
  db: Database,
  sessionId: string,
  actorLtiUserId: string,
  requestId?: string,
): Promise<{ gradeRecompute: boolean; jobCount: number }> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId)).for('update');
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);
    if (session.deletedAt) throw new SessionAlreadyDeletedError();

    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId));
    const now = new Date();
    await tx
      .update(attendanceSessions)
      .set({ deletedAt: now, deletedByLtiUserId: actorLtiUserId, updatedAt: now })
      .where(eq(attendanceSessions.id, sessionId));

    let gradeRecompute = false;
    let jobCount = 0;
    if (session.state === 'closed') {
      gradeRecompute = true;
      ({ jobCount } = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId));
    }

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_deleted',
      targetType: 'attendance_session',
      targetId: sessionId,
      oldValue: { deletedAt: null, state: session.state },
      newValue: { deletedAt: now.toISOString(), deletedByLtiUserId: actorLtiUserId, gradeRecompute, jobCount },
      requestId: requestId ?? null,
    });

    return { gradeRecompute, jobCount };
  });
}

export async function restoreAttendanceSession(
  db: Database,
  sessionId: string,
  actorLtiUserId: string,
  requestId?: string,
): Promise<{ gradeRecompute: boolean; jobCount: number }> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(attendanceSessions).where(eq(attendanceSessions.id, sessionId)).for('update');
    if (!session) throw new Error(`Attendance session ${sessionId} not found.`);
    if (!session.deletedAt) throw new SessionNotDeletedError();

    const [course] = await tx.select().from(courses).where(eq(courses.id, session.courseId));
    const now = new Date();
    await tx
      .update(attendanceSessions)
      .set({ deletedAt: null, deletedByLtiUserId: null, updatedAt: now })
      .where(eq(attendanceSessions.id, sessionId));

    let gradeRecompute = false;
    let jobCount = 0;
    if (session.state === 'closed') {
      gradeRecompute = true;
      ({ jobCount } = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId));
    }

    await tx.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: session.courseId,
      attendanceSessionId: sessionId,
      actorLtiUserId,
      eventType: 'attendance_session_restored',
      targetType: 'attendance_session',
      targetId: sessionId,
      oldValue: { deletedAt: session.deletedAt.toISOString() },
      newValue: { deletedAt: null, gradeRecompute, jobCount },
      requestId: requestId ?? null,
    });

    return { gradeRecompute, jobCount };
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS (all old + new tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "feat(phase7): softDeleteAttendanceSession + restoreAttendanceSession services

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 4: Routes — history list, soft delete, restore

**Files:**
- Modify: `server/src/routes/attendance-sessions.ts`
- Test: `server/tests/routes/attendance-sessions.test.ts`

**Interfaces:**
- Consumes: `softDeleteAttendanceSession`, `restoreAttendanceSession` (Task 3). Existing route helpers `sessionOf`, `loadSessionScopedToCourse`, `replyForError`, `HTTP_FOR_CODE`, `serializeSession`, the `mutation` / `readOnly` preHandler bundles.
- Produces:
  - `GET /api/attendance-sessions/history` → `200 { sessions: SessionHistoryItem[] }`, newest-first by `openedAt`. `?includeDeleted=1` (or `=true`) also returns soft-deleted rows. `SessionHistoryItem = { id, courseId, state, label, meetingAt, openedAt, closedAt, startedByLtiUserId, deletedAt, deletedByLtiUserId }`.
  - `DELETE /api/attendance-sessions/:id` → `204` on success; `404 { error, requestId }` for cross-course / unknown / already-deleted.
  - `POST /api/attendance-sessions/:id/restore` → `200 { ok: true }`; `404` cross-course/unknown; `409 { error: 'session_not_deleted', requestId }` if not deleted.
  - Resume list `GET /api/attendance-sessions` now also filters `deleted_at IS NULL`.

- [ ] **Step 1: Write the failing tests**

In `server/tests/routes/attendance-sessions.test.ts`, add `isNull` is not needed in tests; add these tests inside the main `describe('attendance-sessions routes', ...)` block:

```ts
it('GET /api/attendance-sessions/history lists all the course\'s sessions newest-first; excludes deleted by default, includes them with ?includeDeleted=1', async () => {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
  const { courseId: otherCourseId } = await seedInstitutionAndCourse(db, platform, { clientId: 'other-client-id' });
  const [older] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed', openedAt: new Date('2026-08-01T10:00:00.000Z') }).returning();
  const [newer] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open', openedAt: new Date('2026-08-20T10:00:00.000Z') }).returning();
  const [deleted] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed', openedAt: new Date('2026-08-10T10:00:00.000Z'), deletedAt: new Date(), deletedByLtiUserId: 'i1' }).returning();
  await db.insert(attendanceSessions).values({ courseId: otherCourseId, startedByLtiUserId: 'x', state: 'open' });
  const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

  const def = await app.inject({ method: 'GET', url: '/api/attendance-sessions/history' });
  expect(def.statusCode).toBe(200);
  expect(def.json().sessions.map((s: { id: string }) => s.id)).toEqual([newer.id, older.id]);

  const withDeleted = await app.inject({ method: 'GET', url: '/api/attendance-sessions/history?includeDeleted=1' });
  expect(withDeleted.json().sessions.map((s: { id: string }) => s.id)).toEqual([newer.id, deleted.id, older.id]);
  const deletedRow = withDeleted.json().sessions.find((s: { id: string }) => s.id === deleted.id);
  expect(deletedRow.deletedAt).toBeTruthy();
  expect(deletedRow.deletedByLtiUserId).toBe('i1');
});

it('DELETE /api/attendance-sessions/:id soft-deletes and returns 204; a second delete is 404', async () => {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
  const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open' }).returning();
  const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

  const first = await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${session.id}`, headers: CSRF });
  expect(first.statusCode).toBe(204);
  const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, session.id));
  expect(row.deletedAt).not.toBeNull();
  const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'attendance_session_deleted'));
  expect(audit.requestId).toBeTruthy();

  const second = await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${session.id}`, headers: CSRF });
  expect(second.statusCode).toBe(404);
  expect(second.json()).toMatchObject({ error: 'session_already_deleted', requestId: expect.any(String) });
});

it('DELETE without a CSRF token is 403; DELETE of another course\'s session is 404 (not 403)', async () => {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
  const other = await seedInstitutionAndCourse(db, platform, { clientId: 'other-client-id' });
  const [foreign] = await db.insert(attendanceSessions).values({ courseId: other.courseId, startedByLtiUserId: 'x', state: 'open' }).returning();
  const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

  expect((await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${foreign.id}` })).statusCode).toBe(403);
  expect((await app.inject({ method: 'DELETE', url: `/api/attendance-sessions/${foreign.id}`, headers: CSRF })).statusCode).toBe(404);
});

it('POST /api/attendance-sessions/:id/restore restores a deleted session; restoring a live one is 409', async () => {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
  const [live] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open' }).returning();
  const [deleted] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open', deletedAt: new Date(), deletedByLtiUserId: 'i1' }).returning();
  const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

  const ok = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${deleted.id}/restore`, headers: CSRF });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ ok: true });
  const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, deleted.id));
  expect(row.deletedAt).toBeNull();

  const conflict = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${live.id}/restore`, headers: CSRF });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ error: 'session_not_deleted' });
});

it('GET /api/attendance-sessions (resume list) excludes a soft-deleted open session', async () => {
  const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
  const [visible] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'open' }).returning();
  await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'reopened', deletedAt: new Date(), deletedByLtiUserId: 'i1' });
  const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });

  const res = await app.inject({ method: 'GET', url: '/api/attendance-sessions?state=open' });
  expect(res.json().sessions.map((s: { id: string }) => s.id)).toEqual([visible.id]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- server/tests/routes/attendance-sessions.test.ts -t "history|soft-delete|restore|resume list"`
Expected: FAIL — `/history` hits the `:id` handler and 404s as `not_found`; `DELETE` / `restore` routes don't exist (405/404); the resume list still returns the deleted session.

- [ ] **Step 3: Implement the routes**

In `server/src/routes/attendance-sessions.ts`:

1. Extend the drizzle import: `import { and, eq, inArray, isNull } from 'drizzle-orm';`
2. Extend the service import: add `softDeleteAttendanceSession, restoreAttendanceSession` to the existing `import { createAttendanceSession, closeAttendanceSession, reopenAttendanceSession } from '../attendance/session-lifecycle.js';`
3. Add to `HTTP_FOR_CODE`:

```ts
const HTTP_FOR_CODE: Record<string, number> = {
  session_closed: 409,
  session_already_closed: 409,
  session_not_closed: 409,
  session_already_deleted: 404,
  session_not_deleted: 409,
  roster_unavailable: 502,
  session_not_found: 404,
  member_not_in_snapshot: 404,
};
```

4. Add a serializer next to `serializeSession`:

```ts
function serializeSessionHistory(s: AttendanceSessionRow) {
  return {
    id: s.id,
    courseId: s.courseId,
    state: s.state,
    label: s.label,
    meetingAt: s.meetingAt,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    startedByLtiUserId: s.startedByLtiUserId,
    deletedAt: s.deletedAt,
    deletedByLtiUserId: s.deletedByLtiUserId,
  };
}
```

5. Add `isNull(attendanceSessions.deletedAt)` to the existing resume-list route's `where`:

```ts
  app.get('/api/attendance-sessions', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const rows = await db
      .select()
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.courseId, session.courseId),
          inArray(attendanceSessions.state, ['open', 'reopened']),
          isNull(attendanceSessions.deletedAt),
        ),
      );
    rows.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
    return { sessions: rows.map(serializeSession) };
  });
```

6. Register the `history` route **immediately after** the resume-list route and **before** `app.get('/api/attendance-sessions/:id', ...)` (static path must be declared so it wins over the param route — Fastify's find-my-way prioritises static, but declaring it first also keeps the file readable):

```ts
  // Session review (spec §25.11): the course's full session history, newest-first.
  // Static path — registered before '/:id'. Excludes soft-deleted rows unless ?includeDeleted=1.
  app.get('/api/attendance-sessions/history', readOnly, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const q = request.query as { includeDeleted?: string };
    const includeDeleted = q.includeDeleted === '1' || q.includeDeleted === 'true';
    const rows = await db
      .select()
      .from(attendanceSessions)
      .where(
        includeDeleted
          ? eq(attendanceSessions.courseId, session.courseId)
          : and(eq(attendanceSessions.courseId, session.courseId), isNull(attendanceSessions.deletedAt)),
      );
    rows.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());
    return { sessions: rows.map(serializeSessionHistory) };
  });
```

7. Add the `DELETE` and `restore` routes after the existing `reopen` route:

```ts
  app.delete('/api/attendance-sessions/:id', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });
    try {
      await softDeleteAttendanceSession(db, id, session.ltiSubject, request.id);
      return reply.code(204).send();
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });

  app.post('/api/attendance-sessions/:id/restore', mutation, async (request, reply) => {
    const session = sessionOf(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };
    const row = await loadSessionScopedToCourse(id, session.courseId);
    if (!row) return reply.code(404).send({ error: 'not_found', requestId: request.id });
    try {
      await restoreAttendanceSession(db, id, session.ltiSubject, request.id);
      return { ok: true };
    } catch (err) {
      return replyForError(request, reply, err);
    }
  });
```

Note: `loadSessionScopedToCourse` does **not** filter `deleted_at`, so both routes can reach a soft-deleted row; the service-layer guards (`SessionAlreadyDeletedError` / `SessionNotDeletedError`) produce the coded 404 / 409 via `replyForError`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- server/tests/routes/attendance-sessions.test.ts`
Expected: PASS (all old + new).

- [ ] **Step 5: Typecheck + lint + full suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/attendance-sessions.ts server/tests/routes/attendance-sessions.test.ts
git commit -m "feat(phase7): history / soft-delete / restore routes for attendance sessions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 5: Web client functions

**Files:**
- Modify: `web/attendance-session.js`
- Test: `web/tests/attendance-session.test.js`

**Interfaces:**
- Consumes: the module-private `request(url, init)` helper and `apiFetch` already in `web/attendance-session.js`.
- Produces:
  - `listSessionHistory({ includeDeleted = false } = {})` → `{ ok: true, sessions: object[] }` / `{ ok: false, error }`. GETs `/api/attendance-sessions/history` or `/api/attendance-sessions/history?includeDeleted=1`.
  - `deleteSession(id)` → `{ ok: true }` / `{ ok: false, error }`. DELETEs `/api/attendance-sessions/:id` (204, no body — do not parse JSON).
  - `restoreSession(id)` → `{ ok: true }` / `{ ok: false, error }`. POSTs `/api/attendance-sessions/:id/restore`.

- [ ] **Step 1: Write the failing tests**

In `web/tests/attendance-session.test.js`, extend the import from `../attendance-session.js` to also import `listSessionHistory, deleteSession, restoreSession`, then add:

```js
it('listSessionHistory GETs the history endpoint and returns the sessions array', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ sessions: [{ id: 's1', state: 'closed' }] }) });
  const result = await listSessionHistory();
  expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/history');
  expect(result).toEqual({ ok: true, sessions: [{ id: 's1', state: 'closed' }] });
});

it('listSessionHistory passes ?includeDeleted=1 when asked, and normalizes a missing sessions key', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
  const result = await listSessionHistory({ includeDeleted: true });
  expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/history?includeDeleted=1');
  expect(result).toEqual({ ok: true, sessions: [] });
});

it('listSessionHistory normalizes a network failure', async () => {
  vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
  const result = await listSessionHistory();
  expect(result.ok).toBe(false);
  expect(result.error.kind).toBe('network');
});

it('deleteSession DELETEs the session path and treats 204 (no body) as success', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) });
  const result = await deleteSession('s1');
  expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1', expect.objectContaining({ method: 'DELETE' }));
  expect(result).toEqual({ ok: true });
});

it('deleteSession surfaces a non-2xx as {ok:false}', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 404 });
  const result = await deleteSession('s1');
  expect(result.ok).toBe(false);
  expect(result.error.kind).toBe('http-status');
});

it('restoreSession POSTs to the restore endpoint', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  const result = await restoreSession('s1');
  expect(apiFetch).toHaveBeenCalledWith('/api/attendance-sessions/s1/restore', expect.objectContaining({ method: 'POST' }));
  expect(result).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- web/tests/attendance-session.test.js`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement**

Append to `web/attendance-session.js`:

```js
/**
 * Lists this course's full attendance-session history, newest-first (spec §25.11 / session
 * review). `includeDeleted` also returns soft-deleted sessions. Never throws.
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {Promise<{ok: true, sessions: object[]}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function listSessionHistory({ includeDeleted = false } = {}) {
  const url = includeDeleted
    ? '/api/attendance-sessions/history?includeDeleted=1'
    : '/api/attendance-sessions/history';
  const result = await request(url);
  if (!result.ok) return result;
  return { ok: true, sessions: Array.isArray(result.body?.sessions) ? result.body.sessions : [] };
}

/**
 * Soft-deletes an attendance session created by accident (restorable). Never throws.
 * A successful DELETE is 204 with no body.
 * @param {string} sessionId
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function deleteSession(sessionId) {
  const url = `/api/attendance-sessions/${sessionId}`;
  let response;
  try {
    response = await apiFetch(url, { method: 'DELETE' });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}` } };
  }
  return { ok: true };
}

/**
 * Restores a previously soft-deleted attendance session. Never throws.
 * @param {string} sessionId
 * @returns {Promise<{ok: true}|{ok: false, error: {kind: string, message: string}}>}
 */
export async function restoreSession(sessionId) {
  const result = await request(`/api/attendance-sessions/${sessionId}/restore`, { method: 'POST' });
  if (!result.ok) return result;
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- web/tests/attendance-session.test.js`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/attendance-session.js web/tests/attendance-session.test.js
git commit -m "feat(phase7): web client for session history / delete / restore

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 6: `web/session-history.js` — pure view-model

**Files:**
- Create: `web/session-history.js`
- Test: `web/tests/session-history.test.js`

**Interfaces:**
- Produces:
  - `formatOpenedAt(iso: string, timeZone?: string): string` — a human date/time; falls back to `String(iso)` for an unparseable value.
  - `buildHistoryView(sessions: object[], opts?: { timeZone?: string, sessionActive?: boolean }): { rows: HistoryRow[], hasDeleted: boolean }` where
    `HistoryRow = { id, state: 'open'|'closed'|'reopened'|'deleted', openedText, labelText, startedByText, isDeleted, actions: { resume: Action, reopen: Action, delete: Action, restore: Action } }`
    and `Action = { visible: boolean, enabled: boolean }`. Input order is preserved (server sorts newest-first). Every action is `enabled: false` when `opts.sessionActive` is true.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/session-history.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { formatOpenedAt, buildHistoryView } from '../session-history.js';

describe('formatOpenedAt', () => {
  it('formats an ISO instant in the given time zone', () => {
    const text = formatOpenedAt('2026-09-01T14:02:00.000Z', 'America/New_York');
    expect(text).toMatch(/Sep 1, 2026/);
    expect(text).toMatch(/10:02/); // 14:02Z == 10:02 EDT
  });

  it('returns the raw value unchanged when it is not a date', () => {
    expect(formatOpenedAt('not-a-date')).toBe('not-a-date');
  });
});

describe('buildHistoryView', () => {
  const base = { id: 's', label: null, meetingAt: null, openedAt: '2026-09-01T14:00:00.000Z', startedByLtiUserId: 'i1', deletedAt: null, deletedByLtiUserId: null };
  const view = (over, opts) => buildHistoryView([{ ...base, ...over }], opts).rows[0];

  it('a closed session offers Reopen + Delete, not Resume/Restore', () => {
    const row = view({ state: 'closed' });
    expect(row.state).toBe('closed');
    expect(row.actions.reopen).toEqual({ visible: true, enabled: true });
    expect(row.actions.delete).toEqual({ visible: true, enabled: true });
    expect(row.actions.resume.visible).toBe(false);
    expect(row.actions.restore.visible).toBe(false);
  });

  it('an open session offers Resume + Delete, not Reopen', () => {
    const row = view({ state: 'open' });
    expect(row.actions.resume.visible).toBe(true);
    expect(row.actions.reopen.visible).toBe(false);
    expect(row.actions.delete.visible).toBe(true);
  });

  it('a reopened session offers Resume', () => {
    expect(view({ state: 'reopened' }).actions.resume.visible).toBe(true);
  });

  it('a soft-deleted session has state "deleted", only Restore visible, and sets hasDeleted', () => {
    const built = buildHistoryView([{ ...base, state: 'closed', deletedAt: '2026-09-02T00:00:00.000Z' }]);
    const row = built.rows[0];
    expect(row.state).toBe('deleted');
    expect(row.isDeleted).toBe(true);
    expect(row.actions.restore).toEqual({ visible: true, enabled: true });
    expect(row.actions.delete.visible).toBe(false);
    expect(row.actions.resume.visible).toBe(false);
    expect(row.actions.reopen.visible).toBe(false);
    expect(built.hasDeleted).toBe(true);
  });

  it('disables every action while a session is active on screen', () => {
    const row = view({ state: 'closed' }, { sessionActive: true });
    expect(row.actions.reopen.enabled).toBe(false);
    expect(row.actions.delete.enabled).toBe(false);
  });

  it('labelText prefers label, then the formatted meetingAt, else empty', () => {
    expect(view({ state: 'open', label: 'Monday lecture' }).labelText).toBe('Monday lecture');
    expect(view({ state: 'open', meetingAt: '2026-09-01T14:00:00.000Z' }, { timeZone: 'UTC' }).labelText).toMatch(/Sep 1, 2026/);
    expect(view({ state: 'open' }).labelText).toBe('');
  });

  it('preserves input order and reports hasDeleted=false when none are deleted', () => {
    const built = buildHistoryView([
      { ...base, id: 'a', state: 'closed' },
      { ...base, id: 'b', state: 'open' },
    ]);
    expect(built.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(built.hasDeleted).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- web/tests/session-history.test.js`
Expected: FAIL — `web/session-history.js` does not exist.

- [ ] **Step 3: Create `web/session-history.js` (pure part only for now)**

Create `web/session-history.js`:

```js
// session-history.js
//
// The "Past sessions" panel. Pure view-model builders (buildHistoryView,
// formatOpenedAt) are unit-tested; mountSessionHistory() below is the DOM
// binder and is exercised by the e2e suite, matching ui.js's untested-DOM
// convention. All user-visible strings are written via textContent by the
// caller/renderer, never innerHTML.

/**
 * Human date/time for a session's openedAt / meetingAt.
 * @param {string} iso
 * @param {string} [timeZone] IANA zone; omit to use the viewer's local zone.
 * @returns {string}
 */
export function formatOpenedAt(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/**
 * @param {object[]} sessions  serializeSessionHistory() rows from the server (already newest-first)
 * @param {{timeZone?: string, sessionActive?: boolean}} [opts]
 * @returns {{rows: object[], hasDeleted: boolean}}
 */
export function buildHistoryView(sessions, { timeZone, sessionActive = false } = {}) {
  const rows = (sessions ?? []).map((s) => {
    const isDeleted = Boolean(s.deletedAt);
    const enabled = !sessionActive;
    const isOpenish = s.state === 'open' || s.state === 'reopened';
    return {
      id: s.id,
      state: isDeleted ? 'deleted' : s.state,
      openedText: formatOpenedAt(s.openedAt, timeZone),
      labelText: s.label || (s.meetingAt ? formatOpenedAt(s.meetingAt, timeZone) : ''),
      startedByText: s.startedByLtiUserId || '',
      isDeleted,
      actions: {
        resume: { visible: !isDeleted && isOpenish, enabled },
        reopen: { visible: !isDeleted && s.state === 'closed', enabled },
        delete: { visible: !isDeleted, enabled },
        restore: { visible: isDeleted, enabled },
      },
    };
  });
  return { rows, hasDeleted: rows.some((r) => r.isDeleted) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- web/tests/session-history.test.js`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: clean (the file has no unused symbols yet; `mountSessionHistory` is added in Task 7).

- [ ] **Step 6: Commit**

```bash
git add web/session-history.js web/tests/session-history.test.js
git commit -m "feat(phase7): session-history view-model (buildHistoryView / formatOpenedAt)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 7: Panel DOM + `app.js` wiring + `index.html` + e2e

**Files:**
- Modify: `web/session-history.js` (add `mountSessionHistory`)
- Modify: `web/index.html` (panel + row template)
- Modify: `web/app.js` (extract `attachToServerSession`, track `currentSessionState`, mount + refresh)
- Modify: `web/styles.css`
- Create: `e2e/session-review.spec.ts`

**Interfaces:**
- Consumes: `listSessionHistory`, `deleteSession`, `restoreSession` (Task 5); `reopenAttendanceSession` (existing, `web/attendance-session.js`); `buildHistoryView` (Task 6); `bindInlineConfirm` (`web/confirm-inline.js`); `ui.showAppMessage` (existing).
- Produces:
  - `mountSessionHistory(deps): { refresh: () => Promise<void> }` where
    `deps = { isSessionActive: () => boolean, attachToServerSession: (sessionId: string, opts?: { announce?: boolean }) => Promise<void>, showMessage: (kind: string, text: string) => void, timeZone?: string }`.
  - `web/app.js` gains `async function attachToServerSession(sessionId, { announce = false } = {})` — the detail-fetch + table-populate + `renderSessionState` + grade-sync + manual-present logic factored out of `resumeOpenSessionIfAny`.

- [ ] **Step 1: Add the panel markup to `index.html`**

In `web/index.html`, add this `<details>` block immediately **after** the closing `</details>` of the existing `#roster-panel` (around line 211), before the `<div class="tools">`:

```html
      <!-- Past sessions: review / reopen / soft-delete closed & accidental sessions -->
      <details id="session-history-panel" class="panel">
        <summary>Past sessions</summary>
        <div class="details-body">
          <div class="button-row">
            <label class="toggle-row">
              <input type="checkbox" id="history-show-deleted" />
              Show deleted
            </label>
            <button id="btn-refresh-history" type="button" class="secondary">Refresh</button>
          </div>
          <p id="session-history-status" class="muted" role="status" aria-live="polite" hidden></p>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Label</th>
                  <th>Status</th>
                  <th>Started by</th>
                  <th><span class="sr-only">Row actions</span></th>
                </tr>
              </thead>
              <tbody id="session-history-table-body"></tbody>
            </table>
          </div>
          <p id="session-history-empty" class="muted" hidden>No attendance sessions yet.</p>
        </div>
      </details>
```

And add this `<template>` next to the existing `#attendance-row-template` (near line 327):

```html
    <template id="session-history-row-template">
      <tr>
        <td class="col-opened"></td>
        <td class="col-label"></td>
        <td class="col-status"><span class="status-badge"></span></td>
        <td class="col-started-by"></td>
        <td class="col-actions">
          <button type="button" class="link-button js-resume" hidden>Resume</button>
          <button type="button" class="link-button js-reopen" hidden>Reopen</button>
          <button type="button" class="link-button danger js-delete" hidden>Delete</button>
          <button type="button" class="link-button js-restore" hidden>Restore</button>
        </td>
      </tr>
    </template>
```

- [ ] **Step 2: Add `mountSessionHistory` to `web/session-history.js`**

Append to `web/session-history.js`:

```js
import { bindInlineConfirm } from './confirm-inline.js';
import { listSessionHistory, deleteSession, restoreSession, reopenAttendanceSession } from './attendance-session.js';

/**
 * Binds the #session-history-panel. Returns { refresh } so the host (app.js) can
 * re-pull the list after start/close/reopen. Not unit-tested (DOM binder), same
 * convention as ui.js.
 * @param {{
 *   isSessionActive: () => boolean,
 *   attachToServerSession: (sessionId: string, opts?: {announce?: boolean}) => Promise<void>,
 *   showMessage: (kind: string, text: string) => void,
 *   timeZone?: string,
 * }} deps
 */
export function mountSessionHistory(deps) {
  const panel = document.getElementById('session-history-panel');
  const tbody = document.getElementById('session-history-table-body');
  const emptyMsg = document.getElementById('session-history-empty');
  const statusMsg = document.getElementById('session-history-status');
  const showDeletedToggle = document.getElementById('history-show-deleted');
  const refreshBtn = document.getElementById('btn-refresh-history');
  const rowTemplate = document.getElementById('session-history-row-template');

  let inFlight = false;

  function setStatus(text) {
    if (!text) {
      statusMsg.hidden = true;
      statusMsg.textContent = '';
      return;
    }
    statusMsg.hidden = false;
    statusMsg.textContent = text;
  }

  async function runAction(fn, successText) {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await fn();
      if (!result.ok) {
        deps.showMessage('error', result.error?.message || 'That action could not be completed.');
        return;
      }
      if (successText) deps.showMessage('info', successText);
      await refresh();
    } finally {
      inFlight = false;
    }
  }

  function renderRow(rowData) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.col-opened').textContent = rowData.openedText;
    node.querySelector('.col-label').textContent = rowData.labelText;
    node.querySelector('.col-started-by').textContent = rowData.startedByText;
    const badge = node.querySelector('.status-badge');
    badge.textContent = rowData.state;
    badge.dataset.state = rowData.state;
    if (rowData.isDeleted) node.classList.add('is-deleted');

    const wire = (selector, action, handler) => {
      const btn = node.querySelector(selector);
      btn.hidden = !action.visible;
      btn.disabled = !action.enabled;
      if (action.visible && action.enabled) handler(btn);
    };

    wire('.js-resume', rowData.actions.resume, (btn) => {
      btn.addEventListener('click', () =>
        runAction(async () => {
          await deps.attachToServerSession(rowData.id, { announce: true });
          return { ok: true };
        }),
      );
    });
    wire('.js-reopen', rowData.actions.reopen, (btn) => {
      btn.addEventListener('click', () =>
        runAction(async () => {
          const reopened = await reopenAttendanceSession(rowData.id);
          if (!reopened.ok) return reopened;
          await deps.attachToServerSession(rowData.id, { announce: true });
          return { ok: true };
        }, 'Session reopened. Scans are accepted again.'),
      );
    });
    wire('.js-restore', rowData.actions.restore, (btn) => {
      btn.addEventListener('click', () => runAction(() => restoreSession(rowData.id), 'Session restored.'));
    });
    wire('.js-delete', rowData.actions.delete, (btn) => {
      bindInlineConfirm(btn, {
        armedLabel: 'Click again to delete',
        onConfirm: () => runAction(() => deleteSession(rowData.id), 'Session deleted. You can restore it from “Show deleted”.'),
      });
    });

    return node;
  }

  async function refresh() {
    const result = await listSessionHistory({ includeDeleted: showDeletedToggle.checked });
    if (!result.ok) {
      setStatus('Could not load past sessions.');
      return;
    }
    setStatus('');
    const { rows } = buildHistoryView(result.sessions, {
      timeZone: deps.timeZone,
      sessionActive: deps.isSessionActive(),
    });
    tbody.replaceChildren(...rows.map(renderRow));
    emptyMsg.hidden = rows.length > 0;
  }

  refreshBtn.addEventListener('click', () => {
    refresh();
  });
  showDeletedToggle.addEventListener('change', () => {
    refresh();
  });
  // Refresh when the panel is first expanded so it isn't fetched on every page load.
  panel.addEventListener('toggle', () => {
    if (panel.open) refresh();
  });

  return { refresh };
}
```

- [ ] **Step 3: Extract `attachToServerSession` in `app.js` and wire the panel**

In `web/app.js`:

1. Add to the import from `./attendance-session.js`: `listSessionHistory` is not needed here; add nothing. Add a new import line:
   `import { mountSessionHistory } from './session-history.js';`

2. Add a module-level state var near `let currentAttendanceSessionId = null;`:
   `let currentSessionState = 'none';`

3. Wherever `ui.renderSessionState({ state: ... })` is called in `app.js` (`startSession`, `closeSession`, `reopenSession`, `init`, and the resume path), set `currentSessionState` to the same value on the line above. Specifically:
   - `startSession`: after a successful create, `currentSessionState = result.session.state;`
   - `closeSession`: on success, `currentSessionState = 'closed';`
   - `reopenSession`: on success, `currentSessionState = 'reopened';`
   - `init` bootstrap-fail and the initial `renderSessionState({ state: 'none' })`: `currentSessionState = 'none';`

4. Refactor `resumeOpenSessionIfAny` — pull its body (from `const detail = await getAttendanceSession(chosen.id);` through the final `ui.showAppMessage(...)`) into a new function, keeping the "pick which session" logic in `resumeOpenSessionIfAny`:

```js
/**
 * Loads an existing server session (open, reopened, or just-reopened) into the
 * screen: fetches detail, repopulates the attendance table, and syncs the
 * session-state / grade-sync / manual-present UI. Shared by page-reload resume
 * and the "Past sessions" panel's Resume / Reopen actions.
 */
async function attachToServerSession(sessionId, { announce = false } = {}) {
  currentAttendanceSessionId = sessionId;
  scanPipeline.sessionId = sessionId;

  const detail = await getAttendanceSession(sessionId);
  if (detail.ok) {
    sessionMembers = detail.body.members || [];
    resumedRowsById.clear();
    ui.clearAttendanceTable();
    const rows = [];
    for (const member of detail.body.members || []) {
      if (member.currentRecord) rows.push(serverRecordToRow(member.currentRecord, member));
    }
    for (const unmatched of detail.body.unmatchedRecords || []) {
      rows.push(serverRecordToRow(unmatched, null));
    }
    rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    for (const row of rows) {
      resumedRowsById.set(row.id, row);
      ui.addAttendanceRow(row, handleRemoveRecord);
    }
  } else {
    ui.showAppMessage('warning', 'Loaded the attendance session, but its roster could not be fetched.');
  }

  const state = detail.ok ? detail.body.session?.state ?? 'reopened' : 'reopened';
  currentSessionState = state;
  ui.renderSessionState({ state, label: detail.ok ? detail.body.session?.label : undefined });
  ui.renderGradeSyncState(detail.body?.gradeSync);
  ui.setManualPresentGroupVisible(state === 'open' || state === 'reopened');
  refreshManualPresentOptions();
  if (announce) ui.showAppMessage('info', 'Attendance session loaded.');
}
```

Then in `resumeOpenSessionIfAny`, replace the pulled-out body with:

```js
  currentAttendanceSessionId = chosen.id;
  scanPipeline.sessionId = chosen.id;
  await attachToServerSession(chosen.id, { announce: false });
  ui.showAppMessage('info', 'Reconnected to the attendance session already in progress.');
```

(Keep the existing `const hintId = ...` / `const chosen = ...` selection lines above it.)

5. In `init()`, after the `if (!boot.ok) { ... } else { ... }` block that calls `resumeOpenSessionIfAny()` and `loadCanvasRoster()`, mount the panel and do a first refresh:

```js
  const sessionHistory = mountSessionHistory({
    isSessionActive: () => currentSessionState === 'open' || currentSessionState === 'reopened',
    attachToServerSession,
    showMessage: ui.showAppMessage,
  });
  await sessionHistory.refresh();
```

Store `sessionHistory` where `startSession` / `closeSession` / `reopenSession` can see it (module scope: `let sessionHistory = null;` near the other state vars, assign in `init`). Add `if (sessionHistory) sessionHistory.refresh();` as the last line of `startSession`, `closeSession`, and `reopenSession`.

- [ ] **Step 4: Styles**

Append to `web/styles.css`:

```css
/* Past sessions panel */
#session-history-panel .is-deleted .col-opened,
#session-history-panel .is-deleted .col-label,
#session-history-panel .is-deleted .col-started-by {
  opacity: 0.55;
}
#session-history-panel .status-badge[data-state='deleted'] {
  background: var(--surface-muted, #e5e7eb);
  color: var(--text-muted, #6b7280);
}
#session-history-panel .col-actions {
  white-space: nowrap;
}
#session-history-panel .col-actions .link-button + .link-button {
  margin-left: 0.5rem;
}
```

(If `styles.css` already defines `--surface-muted` / `--text-muted`, the fallbacks are harmless; if the file uses different token names, match the nearest existing `.status-badge` rule instead.)

- [ ] **Step 5: Run the JS unit suite + lint + typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass. (`session-history.test.js` still green; no new unit tests for the DOM binder.)

- [ ] **Step 6: Write the e2e spec**

Create `e2e/session-review.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { webhidShimScript } from './support/webhid-shim.js';
import { seedInstructorLaunch, teardownSeedResources } from './support/seed-launch.js';

// End-to-end for session review: launch -> start -> close -> reopen FROM the Past sessions panel
// -> close again -> delete FROM the panel -> Show deleted -> restore. Against the built server.

test.afterAll(async () => {
  await teardownSeedResources();
});

test('instructor: review, reopen-from-panel, delete and restore a past session', async ({ page, context }) => {
  page.on('dialog', (dialog) => dialog.accept('e2e'));
  await context.addInitScript(webhidShimScript);

  const seeded = await seedInstructorLaunch();
  await page.goto('/index.html');
  await page.evaluate(
    ({ url, fields }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = url;
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value as string;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    },
    { url: seeded.launchUrl, fields: seeded.fields },
  );

  const startButton = page.getByRole('button', { name: 'Start Attendance' });
  await expect(startButton).toBeEnabled({ timeout: 20_000 });
  await startButton.click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session open/i);

  await page.getByRole('button', { name: 'Close Attendance' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session closed/i);

  // Open the Past sessions panel — it refreshes on expand.
  const panel = page.locator('#session-history-panel');
  await panel.locator('summary').click();
  const row = page.locator('#session-history-table-body tr').first();
  await expect(row).toBeVisible();
  await expect(row.locator('.status-badge')).toHaveText('closed');

  // Reopen from the panel.
  await row.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session reopened/i);

  // Close again, then delete from the panel (two-click inline confirm).
  await page.getByRole('button', { name: 'Close Attendance' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session closed/i);
  await panel.locator('summary').click(); // collapse
  await panel.locator('summary').click(); // expand -> refresh
  const delBtn = page.locator('#session-history-table-body tr').first().getByRole('button', { name: /Delete|Click again to delete/ });
  await delBtn.click();
  await delBtn.click();
  await expect(page.locator('#session-history-table-body tr')).toHaveCount(0);

  // Show deleted -> the row is back with a Restore action.
  await page.locator('#history-show-deleted').check();
  const deletedRow = page.locator('#session-history-table-body tr').first();
  await expect(deletedRow.locator('.status-badge')).toHaveText('deleted');
  await deletedRow.getByRole('button', { name: 'Restore' }).click();
  await expect(deletedRow.locator('.status-badge')).toHaveText('closed');
});
```

If `seed-launch.ts` does not export `seedInstructorLaunch` / `teardownSeedResources` with these exact names, match the names used in `e2e/instructor-flow.spec.ts` (it imports from the same module).

- [ ] **Step 7: Run the e2e suite**

Run: `npm run test:e2e -- session-review`
Expected: PASS. If Playwright browsers/server aren't set up in this environment, run `npm run test:e2e` once to let its `webServer` config build+boot; if e2e cannot run at all here, note that and rely on the unit + route coverage, leaving this spec committed for CI.

- [ ] **Step 8: Manual smoke (optional but recommended)**

Run the app (`npm run dev`), launch from the mock Canvas, start + close a session, expand **Past sessions**, confirm the row shows the opened time, reopen it, close it, delete it, toggle **Show deleted**, restore it.

- [ ] **Step 9: Commit**

```bash
git add web/session-history.js web/index.html web/app.js web/styles.css e2e/session-review.spec.ts
git commit -m "feat(phase7): Past sessions panel — review, reopen, soft-delete, restore

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/canvas-lti/spec.md`
- Modify: `docs/canvas-lti/progress.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the audit list (spec §33)**

In `docs/canvas-lti/spec.md`, in the `# 33. Audit requirements` code block, add two entries after `attendance_record_removed`:

```text
attendance_session_deleted
attendance_session_restored
```

- [ ] **Step 2: Add a session review / soft-delete note (spec §25)**

After `## 25.10 CSV` in `docs/canvas-lti/spec.md`, add:

```markdown
## 25.11 History, soft delete, restore

```text
GET  /api/attendance-sessions/history[?includeDeleted=1]
DELETE /api/attendance-sessions/{id}
POST /api/attendance-sessions/{id}/restore
```

`history` lists the course's sessions newest-first by `opened_at` (soft-deleted
excluded unless `includeDeleted=1`). `DELETE` is a soft delete: it sets
`attendance_sessions.deleted_at` / `deleted_by_lti_user_id`, is restorable, and —
when the session was `closed` — recomputes the course's cumulative attendance
grades without it. `restore` is the inverse. Both audit actor + time and, when a
recompute ran, emit `grade_sync_requested`. Editing a past session is unchanged:
reopen it, correct records, close it.
```

- [ ] **Step 3: Log it in progress.md**

Append a bullet under the most recent phase heading in `docs/canvas-lti/progress.md`:

```markdown
- Session review: `GET /api/attendance-sessions/history`, soft delete
  (`DELETE /api/attendance-sessions/:id`) + `POST .../restore` with grade
  recompute, and the "Past sessions" web panel (reopen / delete / restore).
```

- [ ] **Step 4: Commit**

```bash
git add docs/canvas-lti/spec.md docs/canvas-lti/progress.md
git commit -m "docs(phase7): session review / soft-delete endpoints + audit events

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Final verification

- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean
- [ ] `npm test` — full Vitest suite green (server + web)
- [ ] `npm run test:e2e` — `instructor-flow` and `session-review` green (or noted as un-runnable in this environment, green expected in CI)
- [ ] Manual: the mock-Canvas launch → start/close/reopen/delete/restore round-trip via the Past sessions panel behaves as described
- [ ] `git log --oneline` shows the 8 task commits on `canvas-lti-phase7`

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Overview — Past sessions panel, list by opened date/time | 7 (panel + `buildHistoryView`/`formatOpenedAt`), 4 (`history` route) |
| §2 data model — `deleted_at` / `deleted_by_lti_user_id`, nullable, restore nulls both | 1 |
| §2 — `deleted_at IS NULL` on resume list + close's closed-session scan | 4 (resume list), 2 (recompute scan) |
| §2 — fetch-by-id not filtered (review/restore can reach a deleted row) | 4 (`loadSessionScopedToCourse` unchanged; noted) |
| §3 — `GET /history` incl. `?includeDeleted=1`, newest-first, static-path routing | 4 |
| §3 — `DELETE /:id` soft delete, row-lock, already-deleted → 404, recompute when `closed` | 3 (service), 4 (route) |
| §3 — `POST /:id/restore`, only-deleted guard → 409, recompute when `closed` | 3, 4 |
| §3 — new error codes `session_already_deleted` (404) / `session_not_deleted` (409) | 3 (codes), 4 (`HTTP_FOR_CODE`) |
| §2 — shared `recomputeCourseGrades` called by close, delete, restore | 2 (extract + close), 3 (delete/restore call it) |
| §4 — `web/session-history.js` module, three client fns, active-session disabling, inline-confirm delete, no reason prompt | 5 (client fns), 6 (view-model), 7 (mount + `attachToServerSession`, `bindInlineConfirm`) |
| §4 — reopen reuses existing flow; `attachToServerSession` factored from `resumeOpenSessionIfAny` | 7 |
| §5 — audit `attendance_session_deleted` / `attendance_session_restored` with `deletedAt` transition + `gradeRecompute`/`jobCount` | 3 (emit), 8 (spec list) |
| §6 testing — recompute extraction behaviour-preserving; delete/restore grade cases; guards; history route; resume-list & close-scan exclusion; CSRF; cross-course 404; web view-model; e2e | 2, 3, 4, 6, 7 |
| §7 out of scope — no pagination, no hard-delete UI, no per-row counts, no new role checks | honoured (no such tasks) |

No gaps.

**Placeholder scan** — no "TBD"/"handle edge cases"/"similar to Task N"; every code step carries full code; every command has an expected result. Two intentional non-determinisms are called out with verification hooks: the generated migration slug (Step 1.4 shows the exact SQL to check against) and `seed-launch.ts` export names (Step 7.6 says to match `instructor-flow.spec.ts`).

**Type consistency**

- `recomputeCourseGrades(tx, db, courseId, triggeringSessionId, actorLtiUserId, requestId)` — identical signature in Task 2 (definition), Task 3 (both call sites), Task 2 Step 4 (close call site). Returns `{ jobCount, closedSessionCount, eligibleMemberCount }`; callers destructure only `jobCount`. �absent fields unused, fine.
- `softDeleteAttendanceSession` / `restoreAttendanceSession` — `(db, sessionId, actorLtiUserId, requestId?)` → `Promise<{ gradeRecompute, jobCount }>` in Task 3 def, Task 3 tests, and Task 4 routes (routes ignore the return). Consistent.
- Error classes `SessionAlreadyDeletedError` (`code = 'session_already_deleted'`) / `SessionNotDeletedError` (`code = 'session_not_deleted'`) — same names/codes in Task 3 (def + tests) and Task 4 (`HTTP_FOR_CODE` keys, response-body assertions). Consistent (404 / 409).
- `serializeSessionHistory` fields — produced in Task 4, consumed field-for-field by `buildHistoryView` in Task 6 (`id`, `state`, `label`, `meetingAt`, `openedAt`, `startedByLtiUserId`, `deletedAt`, `deletedByLtiUserId`). Consistent.
- Client fns `listSessionHistory({ includeDeleted })` / `deleteSession(id)` / `restoreSession(id)` — same shapes in Task 5 (def + tests) and Task 7 (`session-history.js` imports + calls). Consistent.
- `mountSessionHistory(deps)` deps `{ isSessionActive, attachToServerSession, showMessage, timeZone? }` — defined in Task 7 Step 2, supplied in Task 7 Step 3 `init()`. `attachToServerSession(sessionId, { announce })` — defined in Task 7 Step 3, called by both `resumeOpenSessionIfAny` and the panel. Consistent.
- `buildHistoryView(sessions, { timeZone, sessionActive })` → `{ rows, hasDeleted }`; `rows[].actions.{resume,reopen,delete,restore}.{visible,enabled}` — same in Task 6 (def + tests) and Task 7 (`renderRow`). Consistent.

No mismatches found.
