# Durable Canvas AGS line-item removal ("full IMP-3") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a soft-delete removes a course's last non-deleted closed attendance session, durably delete the whole Canvas AGS attendance line item (the Gradebook column) and purge the course's local `grade_sync_jobs`, so no stale attendance grades are left behind in Canvas.

**Architecture:** The soft-delete transaction records the intent on new nullable `delete_*` columns of `grade_line_items` and purges `grade_sync_jobs` locally (no Canvas call in the request — spec §28). A new worker pass, `processLineItemDeletions`, drains those rows: it mints an AGS token, calls a new `deleteLineItem` (Canvas 404 = already-gone success), backs off retryable failures, and on success deletes the `grade_line_items` row under a re-checked per-course advisory lock. A later close or restore cancels a still-pending request; the normal recompute → worker path then recreates the line item idempotently via `ensureLineItem`.

**Tech Stack:** Node 22 ESM (TypeScript, `.js` import suffixes), Fastify 5, Drizzle ORM + `pg`, PostgreSQL, drizzle-kit migrations, Vitest, Playwright. Frontend is vanilla ES modules (no build step, CSP `'self'`-only).

## Global Constraints

- Node ESM: every relative import uses a `.js` suffix even from `.ts` source.
- Durable, not synchronous: the AGS DELETE must NOT be an HTTP call inside any attendance mutation transaction (spec §28). It runs only in the worker pass.
- Errors are opaque coded strings prefixed `ags:` (e.g. `ags:network`); never persist or return a raw Canvas body or URL (spec §31.9, §31.8).
- Every lifecycle state change is audited in the same transaction that makes it.
- Tenancy: routes are course-scoped; cross-course lookups return 404 (unchanged — routes already enforce this).
- Reuse existing retry primitives: `computeBackoff` and `MAX_GRADE_SYNC_ATTEMPTS` (= 6) from `server/src/attendance/grade-sync-store.ts`.
- New audit `event_type` values, all with `target_type: 'grade_line_item'` and `target_id: <courseId>`: `grade_line_item_delete_requested`, `grade_line_item_deleted`, `grade_line_item_delete_failed`, `grade_line_item_delete_canceled`.
- The interim HTTP contract is unchanged: `softDeleteAttendanceSession` still returns `{ gradeRecompute, jobCount, lastClosedSessionRemoved }` and `DELETE /api/attendance-sessions/:id` still responds `200 { ok: true, lastClosedSessionRemoved }`.
- Migrations are generated from the repo root with `npx drizzle-kit generate` (config: `./drizzle.config.ts`, schema `./server/src/database/schema.ts`, out `./server/migrations`). Vitest global setup (`server/tests/support/global-setup.ts`) auto-applies pending migrations before the suite.
- Test DB requires `docker compose up -d postgres` (compose project `canvas-lti-phase0`, port 5432).
- Full green gate before the final commit: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e` (all run from the repo root). Re-run `server/tests/support/mock-canvas-nrps.test.ts` in isolation before treating a parallel-load failure as real (known flaky).
- Every `git commit` message ends with these two trailers:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
  ```
- All commands are run from the worktree root: `/Users/nbiggs112/repos/attendance-tracker/.claude/worktrees/canvas-lti-phase7`. Never `cd` to the main checkout. Branch `canvas-lti-phase7`, off `ef0ae16`. This branch is part of the unmerged Canvas LTI phase stack — never merge it to `main`.

---

## File Structure

**Created:**
- `server/migrations/0007_<generated-name>.sql` — drizzle-kit output for the `grade_line_items` `delete_*` columns (name auto-assigned; also updates `server/migrations/meta/`).
- `server/src/attendance/line-item-deletion-store.ts` — all DB access for the `grade_line_items` `delete_*` lifecycle (request / cancel / claim-due / retry / fail / re-arm / delete-row).
- `server/src/attendance/ags-course-context.ts` — `CourseAgsContext` type + `loadCourseAgsContext`, extracted verbatim from `grade-worker.ts` so both worker passes share it.
- `server/src/attendance/line-item-deletion.ts` — `processLineItemDeletions`, the worker pass that drains due deletion rows against Canvas.
- `server/tests/attendance/line-item-deletion.test.ts` — tests for the worker pass + store.

**Modified:**
- `server/src/database/schema.ts` — 5 columns on `gradeLineItems`.
- `server/src/lti/ags.ts` — add `deleteLineItem`.
- `server/tests/support/mock-canvas.ts` — add `DELETE /ags/lineitems/:lineItemId` route.
- `server/tests/lti/ags.test.ts` — `deleteLineItem` cases.
- `server/src/attendance/grade-worker.ts` — import `loadCourseAgsContext`/`CourseAgsContext` from the new shared module instead of defining them.
- `server/src/attendance/grade-sync-store.ts` — add `deleteCourseGradeSyncJobs`.
- `server/src/attendance/session-lifecycle.ts` — per-course advisory lock in `close`/`softDelete`/`restore`; request deletion on last-closed soft-delete; cancel on `close`/`restore` when closed sessions remain.
- `server/tests/attendance/session-lifecycle.test.ts` — new cases.
- `server/src/worker.ts` — run `processLineItemDeletions` before `processGradeSyncJobs`; include its tally in the log line.
- `server/src/routes/attendance-sessions.ts` — `POST :id/grade-sync` also re-arms a stuck deletion; response gains `deletionRearmed`.
- `server/tests/routes/attendance-sessions.test.ts` — updated `grade-sync` assertions + a re-arm case.
- `web/session-history.js` — reword the last-closed-session warning.
- `web/attendance-session.js` — update the `deleteSession` JSDoc.
- `docs/canvas-lti/spec.md` — §25.11, §27.1, §33 updates.

---

## Task 1: `grade_line_items` deletion columns + migration

**Files:**
- Modify: `server/src/database/schema.ts:234-248` (the `gradeLineItems` table)
- Create: `server/migrations/0007_<generated-name>.sql` (+ `server/migrations/meta/` updates) via drizzle-kit
- Test: none of its own — verified by `npm run typecheck` and by the migration applying cleanly in later tasks' test runs

**Interfaces:**
- Consumes: nothing.
- Produces: `GradeLineItemRow` (`typeof gradeLineItems.$inferSelect`) gains
  `deleteRequestedAt: Date | null`, `deleteRequestedByLtiUserId: string | null`,
  `deleteAttemptCount: number`, `deleteNextAttemptAt: Date | null`,
  `deleteLastError: string | null`. Column names in SQL:
  `delete_requested_at`, `delete_requested_by_lti_user_id`, `delete_attempt_count`,
  `delete_next_attempt_at`, `delete_last_error`.

- [ ] **Step 1: Add the columns to the Drizzle table**

In `server/src/database/schema.ts`, replace the `gradeLineItems` definition (currently lines ~234-248) with:

```ts
// One cumulative Canvas Gradebook line item per course (spec §27). UNIQUE(course_id) makes
// ensureLineItem's persist step idempotent regardless of how many times the worker runs.
//
// The delete_* columns carry a durable "remove this course's Canvas line item" request (spec
// §25.11, §27.1). They are set by softDeleteAttendanceSession when a soft-delete removes the
// course's last closed session, drained by processLineItemDeletions, and cleared by a later
// close/restore. delete_next_attempt_at NULL while delete_requested_at is NOT NULL means the
// request reached a terminal failure and is awaiting a manual re-arm.
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
    deleteRequestedAt: timestamp('delete_requested_at', { withTimezone: true }),
    deleteRequestedByLtiUserId: text('delete_requested_by_lti_user_id'),
    deleteAttemptCount: integer('delete_attempt_count').notNull().default(0),
    deleteNextAttemptAt: timestamp('delete_next_attempt_at', { withTimezone: true }),
    deleteLastError: text('delete_last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.courseId)],
);
```

- [ ] **Step 2: Generate the migration**

Run from the worktree root:

```bash
npx drizzle-kit generate
```

Expected: a new `server/migrations/0007_*.sql` file is created containing five `ALTER TABLE "grade_line_items" ADD COLUMN ...` statements, and `server/migrations/meta/_journal.json` gains an `idx: 7` entry. No other table is touched (if the diff touches other tables, stop — the schema has drifted and must be investigated).

- [ ] **Step 3: Inspect the generated SQL**

Open the new `server/migrations/0007_*.sql`. Confirm it is exactly the five new columns, e.g.:

```sql
ALTER TABLE "grade_line_items" ADD COLUMN "delete_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_requested_by_lti_user_id" text;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grade_line_items" ADD COLUMN "delete_last_error" text;
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no references to the new columns yet, but the schema must compile).

- [ ] **Step 5: Commit**

```bash
git add server/src/database/schema.ts server/migrations/
git commit -m "$(cat <<'EOF'
feat(phase7): grade_line_items delete_* columns for durable line-item removal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 2: `deleteLineItem` in `ags.ts` + mock-canvas DELETE route

**Files:**
- Modify: `server/src/lti/ags.ts` (add `deleteLineItem` after `postScore`, ~line 246)
- Modify: `server/tests/support/mock-canvas.ts` (add a `DELETE /ags/lineitems/:lineItemId` route next to the other `/ags/...` routes, ~line 138)
- Test: `server/tests/lti/ags.test.ts` (add a `describe('deleteLineItem', ...)` block)

**Interfaces:**
- Consumes: `AgsResult<T>`, `AgsError`, `validateCanvasServiceUrl`, `classifyResponse`, `networkError` (all already in `ags.ts`).
- Produces:
  ```ts
  export async function deleteLineItem(
    lineItemUrl: string,
    accessToken: string,
    deps?: { fetchImpl?: typeof fetch },
  ): Promise<AgsResult<boolean>>
  ```
  Contract: `validateCanvasServiceUrl` failure → `{ ok: false, error: { kind: 'invalid-service-url', retryable: false } }`. HTTP 404 → `{ ok: true, value: true }` (already gone). Normal 2xx/204 → `{ ok: true, value: false }`. Otherwise classified exactly like `postScore` (401 → `auth` retryable; 429/5xx/network → retryable; other 4xx → `client-error` non-retryable). `value` = "Canvas reported the line item already absent", used only for the `grade_line_item_deleted` audit's `canvas404` field.

- [ ] **Step 1: Add the mock-canvas DELETE route**

In `server/tests/support/mock-canvas.ts`, immediately after the `this.app.post('/ags/lineitems/:lineItemId/scores', ...)` handler (ends ~line 138), add:

```ts
    this.app.delete('/ags/lineitems/:lineItemId', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { lineItemId } = request.params as { lineItemId: string };
      for (const [courseId, items] of this.lineItems) {
        const idx = items.findIndex((li) => li.id.endsWith(`/${lineItemId}`));
        if (idx !== -1) {
          items.splice(idx, 1);
          this.lineItems.set(courseId, items);
          this.lineItemScores.delete(lineItemId);
          return reply.code(204).send();
        }
      }
      return reply.code(404).send({ error: 'unknown_line_item' }); // already gone
    });
```

- [ ] **Step 2: Write the failing tests**

Append to `server/tests/lti/ags.test.ts`:

```ts
describe('deleteLineItem', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('DELETEs the line item and removes it from Canvas (value=false, not a 404)', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-del');
    expect(platform.getLineItems('c-del')).toHaveLength(1);

    const result = await deleteLineItem(lineItemUrl, token);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false);
    expect(platform.getLineItems('c-del')).toHaveLength(0);
  });

  it('treats a Canvas 404 as already-gone success (value=true)', async () => {
    const token = await mintToken(platform);
    // A well-formed line-item URL that was never created.
    const missingUrl = platform.seedExistingLineItem('c-del-404');
    await deleteLineItem(missingUrl, token); // first delete really removes it
    const result = await deleteLineItem(missingUrl, token); // second hits 404

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
  });

  it('classifies a 401 as retryable auth', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-del-401');
    platform.failNextAgsRequest('auth');
    const result = await deleteLineItem(lineItemUrl, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'auth', retryable: true });
  });

  it('classifies a 429 as retryable rate-limited', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-del-429');
    platform.failNextAgsRequest('rate-limited');
    const result = await deleteLineItem(lineItemUrl, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'rate-limited', retryable: true });
  });

  it('classifies a 500 as retryable server-error', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-del-500');
    platform.failNextAgsRequest('server-error');
    const result = await deleteLineItem(lineItemUrl, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'server-error', retryable: true });
  });

  it('classifies a 422 as PERMANENT client-error', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-del-422');
    platform.failNextAgsRequest('client-error');
    const result = await deleteLineItem(lineItemUrl, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'client-error', retryable: false });
  });

  it('classifies a thrown fetch as retryable network', async () => {
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await deleteLineItem('https://canvas.example.edu/api/lti/courses/1/line_items/9', 'tok', { fetchImpl: dead });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'network', retryable: true });
  });

  it('rejects a malformed URL without a fetch', async () => {
    const result = await deleteLineItem('not a url', 'tok');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-service-url');
  });
});
```

Then update the import at the top of the file:

```ts
import { ensureLineItem, postScore, deleteLineItem, ATTENDANCE_RESOURCE_ID, ATTENDANCE_TAG } from '../../src/lti/ags.js';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- server/tests/lti/ags.test.ts`
Expected: FAIL — `deleteLineItem is not a function` (or a TS build error that `deleteLineItem` has no exported member).

- [ ] **Step 4: Implement `deleteLineItem`**

In `server/src/lti/ags.ts`, after `postScore` (ends ~line 246), add:

```ts
// DELETE the whole cumulative line item (spec §25.11, §27.1). Same auth-retry contract as
// postScore (the caller — line-item-deletion.ts — owns the single 401 re-mint). A Canvas 404
// means the line item is already gone, which is exactly the desired end state, so it is a
// success, not an error. The boolean value is `true` when Canvas reported it already absent
// (404) and `false` for a normal 2xx delete — used only for the audit's `canvas404` field.
export async function deleteLineItem(
  lineItemUrl: string,
  accessToken: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AgsResult<boolean>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const urlCheck = validateCanvasServiceUrl(lineItemUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: { kind: 'invalid-service-url', message: 'ags:invalid-service-url', retryable: false } };
  }

  let response: Response;
  try {
    response = await fetchImpl(lineItemUrl, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    });
  } catch (err) {
    return networkError(err);
  }
  if (response.status === 404) return { ok: true, value: true };
  const error = classifyResponse(response);
  if (error) return error;
  return { ok: true, value: false };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- server/tests/lti/ags.test.ts`
Expected: PASS (all `deleteLineItem` cases plus the untouched `ensureLineItem` / `postScore` cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/lti/ags.ts server/tests/support/mock-canvas.ts server/tests/lti/ags.test.ts
git commit -m "$(cat <<'EOF'
feat(phase7): ags.deleteLineItem — DELETE a cumulative line item, 404 = already gone

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 3: `line-item-deletion-store.ts` + `deleteCourseGradeSyncJobs`

**Files:**
- Create: `server/src/attendance/line-item-deletion-store.ts`
- Modify: `server/src/attendance/grade-sync-store.ts` (add `deleteCourseGradeSyncJobs` near `resetFailedJobs`, ~line 178)
- Test: `server/tests/attendance/line-item-deletion.test.ts` (create; store-only cases in this task, worker cases added in Task 5)

**Interfaces:**
- Consumes: `Database` (`../database/client.js`), `Tx` (`./session-lifecycle.js`), `gradeLineItems`, `gradeSyncJobs`, `GradeLineItemRow` (`../database/schema.js`).
- Produces (all exported from `line-item-deletion-store.ts`):
  ```ts
  type DeletionExecutor = Database | Tx;

  // Set the request on an existing grade_line_items row. Returns whether a row existed
  // (false => the worker never created a Canvas line item, nothing durable to remove).
  requestLineItemDeletion(
    executor: DeletionExecutor, courseId: string, actorLtiUserId: string, now: Date,
  ): Promise<{ requested: boolean; canvasLineItemId: string | null }>;

  // Clear any pending request. Returns whether a row was updated.
  cancelLineItemDeletion(executor: DeletionExecutor, courseId: string): Promise<boolean>;

  // Due rows: delete_requested_at NOT NULL AND delete_next_attempt_at NOT NULL AND <= now(),
  // oldest delete_next_attempt_at first.
  claimDueLineItemDeletions(db: Database, limit: number): Promise<GradeLineItemRow[]>;

  markLineItemDeletionRetry(
    db: Database, courseId: string, attemptCount: number, nextAttemptAt: Date, lastError: string, now: Date,
  ): Promise<void>;

  // Terminal failure: keep delete_requested_at, set delete_next_attempt_at = NULL.
  markLineItemDeletionFailed(db: Database, courseId: string, lastError: string, now: Date): Promise<void>;

  // Re-arm a terminally-failed request (delete_requested_at NOT NULL AND delete_next_attempt_at NULL).
  // Returns whether a row was re-armed.
  rearmLineItemDeletion(db: Database, courseId: string, now: Date): Promise<boolean>;

  deleteGradeLineItemRow(executor: DeletionExecutor, courseId: string): Promise<void>;
  ```
- Produces from `grade-sync-store.ts`:
  ```ts
  deleteCourseGradeSyncJobs(executor: Database | Tx, courseId: string): Promise<number>; // rows deleted
  ```

- [ ] **Step 1: Write the failing store tests**

Create `server/tests/attendance/line-item-deletion.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { gradeLineItems, gradeSyncJobs } from '../../src/database/schema.js';
import {
  requestLineItemDeletion,
  cancelLineItemDeletion,
  claimDueLineItemDeletions,
  markLineItemDeletionRetry,
  markLineItemDeletionFailed,
  rearmLineItemDeletion,
  deleteGradeLineItemRow,
} from '../../src/attendance/line-item-deletion-store.js';
import { deleteCourseGradeSyncJobs } from '../../src/attendance/grade-sync-store.js';

const { db } = getTestDb();
const platform = new MockCanvasPlatform();
afterAll(() => closeTestDb());
beforeEach(async () => {
  await resetDb();
});

async function seedLineItem(courseId: string, over: Partial<typeof gradeLineItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(gradeLineItems)
    .values({
      courseId,
      canvasLineItemId: 'li-1',
      canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/li-1',
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
      ...over,
    })
    .returning();
  return row;
}

describe('line-item-deletion-store', () => {
  it('requestLineItemDeletion sets the request on an existing row and reports the canvas id', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId);
    const now = new Date('2026-09-01T00:00:00.000Z');

    const res = await requestLineItemDeletion(db, courseId, 'instructor-9', now);

    expect(res).toEqual({ requested: true, canvasLineItemId: 'li-1' });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(row.deleteRequestedByLtiUserId).toBe('instructor-9');
    expect(row.deleteAttemptCount).toBe(0);
    expect(row.deleteNextAttemptAt).not.toBeNull();
    expect(row.deleteLastError).toBeNull();
  });

  it('requestLineItemDeletion reports requested:false when no row exists', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const res = await requestLineItemDeletion(db, courseId, 'i1', new Date());
    expect(res).toEqual({ requested: false, canvasLineItemId: null });
  });

  it('cancelLineItemDeletion clears all delete_* fields and reports whether it touched a row', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId, {
      deleteRequestedAt: new Date(),
      deleteRequestedByLtiUserId: 'i1',
      deleteAttemptCount: 3,
      deleteNextAttemptAt: new Date(),
      deleteLastError: 'ags:server-error',
    });

    expect(await cancelLineItemDeletion(db, courseId)).toBe(true);
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).toBeNull();
    expect(row.deleteRequestedByLtiUserId).toBeNull();
    expect(row.deleteAttemptCount).toBe(0);
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBeNull();

    expect(await cancelLineItemDeletion(db, courseId)).toBe(false); // nothing left to cancel
  });

  it('claimDueLineItemDeletions returns only due requested rows, oldest-scheduled first', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 600_000);
    const c1 = await seedInstitutionAndCourse(db, platform);
    const c2 = await seedInstitutionAndCourse(db, platform);
    const c3 = await seedInstitutionAndCourse(db, platform);
    const c4 = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(c1.courseId, { deleteRequestedAt: past, deleteNextAttemptAt: new Date(past.getTime() - 1000) });
    await seedLineItem(c2.courseId, { deleteRequestedAt: past, deleteNextAttemptAt: past });
    await seedLineItem(c3.courseId, { deleteRequestedAt: past, deleteNextAttemptAt: future }); // backing off
    await seedLineItem(c4.courseId, { deleteRequestedAt: null, deleteNextAttemptAt: null }); // no request

    const due = await claimDueLineItemDeletions(db, 50);

    expect(due.map((r) => r.courseId)).toEqual([c1.courseId, c2.courseId]);
  });

  it('markLineItemDeletionRetry bumps the count and schedules the next attempt', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date() });
    const next = new Date(Date.now() + 300_000);

    await markLineItemDeletionRetry(db, courseId, 1, next, 'ags:rate-limited', new Date());

    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteAttemptCount).toBe(1);
    expect(row.deleteLastError).toBe('ags:rate-limited');
    expect(new Date(row.deleteNextAttemptAt!).getTime()).toBe(next.getTime());
    expect(row.deleteRequestedAt).not.toBeNull();
  });

  it('markLineItemDeletionFailed keeps the request but nulls the schedule', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date(), deleteAttemptCount: 6 });

    await markLineItemDeletionFailed(db, courseId, 'ags:server-error', new Date());

    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBe('ags:server-error');
  });

  it('rearmLineItemDeletion reschedules a terminally-failed request only', async () => {
    const stuck = await seedInstitutionAndCourse(db, platform);
    const healthy = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(stuck.courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: null, deleteAttemptCount: 6, deleteLastError: 'ags:server-error' });
    await seedLineItem(healthy.courseId, { deleteRequestedAt: new Date(), deleteNextAttemptAt: new Date() });

    expect(await rearmLineItemDeletion(db, stuck.courseId, new Date())).toBe(true);
    expect(await rearmLineItemDeletion(db, healthy.courseId, new Date())).toBe(false); // still scheduled, not stuck

    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, stuck.courseId));
    expect(row.deleteAttemptCount).toBe(0);
    expect(row.deleteNextAttemptAt).not.toBeNull();
  });

  it('deleteGradeLineItemRow removes the course row', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await seedLineItem(courseId);
    await deleteGradeLineItemRow(db, courseId);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
  });

  it('deleteCourseGradeSyncJobs removes every job for the course and returns the count', async () => {
    const a = await seedInstitutionAndCourse(db, platform);
    const b = await seedInstitutionAndCourse(db, platform);
    await db.insert(gradeSyncJobs).values([
      { courseId: a.courseId, ltiUserId: 'u1', score: 10, state: 'pending' },
      { courseId: a.courseId, ltiUserId: 'u2', score: 20, state: 'synced' },
      { courseId: b.courseId, ltiUserId: 'u1', score: 30, state: 'pending' },
    ]);

    const removed = await deleteCourseGradeSyncJobs(db, a.courseId);

    expect(removed).toBe(2);
    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, a.courseId))).toHaveLength(0);
    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, b.courseId))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- server/tests/attendance/line-item-deletion.test.ts`
Expected: FAIL — module `line-item-deletion-store.js` not found / `deleteCourseGradeSyncJobs` not exported.

- [ ] **Step 3: Add `deleteCourseGradeSyncJobs` to `grade-sync-store.ts`**

In `server/src/attendance/grade-sync-store.ts`, after `resetFailedJobs` (ends ~line 185), add:

```ts
/**
 * Hard-delete every grade-sync job for a course. Called inside the soft-delete transaction when a
 * course loses its last closed session (spec §25.11): the cumulative line item is going away, so
 * no score may post to it. Returns the number of rows removed.
 */
export async function deleteCourseGradeSyncJobs(executor: Database | Tx, courseId: string): Promise<number> {
  const removed = await executor
    .delete(gradeSyncJobs)
    .where(eq(gradeSyncJobs.courseId, courseId))
    .returning({ id: gradeSyncJobs.id });
  return removed.length;
}
```

(`Tx` is already imported at the top of the file; `eq` and `gradeSyncJobs` too.)

- [ ] **Step 4: Create `line-item-deletion-store.ts`**

Create `server/src/attendance/line-item-deletion-store.ts`:

```ts
// server/src/attendance/line-item-deletion-store.ts
//
// All DB access for the grade_line_items.delete_* lifecycle (spec §25.11, §27.1):
//   request  -> softDeleteAttendanceSession, when a soft-delete removes the last closed session
//   cancel   -> closeAttendanceSession / restoreAttendanceSession, when closed sessions remain
//   claim    -> processLineItemDeletions (worker), drains due requests against Canvas
//   retry / fail -> processLineItemDeletions, on a failed AGS DELETE
//   re-arm   -> POST /api/attendance-sessions/:id/grade-sync, after a terminal failure
//   delete-row -> processLineItemDeletions, after a successful (or 404) AGS DELETE
//
// State on the single grade_line_items row per course:
//   delete_requested_at NOT NULL                      => removal wanted
//   + delete_next_attempt_at NOT NULL, <= now()       => due for the worker
//   + delete_next_attempt_at NOT NULL, in the future  => backing off
//   + delete_next_attempt_at NULL                     => terminal failure, awaiting a manual re-arm
//   delete_requested_at NULL (or no row)              => nothing to do

import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { Tx } from './session-lifecycle.js';
import { gradeLineItems, type GradeLineItemRow } from '../database/schema.js';

type DeletionExecutor = Database | Tx;

export async function requestLineItemDeletion(
  executor: DeletionExecutor,
  courseId: string,
  actorLtiUserId: string,
  now: Date,
): Promise<{ requested: boolean; canvasLineItemId: string | null }> {
  const updated = await executor
    .update(gradeLineItems)
    .set({
      deleteRequestedAt: now,
      deleteRequestedByLtiUserId: actorLtiUserId,
      deleteAttemptCount: 0,
      deleteNextAttemptAt: now,
      deleteLastError: null,
      updatedAt: now,
    })
    .where(eq(gradeLineItems.courseId, courseId))
    .returning({ canvasLineItemId: gradeLineItems.canvasLineItemId });
  return { requested: updated.length > 0, canvasLineItemId: updated[0]?.canvasLineItemId ?? null };
}

export async function cancelLineItemDeletion(executor: DeletionExecutor, courseId: string): Promise<boolean> {
  const updated = await executor
    .update(gradeLineItems)
    .set({
      deleteRequestedAt: null,
      deleteRequestedByLtiUserId: null,
      deleteAttemptCount: 0,
      deleteNextAttemptAt: null,
      deleteLastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(gradeLineItems.courseId, courseId), isNotNull(gradeLineItems.deleteRequestedAt)))
    .returning({ id: gradeLineItems.id });
  return updated.length > 0;
}

export function claimDueLineItemDeletions(db: Database, limit: number): Promise<GradeLineItemRow[]> {
  return db
    .select()
    .from(gradeLineItems)
    .where(
      and(
        isNotNull(gradeLineItems.deleteRequestedAt),
        isNotNull(gradeLineItems.deleteNextAttemptAt),
        lte(gradeLineItems.deleteNextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(gradeLineItems.deleteNextAttemptAt))
    .limit(limit);
}

export async function markLineItemDeletionRetry(
  db: Database,
  courseId: string,
  attemptCount: number,
  nextAttemptAt: Date,
  lastError: string,
  now: Date,
): Promise<void> {
  await db
    .update(gradeLineItems)
    .set({ deleteAttemptCount: attemptCount, deleteNextAttemptAt: nextAttemptAt, deleteLastError: lastError, updatedAt: now })
    .where(eq(gradeLineItems.courseId, courseId));
}

export async function markLineItemDeletionFailed(
  db: Database,
  courseId: string,
  lastError: string,
  now: Date,
): Promise<void> {
  await db
    .update(gradeLineItems)
    .set({ deleteNextAttemptAt: null, deleteLastError: lastError, updatedAt: now })
    .where(eq(gradeLineItems.courseId, courseId));
}

export async function rearmLineItemDeletion(db: Database, courseId: string, now: Date): Promise<boolean> {
  const updated = await db
    .update(gradeLineItems)
    .set({ deleteAttemptCount: 0, deleteNextAttemptAt: now, deleteLastError: null, updatedAt: now })
    .where(
      and(
        eq(gradeLineItems.courseId, courseId),
        isNotNull(gradeLineItems.deleteRequestedAt),
        isNull(gradeLineItems.deleteNextAttemptAt),
      ),
    )
    .returning({ id: gradeLineItems.id });
  return updated.length > 0;
}

export async function deleteGradeLineItemRow(executor: DeletionExecutor, courseId: string): Promise<void> {
  await executor.delete(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- server/tests/attendance/line-item-deletion.test.ts`
Expected: PASS (all `line-item-deletion-store` cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/attendance/line-item-deletion-store.ts server/src/attendance/grade-sync-store.ts server/tests/attendance/line-item-deletion.test.ts
git commit -m "$(cat <<'EOF'
feat(phase7): line-item-deletion-store + deleteCourseGradeSyncJobs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 4: Advisory lock + request/cancel in `session-lifecycle.ts`

**Files:**
- Modify: `server/src/attendance/session-lifecycle.ts` (imports; `closeAttendanceSession` ~148-212; `softDeleteAttendanceSession` ~247-301; `restoreAttendanceSession` ~303-343)
- Test: `server/tests/attendance/session-lifecycle.test.ts` (add cases to the existing `softDeleteAttendanceSession / restoreAttendanceSession` describe, ~line 362)

**Interfaces:**
- Consumes: `requestLineItemDeletion`, `cancelLineItemDeletion` (`./line-item-deletion-store.js`); `deleteCourseGradeSyncJobs` (`./grade-sync-store.js`); `sql` (`drizzle-orm`); `recomputeCourseGrades` returning `{ jobCount, closedSessionCount, eligibleMemberCount }` (unchanged).
- Produces: `softDeleteAttendanceSession` return shape is UNCHANGED (`{ gradeRecompute, jobCount, lastClosedSessionRemoved }`). New audit rows: `grade_line_item_delete_requested` (from `softDelete`), `grade_line_item_delete_canceled` (from `close` and `restore`). Behavioural contract: after any `close`/`softDelete`/`restore` transaction commits, `pg_advisory_xact_lock(hashtext(courseId)::bigint)` was held for its duration.

- [ ] **Step 1: Write the failing tests**

In `server/tests/attendance/session-lifecycle.test.ts`, add these imports to the existing schema import line (it currently imports from `'../../src/database/schema.js'`):

```ts
import { attendanceSessions, attendanceSessionMembers, attendanceRecords, auditEvents, gradeSyncJobs, gradeLineItems, courseMembers } from '../../src/database/schema.js';
```

Add inside the `describe('softDeleteAttendanceSession / restoreAttendanceSession', ...)` block:

```ts
  // Helper: give the course a persisted cumulative line item, as the grade worker would have.
  async function seedCourseLineItem(courseId: string) {
    await db.insert(gradeLineItems).values({
      courseId,
      canvasLineItemId: 'li-1',
      canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/li-1',
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
    });
  }

  it('last-closed soft-delete: purges grade_sync_jobs, flags the line item for deletion, audits grade_line_item_delete_requested', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const members = [member({ ltiUserId: 'u1', institutionalId: '111' })];
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members, fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseMembers(courseId, members);
    await seedCourseLineItem(courseId);

    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await db.insert(attendanceRecords).values({ attendanceSessionId: s.id, ltiUserId: 'u1', institutionalId: '111', clientScanId: 'a1', status: 'present', source: 'card', scannedAt: new Date() });
    await closeAttendanceSession(db, s.id, 'i1', 'rc');
    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId))).toHaveLength(1);

    const result = await softDeleteAttendanceSession(db, s.id, 'instructor-7', 'req-del');

    expect(result).toEqual({ gradeRecompute: true, jobCount: 0, lastClosedSessionRemoved: true });
    expect(await db.select().from(gradeSyncJobs).where(eq(gradeSyncJobs.courseId, courseId))).toHaveLength(0);
    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li.deleteRequestedAt).not.toBeNull();
    expect(li.deleteRequestedByLtiUserId).toBe('instructor-7');
    expect(li.deleteNextAttemptAt).not.toBeNull();
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_requested'));
    expect(audit).toMatchObject({ actorLtiUserId: 'instructor-7', targetType: 'grade_line_item', targetId: courseId, requestId: 'req-del' });
    expect(audit.newValue).toMatchObject({ canvasLineItemId: 'li-1' });
  });

  it('last-closed soft-delete with NO grade_line_items row: purges jobs, writes no deletion request or audit', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, s.id, 'i1', 'rc');

    const result = await softDeleteAttendanceSession(db, s.id, 'i1', 'req-del');

    expect(result.lastClosedSessionRemoved).toBe(true);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_requested'))).toHaveLength(0);
  });

  it('restoring the last closed session cancels a pending deletion and audits grade_line_item_delete_canceled', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseLineItem(courseId);
    const s = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, s.id, 'i1', 'rc');
    await softDeleteAttendanceSession(db, s.id, 'i1', 'req-del');

    await restoreAttendanceSession(db, s.id, 'instructor-8', 'req-restore');

    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li.deleteRequestedAt).toBeNull();
    expect(li.deleteNextAttemptAt).toBeNull();
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_canceled'));
    expect(audit).toMatchObject({ actorLtiUserId: 'instructor-8', targetType: 'grade_line_item', targetId: courseId });
  });

  it('closing a fresh session in the course cancels a pending deletion', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseLineItem(courseId);
    const s1 = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, s1.id, 'i1', 'rc1');
    await softDeleteAttendanceSession(db, s1.id, 'i1', 'req-del');

    const s2 = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, s2.id, 'i1', 'rc2');

    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li.deleteRequestedAt).toBeNull();
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_canceled'))).toHaveLength(1);
  });

  it('two concurrent soft-deletes of two closed sessions in one course serialize without deadlock', async () => {
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    vi.mocked(getRosterWithFallback).mockResolvedValue({ members: [], fetchedAt: new Date().toISOString(), stale: false, refreshed: true });
    await seedCourseLineItem(courseId);
    const a = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, a.id, 'i1', 'rca');
    const b = await createAttendanceSession(db, courseId, 'i1', {}, 'r', { signingKey });
    await closeAttendanceSession(db, b.id, 'i1', 'rcb');

    const [ra, rb] = await Promise.all([
      softDeleteAttendanceSession(db, a.id, 'i1', 'req-a'),
      softDeleteAttendanceSession(db, b.id, 'i1', 'req-b'),
    ]);

    // Exactly one of the two sees the course drop to zero closed sessions.
    expect([ra.lastClosedSessionRemoved, rb.lastClosedSessionRemoved].filter(Boolean)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts`
Expected: FAIL — `grade_line_item_delete_requested` audit rows are not written; `gradeSyncJobs` for the course still present after a last-closed delete.

- [ ] **Step 3: Update imports in `session-lifecycle.ts`**

At the top of `server/src/attendance/session-lifecycle.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
```

and after the existing `import { recomputeCourseGrades } from './grade-recompute.js';` line:

```ts
import { deleteCourseGradeSyncJobs } from './grade-sync-store.js';
import { requestLineItemDeletion, cancelLineItemDeletion } from './line-item-deletion-store.js';
```

- [ ] **Step 4: Add the advisory lock to all three transactions**

In each of `closeAttendanceSession`, `softDeleteAttendanceSession`, and `restoreAttendanceSession`: place this line **after every guard clause that throws** (`if (!session) ...`, `SessionDeletedError` / `SessionAlreadyClosedError` in close; `SessionAlreadyDeletedError` in softDelete; `SessionNotDeletedError` in restore) and **immediately before the `const [course] = await tx.select().from(courses)...` load**:

```ts
    // Serialize every per-course grade mutation (close / soft-delete / restore) so the
    // course-wide grade_sync_jobs writes below cannot interleave and deadlock (reviewer
    // finding). Auto-released at transaction end.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session.courseId})::bigint)`);
```

- [ ] **Step 5: Request the deletion in `softDeleteAttendanceSession`**

In `softDeleteAttendanceSession`, the block that currently reads:

```ts
    let gradeRecompute = false;
    let jobCount = 0;
    let closedSessionCount = 0;
    if (session.state === 'closed') {
      gradeRecompute = true;
      const recompute = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
      jobCount = recompute.jobCount;
      closedSessionCount = recompute.closedSessionCount;
    }
    // IMP-3 (interim): a closed-session delete that leaves the course with zero live closed
    // sessions has a zero-denominator recompute (spec §27.2) — grade_sync_jobs rows and any
    // scores already written to Canvas are left in place. Surface it so the client can warn.
    const lastClosedSessionRemoved = gradeRecompute && closedSessionCount === 0;
```

becomes:

```ts
    let gradeRecompute = false;
    let jobCount = 0;
    let closedSessionCount = 0;
    if (session.state === 'closed') {
      gradeRecompute = true;
      const recompute = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
      jobCount = recompute.jobCount;
      closedSessionCount = recompute.closedSessionCount;
    }
    // IMP-3 (spec §25.11): a closed-session delete that leaves the course with zero live closed
    // sessions has a zero-denominator recompute (spec §27.2). Purge the course's grade_sync_jobs
    // (nothing may post to a line item that is going away) and flag the cumulative line item for
    // durable removal by the worker. Both are local writes — no Canvas call here (spec §28).
    const lastClosedSessionRemoved = gradeRecompute && closedSessionCount === 0;
    let lineItemDeleteRequested = false;
    if (lastClosedSessionRemoved) {
      await deleteCourseGradeSyncJobs(tx, session.courseId);
      const { requested, canvasLineItemId } = await requestLineItemDeletion(tx, session.courseId, actorLtiUserId, now);
      lineItemDeleteRequested = requested;
      if (requested) {
        await tx.insert(auditEvents).values({
          institutionId: course.institutionId,
          courseId: session.courseId,
          attendanceSessionId: sessionId,
          actorLtiUserId,
          eventType: 'grade_line_item_delete_requested',
          targetType: 'grade_line_item',
          targetId: session.courseId,
          newValue: { canvasLineItemId },
          requestId: requestId ?? null,
        });
      }
    }
```

Then in the existing `attendance_session_deleted` audit `newValue` object, add one field so the audit trail records what happened:

```ts
      newValue: {
        deletedAt: now.toISOString(),
        deletedByLtiUserId: actorLtiUserId,
        gradeRecompute,
        jobCount,
        closedSessionCount,
        lastClosedSessionRemoved,
        lineItemDeleteRequested,
      },
```

The `return { gradeRecompute, jobCount, lastClosedSessionRemoved };` line is unchanged.

- [ ] **Step 6: Cancel a pending deletion in `closeAttendanceSession` and `restoreAttendanceSession`**

In `closeAttendanceSession`, the recompute call is currently:

```ts
    await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
```

Replace with:

```ts
    const recompute = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
    // The course now has at least one live closed session, so any pending durable removal of its
    // cumulative line item is stale — cancel it. The recompute's fresh grade_sync_jobs + the
    // worker's idempotent ensureLineItem rebuild the column on the normal path (spec §27.1).
    if (recompute.closedSessionCount > 0 && (await cancelLineItemDeletion(tx, session.courseId))) {
      await tx.insert(auditEvents).values({
        institutionId: course.institutionId,
        courseId: session.courseId,
        attendanceSessionId: sessionId,
        actorLtiUserId,
        eventType: 'grade_line_item_delete_canceled',
        targetType: 'grade_line_item',
        targetId: session.courseId,
        newValue: { trigger: 'close' },
        requestId: requestId ?? null,
      });
    }
```

In `restoreAttendanceSession`, the block is currently:

```ts
    let gradeRecompute = false;
    let jobCount = 0;
    if (session.state === 'closed') {
      gradeRecompute = true;
      ({ jobCount } = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId));
    }
```

Replace with:

```ts
    let gradeRecompute = false;
    let jobCount = 0;
    if (session.state === 'closed') {
      gradeRecompute = true;
      const recompute = await recomputeCourseGrades(tx, db, session.courseId, sessionId, actorLtiUserId, requestId);
      jobCount = recompute.jobCount;
      // A restored closed session means the course has closed sessions again — cancel any pending
      // durable removal of its cumulative line item (spec §25.11). No eager AGS call: the recompute
      // above enqueued fresh grade_sync_jobs and the worker's ensureLineItem is idempotent.
      if (recompute.closedSessionCount > 0 && (await cancelLineItemDeletion(tx, session.courseId))) {
        await tx.insert(auditEvents).values({
          institutionId: course.institutionId,
          courseId: session.courseId,
          attendanceSessionId: sessionId,
          actorLtiUserId,
          eventType: 'grade_line_item_delete_canceled',
          targetType: 'grade_line_item',
          targetId: session.courseId,
          newValue: { trigger: 'restore' },
          requestId: requestId ?? null,
        });
      }
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- server/tests/attendance/session-lifecycle.test.ts`
Expected: PASS — all new cases plus the untouched existing ones (the interim `lastClosedSessionRemoved` cases still pass; their `audit.newValue` `toMatchObject` assertions are unaffected by the added `lineItemDeleteRequested` field).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/attendance/session-lifecycle.ts server/tests/attendance/session-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(phase7): request/cancel durable line-item removal in session lifecycle + per-course advisory lock

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 5: `processLineItemDeletions` worker pass + `worker.ts` wiring

**Files:**
- Create: `server/src/attendance/ags-course-context.ts`
- Modify: `server/src/attendance/grade-worker.ts` (remove the local `CourseAgsContext` + `loadCourseAgsContext`, import them instead — lines ~55-92)
- Create: `server/src/attendance/line-item-deletion.ts`
- Modify: `server/src/worker.ts` (run the new pass before `processGradeSyncJobs`, ~line 46-52)
- Test: `server/tests/attendance/line-item-deletion.test.ts` (add a `describe('processLineItemDeletions', ...)` block); `server/tests/attendance/grade-worker.test.ts` (unchanged — must stay green after the extraction)

**Interfaces:**
- Consumes: `deleteLineItem` (`../lti/ags.js`); `getAccessToken`, `clearAccessTokenCache` (`../lti/token-client.js`); `AGS_LINEITEM_SCOPE` (`../lti/scopes.js`); `computeBackoff`, `MAX_GRADE_SYNC_ATTEMPTS` (`./grade-sync-store.js`); `claimDueLineItemDeletions`, `markLineItemDeletionRetry`, `markLineItemDeletionFailed`, `deleteGradeLineItemRow` (`./line-item-deletion-store.js`); `cancelLineItemDeletion` re-check via a direct select; `ToolSigningKey` (`../lti/signing-keys.js`); `auditEvents`, `gradeLineItems` (`../database/schema.js`).
- Produces:
  ```ts
  // ags-course-context.ts
  export interface CourseAgsContext {
    courseId: string;
    institutionId: string;
    agsLineitemsUrl: string | null;
    registration: { id: string; clientId: string; tokenEndpoint: string; tokenAudience: string };
  }
  export function loadCourseAgsContext(db: Database, courseId: string): Promise<CourseAgsContext | null>;

  // line-item-deletion.ts
  export interface ProcessLineItemDeletionsDeps {
    signingKey: ToolSigningKey;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    rand?: () => number;
    maxRows?: number;
    shouldStop?: () => boolean;
  }
  export interface ProcessLineItemDeletionsResult {
    processed: number; deleted: number; retried: number; failed: number;
  }
  export function processLineItemDeletions(
    db: Database, deps: ProcessLineItemDeletionsDeps,
  ): Promise<ProcessLineItemDeletionsResult>;
  ```

- [ ] **Step 1: Extract `loadCourseAgsContext` into a shared module**

Create `server/src/attendance/ags-course-context.ts`:

```ts
// server/src/attendance/ags-course-context.ts
//
// Shared by both worker passes (grade-worker.ts posts scores; line-item-deletion.ts DELETEs the
// line item). Resolves a course to its institution + the LTI registration needed to mint an AGS
// client-credentials token.

import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { courses, institutions, ltiDeployments, ltiRegistrations } from '../database/schema.js';

export interface CourseAgsContext {
  courseId: string;
  institutionId: string;
  agsLineitemsUrl: string | null;
  registration: { id: string; clientId: string; tokenEndpoint: string; tokenAudience: string };
}

export async function loadCourseAgsContext(db: Database, courseId: string): Promise<CourseAgsContext | null> {
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
```

In `server/src/attendance/grade-worker.ts`: delete the local `interface CourseAgsContext { ... }` and the `async function loadCourseAgsContext(...) { ... }` (lines ~55-92), and add near the other imports:

```ts
import { loadCourseAgsContext, type CourseAgsContext } from './ags-course-context.js';
```

Remove `courses`, `institutions`, `ltiDeployments`, `ltiRegistrations` from the `../database/schema.js` import if they are now unused there (keep `auditEvents`, `gradeLineItems`, `type GradeSyncJobRow`). Keep the `eq` import (still used elsewhere in the file).

- [ ] **Step 2: Verify the extraction is behaviour-neutral**

Run: `npm test -- server/tests/attendance/grade-worker.test.ts`
Expected: PASS (unchanged behaviour).

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit the extraction**

```bash
git add server/src/attendance/ags-course-context.ts server/src/attendance/grade-worker.ts
git commit -m "$(cat <<'EOF'
refactor(phase7): extract loadCourseAgsContext into ags-course-context.ts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

- [ ] **Step 4: Write the failing worker-pass tests**

Add to `server/tests/attendance/line-item-deletion.test.ts` (extend the existing imports first):

```ts
import { getActiveSigningKey, loadSigningKeysFromEnv, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { auditEvents } from '../../src/database/schema.js';
import { processLineItemDeletions } from '../../src/attendance/line-item-deletion.js';
```

Change the top-level `const platform = new MockCanvasPlatform();` and `afterAll` setup to start the platform (the worker pass makes real HTTP calls to the mock):

```ts
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
```

(Add `beforeAll` to the `vitest` import.)

Then append:

```ts
describe('processLineItemDeletions', () => {
  let agsKey = 0;
  // Seed a course whose AGS URL points at an isolated mock course key, plus a persisted line item
  // with a real mock line-item URL, already flagged as a due deletion request.
  async function seedDueDeletion(over: Partial<typeof gradeLineItems.$inferInsert> = {}) {
    const key = `lid-${agsKey++}`;
    const { courseId } = await seedInstitutionAndCourse(db, platform, { agsLineitemsUrl: platform.lineItemsUrlFor(key) });
    const canvasLineItemUrl = platform.seedExistingLineItem(key);
    const canvasLineItemId = canvasLineItemUrl.split('/').pop()!;
    await db.insert(gradeLineItems).values({
      courseId,
      canvasLineItemId,
      canvasLineItemUrl,
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
      deleteRequestedAt: new Date(Date.now() - 60_000),
      deleteRequestedByLtiUserId: 'i1',
      deleteNextAttemptAt: new Date(Date.now() - 60_000),
      ...over,
    });
    return { courseId, key, canvasLineItemId };
  }

  it('DELETEs the Canvas line item, removes the grade_line_items row, audits grade_line_item_deleted', async () => {
    const { courseId, key, canvasLineItemId } = await seedDueDeletion();

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ processed: 1, deleted: 1, retried: 0, failed: 0 });
    expect(platform.getLineItems(key)).toHaveLength(0);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'));
    expect(audit).toMatchObject({ targetType: 'grade_line_item', targetId: courseId, actorLtiUserId: null });
    expect(audit.newValue).toMatchObject({ canvasLineItemId, canvas404: false });
  });

  it('treats a Canvas 404 as success (row removed, canvas404 true)', async () => {
    const { courseId } = await seedDueDeletion();
    // Repoint at a well-formed line-item URL on the live mock that was never created -> DELETE 404.
    const mockBase = platform.lineItemsUrlFor('x').replace(/\/ags\/x\/lineitems$/, '');
    await db
      .update(gradeLineItems)
      .set({ canvasLineItemUrl: `${mockBase}/ags/lineitems/never-created`, canvasLineItemId: 'never-created' })
      .where(eq(gradeLineItems.courseId, courseId));

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ processed: 1, deleted: 1, failed: 0 });
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(0);
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'));
    expect(audit.newValue).toMatchObject({ canvas404: true });
  });

  it('a 429 schedules a retry: attempt+1, future delete_next_attempt_at, row kept, no failure audit', async () => {
    const { courseId } = await seedDueDeletion();
    const now = new Date('2026-09-01T00:00:00.000Z');
    platform.failNextAgsRequest('rate-limited');

    const result = await processLineItemDeletions(db, { signingKey, now: () => now, rand: () => 0.5 });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 1, failed: 0 });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteAttemptCount).toBe(1);
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(new Date(row.deleteNextAttemptAt!).getTime()).toBeGreaterThan(now.getTime());
    expect(row.deleteLastError).toBe('ags:rate-limited');
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_failed'))).toHaveLength(0);
  });

  it('at the attempt ceiling a retryable failure is terminal: delete_next_attempt_at NULL + grade_line_item_delete_failed', async () => {
    const { courseId } = await seedDueDeletion({ deleteAttemptCount: 5 }); // MAX_GRADE_SYNC_ATTEMPTS - 1
    platform.failNextAgsRequest('server-error');

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 0, failed: 1 });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteRequestedAt).not.toBeNull();
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBe('ags:server-error');
    const [audit] = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_delete_failed'));
    expect(audit.newValue).toMatchObject({ attemptCount: 6, error: 'ags:server-error' });
  });

  it('a permanent 4xx is terminal on the first attempt', async () => {
    const { courseId } = await seedDueDeletion();
    platform.failNextAgsRequest('client-error');

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result).toMatchObject({ deleted: 0, retried: 0, failed: 1 });
    const [row] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(row.deleteNextAttemptAt).toBeNull();
    expect(row.deleteLastError).toBe('ags:client-error');
  });

  it('a 401 is re-minted once and then succeeds', async () => {
    const { courseId, key } = await seedDueDeletion();
    platform.failNextAgsRequest('auth'); // one-shot 401

    const result = await processLineItemDeletions(db, { signingKey });

    expect(result.deleted).toBe(1);
    expect(platform.getLineItems(key)).toHaveLength(0);
    void courseId;
  });

  it('if the request is cleared between the AGS call and the finalize, the row is kept and not counted', async () => {
    const { courseId, key } = await seedDueDeletion();
    // fetchImpl clears the deletion request right after the DELETE resolves, simulating a
    // concurrent close/restore winning the race.
    const realFetch = fetch;
    const raceFetch: typeof fetch = async (input, init) => {
      const res = await realFetch(input as string, init);
      if ((init?.method ?? 'GET') === 'DELETE') {
        await db.update(gradeLineItems)
          .set({ deleteRequestedAt: null, deleteRequestedByLtiUserId: null, deleteAttemptCount: 0, deleteNextAttemptAt: null, deleteLastError: null })
          .where(eq(gradeLineItems.courseId, courseId));
      }
      return res;
    };

    const result = await processLineItemDeletions(db, { signingKey, fetchImpl: raceFetch });

    expect(result).toMatchObject({ processed: 1, deleted: 0, retried: 0, failed: 0 });
    // Canvas line item was deleted, but the local row survives because the request was cleared.
    expect(platform.getLineItems(key)).toHaveLength(0);
    expect(await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId))).toHaveLength(1);
    expect(await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'grade_line_item_deleted'))).toHaveLength(0);
  });

  it('stops between rows when shouldStop() flips', async () => {
    await seedDueDeletion();
    await seedDueDeletion();
    let calls = 0;
    const result = await processLineItemDeletions(db, {
      signingKey,
      shouldStop: () => calls++ >= 1, // false for the first row, true before the second
    });
    expect(result.processed).toBe(1);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -- server/tests/attendance/line-item-deletion.test.ts`
Expected: FAIL — module `line-item-deletion.js` not found.

- [ ] **Step 6: Implement `processLineItemDeletions`**

Create `server/src/attendance/line-item-deletion.ts`:

```ts
// server/src/attendance/line-item-deletion.ts
//
// The worker's line-item-deletion pass (spec §25.11, §27.1, §28). Drains due grade_line_items
// deletion requests: for each course, mint ONE AGS token (lineitem scope only), DELETE the
// cumulative line item, and on success remove the local grade_line_items row under a re-checked
// per-course advisory lock. Retryable failures (429 / 5xx / network / 401) back off with jitter up
// to MAX_GRADE_SYNC_ATTEMPTS, then terminally fail; permanent 4xx fails immediately. Every terminal
// outcome writes an audit row. Canvas 404 = the line item is already gone = success.
//
// Invoked by server/src/worker.ts BEFORE processGradeSyncJobs so a course marked for removal loses
// its column before any stray score post. NOT wired into the Fastify web process.

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { auditEvents, gradeLineItems } from '../database/schema.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import { AGS_LINEITEM_SCOPE } from '../lti/scopes.js';
import { getAccessToken, clearAccessTokenCache } from '../lti/token-client.js';
import { deleteLineItem } from '../lti/ags.js';
import { loadCourseAgsContext } from './ags-course-context.js';
import { computeBackoff, MAX_GRADE_SYNC_ATTEMPTS } from './grade-sync-store.js';
import {
  claimDueLineItemDeletions,
  markLineItemDeletionRetry,
  markLineItemDeletionFailed,
} from './line-item-deletion-store.js';

export interface ProcessLineItemDeletionsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  rand?: () => number;
  maxRows?: number;
  shouldStop?: () => boolean;
}

export interface ProcessLineItemDeletionsResult {
  processed: number;
  deleted: number;
  retried: number;
  failed: number;
}

export async function processLineItemDeletions(
  db: Database,
  deps: ProcessLineItemDeletionsDeps,
): Promise<ProcessLineItemDeletionsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const rand = deps.rand ?? Math.random;
  const result: ProcessLineItemDeletionsResult = { processed: 0, deleted: 0, retried: 0, failed: 0 };

  const due = await claimDueLineItemDeletions(db, deps.maxRows ?? 50);

  for (const row of due) {
    if (deps.shouldStop?.()) break;
    result.processed += 1;
    const courseId = row.courseId;
    const ctx = await loadCourseAgsContext(db, courseId);

    // No registration => cannot mint a token. Treat as retryable (config/replication lag).
    if (!ctx) {
      await scheduleRetryOrFail(db, row, 'ags:no-context', now, rand, result, null);
      continue;
    }

    const registration = {
      id: ctx.registration.id,
      clientId: ctx.registration.clientId,
      tokenEndpoint: ctx.registration.tokenEndpoint,
      tokenAudience: ctx.registration.tokenAudience,
    };
    const scopes = [AGS_LINEITEM_SCOPE];
    const mintToken = () => getAccessToken(registration, scopes, { signingKey: deps.signingKey, fetchImpl });

    let token: string;
    try {
      token = await mintToken();
    } catch {
      await scheduleRetryOrFail(db, row, 'ags:token', now, rand, result, ctx.institutionId);
      continue;
    }

    let authRetried = false;
    const remintOnce = async (): Promise<boolean> => {
      if (authRetried) return false;
      authRetried = true;
      clearAccessTokenCache(registration.id, scopes);
      try {
        token = await mintToken();
        return true;
      } catch {
        return false;
      }
    };

    let del = await deleteLineItem(row.canvasLineItemUrl, token, { fetchImpl });
    if (!del.ok && del.error.kind === 'auth' && (await remintOnce())) {
      del = await deleteLineItem(row.canvasLineItemUrl, token, { fetchImpl });
    }

    if (del.ok) {
      // Finalize under a per-course advisory lock and re-check the request: a concurrent
      // close/restore may have cancelled it (and enqueued fresh work) while the DELETE was
      // in flight. If so, leave the row — do not undo the cancel.
      const finalized = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${courseId})::bigint)`);
        const [current] = await tx.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
        if (!current || current.deleteRequestedAt === null) return false;
        await tx.delete(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
        await tx.insert(auditEvents).values({
          institutionId: ctx.institutionId,
          courseId,
          attendanceSessionId: null,
          actorLtiUserId: null,
          eventType: 'grade_line_item_deleted',
          targetType: 'grade_line_item',
          targetId: courseId,
          newValue: { canvasLineItemId: row.canvasLineItemId, canvas404: del.value },
          requestId: null,
        });
        return true;
      });
      if (finalized) result.deleted += 1;
      continue;
    }

    if (del.error.retryable) {
      await scheduleRetryOrFail(db, row, del.error.message, now, rand, result, ctx.institutionId);
    } else {
      await markLineItemDeletionFailed(db, courseId, del.error.message, now);
      await writeFailedAudit(db, ctx.institutionId, courseId, row.deleteAttemptCount + 1, del.error.message);
      result.failed += 1;
    }
  }

  return result;
}

async function scheduleRetryOrFail(
  db: Database,
  row: { courseId: string; deleteAttemptCount: number },
  errorCode: string,
  now: Date,
  rand: () => number,
  result: ProcessLineItemDeletionsResult,
  institutionId: string | null,
): Promise<void> {
  const attemptCount = row.deleteAttemptCount + 1;
  if (attemptCount >= MAX_GRADE_SYNC_ATTEMPTS) {
    await markLineItemDeletionFailed(db, row.courseId, errorCode, now);
    if (institutionId) await writeFailedAudit(db, institutionId, row.courseId, attemptCount, errorCode);
    result.failed += 1;
  } else {
    // computeBackoff gets the PRE-increment count, matching grade-worker.ts.
    await markLineItemDeletionRetry(db, row.courseId, attemptCount, computeBackoff(row.deleteAttemptCount, now, rand), errorCode, now);
    result.retried += 1;
  }
}

async function writeFailedAudit(
  db: Database,
  institutionId: string,
  courseId: string,
  attemptCount: number,
  error: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    institutionId,
    courseId,
    attendanceSessionId: null,
    actorLtiUserId: null,
    eventType: 'grade_line_item_delete_failed',
    targetType: 'grade_line_item',
    targetId: courseId,
    newValue: { attemptCount, error },
    requestId: null,
  });
}
```

(`deleteLineItem` returns `AgsResult<boolean>` from Task 2, where `value === true` means Canvas reported the line item already absent — so `canvas404: del.value` is accurate here with no extra work.)

- [ ] **Step 7: Wire the pass into `worker.ts`**

In `server/src/worker.ts`, add the import next to the others:

```ts
import { processLineItemDeletions } from './attendance/line-item-deletion.js';
```

and change the try block so the new pass runs before `processGradeSyncJobs`:

```ts
try {
  const maintenance = await runMaintenancePass(db, { retentionDays: env.RETENTION_DAYS, shouldStop });
  const signingKey = getActiveSigningKey(await loadSigningKeys(db, env.LTI_TOOL_SIGNING_KEYS_JSON));
  const lineItemDeletions = await processLineItemDeletions(db, { signingKey, shouldStop });
  const grade = await processGradeSyncJobs(db, { signingKey, shouldStop });
  const gauges = await countGradeJobsByState(db);
  setGradeJobGauges(gauges.pending, gauges.failed);
  // Tally only — no member ids, scores, tokens, or URLs (spec §31.8).
  console.log(`[worker] ${JSON.stringify({ maintenance, lineItemDeletions, grade })}`);
} catch (err) {
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- server/tests/attendance/line-item-deletion.test.ts server/tests/attendance/grade-worker.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src/attendance/line-item-deletion.ts server/src/worker.ts server/tests/attendance/line-item-deletion.test.ts
git commit -m "$(cat <<'EOF'
feat(phase7): processLineItemDeletions worker pass — durable AGS line-item DELETE

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 6: Manual re-arm in `POST /api/attendance-sessions/:id/grade-sync`

**Files:**
- Modify: `server/src/routes/attendance-sessions.ts` (imports ~line 20; the `grade-sync` handler ~339-359)
- Test: `server/tests/routes/attendance-sessions.test.ts` (the `grade-sync` describe, ~406-435)

**Interfaces:**
- Consumes: `rearmLineItemDeletion` (`../attendance/line-item-deletion-store.js`).
- Produces: `POST /api/attendance-sessions/:id/grade-sync` response becomes `{ ok: true, retried: number, deletionRearmed: boolean }`; the `grade_sync_requested` audit `newValue` gains `deletionRearmed`.

- [ ] **Step 1: Update the failing route tests**

In `server/tests/routes/attendance-sessions.test.ts`, the existing case `POST :id/grade-sync re-queues the course's failed jobs and audits grade_sync_requested` currently asserts `expect(res.json()).toEqual({ ok: true, retried: 1 });`. Change that line to:

```ts
    expect(res.json()).toEqual({ ok: true, retried: 1, deletionRearmed: false });
```

and add after it:

```ts
    expect(audit.newValue).toMatchObject({ retriedJobCount: 1, trigger: 'manual', deletionRearmed: false });
```

Add a new case in the same describe:

```ts
  it('POST :id/grade-sync re-arms a terminally-failed line-item deletion for the course', async () => {
    const { institutionId, courseId } = await seedInstitutionAndCourse(db, platform);
    const app = buildTestApp({ resolver: { resolveCard: vi.fn() }, session: makeSession({ institutionId, courseId }) });
    const [session] = await db.insert(attendanceSessions).values({ courseId, startedByLtiUserId: 'i1', state: 'closed' }).returning();
    await db.insert(gradeLineItems).values({
      courseId,
      canvasLineItemId: 'li-1',
      canvasLineItemUrl: 'https://canvas.example.edu/api/lti/courses/1/line_items/li-1',
      resourceId: 'attendance-cumulative-v1',
      tag: 'attendance',
      scoreMaximum: 100,
      deleteRequestedAt: new Date(),
      deleteNextAttemptAt: null, // terminal failure
      deleteAttemptCount: 6,
      deleteLastError: 'ags:server-error',
    });

    const res = await app.inject({ method: 'POST', url: `/api/attendance-sessions/${session.id}/grade-sync`, headers: CSRF });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, retried: 0, deletionRearmed: true });
    const [li] = await db.select().from(gradeLineItems).where(eq(gradeLineItems.courseId, courseId));
    expect(li.deleteNextAttemptAt).not.toBeNull();
    expect(li.deleteAttemptCount).toBe(0);
  });
```

Add `gradeLineItems` to this test file's `../../src/database/schema.js` import if not present.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- server/tests/routes/attendance-sessions.test.ts`
Expected: FAIL — response is `{ ok: true, retried: 1 }` (missing `deletionRearmed`).

- [ ] **Step 3: Implement the re-arm**

In `server/src/routes/attendance-sessions.ts`, extend the import on line ~20:

```ts
import { getGradeSyncSummary, resetFailedJobs } from '../attendance/grade-sync-store.js';
import { rearmLineItemDeletion } from '../attendance/line-item-deletion-store.js';
```

In the `grade-sync` handler, replace:

```ts
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
```

with:

```ts
    const now = new Date();
    const retried = await resetFailedJobs(db, row.courseId, now);
    const deletionRearmed = await rearmLineItemDeletion(db, row.courseId, now);
    const [course] = await db.select().from(courses).where(eq(courses.id, row.courseId));
    await db.insert(auditEvents).values({
      institutionId: course.institutionId,
      courseId: row.courseId,
      attendanceSessionId: id,
      actorLtiUserId: session.ltiSubject,
      eventType: 'grade_sync_requested',
      targetType: 'attendance_session',
      targetId: id,
      newValue: { retriedJobCount: retried, trigger: 'manual', deletionRearmed },
      requestId: request.id,
    });
    return { ok: true, retried, deletionRearmed };
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- server/tests/routes/attendance-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/attendance-sessions.ts server/tests/routes/attendance-sessions.test.ts
git commit -m "$(cat <<'EOF'
feat(phase7): grade-sync route re-arms a terminally-failed line-item deletion

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 7: Frontend copy + spec updates

**Files:**
- Modify: `web/session-history.js` (~line 156, the `lastClosedSessionRemoved` warning)
- Modify: `web/attendance-session.js` (~lines 181-205, the `deleteSession` JSDoc)
- Modify: `docs/canvas-lti/spec.md` (§25.11 ~line 1282-1302; §27.1 ~line 1550-1570; §33 ~line 1936-1953)
- Test: `web/tests/attendance-session.test.js` (unchanged — return shape is stable; run to confirm)

**Interfaces:**
- Consumes: nothing new.
- Produces: no code-signature changes. Documentation + user-facing copy only.

- [ ] **Step 1: Reword the panel warning**

In `web/session-history.js`, the block:

```js
            if (result.ok && result.lastClosedSessionRemoved) {
              deps.showMessage(
                'warning',
                'That was the last closed session in this course. Attendance scores already sent to Canvas are not removed automatically.',
              );
            }
```

becomes:

```js
            if (result.ok && result.lastClosedSessionRemoved) {
              deps.showMessage(
                'warning',
                'That was the last closed session in this course. The Canvas attendance column will be removed automatically.',
              );
            }
```

- [ ] **Step 2: Update the `deleteSession` JSDoc**

In `web/attendance-session.js`, the comment above `deleteSession` (~lines 181-185) currently says:

```js
 * A successful DELETE is `200 { ok: true, lastClosedSessionRemoved }`; an unparseable
 * body degrades to `lastClosedSessionRemoved: false`.
 *
 * @returns {Promise<{ok: true, lastClosedSessionRemoved: boolean}|{ok: false, error: {kind: string, message: string}}>}
```

Change the prose to:

```js
 * A successful DELETE is `200 { ok: true, lastClosedSessionRemoved }`; an unparseable
 * body degrades to `lastClosedSessionRemoved: false`. When `lastClosedSessionRemoved`
 * is true the server has scheduled durable removal of the course's Canvas attendance
 * line item (handled by the grade-sync worker); the caller only needs to inform the user.
 *
 * @returns {Promise<{ok: true, lastClosedSessionRemoved: boolean}|{ok: false, error: {kind: string, message: string}}>}
```

- [ ] **Step 3: Run the web tests**

Run: `npm test -- web/tests/attendance-session.test.js web/tests/session-history.test.js`
Expected: PASS (no assertion targets the old warning string; `deleteSession` return shape is unchanged).

- [ ] **Step 4: Update spec §25.11**

In `docs/canvas-lti/spec.md`, replace the sentences from “It responds `200 { ok: true, lastClosedSessionRemoved }`.” through “is a tracked follow-up.” with:

```text
It responds `200 { ok: true, lastClosedSessionRemoved }`. When the deleted session
was the course's **last** closed session there is nothing left to recompute from:
the course's `grade_sync_jobs` are purged and the cumulative Canvas line item is
flagged for durable removal on `grade_line_items` (`delete_requested_at` +
`delete_next_attempt_at`). The grade-sync worker's line-item-deletion pass then
issues the AGS `DELETE` (a Canvas `404` counts as already removed), drops the
`grade_line_items` row, and audits `grade_line_item_deleted`. `lastClosedSessionRemoved`
is `true` so the client can tell the instructor the column is being removed. A later
close or restore in the course cancels a still-pending removal
(`grade_line_item_delete_canceled`); the next recompute recreates the line item
idempotently via `ensureLineItem` (spec §27.1). `POST /grade-sync` re-arms a removal
that hit its retry ceiling.
```

- [ ] **Step 5: Update spec §27.1**

After the “This operation MUST be idempotent.” line in §27.1, add:

```text

### Removing the line item

When a course loses its last non-deleted closed session, the tool durably removes
the cumulative line item rather than leaving a stale Gradebook column. The request
is recorded on `grade_line_items` (`delete_requested_at`, `delete_requested_by_lti_user_id`,
`delete_attempt_count`, `delete_next_attempt_at`, `delete_last_error`) inside the
soft-delete transaction — never as a synchronous Canvas call (spec §28). A worker
pass issues the AGS `DELETE`; a Canvas `404` is treated as success. Retryable
failures (429 / 5xx / network / 401) back off with jitter to the shared attempt
ceiling, then terminally fail (`delete_next_attempt_at` NULL) pending a manual
re-arm. A close or restore before the worker runs cancels the request. Recreation
on the next close/restore goes through the same idempotent `ensureLineItem` path.
```

- [ ] **Step 6: Update spec §33**

In the audit `event_type` list, after `grade_sync_completed`, add:

```text
grade_line_item_delete_requested
grade_line_item_deleted
grade_line_item_delete_failed
grade_line_item_delete_canceled
```

- [ ] **Step 7: Commit**

```bash
git add web/session-history.js web/attendance-session.js docs/canvas-lti/spec.md
git commit -m "$(cat <<'EOF'
docs(phase7): durable line-item removal — spec §25.11/§27.1/§33 + panel copy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Ensure Postgres is up**

Run: `docker compose up -d postgres`
Expected: container `canvas-lti-phase0` postgres running on port 5432.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS, no errors.

- [ ] **Step 4: Unit/integration tests**

Run: `npm test`
Expected: PASS. If `server/tests/support/mock-canvas-nrps.test.ts` reports a parallel-load failure, re-run it alone: `npm test -- server/tests/support/mock-canvas-nrps.test.ts` and treat a clean solo run as green (known flaky).

- [ ] **Step 5: E2E**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 6: Confirm the migration is registered**

Run: `git status --porcelain server/migrations/`
Expected: clean (the `0007_*.sql` and `meta/` changes were committed in Task 1).

- [ ] **Step 7: Final review commit (only if the gate surfaced fixes)**

If Steps 2-5 required changes, commit them:

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(phase7): green gate for durable line-item removal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
EOF
)"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-09-01-durable-line-item-removal-design.md`):

| Spec section | Task(s) |
|---|---|
| §4 data model — `delete_*` columns + migration | Task 1 |
| §5 `deleteLineItem` (404 = success, classify like postScore) | Task 2 |
| §6.1 per-course advisory lock in close/softDelete/restore | Task 4 Step 4 |
| §6.2 request deletion + purge jobs on last-closed soft-delete | Task 4 Step 5 |
| §6.3 cancel on close/restore when closed sessions remain | Task 4 Step 6 |
| §7 `processLineItemDeletions` + `worker.ts` wiring | Task 5 |
| §7 `loadCourseAgsContext` shared | Task 5 Step 1 |
| §8 manual re-arm via grade-sync route | Task 6 |
| §9 audit event types + spec §25.11/§27.1/§33 | Task 4 (audit emit) + Task 7 (spec text) |
| §10 interim field kept, panel reworded | Task 7 Steps 1-2 |
| §12 test plan | Tasks 2, 3, 4, 5, 6 tests; Task 8 gate |
| §13 out of scope (getCachedRoster ORDER BY, wider row locks, reopen) | Not implemented — intentionally deferred |

No gaps.

**Placeholder scan:** `deleteLineItem` is defined once, in Task 2, as `AgsResult<boolean>` (`value === true` ⇔ Canvas 404 / already gone); Task 5's worker code consumes `del.value` directly for the audit's `canvas404` field. No `TODO`/`TBD`/"handle edge cases"/"similar to Task N" left; every code step shows complete code.

**Type consistency:**
- `requestLineItemDeletion` / `cancelLineItemDeletion` / `claimDueLineItemDeletions` / `markLineItemDeletionRetry` / `markLineItemDeletionFailed` / `rearmLineItemDeletion` / `deleteGradeLineItemRow` — names identical across Task 3 (defs), Task 4, Task 5, Task 6.
- `deleteCourseGradeSyncJobs(executor, courseId)` — Task 3 def, Task 4 use. Consistent.
- `processLineItemDeletions(db, deps)` returning `{ processed, deleted, retried, failed }` — Task 5 def + tests, Task 5 Step 8 worker use. Consistent.
- `CourseAgsContext` / `loadCourseAgsContext` — Task 5 Step 1 def, re-imported in `grade-worker.ts` same step. Consistent.
- Column accessors `deleteRequestedAt`, `deleteRequestedByLtiUserId`, `deleteAttemptCount`, `deleteNextAttemptAt`, `deleteLastError` — Task 1 schema, used verbatim in Tasks 3-6.
- `softDeleteAttendanceSession` return `{ gradeRecompute, jobCount, lastClosedSessionRemoved }` — unchanged (Task 4 Step 5 explicitly keeps the `return` line).
- Audit `event_type` strings — the four `grade_line_item_*` values match between Task 4 (emit), Task 5 (emit), Task 7 (spec list).
