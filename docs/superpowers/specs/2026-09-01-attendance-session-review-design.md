# Attendance session review, reopen, and soft delete — design

**Date:** 2026-09-01
**Branch context:** `canvas-lti-phase7` worktree (phases 0–7 live on unmerged worktree branches).
**Status:** approved for planning.

## Problem

Once an attendance session is closed there is no way to get back to it. The web UI
is a single scanning screen. `GET /api/attendance-sessions` returns only `open` /
`reopened` sessions (for page-reload resume), and the "Reopen attendance" button
appears only immediately after a close in the same page load. An instructor cannot:

- review who was present / absent / excused for a past class meeting;
- correct a past session (they can, mechanically, via reopen — but they cannot
  reach it);
- remove a session created by accident.

## Goals

1. List this course's attendance sessions, identified by the date/time they were
   first opened, reachable from the main screen.
2. Let an instructor reopen a closed session and correct it using the controls
   that already exist at the bottom of the screen.
3. Let an instructor soft-delete a session created by accident, and restore it
   later. Deletion must keep Canvas cumulative attendance grades correct.

## Non-goals

- Pagination of the session list. A course has at most ~50 meetings per term.
- A hard-delete or purge UI. Permanent deletion remains the concern of the
  existing retention / purge job (spec §34).
- Per-row present/absent/excused counts in the list. The existing session-detail
  view already shows per-member status once a session is reopened.
- New role checks. Every holder of an app session is already an authorized
  instructor/administrator for that course (`authorizeInstructorRole` at launch;
  `GET /api/me` returns `permissions.editAttendance = true`).
- Changing how corrections work. Editing is "reopen → correct → close", exactly
  as today.

## Approach

Make closed (and accidentally-created) sessions **reachable** from the main
screen, and add **soft delete / restore**. Reuse every existing mechanism for the
editing itself.

### 1. Data model

Drizzle migration `server/migrations/0006_*.sql` (next in sequence after
`0005_special_callisto`) adds two nullable columns to `attendance_sessions`:

```
deleted_at              timestamp with time zone   -- null = live
deleted_by_lti_user_id  text
```

- Soft delete sets both columns; restore sets both back to `null`.
- `state` is left untouched by delete/restore, so a restored session returns to
  whatever state it had (`open`, `closed`, or `reopened`).

Schema type exports (`AttendanceSessionRow`) pick the new columns up
automatically.

**Every query that enumerates sessions to drive behavior gains a
`deleted_at IS NULL` filter:**

- `GET /api/attendance-sessions` — the resume list in
  `routes/attendance-sessions.ts`.
- The "every CLOSED session in the course" query inside `closeAttendanceSession`
  (`attendance/session-lifecycle.ts`) that feeds the cumulative-grade recompute.

Fetch-by-id paths (`GET /api/attendance-sessions/:id`, `.../export.csv`) are **not**
filtered — a deleted session is still individually fetchable so the panel can
display and restore it.

### 2. Shared grade recompute

Extract the block at the end of `closeAttendanceSession` (spec §25.7 steps 3–4,
§28 steps 2–3) — "current roster → eligible LTI user IDs → every non-deleted
closed session in the course → resolve per-session statuses →
`computeCumulativeScores` → `upsertGradeSyncJobs` → audit `grade_sync_requested`"
— into one function:

```ts
// attendance/session-lifecycle.ts (or a new attendance/grade-recompute.ts)
async function recomputeCourseGrades(
  tx: Tx,
  db: Database,          // for getCachedRosterAsMembers, which is typed db: Database
  courseId: string,
  triggeringSessionId: string,
  actorLtiUserId: string,
  requestId: string | undefined,
): Promise<{ jobCount: number; closedSessionCount: number; eligibleMemberCount: number }>
```

`closeAttendanceSession`, the new delete handler, and the new restore handler all
call it. The "closed sessions in the course" query inside it filters
`deleted_at IS NULL` and continues to exclude `reopened` sessions (mid-correction,
unchanged).

### 3. API

All routes stay CSRF-gated for mutations, tenant-scoped to
`request.appSession.courseId`, and 404 (never 403) for a cross-course id, matching
the existing sibling routes in `routes/attendance-sessions.ts`.

#### `GET /api/attendance-sessions/history`

Read-only. Returns this course's sessions, newest-first by `openedAt`:

```json
{
  "sessions": [
    {
      "id": "...",
      "state": "closed",
      "label": null,
      "meetingAt": null,
      "openedAt": "2026-09-01T14:02:11.000Z",
      "closedAt": "2026-09-01T14:51:03.000Z",
      "startedByLtiUserId": "...",
      "deletedAt": null,
      "deletedByLtiUserId": null
    }
  ]
}
```

- Excludes soft-deleted rows by default.
- `?includeDeleted=1` includes them (with `deletedAt` / `deletedByLtiUserId`
  populated).
- Static path is registered alongside `/:id`; Fastify matches static segments
  before parameters, so `history` does not collide with `GET
  /api/attendance-sessions/:id`.
- The existing no-arg `GET /api/attendance-sessions` is unchanged (still
  `open` + `reopened` only, for resume).

#### `DELETE /api/attendance-sessions/:id`

Soft delete. In one transaction:

1. Row-lock the session (`.for('update')`), like close/reopen.
2. 404 if not found in the caller's course, or if `deletedAt` is already set.
3. Set `deleted_at = now()`, `deleted_by_lti_user_id = actor`.
4. Insert `audit_events` row: `eventType: 'attendance_session_deleted'`,
   `targetType: 'attendance_session'`, `oldValue: { deletedAt: null }`,
   `newValue: { deletedAt, deletedBy, gradeRecompute, jobCount }`.
5. **If the session's `state` is `closed`**, call `recomputeCourseGrades` — which
   now excludes this session — so the affected students' scores drop and re-sync
   (`gradeRecompute: true`). A `closed` session that had eligible members always
   holds `present` / `system_absence` records, so "state is closed" is the
   trigger; the recompute is idempotent, so there is no need to first count
   records. `open` / `reopened` sessions never contributed to a grade, so no
   recompute runs (`gradeRecompute: false`, `jobCount: 0`).

Returns `204`.

#### `POST /api/attendance-sessions/:id/restore`

Mirror of delete. In one transaction:

1. Row-lock.
2. 404 if not found in course, or if `deletedAt` is `null` (only a deleted
   session restores).
3. Set `deleted_at = null`, `deleted_by_lti_user_id = null`.
4. Insert `audit_events` row: `eventType: 'attendance_session_restored'`,
   `oldValue: { deletedAt }`, `newValue: { deletedAt: null, gradeRecompute,
   jobCount }`.
5. If the restored session's `state` is `closed`, call `recomputeCourseGrades` so
   it re-enters the cumulative totals.

Returns `{ ok: true }` (matches `close` / `reopen`).

#### Error codes

Reuse `replyForError` / `HTTP_FOR_CODE`. New coded errors:

- `session_not_found` → 404 (already mapped).
- `session_already_deleted` → 404 (do not leak; treat like not-found).
- `session_not_deleted` → 409 (restore on a live session).

### 4. Web client

#### New module: `web/session-history.js`

Owns the panel end to end so `app.js` and `ui.js` do not grow further:

- `renderHistoryPanel()` — fetch `GET /api/attendance-sessions/history` (with
  `includeDeleted` when the toggle is on), render one table row per session:
  opened date/time formatted in the course timezone, `label` / meeting date if
  present, a state badge (`open` / `closed` / `reopened` / `deleted`), started-by.
- Row actions, enabled per state and per "is a session active on screen":
  - **Resume** (`open` / `reopened`) — calls back into `app.js` to attach to it.
  - **Reopen** (`closed`) — `POST .../reopen`, then callback into `app.js` to load
    it as the active session.
  - **Delete** — inline confirm (`bindInlineConfirm`, "Click again to delete"),
    then `DELETE /api/attendance-sessions/:id`, then re-render.
  - **Restore** (deleted rows, behind the toggle) — `POST .../restore`, then
    re-render.
- `refresh()` — re-fetch and re-render (called after any action, and on a manual
  refresh button).

The module receives, from `app.js`, a small callback bundle:
`{ isSessionActive(): boolean, loadReopenedSession(sessionId): Promise<void> }`.
`loadReopenedSession` reuses the logic already in `resumeOpenSessionIfAny`
(fetch detail, populate the table, `renderSessionState`, show the manual-present
group) — factor that body into a reusable `attachToSession(sessionId, { announce })`
in `app.js`.

#### `web/attendance-session.js`

Add three thin client functions next to the existing ones:

- `listSessionHistory({ includeDeleted = false } = {})` → `{ ok, sessions }`.
- `deleteSession(id)` → `{ ok }` (204).
- `restoreSession(id)` → `{ ok }`.

All go through the shared `api-client` request helper (CSRF header, JSON error
mapping) like the current calls.

#### `web/index.html`

Add, near the Roster `<details>` panel:

```html
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
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Opened</th><th>Label</th><th>Status</th><th>Started by</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody id="session-history-table-body"></tbody>
      </table>
    </div>
    <p id="session-history-empty" class="muted" hidden>No attendance sessions yet.</p>
  </div>
</details>
```

Plus a row `<template>` mirroring the existing `attendance-row-template` pattern.

#### Active-session rule

While an `open` / `reopened` session is active on screen (`isSessionActive()`
true), the panel's Resume / Reopen / Delete buttons are disabled with a one-line
hint ("Close the current session first."). This keeps the client single-session:
there is never more than one session loaded into the table. A closed session that
was created by accident is deleted as a closed row — the instructor closes the
active one first, then deletes it from the panel.

#### Delete confirmation and reason

Inline confirm only (`bindInlineConfirm`), consistent with "Clear attendance". No
free-text reason prompt: spec §33 requires a recorded reason for attendance
*corrections*, not for session lifecycle events, which record actor + timestamp +
session identity. `reopen` keeps its existing optional reason prompt.

### 5. Audit

Two new `event_type` values written to `audit_events`:

- `attendance_session_deleted`
- `attendance_session_restored`

Each carries `actorLtiUserId`, `attendanceSessionId`, `courseId`,
`institutionId`, `oldValue` / `newValue` with the `deletedAt` transition, and
`gradeRecompute` (bool) + `jobCount` when a recompute ran. Both are added to the
spec §33 audit list in `docs/canvas-lti/spec.md`.

## Testing

### Server

- **`recomputeCourseGrades` extraction** — `closeAttendanceSession` behaviour is
  unchanged (existing lifecycle + grade-calc tests stay green).
- **Delete** — deleting a `closed` session recomputes and enqueues
  `grade_sync_jobs` for the affected students (scores drop); deleting an `open`
  or `reopened` session enqueues nothing; audit row written; double-delete → 404.
- **Restore** — restoring a `closed` session recomputes and re-enqueues;
  restoring a session that is not deleted → 409; audit row written.
- **`history` route** — newest-first; excludes deleted by default; includes them
  with `?includeDeleted=1`; cross-course id absent from results.
- **Exclusion filters** — the resume list (`GET /api/attendance-sessions`) omits
  a deleted session; `closeAttendanceSession`'s cross-session recompute omits a
  deleted session.
- **Cross-cutting** — CSRF required on `DELETE` and `restore`; cross-course id →
  404 on both.

### Web

- `web/tests/` for `session-history.js`: row rendering per state, the
  show-deleted toggle, the active-session disabling rule, and that each action
  calls the right client function and re-renders.

## Files touched

**Server**

- `server/src/database/schema.ts` — two columns on `attendanceSessions`.
- `server/migrations/0006_*.sql` + `meta/_journal.json` — generated migration.
- `server/src/attendance/session-lifecycle.ts` — extract
  `recomputeCourseGrades`; `deleted_at IS NULL` in the closed-sessions query;
  new `softDeleteAttendanceSession` / `restoreAttendanceSession` (or a new
  `attendance/session-delete.ts`).
- `server/src/routes/attendance-sessions.ts` — `GET .../history`,
  `DELETE /:id`, `POST /:id/restore`; new error codes.
- `server/tests/attendance/*`, `server/tests/...route...` — as above.

**Web**

- `web/session-history.js` — new.
- `web/attendance-session.js` — three client functions.
- `web/app.js` — factor `attachToSession`; wire the panel callbacks.
- `web/index.html` — the `<details>` panel + row template.
- `web/styles.css` — badge/action styling reuse (minimal).
- `web/tests/` — new test file.

**Docs**

- `docs/canvas-lti/spec.md` — §33 audit list gains the two event types; §25 note
  that a session may be soft-deleted / restored.
