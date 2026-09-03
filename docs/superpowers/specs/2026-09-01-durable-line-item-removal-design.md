# Durable removal of the Canvas AGS attendance line item ("full IMP-3")

**Branch:** `canvas-lti-phase7` (off `ef0ae16`). Part of the unmerged Canvas LTI phase
stack — never merged to `main`.

**Follows:** the interim shipped in `ef0ae16` (Task 10): `softDeleteAttendanceSession`
returns `lastClosedSessionRemoved`, `DELETE /api/attendance-sessions/:id` returns
`200 { ok: true, lastClosedSessionRemoved }`, the "Past sessions" panel warns, and
spec §25.11 records durable removal as a tracked follow-up.

---

## 1. Problem

`recomputeCourseGrades` (`server/src/attendance/grade-recompute.ts`) produces an empty
score map when zero non-deleted closed sessions remain (spec §27.2: zero denominator →
no score submitted). So when a soft-delete removes a course's **last** closed session:

- the existing `grade_sync_jobs` rows for the course are left untouched, and
- the attendance grades already written to Canvas stay in the Gradebook column with no
  attendance data behind them.

The interim only surfaces this to the instructor as a warning. This work makes the
cleanup happen: **delete the whole Canvas AGS line item** (remove the Gradebook column)
and purge the course's local `grade_sync_jobs`. A later close or restore recreates the
line item idempotently via `ensureLineItem` (spec §27.1).

## 2. Constraints

- **Durable, not synchronous.** The AGS DELETE must not be an HTTP call inside the
  soft-delete transaction (spec §28 — attendance mutations must not depend on Canvas
  writes succeeding in one request). It is driven through the same outbox/worker model
  the score posts use.
- Node ESM (`.js` import suffixes even from `.ts`).
- Opaque coded errors with `requestId`; never a raw Canvas body (spec §31.9).
- Every lifecycle change audited in the same transaction that makes it.
- Course-scoped tenancy; cross-course lookups 404 (unchanged — the routes already do
  this).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e` all pass. Test DB:
  `docker compose up -d postgres` (compose project `canvas-lti-phase0`, port 5432);
  Vitest global setup auto-applies new migrations. Re-run
  `server/tests/support/mock-canvas-nrps.test.ts` before trusting a parallel-load
  failure (known flaky).

## 3. Decisions (resolved during brainstorming)

| Question | Decision |
|---|---|
| Durable representation of "deletion requested" | **Nullable columns on `grade_line_items`** (already one row per course, already holds `canvas_line_item_url`). A new worker pass scans them. No new table, no `grade_sync_jobs` `kind` discriminator. |
| Cancelling pending `grade_sync_jobs` once deletion is requested | Hard `DELETE` of the course's `grade_sync_jobs` rows inside the soft-delete transaction (pure local write). |
| `restoreAttendanceSession` with a pending deletion | Cancel the request; do **not** eagerly recreate the line item — the existing recompute → worker pass rebuilds it idempotently. |
| Failure/retry semantics for the AGS DELETE | Mirror `postScore`: Canvas 404 treated as already-gone success; same 401 re-mint-once pattern; retryable 429/5xx/network with exponential backoff + jitter to `MAX_GRADE_SYNC_ATTEMPTS`, then terminal; permanent non-404 4xx terminal immediately. |
| Audit event type | New `grade_line_item_delete_requested` / `grade_line_item_deleted` / `grade_line_item_delete_failed` / `grade_line_item_delete_canceled`; spec §33 updated. |
| Reviewer's concurrency findings | Fold in **only** the per-course advisory lock (`pg_advisory_xact_lock(hashtext(courseId)::bigint)`) in `close` / `softDelete` / `restore`, because this feature adds a course-wide `grade_sync_jobs` DELETE to that path. `getCachedRoster` ORDER BY and widening the recompute txns' row-lock scope stay a separate task. |
| Fate of the interim `lastClosedSessionRemoved` field + panel warning | **Keep the field name and response shape**; reword the client warning to say the Canvas column is removed automatically. |

## 4. Data model — migration `0007`

Five columns added to **`grade_line_items`** (Drizzle `server/src/database/schema.ts`
plus a generated SQL migration in `server/migrations/`):

| column | type | meaning |
|---|---|---|
| `delete_requested_at` | `timestamptz` NULL | non-null ⇒ this course's Canvas line item is to be removed |
| `delete_requested_by_lti_user_id` | `text` NULL | actor from the triggering soft-delete |
| `delete_attempt_count` | `integer NOT NULL DEFAULT 0` | AGS DELETE attempts so far |
| `delete_next_attempt_at` | `timestamptz` NULL | worker due-time; **NULL ⇒ not scheduled** (no request pending, or terminal failure reached) |
| `delete_last_error` | `text` NULL | opaque coded error (spec §31.9) |

Worker pickup predicate:

```
delete_requested_at    IS NOT NULL
AND delete_next_attempt_at IS NOT NULL
AND delete_next_attempt_at <= now()
```

State encoding:

- **request pending, due:** `delete_requested_at` set, `delete_next_attempt_at <= now()`
- **request pending, backing off:** `delete_requested_at` set, `delete_next_attempt_at` in the future
- **terminal failure:** `delete_requested_at` set, `delete_next_attempt_at` NULL, `delete_last_error` set
- **no request / done:** `delete_requested_at` NULL (or the whole row is gone)

`GradeLineItemRow` type picks up the new columns automatically.

## 5. `server/src/lti/ags.ts` — `deleteLineItem`

```ts
export async function deleteLineItem(
  lineItemUrl: string,
  accessToken: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<AgsResult<void>>
```

- `validateCanvasServiceUrl(lineItemUrl)` first — invalid ⇒
  `{ ok: false, error: { kind: 'invalid-service-url', ..., retryable: false } }` (same
  as `postScore`).
- `fetchImpl(lineItemUrl, { method: 'DELETE', headers: { Authorization: 'Bearer …' }, redirect: 'manual' })`.
- **`response.status === 404` ⇒ `{ ok: true, value: undefined }`** — the line item is
  already gone; the durable-removal goal is met. (Checked before `classifyResponse`.)
- Otherwise reuse `classifyResponse`: 2xx/204 → ok; 401 → `auth` (retryable, caller
  re-mints once); 429 / 5xx / network → retryable; any other 4xx → `client-error`
  `retryable: false`.
- No same-origin re-check — mirrors `postScore`, which trusts the persisted
  `canvas_line_item_url` (it passed `assertSameOrigin` when the worker persisted it).

## 6. `server/src/attendance/session-lifecycle.ts`

### 6.1 Per-course advisory lock

As the **first** statement inside the `db.transaction` callback of
`closeAttendanceSession`, `softDeleteAttendanceSession`, and
`restoreAttendanceSession`:

```ts
await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${courseId})::bigint)`);
```

`courseId` for `close` / `softDelete` / `restore` is `session.courseId` — so the lock is
taken right after the `SELECT … FOR UPDATE` that loads the session. Serializes every
per-course grade mutation (close, soft-delete, restore) against each other; auto-released
at transaction end. `reopenAttendanceSession` is out of scope (it does not recompute
today).

Rationale: this feature adds a course-wide `DELETE FROM grade_sync_jobs WHERE course_id`
that runs concurrently with `upsertGradeSyncJobs` (a `close` on the same course from
another request), which iterates an unordered `Map` — a deadlock class the reviewer
flagged. The advisory lock removes it without the broader row-lock audit.

### 6.2 `softDeleteAttendanceSession` — request the deletion

The existing condition is unchanged: `gradeRecompute` (session was `closed`) and the
recompute returned `closedSessionCount === 0`. That is exactly today's
`lastClosedSessionRemoved`. When it holds, inside the same transaction and after the
existing `recomputeCourseGrades` call:

1. `DELETE FROM grade_sync_jobs WHERE course_id = <courseId>` — remove all
   pending / synced / failed rows so nothing can post to a line item that is going away.
   Pure local write; no Canvas dependency (spec §28).
2. Load the course's `grade_line_items` row (`SELECT … FOR UPDATE` — the advisory lock
   already serializes, this is belt-and-suspenders and cheap).
   - **Row exists:** `UPDATE grade_line_items SET delete_requested_at = now(),
     delete_requested_by_lti_user_id = <actor>, delete_attempt_count = 0,
     delete_next_attempt_at = now(), delete_last_error = NULL WHERE course_id = …`.
     Audit `grade_line_item_delete_requested` with `target_type: 'grade_line_item'`,
     `target_id: <courseId>`, `new_value: { canvasLineItemId }`.
   - **No row:** the worker never created a Canvas line item, so there is nothing durable
     to delete — step 1 only, no request, no audit.

The `lastClosedSessionRemoved` return value and the `attendance_session_deleted` audit
`new_value` payload are **unchanged**.

### 6.3 `closeAttendanceSession` and `restoreAttendanceSession` — cancel a pending deletion

After `recomputeCourseGrades`, when it returned `closedSessionCount > 0` (the course now
has at least one live closed session, so the column must live):

```
UPDATE grade_line_items
   SET delete_requested_at = NULL, delete_requested_by_lti_user_id = NULL,
       delete_attempt_count = 0, delete_next_attempt_at = NULL, delete_last_error = NULL
 WHERE course_id = <courseId> AND delete_requested_at IS NOT NULL
```

If a row was updated, audit `grade_line_item_delete_canceled`. The recompute's fresh
`grade_sync_jobs` plus the worker's idempotent `ensureLineItem` rebuild the column on the
normal path — **no eager AGS call in the request.** If the worker already deleted the
`grade_line_items` row, this UPDATE matches nothing; the recompute still rebuilds via a
brand-new Canvas line item (spec §27.1 idempotency).

`restoreAttendanceSession` only reaches this branch when `session.state === 'closed'`
(its existing `gradeRecompute` guard), which is the only case that changes the
closed-session count.

## 7. New worker pass — `server/src/attendance/line-item-deletion.ts`

```ts
export interface ProcessLineItemDeletionsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  rand?: () => number;
  shouldStop?: () => boolean;
}
export interface ProcessLineItemDeletionsResult {
  processed: number; deleted: number; retried: number; failed: number;
}
export async function processLineItemDeletions(
  db: Database, deps: ProcessLineItemDeletionsDeps,
): Promise<ProcessLineItemDeletionsResult>
```

Structured like `processGradeSyncJobs`:

1. `SELECT` due `grade_line_items` rows (predicate in §4), oldest `delete_next_attempt_at`
   first, `limit` (default 50).
2. For each row, honoring `deps.shouldStop?.()` between rows:
   - `loadCourseAgsContext(db, courseId)` (reused from `grade-worker.ts` — export it or
     move it to a shared module) for the registration. Missing context or missing
     `agsLineitemsUrl` is not needed for a DELETE, but a missing registration ⇒ cannot
     mint ⇒ treat as a retryable `ags:token` failure (see backoff below).
   - Mint a token with `[AGS_LINEITEM_SCOPE]` only (not the score scope).
   - `deleteLineItem(row.canvasLineItemUrl, token, { fetchImpl })`. On an `auth` error,
     `clearAccessTokenCache(registration.id, [AGS_LINEITEM_SCOPE])` + re-mint **once**,
     retry (mirrors `grade-worker.ts` `remintOnce`).
   - **Success or 404:** open a short `db.transaction`:
     `select pg_advisory_xact_lock(hashtext(${courseId})::bigint)`, then re-read
     `delete_requested_at` for the row.
     - Still non-null ⇒ `DELETE FROM grade_line_items WHERE course_id = …` + audit
       `grade_line_item_deleted` (`target_type: 'grade_line_item'`, `target_id: courseId`,
       `new_value: { canvasLineItemId, canvas404: <bool> }`). `deleted += 1`.
     - Cleared (a concurrent `close` / `restore` won the race) ⇒ leave the row, log a
       tally-only line, move on. Not counted as `deleted` or `failed`.
   - **Retryable failure** (`auth` after the single re-mint, `rate-limited`,
     `server-error`, `network`, `ags:token`): `delete_attempt_count = prev + 1`. If
     `prev + 1 >= MAX_GRADE_SYNC_ATTEMPTS` → terminal (below). Else
     `delete_next_attempt_at = computeBackoff(prev, now, rand)`,
     `delete_last_error = <code>`; `retried += 1`. Reuses `computeBackoff` /
     `MAX_GRADE_SYNC_ATTEMPTS` from `grade-sync-store.ts`.
   - **Terminal** (ceiling reached, or `client-error` / `bad-json` / `invalid-service-url`
     — i.e. permanent non-404): `delete_next_attempt_at = NULL`, `delete_last_error =
     <code>`, keep `delete_requested_at`. Audit `grade_line_item_delete_failed`
     (`new_value: { attemptCount, error }`). `failed += 1`.
3. Return the tally.

### `server/src/worker.ts`

Run `processLineItemDeletions(db, { signingKey, shouldStop })` **before**
`processGradeSyncJobs` (so a course marked for deletion has its column gone before any
stray score post). Fold its tally into the `[worker] {…}` log line. Existing gauges
unchanged.

## 8. Manual-retry tie-in — `POST /api/attendance-sessions/:id/grade-sync`

The route (`server/src/routes/attendance-sessions.ts`) currently calls
`resetFailedJobs`. Add: re-arm a stuck deletion for the same course —

```
UPDATE grade_line_items
   SET delete_attempt_count = 0, delete_next_attempt_at = now()
 WHERE course_id = <courseId>
   AND delete_requested_at IS NOT NULL
   AND delete_next_attempt_at IS NULL
```

Return `{ ok: true, retried, deletionRearmed: <bool> }`. The existing
`grade_sync_requested` audit `new_value` gains `deletionRearmed`. Satisfies spec §28
"failures must be retryable". A small store helper (`rearmLineItemDeletion(db, courseId,
now)` in `grade-sync-store.ts` or a new `line-item-deletion-store.ts`) returns whether a
row was touched.

## 9. Audit + spec updates

- **New event types**, all `target_type: 'grade_line_item'`, `target_id: <courseId>`:
  `grade_line_item_delete_requested`, `grade_line_item_deleted`,
  `grade_line_item_delete_failed`, `grade_line_item_delete_canceled`. Added to the list
  in spec **§33**.
- **§25.11** reworded: a last-closed-session delete now *schedules durable removal of the
  whole Canvas attendance line item* through the outbox worker, purges the course's
  `grade_sync_jobs`, and a later close/restore cancels a still-pending removal so the next
  recompute rebuilds the column idempotently. Drop the "Automatically clearing the Canvas
  attendance line item in that case is a tracked follow-up" sentence.
- **§27 / §27.1** — add a short "Removing the line item" note: the `delete_*` columns on
  `grade_line_items`, the worker pass, Canvas 404 treated as success, idempotent
  recreation on the next close/restore.

## 10. Interim field + panel UX ("keep field, reword")

- **Server unchanged:** `softDeleteAttendanceSession` still returns
  `{ gradeRecompute, jobCount, lastClosedSessionRemoved }`; the route still responds
  `200 { ok: true, lastClosedSessionRemoved }`.
- **`web/session-history.js`** (`~line 156`) warning text →

  > "That was the last closed session in this course. The Canvas attendance column will
  > be removed automatically."

  (drops "Attendance scores already sent to Canvas are not removed automatically.")
- **`web/attendance-session.js`** JSDoc for `deleteSession` updated to describe the new
  meaning; return shape unchanged.

## 11. Component boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `ags.ts#deleteLineItem` | one authenticated `DELETE`, classify outcome, 404 = success | `validateCanvasServiceUrl`, `classifyResponse` |
| `session-lifecycle.ts` | advisory lock; on last-closed delete → purge jobs + set `delete_*`; on close/restore with live closed sessions → clear `delete_*`; audit all three | `recomputeCourseGrades`, schema |
| `line-item-deletion.ts#processLineItemDeletions` | drain due `grade_line_items` deletion rows: mint token, call `deleteLineItem`, backoff/terminal, delete row + audit on success under a re-checked advisory lock | `deleteLineItem`, `loadCourseAgsContext`, `computeBackoff`, token client |
| `worker.ts` | run the new pass before the score pass; log the tally | both passes |
| grade-sync route | re-arm a stuck deletion alongside `resetFailedJobs` | store helper |

## 12. Test plan

- **`server/tests/lti/ags.test.ts`** — `deleteLineItem`: 204 → ok; 404 → ok; 401 → `auth`
  retryable; 429 / 503 / network → retryable; 422 → permanent; invalid URL →
  `invalid-service-url`.
- **`server/tests/attendance/line-item-deletion.test.ts`** (new) — due-row selection
  respects the three-part predicate and ordering; success deletes the `grade_line_items`
  row + writes `grade_line_item_deleted`; Canvas 404 behaves identically; retryable
  failure bumps `delete_attempt_count` and sets a future `delete_next_attempt_at`;
  reaching `MAX_GRADE_SYNC_ATTEMPTS` sets `delete_next_attempt_at = NULL` +
  `grade_line_item_delete_failed`; permanent 4xx is terminal on the first attempt; `auth`
  re-mints exactly once; concurrent-clear guard — flag cleared between the AGS call and
  the finalize txn ⇒ row kept, not counted; `shouldStop()` halts between rows.
- **`server/tests/attendance/session-lifecycle.test.ts`** — extend the IMP-3 cases:
  last-closed soft-delete sets `delete_requested_at` + `delete_requested_by_lti_user_id`,
  purges `grade_sync_jobs`, writes `grade_line_item_delete_requested`; same when no
  `grade_line_items` row exists ⇒ jobs purged, no request, no audit; `restore` of that
  session clears `delete_*` + writes `grade_line_item_delete_canceled`; a fresh `close`
  in the same course also clears it; two concurrent `softDeleteAttendanceSession` calls on
  one course serialize (advisory-lock smoke — no deadlock, both complete).
- **`server/tests/routes/attendance-sessions.test.ts`** — DELETE response shape
  unchanged (`{ ok: true, lastClosedSessionRemoved }`); `grade-sync` route returns
  `deletionRearmed: true` when a stuck deletion exists and `false` otherwise; audit
  `new_value` records it.
- **`web/tests/session-history.test.js`** — asserts the reworded warning string.
- **`web/tests/attendance-session.test.js`** — unchanged behaviour (return shape stable);
  adjust any JSDoc-derived assertion if present.
- **Full gate:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`.
  Re-run `server/tests/support/mock-canvas-nrps.test.ts` on any parallel-load flake
  before treating it as real.

## 13. Out of scope

Filed as the reviewer's separate concurrency task:

- `getCachedRoster` has no `ORDER BY`.
- Recompute-triggering transactions only `.for('update')` the session row (not the
  broader working set).
- `reopenAttendanceSession` neither recomputes nor takes the advisory lock.

Only the per-course advisory lock in `close` / `softDelete` / `restore` is folded into
this task.

## 14. Rollout / sequencing

1. Migration `0007` + schema columns.
2. `deleteLineItem` in `ags.ts` + its tests.
3. Advisory lock + request/cancel logic in `session-lifecycle.ts` + tests.
4. `processLineItemDeletions` + `worker.ts` wiring + tests.
5. Grade-sync route re-arm + tests.
6. `web/` copy change + test.
7. Spec §25.11 / §27 / §33 updates.
8. Full gate; commit with the required trailers.
