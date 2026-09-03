# Task 22B — Canvas roster in the scanner UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the scanner is launched from Canvas, show which course it is attached to and its live Canvas roster count + list, fetched automatically with no CSV upload — satisfying spec §50 step 4 ("App displays course name and current roster count") and the Phase 4 exit criterion ("instructor launches from a course and sees the active Canvas learner roster without uploading a file"), which were met at the API level only and never wired into `web/`.

**Architecture:** The backend already exposes everything needed: `GET /api/me` returns the course/institution/user context, and `GET /api/course/roster` + `POST /api/course/roster/refresh` return a normalized `CourseRosterMember[]` (Phase 4, `server/src/routes/course-roster.ts`, integration-tested). This task is frontend-only: a new pure client module `web/course-roster.js` (fetch + index helpers, unit-tested like `web/api-client.js`), new markup in `web/index.html`, new render functions in `web/ui.js`, and wiring in `web/app.js` that runs the roster fetch right after `bootstrapSession()` in `init()`. The existing CSV-upload roster panel stays as a manual fallback.

**Tech Stack:** Vanilla ES modules (no framework/build), Vitest with `global.fetch = vi.fn()` for unit tests, Playwright for the end-to-end instructor flow (`e2e/instructor-flow.spec.ts`, which already stands up a mock Canvas with a seeded NRPS roster).

## Global Constraints

- No new runtime dependencies; `web/` stays framework-free, build-free, vanilla ES modules.
- Untrusted strings (names, institutional IDs, any API field) are written with `textContent`, never `innerHTML` (`web/ui.js` header comment).
- Every client mutation goes through `apiFetch` from `web/api-client.js` so it carries `x-csrf-token`; GETs pass straight through.
- Client modules never throw across their public API — they return `{ ok: true, ... }` / `{ ok: false, error: { kind, message } }` (see `web/attendance-session.js`).
- `ui.js` functions take plain data and only touch the DOM; they never call `fetch` or decide business logic.
- Green bar at every commit: `npm test`, `npm run lint`, `npm run typecheck` all clean. Known-flaky `server/tests/support/mock-canvas-nrps.test.ts` under parallel load — re-run once before treating a failure as real.
- Commit-message trailers, exactly:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ
  ```
- No student names / institutional IDs / card codes in committed files or test fixtures beyond the synthetic values the e2e harness already uses ("E2E Test Learner").

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `web/course-roster.js` (new) | Pure client module: `fetchCourseRoster()`, `refreshCourseRoster()`, `buildMemberIndex()`, `countEligible()`. No DOM. | 1 |
| `web/tests/course-roster.test.js` (new) | Unit tests for the above, `fetch` mocked. | 1 |
| `web/index.html` (modify) | Add the course-context strip in the header and a "Canvas Roster" panel; relabel the CSV section as a fallback. | 2 |
| `web/ui.js` (modify) | Element refs + `renderCourseContext()`, `renderCanvasRoster()`, `renderCanvasRosterError()`, `setRosterCountText()`. | 2 |
| `web/app.js` (modify) | After `bootstrapSession()`, render the context and call `loadCanvasRoster()`; wire the Refresh button; keep `canvasRosterState`. | 2 |
| `web/absentees.js` (modify) | `computeAbsentRowsFromMembers()` — absent rows synthesized from the Canvas roster (carry `displayName`). | 3 |
| `web/tests/absentees.test.js` (new) | Unit tests for both absent-row functions. | 3 |
| `e2e/instructor-flow.spec.ts` (modify) | Assert the course name, roster count, and roster list render after launch. | 4 |
| `e2e/support/seed-launch.ts` (modify, only if needed) | Ensure the seeded launch context carries a title/label to assert against. | 4 |
| `docs/canvas-lti/progress.md` (modify) | Record Task 22B under the Phase 7 section. | 4 |

---

## Task 1: `web/course-roster.js` — pure roster client + index helpers

**Files:**
- Create: `web/course-roster.js`
- Test: `web/tests/course-roster.test.js`

**Interfaces:**
- Consumes: `apiFetch` from `web/api-client.js`; `normalizeId` from `web/roster.js` (`normalizeId(id)` → trimmed, leading-zero-preserving string key).
- Produces:
  - `fetchCourseRoster(): Promise<RosterResult>` — `GET /api/course/roster`.
  - `refreshCourseRoster(): Promise<RosterResult>` — `POST /api/course/roster/refresh` (bodyless; `apiFetch` attaches CSRF).
  - `buildMemberIndex(members: CanvasRosterMember[]): Map<string, CanvasRosterMember>` — keyed by `normalizeId(institutionalId)`, eligible members only, members with no `institutionalId` skipped.
  - `countEligible(members: CanvasRosterMember[]): number`.
  - Types (JSDoc): `CanvasRosterMember = { ltiUserId: string, institutionalId: string|null, displayName: string|null, givenName: string|null, familyName: string|null, email: string|null, roles: string[], status: string, eligibleForAttendance: boolean }` (mirrors `serializeMember` in `server/src/routes/course-roster.ts`).
  - `RosterResult = { ok: true, members: CanvasRosterMember[], fetchedAt: string, stale: boolean } | { ok: false, error: { kind: 'network'|'http-status'|'bad-json', message: string, status?: number } }`.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/course-roster.test.js`:

```js
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { fetchCourseRoster, refreshCourseRoster, buildMemberIndex, countEligible } from '../course-roster.js';
import { bootstrapSession } from '../api-client.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

const MEMBER = {
  ltiUserId: 'u-1',
  institutionalId: '0041234',
  displayName: 'Test Learner',
  givenName: 'Test',
  familyName: 'Learner',
  email: null,
  roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
  status: 'Active',
  eligibleForAttendance: true,
};

describe('fetchCourseRoster', () => {
  it('GETs /api/course/roster and returns the normalized member list', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ members: [MEMBER], fetchedAt: '2026-08-31T19:00:00.000Z', stale: false }),
    });

    const result = await fetchCourseRoster();

    expect(global.fetch).toHaveBeenCalledWith('/api/course/roster', expect.objectContaining({ method: 'GET' }));
    expect(result).toEqual({ ok: true, members: [MEMBER], fetchedAt: '2026-08-31T19:00:00.000Z', stale: false });
  });

  it('returns a normalized error (never throws) on a 502 roster_refresh_failed, carrying the status', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'roster_refresh_failed', requestId: 'r-1' }),
    });

    const result = await fetchCourseRoster();

    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('http-status');
    expect(result.error.status).toBe(502);
  });

  it('returns a network error result when fetch rejects', async () => {
    global.fetch.mockRejectedValueOnce(new Error('offline'));
    const result = await fetchCourseRoster();
    expect(result).toEqual({ ok: false, error: { kind: 'network', message: expect.stringContaining('offline') } });
  });
});

describe('refreshCourseRoster', () => {
  it('POSTs /api/course/roster/refresh with the CSRF token and no body', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ csrfToken: 'tok-9' }) });
    await bootstrapSession();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ members: [], fetchedAt: '2026-08-31T19:05:00.000Z', stale: false }),
    });

    const result = await refreshCourseRoster();

    const [url, init] = global.fetch.mock.calls.at(-1);
    expect(url).toBe('/api/course/roster/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers['x-csrf-token']).toBe('tok-9');
    expect(init.body).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

describe('buildMemberIndex', () => {
  it('keys eligible members by normalized institutional ID and skips members with no ID', () => {
    const noId = { ...MEMBER, ltiUserId: 'u-2', institutionalId: null };
    const ineligible = { ...MEMBER, ltiUserId: 'u-3', institutionalId: '9', eligibleForAttendance: false };
    const index = buildMemberIndex([MEMBER, noId, ineligible]);
    expect([...index.keys()]).toEqual(['0041234']);
    expect(index.get('0041234').ltiUserId).toBe('u-1');
  });
});

describe('countEligible', () => {
  it('counts only members eligible for attendance', () => {
    expect(countEligible([MEMBER, { ...MEMBER, eligibleForAttendance: false }])).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/tests/course-roster.test.js`
Expected: FAIL — `Failed to resolve import "../course-roster.js"`.

- [ ] **Step 3: Write `web/course-roster.js`**

```js
// course-roster.js
//
// Pure client for the Canvas course roster (Phase 4 backend: GET /api/course/roster,
// POST /api/course/roster/refresh). Same never-throws convention as attendance-session.js:
// every function returns a normalized {ok, ...} / {ok:false, error} result. No DOM.

import { apiFetch } from './api-client.js';
import { normalizeId } from './roster.js';

/**
 * @typedef {Object} CanvasRosterMember
 * @property {string} ltiUserId
 * @property {string|null} institutionalId
 * @property {string|null} displayName
 * @property {string|null} givenName
 * @property {string|null} familyName
 * @property {string|null} email
 * @property {string[]} roles
 * @property {string} status
 * @property {boolean} eligibleForAttendance
 */

/**
 * @typedef {{ok: true, members: CanvasRosterMember[], fetchedAt: string, stale: boolean}
 *          | {ok: false, error: {kind: 'network'|'http-status'|'bad-json', message: string, status?: number}}} RosterResult
 */

/** @param {Response} response @param {string} url @returns {Promise<RosterResult>} */
async function readRosterResponse(response, url) {
  if (!response.ok) {
    return { ok: false, error: { kind: 'http-status', message: `${url} returned HTTP ${response.status}`, status: response.status } };
  }
  try {
    const body = await response.json();
    return {
      ok: true,
      members: Array.isArray(body?.members) ? body.members : [],
      fetchedAt: typeof body?.fetchedAt === 'string' ? body.fetchedAt : '',
      stale: body?.stale === true,
    };
  } catch (err) {
    return { ok: false, error: { kind: 'bad-json', message: `${url} returned invalid JSON: ${err.message}` } };
  }
}

/** GET /api/course/roster. Never throws. @returns {Promise<RosterResult>} */
export async function fetchCourseRoster() {
  const url = '/api/course/roster';
  let response;
  try {
    response = await apiFetch(url);
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  return readRosterResponse(response, url);
}

/** POST /api/course/roster/refresh (CSRF-gated, bodyless). Never throws. @returns {Promise<RosterResult>} */
export async function refreshCourseRoster() {
  const url = '/api/course/roster/refresh';
  let response;
  try {
    response = await apiFetch(url, { method: 'POST' });
  } catch (err) {
    return { ok: false, error: { kind: 'network', message: `Request to ${url} failed: ${err.message}` } };
  }
  return readRosterResponse(response, url);
}

/**
 * Index eligible members by normalized institutional ID, for absent-diffing and
 * name lookup against a scan's institutional ID. Members with no institutional
 * ID cannot be matched to a scan and are omitted.
 * @param {CanvasRosterMember[]} members
 * @returns {Map<string, CanvasRosterMember>}
 */
export function buildMemberIndex(members) {
  const index = new Map();
  for (const member of members) {
    if (!member.eligibleForAttendance || !member.institutionalId) continue;
    index.set(normalizeId(member.institutionalId), member);
  }
  return index;
}

/** @param {CanvasRosterMember[]} members @returns {number} */
export function countEligible(members) {
  return members.reduce((n, m) => (m.eligibleForAttendance ? n + 1 : n), 0);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run web/tests/course-roster.test.js`
Expected: PASS (8 assertions across 6 tests).

- [ ] **Step 5: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass. If `mock-canvas-nrps.test.ts` fails, re-run `npm test` once.

- [ ] **Step 6: Commit**

```bash
git add web/course-roster.js web/tests/course-roster.test.js
git commit -m "feat(task-22b): web/course-roster.js — pure client for GET/POST /api/course/roster

Fetch + refresh helpers (never-throws result shape) plus buildMemberIndex /
countEligible for the roster UI. No wiring yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 2: Course-context strip + Canvas Roster panel — markup, rendering, launch wiring

**Files:**
- Modify: `web/index.html` (header block; new panel; relabel CSV section)
- Modify: `web/ui.js` (element refs near line 11–80; new render functions)
- Modify: `web/app.js` (imports near line 13–30; `init()` near line 669–700; new `loadCanvasRoster()`; refresh-button listener near the roster wiring at line 289–368)

**Interfaces:**
- Consumes: `fetchCourseRoster`, `refreshCourseRoster`, `buildMemberIndex`, `countEligible` from `web/course-roster.js` (Task 1); `bootstrapSession()` from `web/api-client.js`, which already returns `{ ok: true, me }` where `me = { user: { displayName, roles }, institution: { name }, course: { id, label, title }, permissions, csrfToken }` (see `server/src/routes/me.ts`).
- Produces (new `web/ui.js` exports, all take plain data, no `fetch`):
  - `renderCourseContext({ user, institution, course })` — fills `#course-context-*`, unhides `#course-context`.
  - `setRosterCountText(count)` — writes `#course-context-roster-count` as `"N student"` / `"N students"`.
  - `renderCanvasRoster({ members, fetchedAt, stale })` — fills `#canvas-roster-table-body` (one `<tr>` per member: name, institutional ID, `eligibleForAttendance ? 'Enrolled' : member.status`), sets `#canvas-roster-status`, toggles `#canvas-roster-empty`, enables `#btn-refresh-roster`.
  - `renderCanvasRosterError({ kind, status, message })` — sets `#canvas-roster-status` to a fallback-pointing message, leaves `#btn-refresh-roster` enabled to retry.
- Produces (new `web/app.js` module state, mirroring `rosterState` at line 40): `canvasRosterState = { members: [], index: new Map(), fetchedAt: null, stale: false, loaded: false }`.

- [ ] **Step 1: Add the course-context strip and Canvas Roster panel to `web/index.html`**

Inside `<header class="app-header">`, immediately after the `<p class="app-subtitle">…</p>` line, add:

```html
    <dl id="course-context" class="course-context" hidden>
      <div><dt>Course</dt><dd id="course-context-name">&mdash;</dd></div>
      <div><dt>Institution</dt><dd id="course-context-institution">&mdash;</dd></div>
      <div><dt>Instructor</dt><dd id="course-context-instructor">&mdash;</dd></div>
      <div><dt>Roster</dt><dd id="course-context-roster-count">&mdash;</dd></div>
    </dl>
```

Inside `<div class="settings-body">`, immediately BEFORE the existing `<section class="panel" aria-labelledby="roster-heading">`, add:

```html
        <!-- Canvas Roster (Phase 4 / Task 22B) -->
        <section class="panel" aria-labelledby="canvas-roster-heading">
          <h2 id="canvas-roster-heading">Canvas Roster</h2>
          <p id="canvas-roster-status" class="muted" role="status" aria-live="polite">Loading roster from Canvas&hellip;</p>
          <div class="button-row">
            <button id="btn-refresh-roster" type="button" class="secondary" disabled>Refresh from Canvas</button>
          </div>
          <div class="table-scroll">
            <table>
              <thead>
                <tr><th>Name</th><th>Institutional ID</th><th>Status</th></tr>
              </thead>
              <tbody id="canvas-roster-table-body"></tbody>
            </table>
          </div>
          <p id="canvas-roster-empty" class="muted" hidden>Canvas returned no students for this course.</p>
        </section>
```

In the existing CSV roster section, change the heading text only:

```html
          <h2 id="roster-heading">Manual Roster (CSV fallback)</h2>
```

- [ ] **Step 2: Add element refs and render functions to `web/ui.js`**

In the `elements` object (after the `rosterIdColumnSelect` entry, ~line 32), add:

```js
  courseContext: document.getElementById('course-context'),
  courseContextName: document.getElementById('course-context-name'),
  courseContextInstitution: document.getElementById('course-context-institution'),
  courseContextInstructor: document.getElementById('course-context-instructor'),
  courseContextRosterCount: document.getElementById('course-context-roster-count'),
  refreshRosterBtn: document.getElementById('btn-refresh-roster'),
  canvasRosterStatus: document.getElementById('canvas-roster-status'),
  canvasRosterTableBody: document.getElementById('canvas-roster-table-body'),
  canvasRosterEmpty: document.getElementById('canvas-roster-empty'),
```

After the `setRosterControlsAvailability` function (~line 135), add:

```js
// ---- Canvas course context + roster ------------------------------------

/** @param {{user?: {displayName?: string}, institution?: {name?: string}, course?: {label?: string, title?: string}}} me */
export function renderCourseContext(me) {
  const course = me?.course ?? {};
  elements.courseContextName.textContent = course.title || course.label || '—';
  elements.courseContextInstitution.textContent = me?.institution?.name || '—';
  elements.courseContextInstructor.textContent = me?.user?.displayName || '—';
  elements.courseContext.hidden = false;
}

/** @param {number} count */
export function setRosterCountText(count) {
  elements.courseContextRosterCount.textContent = `${count} ${count === 1 ? 'student' : 'students'}`;
}

/** @param {string} iso @returns {string} */
function shortTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/** @param {{members: import('./course-roster.js').CanvasRosterMember[], fetchedAt: string, stale: boolean}} roster */
export function renderCanvasRoster({ members, fetchedAt, stale }) {
  const body = elements.canvasRosterTableBody;
  while (body.firstChild) body.removeChild(body.firstChild);

  for (const member of members) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = member.displayName || '—';
    const id = document.createElement('td');
    id.textContent = member.institutionalId || '—';
    const status = document.createElement('td');
    status.textContent = member.eligibleForAttendance ? 'Enrolled' : member.status || '—';
    tr.append(name, id, status);
    body.appendChild(tr);
  }

  elements.canvasRosterEmpty.hidden = members.length > 0;
  const when = shortTime(fetchedAt);
  const staleNote = stale ? ' · showing the last cached copy (Canvas was unreachable)' : '';
  elements.canvasRosterStatus.textContent = members.length
    ? `${members.length} enrolled${when ? ` · updated ${when}` : ''}${staleNote}`
    : `No students returned by Canvas${when ? ` · checked ${when}` : ''}`;
  elements.refreshRosterBtn.disabled = false;
}

/** @param {{kind: string, status?: number, message?: string}} error */
export function renderCanvasRosterError(error) {
  const detail = error?.status ? ` (HTTP ${error.status})` : '';
  elements.canvasRosterStatus.textContent =
    `Couldn't load the Canvas roster${detail}. You can retry, or use the Manual Roster (CSV fallback) below.`;
  elements.refreshRosterBtn.disabled = false;
}
```

- [ ] **Step 3: Wire the fetch into `web/app.js`**

Add to the import from `./course-roster.js` (new import line after the `./roster.js` import at line 13):

```js
import { fetchCourseRoster, refreshCourseRoster, buildMemberIndex, countEligible } from './course-roster.js';
```

After the `rosterState` declaration (~line 47), add:

```js
// ---- Canvas roster state (owned here; course-roster.js provides pure helpers) ----

const canvasRosterState = {
  members: [],
  index: new Map(), // normalized institutional ID -> CanvasRosterMember
  fetchedAt: null,
  stale: false,
  loaded: false,
};

async function loadCanvasRoster({ refresh = false } = {}) {
  elements.refreshRosterBtn.disabled = true;
  const result = refresh ? await refreshCourseRoster() : await fetchCourseRoster();
  if (!result.ok) {
    ui.renderCanvasRosterError(result.error);
    diagnostics.logEvent('error', { kind: 'canvas-roster-load-failed', message: result.error.message });
    return;
  }
  canvasRosterState.members = result.members;
  canvasRosterState.index = buildMemberIndex(result.members);
  canvasRosterState.fetchedAt = result.fetchedAt;
  canvasRosterState.stale = result.stale;
  canvasRosterState.loaded = true;
  ui.renderCanvasRoster(result);
  ui.setRosterCountText(countEligible(result.members));
}
```

Near the other roster wiring (after the `rosterEnableToggle` listener, ~line 368), add:

```js
elements.refreshRosterBtn.addEventListener('click', () => {
  loadCanvasRoster({ refresh: true });
});
```

In `init()` (~line 678), replace the `bootstrapSession()` result handling so the context + roster load when authenticated:

```js
  const boot = await bootstrapSession();
  ui.renderSessionState({ state: 'none' });
  if (!boot.ok) {
    ui.showAppMessage('error', 'Could not load your session. Reload the page from Canvas.');
    elements.startSessionBtn.disabled = true;
  } else {
    ui.renderCourseContext(boot.me);
    await loadCanvasRoster();
    // C1: resume an attendance session that is still open on the server.
    await resumeOpenSessionIfAny();
  }
```

- [ ] **Step 4: Manual + green-bar verification**

`ui.js` render functions are not unit-tested anywhere in this repo (they are coupled to `document` at module load and are covered by Playwright + manual checks — see `web/ui.js` header and the absence of a `ui.test.js`). Task 4 adds the e2e assertion. For this task:

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green (no test regressions; the new module is imported but its DOM paths run only in a browser / the e2e).

Manual: `npm run dev`, open the app through a mock or real launch, confirm the header shows the course name + "N students", the Canvas Roster panel lists members, and "Refresh from Canvas" re-fetches. With the backend returning 502 for the roster, confirm the status line points at the CSV fallback and the panel does not throw.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/ui.js web/app.js
git commit -m "feat(task-22b): show Canvas course context + roster in the scanner UI

init() now renders the course name / institution / instructor / roster count from
GET /api/me and loads GET /api/course/roster into a new Canvas Roster panel, with a
Refresh button (POST /api/course/roster/refresh) and a graceful degraded/again path.
The CSV panel is relabelled 'Manual Roster (CSV fallback)' and otherwise unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 3: Absent rows from the Canvas roster

**Files:**
- Modify: `web/absentees.js`
- Modify: `web/app.js` (the `downloadCsvBtn` handler, ~line 372–411)
- Test: `web/tests/absentees.test.js` (new)

**Interfaces:**
- Consumes: `canvasRosterState.index` (Task 2) — `Map<string, CanvasRosterMember>`; `normalizeId` from `web/roster.js`.
- Produces: `computeAbsentRowsFromMembers({ memberIndex, scannedIds }): AbsentRow[]` where `AbsentRow = { id, timestamp: '', rawCardCode: '', institutionalId: string, displayName: string|null, status: '', isAbsent: true }`. The existing `computeAbsentRows({ rosterState, scannedIds })` is unchanged.

- [ ] **Step 1: Write the failing tests**

Create `web/tests/absentees.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computeAbsentRows, computeAbsentRowsFromMembers } from '../absentees.js';

describe('computeAbsentRows (CSV roster)', () => {
  it('returns one row per roster ID with no matching scan', () => {
    const rosterState = { index: new Map([['0041', {}], ['0042', {}], ['0043', {}]]) };
    const rows = computeAbsentRows({ rosterState, scannedIds: new Set(['0042']) });
    expect(rows.map((r) => r.institutionalId)).toEqual(['0041', '0043']);
    expect(rows[0]).toMatchObject({ isAbsent: true, timestamp: '', rawCardCode: '', status: '' });
  });
});

describe('computeAbsentRowsFromMembers (Canvas roster)', () => {
  const memberIndex = new Map([
    ['0041', { institutionalId: '0041', displayName: 'Ann Absent' }],
    ['0042', { institutionalId: '0042', displayName: 'Pat Present' }],
  ]);

  it('returns absent rows carrying the member display name', () => {
    const rows = computeAbsentRowsFromMembers({ memberIndex, scannedIds: new Set(['0042']) });
    expect(rows).toEqual([
      { id: 'absent-0041', timestamp: '', rawCardCode: '', institutionalId: '0041', displayName: 'Ann Absent', status: '', isAbsent: true },
    ]);
  });

  it('returns [] when everyone on the roster scanned', () => {
    const rows = computeAbsentRowsFromMembers({ memberIndex, scannedIds: new Set(['0041', '0042']) });
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run web/tests/absentees.test.js`
Expected: FAIL — `computeAbsentRowsFromMembers` is not exported.

- [ ] **Step 3: Add `computeAbsentRowsFromMembers` to `web/absentees.js`**

Append:

```js
/**
 * Same idea as computeAbsentRows, but sourced from the live Canvas roster index
 * (course-roster.js buildMemberIndex) so each absent row carries the member's
 * display name rather than only an ID.
 *
 * @param {Object} args
 * @param {Map<string, {institutionalId: string, displayName: string|null}>} args.memberIndex
 * @param {Set<string>} args.scannedIds - normalized institutional IDs already scanned this session
 * @returns {AbsentRow[]}
 */
export function computeAbsentRowsFromMembers({ memberIndex, scannedIds }) {
  const rows = [];
  for (const [normId, member] of memberIndex.entries()) {
    if (scannedIds.has(normId)) continue;
    rows.push({
      id: `absent-${normId}`,
      timestamp: '',
      rawCardCode: '',
      institutionalId: member.institutionalId,
      displayName: member.displayName ?? null,
      status: '',
      isAbsent: true,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Prefer the Canvas roster in the no-session CSV export path**

In `web/app.js`, in the `downloadCsvBtn` click handler, replace the block that starts `const rosterActive = rosterState.enabled …` down to the `computeAbsentRows(...)` call with:

```js
  const canvasRosterActive = canvasRosterState.loaded && canvasRosterState.index.size > 0;
  const csvRosterActive = rosterState.enabled && rosterState.index.size > 0;
  const rosterActive = canvasRosterActive || csvRosterActive;
  const mode = rosterActive ? elements.exportModeSelect.value : 'present';
  const presentRecords = scanPipeline.getRecords();

  if (mode === 'present') {
    const result = downloadAttendanceCsv(presentRecords);
    if (!result.ok) {
      ui.showAppMessage('error', `CSV export failed: ${result.error}`);
    }
    return;
  }

  const scannedIds = new Set(presentRecords.map((record) => record.institutionalId).filter(Boolean).map(normalizeId));
  const absentRows = canvasRosterActive
    ? computeAbsentRowsFromMembers({ memberIndex: canvasRosterState.index, scannedIds })
    : computeAbsentRows({ rosterState, scannedIds });
```

Add `computeAbsentRowsFromMembers` to the existing import from `./absentees.js` at line 16:

```js
import { computeAbsentRows, computeAbsentRowsFromMembers } from './absentees.js';
```

Also update `refreshExportControls()` (~line 293) so the Present/Absent selector appears when the Canvas roster is loaded:

```js
function refreshExportControls() {
  const rosterActive =
    (canvasRosterState.loaded && canvasRosterState.index.size > 0) ||
    (rosterState.enabled && rosterState.index.size > 0);
  ui.setExportControlsAvailability({ rosterActive });
}
```

And call `refreshExportControls()` at the end of `loadCanvasRoster()` (after `ui.setRosterCountText(...)`).

- [ ] **Step 5: Run tests + green bar**

Run: `npx vitest run web/tests/absentees.test.js && npm test && npm run lint && npm run typecheck`
Expected: new file passes (4 tests); full suite green.

- [ ] **Step 6: Commit**

```bash
git add web/absentees.js web/app.js web/tests/absentees.test.js
git commit -m "feat(task-22b): synthesize absent CSV rows from the Canvas roster

computeAbsentRowsFromMembers() diffs the live Canvas roster index against scanned
IDs so 'Absent' export rows carry the member's name. The no-session CSV export and
the Present/Absent selector now activate on the Canvas roster too, not only an
uploaded CSV. Session-active export is unchanged (server CSV is authoritative).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 4: End-to-end assertion + progress note

**Files:**
- Modify: `e2e/instructor-flow.spec.ts`
- Modify: `e2e/support/seed-launch.ts` (only if the launch context has no title/label to assert against)
- Modify: `docs/canvas-lti/progress.md`

**Interfaces:**
- Consumes: the existing e2e harness — `seedInstructorLaunch()` in `e2e/support/seed-launch.ts` stands up a mock Canvas with a paginated NRPS roster containing one learner named `E2E Test Learner` (`e2e/support/seed-launch.ts:127`), and drives a real `/lti/launch` against the dev server.
- Produces: an assertion that the roster UI rendered — no new production code.

- [ ] **Step 1: Confirm what the seeded launch context exposes**

Read `e2e/support/seed-launch.ts` and find the `id_token` context claim (`https://purl.imsglobal.org/spec/lti/claim/context`). Note its `title` / `label`.
- If it sets a `title` (e.g. `"E2E Course"`), use that string in Step 2.
- If it has no context `title`/`label`, add `title: 'E2E Course', label: 'E2E-101'` to that claim object, and note it in the commit.

- [ ] **Step 2: Add roster-UI assertions to the instructor flow**

In `e2e/instructor-flow.spec.ts`, after the block that asserts `GET /api/me` succeeded / the Start button is enabled (~line 48–50), add:

```ts
  // Task 22B: the Canvas course context + roster render from /api/me and
  // /api/course/roster without any CSV upload.
  await expect(page.locator('#course-context')).toBeVisible();
  await expect(page.locator('#course-context-name')).toHaveText('E2E Course'); // context.title from seed-launch.ts
  await expect(page.locator('#course-context-roster-count')).toHaveText('1 student');
  await expect(page.locator('#canvas-roster-table-body tr')).toHaveCount(1);
  await expect(page.locator('#canvas-roster-table-body tr').first()).toContainText('E2E Test Learner');
```

- [ ] **Step 3: Run the e2e flow**

Run: `npm run test:e2e -- instructor-flow`
Expected: PASS, including the new roster assertions. If `#course-context-name` mismatches, reconcile the expected string with the actual seeded `context.title` from Step 1 (do not weaken the assertion to a substring unless the seed genuinely has no stable title).

- [ ] **Step 4: Record Task 22B in `docs/canvas-lti/progress.md`**

Under the `## Phase 7 — what actually happened` section (create it if Task 22 has not yet written it; otherwise append), add:

```markdown
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
```

- [ ] **Step 5: Green bar + commit**

Run: `npm test && npm run lint && npm run typecheck && npm run test:e2e -- instructor-flow`
Expected: all pass.

```bash
git add e2e/instructor-flow.spec.ts e2e/support/seed-launch.ts docs/canvas-lti/progress.md
git commit -m "test(task-22b): e2e asserts the Canvas course context + roster render on launch

Also records Task 22B under progress.md's Phase 7 section.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Self-Review

**Spec coverage**
- §50 step 4 ("App displays course name and current roster count") → Task 2 (`renderCourseContext` + `setRosterCountText`).
- Phase 4 exit criterion ("sees the active Canvas learner roster without uploading a file") → Task 2 (Canvas Roster panel fed by `GET /api/course/roster`) + Task 4 (e2e proof).
- §25.2 roster endpoints (`GET /api/course/roster`, `POST /api/course/roster/refresh`, degrade-to-cache with `stale:true`, 502 on hard failure) → Task 1 (both verbs, `stale` surfaced) + Task 2 (`renderCanvasRoster` stale note, `renderCanvasRosterError` for 502).
- §50 step 6 ("App snapshots the roster" on Start Attendance) → already implemented server-side in `closeAttendanceSession`/session create; no UI change needed.
- Not in scope: per-institution identity-match config UI (spec §27.2, deferred to Phase 8); changing the client CSV column set to add names.

**Placeholder scan** — no TBD/TODO/"handle edge cases"/"similar to Task N"; every code step carries full code.

**Type consistency**
- `CanvasRosterMember` fields match `serializeMember` in `server/src/routes/course-roster.ts` (`ltiUserId`, `institutionalId`, `displayName`, `givenName`, `familyName`, `email`, `roles`, `status`, `eligibleForAttendance`).
- `RosterResult` shape is produced by Task 1 (`fetchCourseRoster`/`refreshCourseRoster`) and consumed by Task 2 (`loadCanvasRoster` reads `.members`/`.fetchedAt`/`.stale`/`.error`).
- `renderCanvasRoster` is called with the whole `RosterResult` (which carries `members`/`fetchedAt`/`stale`) in Task 2 — consistent.
- `AbsentRow` from `computeAbsentRowsFromMembers` (Task 3) adds `displayName` to the shape `csv.js buildAttendanceCsv` already tolerates (it reads `institutionalId` + `isAbsent`; extra keys are ignored).
- `buildMemberIndex` / `countEligible` names identical in Task 1 definition and Tasks 2–3 imports.

---

## Companion investigation (NOT part of Task 22B): Symptom B — nothing in the Canvas Gradebook

Separate from the UI. Grade sync is server-side (`grade-worker`), independent of this UI work. As of the last investigation the worker ran every 5 min with `grade.processed: 0`, no web-tier errors, and Log Analytics lagged ~20 min behind the test close. With the dev DB firewall open, run:

```sql
-- against the dev DATABASE_URL
select course_id, lti_user_id, state, score, attempt_count, last_error, next_attempt_at, updated_at
  from grade_sync_jobs order by updated_at desc limit 20;
select course_id, canvas_lineitem_id, lineitem_url, updated_at from grade_line_items;
select count(*) filter (where eligible_for_attendance) as eligible, count(*) as total from course_members;
select event_type, new_value, created_at from audit_events
  where event_type in ('grade_sync_requested','roster_refreshed') order by created_at desc limit 20;
```

Likely outcomes and where they point:
- `grade_sync_jobs` empty + `course_members` eligible = 0 → NRPS roster never cached → the shared Canvas LTI-Advantage **token grant** (NRPS + AGS use the same one) is failing. Check `lti_registrations.token_audience` for the dev issuer; the reviewer flagged this — Canvas may require `https://canvas.instructure.com/login/oauth2/token` even for test. Re-seed that row if so.
- `grade_sync_jobs` rows in `state = 'failed'` with a `last_error` like `ags:auth` / `ags:http-4xx` → AGS-side; inspect `grade_line_items.lineitem_url` provenance and the score-post payload.
- `grade_sync_jobs` rows `synced` → it worked and the earlier check was just Log-Analytics lag; re-check the Canvas Gradebook.

Fold the result into Task 22 Step 8 (live §46 AGS matrix), not this plan.
