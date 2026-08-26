# Canvas LTI Phase 4 — NRPS Roster Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instructors launching from a Canvas course see the live Canvas learner roster through NRPS, with zero CSV upload, and a cached-roster fallback that survives transient Canvas failures.

**Architecture:** A new `server/src/lti/nrps.ts` orchestrates: OAuth2 client-credentials token acquisition (`token-client.ts`), a paginated authenticated fetch of Canvas's Names and Role Provisioning Service (NRPS) endpoint, and normalization of raw Canvas membership records into a stable `CourseRosterMember` shape. `roster-store.ts` persists that roster into a new `course_members` table (upsert, never delete — removed members are marked `status: 'removed'`) and exposes cache-staleness/lookup helpers. Two new routes (`GET /api/course/roster`, `POST /api/course/roster/refresh`) expose this to the authenticated frontend, both degrading gracefully to a &lt;24h-old cache with `stale: true` rather than hard-failing when Canvas is unreachable.

**Tech Stack:** `jose` (client-assertion JWT signing, already a Phase 3 dependency), `drizzle-orm` + `pg` (already Phase 3 dependencies), Fastify, Vitest. **No new npm dependencies this phase.**

## ⚠️ Re-confirm before executing

This plan is written against Phase 3's **designed** module shapes (`server/src/database/schema.ts`, `server/src/database/client.ts`, `server/src/lti/types.ts`'s `LtiRegistration`, `server/src/lti/signing-keys.ts`'s `getActiveSigningKey()`, `server/src/auth/middleware.ts`'s `requireSession`, `server/tests/support/mock-canvas.ts`, `server/tests/support/db.ts`, `server/tests/support/seed.ts`) as documented in the Phase 3 design doc and this repo's `docs/superpowers/plans/2026-08-26-canvas-lti-phase3-lti-authentication.md`, **not against code that existed when this plan was written** (Phase 3 had not yet been executed). Before starting Task 1, open the real files at those paths and confirm:
- The exact exported name and return shape of the active-signing-key accessor in `server/src/lti/signing-keys.ts` (this plan assumes `getActiveSigningKey(): Promise<{ kid: string; privateKey: CryptoKey }>`).
- The exact shape of `request.appSession` after `requireSession` runs (this plan assumes `{ institutionId, deploymentId, ltiSubject, courseId, roles, ... }` per Phase 3's `app_sessions` schema).
- The exact `LtiRegistration`/`LtiDeployment` field names in `server/src/lti/types.ts`.
- The real `server/tests/support/mock-canvas.ts` harness's existing exports (`mintIdToken`, `publishNewKey`, `unpublishKey`, `jwksUrl`, `baseUrl`, etc.) before writing Task 6's extension — add to it, don't guess and duplicate.

If any of these differ from what's assumed below, **adapt this plan's call sites to match the real Phase 3 code — never change Phase 3's already-shipped public interfaces to fit this plan.**

## Fixed contract — do not reshape without updating Phase 5's plan too

```ts
export interface CourseRosterMember {
  ltiUserId: string;
  institutionalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  roles: string[];
  status: string;
  eligibleForAttendance: boolean;
}

export type CourseRosterResult =
  | { ok: true; members: CourseRosterMember[]; fetchedAt: string }
  | {
      ok: false;
      error: {
        kind: 'invalid-service-url' | 'expired-token' | 'rate-limited' | 'pagination-failure' | 'network' | 'http-status' | 'bad-json';
        message: string;
        retryable: boolean;
      };
    };

export async function refreshCourseRoster(courseId: string): Promise<CourseRosterResult>;
```

Phase 5's `createSession` snapshots `CourseRosterMember[]` verbatim into `attendance_session_members.snapshot_data`. If this shape changes, Phase 5's plan document must be updated in lockstep.

## Global Constraints

- No new npm dependencies (spec §7 stack already covers this via `jose`/`drizzle-orm`/`pg`).
- Outbound URLs to Canvas must come only from the signed launch's `nrps_url` (persisted at launch time) — never accept or construct a Canvas URL from browser input (spec §31.7 SSRF).
- Institutional IDs are normalized as trimmed strings and are **never** converted to integers or otherwise coerced — leading zeroes are meaningful (spec §20).
- Never match roster identity by student display name (spec §20). Email matching must be explicitly opted in via `identityMatchEmailEnabled` (spec §20).
- Multiple `course_members` rows may share an `institutionalId` within a course; never merge or silently drop duplicates — `findCourseMembersByInstitutionalId` returns an array, surfacing ambiguity to the caller (spec §20, design decision).
- Members no longer present in a fresh NRPS fetch are marked `status: 'removed'`, never deleted (avoids dangling references from anything holding a `course_members.id`).
- Do not log full NRPS payloads, Canvas access tokens, or the rendered NRPS/token request URLs with embedded credentials (spec §31.8).
- Roster cache TTL is 5 minutes (spec §18.4); `POST /api/course/roster/refresh` and `GET /api/course/roster` both fall back to a cached roster if it is &lt;24 hours old rather than hard-failing on a transient Canvas error (design decision — a transient Canvas 429 must not block an instructor mid-class).
- All new routes require `requireSession` (an authenticated instructor application session) per spec §25's blanket rule.
- Use parameterized queries via Drizzle only — never string-concatenate SQL (spec §31.6).
- `roles` arrays store raw NRPS role URNs verbatim, never coerced or renamed.

---

## File/module layout

```
server/src/lti/
  scopes.ts            # NEW — named IMS LTI Advantage scope URI constants
  service-url.ts        # NEW — Canvas service-URL validation (SSRF guard)
  roster-config.ts        # NEW — institution roster-filter/identity-match config resolution
  token-client.ts           # NEW — OAuth2 client-credentials grant + access-token cache
  nrps.ts                     # NEW — fetch + pagination + member normalization + orchestration

server/src/attendance/
  roster-store.ts                # NEW — course_members upsert/read, 5-min cache-staleness check

server/src/database/
  schema.ts             # MODIFY — extend `courses`/`institutions`, add `course_members`/`audit_events`

server/src/routes/
  course-roster.ts        # NEW — GET /api/course/roster, POST /api/course/roster/refresh

server/tests/lti/
  scopes.test.ts
  service-url.test.ts
  roster-config.test.ts
  token-client.test.ts
  nrps.test.ts

server/tests/attendance/
  roster-store.test.ts

server/tests/routes/
  course-roster.test.ts

server/tests/support/
  mock-canvas.ts          # MODIFY — extend with a Canvas token endpoint + paginated NRPS endpoint
```

---

### Task 1: Database schema — extend `courses`/`institutions`, add `course_members`/`audit_events`

**Files:**
- Modify: `server/src/database/schema.ts`
- Test: `server/tests/database/schema.test.ts` (extend the existing Phase 3 smoke test file — create it if it does not yet exist under this exact name)

**Interfaces:**
- Consumes: Phase 3's existing `institutions`, `courses` Drizzle table exports and the `db` export from `server/src/database/client.ts`.
- Produces: `courseMembers` and `auditEvents` Drizzle table exports; `courses.nrpsUrl`/`courses.agsLineitemsUrl`/`courses.lastLaunchedAt`/`courses.rosterCachedAt` columns; `institutions.canvasIdentityMatchField`/`institutions.identityMatchEmailEnabled`/`institutions.rosterLearnerRoles` columns. `CourseMemberRow = typeof courseMembers.$inferSelect` (re-exported from `server/src/attendance/roster-store.ts` in Task 9, not from schema.ts itself).

- [ ] **Step 1: Open the real `server/src/database/schema.ts` and confirm the existing `courses`/`institutions` table shapes**

Read the file. Confirm `courses` has at least `id`, `institutionId`, `deploymentId`, `ltiContextId`, `label`, `title`, `createdAt`, `updatedAt`, and `institutions` has at least `id`, `slug`, `displayName`, `timezone`, `enabled`, `createdAt`, `updatedAt`, per Phase 3's design. If the real column names differ from these, use the real names in every step below instead.

- [ ] **Step 2: Add the new columns to `courses` and `institutions`**

In `server/src/database/schema.ts`, locate the `courses` table's column object literal and add:

```ts
  nrpsUrl: text('nrps_url'),
  agsLineitemsUrl: text('ags_lineitems_url'),
  lastLaunchedAt: timestamp('last_launched_at', { withTimezone: true }),
  rosterCachedAt: timestamp('roster_cached_at', { withTimezone: true }),
```

Locate the `institutions` table's column object literal and add:

```ts
  canvasIdentityMatchField: text('canvas_identity_match_field').notNull().default('lis_person_sourcedid'),
  identityMatchEmailEnabled: boolean('identity_match_email_enabled').notNull().default(false),
  rosterLearnerRoles: jsonb('roster_learner_roles')
    .$type<string[]>()
    .notNull()
    .default(sql`'["Learner"]'::jsonb`),
```

Ensure `sql` is imported from `drizzle-orm` at the top of the file: `import { sql } from 'drizzle-orm';` (add it to the existing import statement if `drizzle-orm` is already imported; add a new import line otherwise). Ensure `jsonb`, `boolean`, `text`, `timestamp` are imported from `drizzle-orm/pg-core` (they should already be imported for the existing tables — extend that import list only if any are missing).

- [ ] **Step 3: Add the `courseMembers` table**

Append to `server/src/database/schema.ts`:

```ts
export const courseMembers = pgTable(
  'course_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    ltiUserId: text('lti_user_id').notNull(),
    institutionalId: text('institutional_id'),
    displayName: text('display_name'),
    givenName: text('given_name'),
    familyName: text('family_name'),
    email: text('email'),
    roles: jsonb('roles').$type<string[]>().notNull(),
    status: text('status').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    courseLtiUserUnique: unique('course_members_course_id_lti_user_id_key').on(table.courseId, table.ltiUserId),
  }),
);
```

`unique` must be imported from `drizzle-orm/pg-core` alongside the other column-type imports.

- [ ] **Step 4: Add the `auditEvents` table**

Append:

```ts
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id')
    .notNull()
    .references(() => institutions.id),
  courseId: uuid('course_id').references(() => courses.id),
  attendanceSessionId: uuid('attendance_session_id'),
  actorLtiUserId: text('actor_lti_user_id'),
  eventType: text('event_type').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  requestId: text('request_id'),
});
```

`attendanceSessionId` intentionally has **no** foreign-key constraint yet — `attendance_sessions` doesn't exist until Phase 5. Phase 5's migration adds that FK via `ALTER TABLE`, not by recreating this table.

- [ ] **Step 5: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new SQL file appears under the repo-root `/migrations` directory containing `ALTER TABLE "courses" ADD COLUMN ...`, `ALTER TABLE "institutions" ADD COLUMN ...`, `CREATE TABLE "course_members" ...`, and `CREATE TABLE "audit_events" ...` statements. Read the generated file and confirm all four changes are present with the exact column names above.

- [ ] **Step 6: Write the schema smoke test**

Create or extend `server/tests/database/schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/database/client.js';
import { institutions, courses, courseMembers, auditEvents } from '../../src/database/schema.js';
import { resetDb } from '../support/db.js';

describe('Phase 4 schema additions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('persists the new courses/institutions columns and course_members/audit_events rows', async () => {
    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'test-u', displayName: 'Test University', timezone: 'America/New_York', enabled: true })
      .returning();

    expect(institution.canvasIdentityMatchField).toBe('lis_person_sourcedid');
    expect(institution.identityMatchEmailEnabled).toBe(false);
    expect(institution.rosterLearnerRoles).toEqual(['Learner']);

    const [course] = await db
      .insert(courses)
      .values({
        institutionId: institution.id,
        deploymentId: institution.id, // placeholder FK target for this isolated smoke test only
        ltiContextId: 'course-1',
        label: 'ENGR-101',
        title: 'Intro to Engineering',
        nrpsUrl: 'https://canvas.example.edu/api/lti/courses/1/names_and_roles',
      })
      .returning();

    expect(course.nrpsUrl).toBe('https://canvas.example.edu/api/lti/courses/1/names_and_roles');
    expect(course.rosterCachedAt).toBeNull();

    const [member] = await db
      .insert(courseMembers)
      .values({
        courseId: course.id,
        ltiUserId: 'user-1',
        institutionalId: '1234567',
        roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
        status: 'Active',
      })
      .returning();
    expect(member.institutionalId).toBe('1234567');

    const [event] = await db
      .insert(auditEvents)
      .values({
        institutionId: institution.id,
        courseId: course.id,
        eventType: 'roster_refreshed',
        targetType: 'course',
        targetId: course.id,
        newValue: { memberCount: 1 },
      })
      .returning();
    expect(event.eventType).toBe('roster_refreshed');

    const found = await db.select().from(courseMembers).where(eq(courseMembers.courseId, course.id));
    expect(found).toHaveLength(1);
  });
});
```

Note: the `deploymentId` value above uses `institution.id` only because this test is isolated and Phase 3's real `courses` insert path always supplies a real `ltiDeployments.id`; if Phase 3's actual `courses.deploymentId` FK is `NOT NULL` referencing `lti_deployments.id`, insert a real `ltiDeployments`/`ltiRegistrations` row first instead — check Phase 3's own `schema.test.ts` for the established fixture pattern and reuse it rather than duplicating logic.

- [ ] **Step 7: Run the test**

Run: `npm test -- schema.test.ts`
Expected: PASS.

- [ ] **Step 8: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add server/src/database/schema.ts migrations/ server/tests/database/schema.test.ts
git commit -m "feat(lti): add course_members/audit_events tables and roster columns"
```

---

### Task 2: `scopes.ts`

**Files:**
- Create: `server/src/lti/scopes.ts`
- Test: `server/tests/lti/scopes.test.ts`

**Interfaces:**
- Produces: `NRPS_MEMBERSHIP_READONLY_SCOPE`, `AGS_LINEITEM_SCOPE`, `AGS_SCORE_SCOPE` string constants.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/scopes.test.ts
import { describe, it, expect } from 'vitest';
import { NRPS_MEMBERSHIP_READONLY_SCOPE, AGS_LINEITEM_SCOPE, AGS_SCORE_SCOPE } from '../../src/lti/scopes.js';

describe('LTI Advantage scope constants', () => {
  it('exposes the exact 1EdTech-documented scope URIs', () => {
    expect(NRPS_MEMBERSHIP_READONLY_SCOPE).toBe(
      'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    );
    expect(AGS_LINEITEM_SCOPE).toBe('https://purl.imsglobal.org/spec/lti-ags/scope/lineitem');
    expect(AGS_SCORE_SCOPE).toBe('https://purl.imsglobal.org/spec/lti-ags/scope/score');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scopes.test.ts`
Expected: FAIL with a module-not-found error for `../../src/lti/scopes.js`.

- [ ] **Step 3: Implement**

```ts
// server/src/lti/scopes.ts
//
// Named IMS LTI Advantage scope URIs, copied verbatim from Canvas's LTI
// Developer Key scope documentation. Spec §10 explicitly forbids
// hand-typing or hardcoding these from memory -- these are the literal
// standardized 1EdTech URIs Canvas's Developer Key UI populates for each
// capability. AGS scopes are reserved for Phase 6 and unused until then.

export const NRPS_MEMBERSHIP_READONLY_SCOPE =
  'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';

export const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';

export const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scopes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/scopes.ts server/tests/lti/scopes.test.ts
git commit -m "feat(lti): add named LTI Advantage scope constants"
```

---

### Task 3: `service-url.ts` — Canvas service-URL SSRF guard

**Files:**
- Create: `server/src/lti/service-url.ts`
- Test: `server/tests/lti/service-url.test.ts`

**Interfaces:**
- Consumes: nothing new (pure function over a URL string and a trusted-host source).
- Produces: `validateCanvasServiceUrl(url: string, trustedHostSource: { tokenEndpoint: string }): { ok: true } | { ok: false; error: string }`.

Design note: redirect rejection (spec §31.7 "disable unrestricted redirects") is enforced at the actual outbound `fetch` call sites in `nrps.ts` and `token-client.ts` via `redirect: 'manual'` plus treating any 3xx response as a failure — not inside this function, which stays a pure, synchronous, trivially-testable check. This keeps `validateCanvasServiceUrl` fast to call before every use without an extra network round trip.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/lti/service-url.test.ts
import { describe, it, expect } from 'vitest';
import { validateCanvasServiceUrl } from '../../src/lti/service-url.js';

const registration = { tokenEndpoint: 'https://canvas.example.edu/login/oauth2/token' };

describe('validateCanvasServiceUrl', () => {
  it('accepts an HTTPS URL on the registration's trusted host', () => {
    const result = validateCanvasServiceUrl('https://canvas.example.edu/api/lti/courses/1/names_and_roles', registration);
    expect(result).toEqual({ ok: true });
  });

  it('rejects a non-HTTPS URL', () => {
    const result = validateCanvasServiceUrl('http://canvas.example.edu/api/lti/courses/1/names_and_roles', registration);
    expect(result).toEqual({ ok: false, error: 'not-https' });
  });

  it('rejects a URL on a foreign host', () => {
    const result = validateCanvasServiceUrl('https://evil.example.com/api/lti/courses/1/names_and_roles', registration);
    expect(result).toEqual({ ok: false, error: 'untrusted-host' });
  });

  it('rejects a URL with embedded credentials', () => {
    const result = validateCanvasServiceUrl('https://user:pass@canvas.example.edu/api/lti/courses/1/names_and_roles', registration);
    expect(result).toEqual({ ok: false, error: 'embedded-credentials' });
  });

  it('rejects a malformed URL', () => {
    const result = validateCanvasServiceUrl('not a url', registration);
    expect(result).toEqual({ ok: false, error: 'malformed-url' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- service-url.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// server/src/lti/service-url.ts
//
// Validates a Canvas-provided service URL (NRPS membership endpoint, AGS
// line-items endpoint) before it is ever fetched. These URLs come only
// from the signed LTI launch claims -- never from the browser -- but the
// spec (§31.7) still requires validating scheme, host, and absence of
// embedded credentials before trusting them. Redirect rejection happens
// at the actual fetch call site (`redirect: 'manual'`), not here.

export interface ServiceUrlValidationResult {
  ok: boolean;
  error?: 'malformed-url' | 'not-https' | 'untrusted-host' | 'embedded-credentials';
}

export function validateCanvasServiceUrl(
  url: string,
  trustedHostSource: { tokenEndpoint: string },
): ServiceUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'malformed-url' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'not-https' };
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'embedded-credentials' };
  }

  const trustedHost = new URL(trustedHostSource.tokenEndpoint).host;
  if (parsed.host !== trustedHost) {
    return { ok: false, error: 'untrusted-host' };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- service-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/service-url.ts server/tests/lti/service-url.test.ts
git commit -m "feat(lti): add Canvas service-URL SSRF validation"
```

---

### Task 4: `roster-config.ts` — institution roster-filter/identity-match config resolution

**Files:**
- Create: `server/src/lti/roster-config.ts`
- Test: `server/tests/lti/roster-config.test.ts`

**Interfaces:**
- Consumes: an institution row shape `{ canvasIdentityMatchField: string; identityMatchEmailEnabled: boolean; rosterLearnerRoles: string[] }` (matches Task 1's `institutions` columns).
- Produces: `InstitutionRosterConfig` type, `resolveInstitutionRosterConfig(institution)`, `resolveInstitutionalId(raw, config)`, `isEligibleForAttendance(status, roles, learnerRoles)`, `NrpsRawMember` type (the raw Canvas membership record shape — re-used by `nrps.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/lti/roster-config.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveInstitutionRosterConfig,
  resolveInstitutionalId,
  isEligibleForAttendance,
  type NrpsRawMember,
} from '../../src/lti/roster-config.js';

describe('resolveInstitutionRosterConfig', () => {
  it('defaults rosterLearnerRoles to ["Learner"] when the institution row has none', () => {
    const config = resolveInstitutionRosterConfig({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: false,
      rosterLearnerRoles: [],
    });
    expect(config.rosterLearnerRoles).toEqual([]);
  });

  it('passes through a configured custom learner-role list', () => {
    const config = resolveInstitutionRosterConfig({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: true,
      rosterLearnerRoles: ['Learner', 'ProxyLearner'],
    });
    expect(config).toEqual({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: true,
      rosterLearnerRoles: ['Learner', 'ProxyLearner'],
    });
  });
});

describe('resolveInstitutionalId', () => {
  const baseConfig = { canvasIdentityMatchField: 'lis_person_sourcedid', identityMatchEmailEnabled: false, rosterLearnerRoles: ['Learner'] };

  it('reads the configured field and trims it', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], lis_person_sourcedid: '  001234  ' };
    expect(resolveInstitutionalId(raw, baseConfig)).toBe('001234');
  });

  it('preserves leading zeroes rather than coercing to a number', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], lis_person_sourcedid: '0009' };
    expect(resolveInstitutionalId(raw, baseConfig)).toBe('0009');
  });

  it('returns null when the configured field is missing (missing SIS ID)', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [] };
    expect(resolveInstitutionalId(raw, baseConfig)).toBeNull();
  });

  it('returns null for an email match field when email matching is not enabled', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], email: 'student@example.edu' };
    const config = { ...baseConfig, canvasIdentityMatchField: 'email', identityMatchEmailEnabled: false };
    expect(resolveInstitutionalId(raw, config)).toBeNull();
  });

  it('reads email when email matching is enabled', () => {
    const raw: NrpsRawMember = { user_id: 'u1', status: 'Active', roles: [], email: 'student@example.edu' };
    const config = { ...baseConfig, canvasIdentityMatchField: 'email', identityMatchEmailEnabled: true };
    expect(resolveInstitutionalId(raw, config)).toBe('student@example.edu');
  });
});

describe('isEligibleForAttendance', () => {
  const learnerRoleUri = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
  const instructorRoleUri = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

  it('is true for an active learner', () => {
    expect(isEligibleForAttendance('Active', [learnerRoleUri], ['Learner'])).toBe(true);
  });

  it('is false for an inactive learner', () => {
    expect(isEligibleForAttendance('Inactive', [learnerRoleUri], ['Learner'])).toBe(false);
  });

  it('is false for an active instructor', () => {
    expect(isEligibleForAttendance('Active', [instructorRoleUri], ['Learner'])).toBe(false);
  });

  it('is true for a custom configured learner-role fragment', () => {
    const customRoleUri = 'http://purl.imsglobal.org/vocab/lis/v2/membership#ProxyLearner';
    expect(isEligibleForAttendance('Active', [customRoleUri], ['Learner', 'ProxyLearner'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- roster-config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// server/src/lti/roster-config.ts
//
// Resolves per-institution NRPS roster-filtering and identity-matching
// configuration (spec §18.2, §20, §52). All matching is exact-fragment
// comparison on role URNs -- never substring matching -- and institutional
// IDs are always trimmed strings, never coerced to numbers (leading
// zeroes are meaningful).

export interface NrpsRawMember {
  user_id: string;
  status: string;
  roles: string[];
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  lis_person_sourcedid?: string;
  [key: string]: unknown;
}

export interface InstitutionRosterConfig {
  canvasIdentityMatchField: string;
  identityMatchEmailEnabled: boolean;
  rosterLearnerRoles: string[];
}

export function resolveInstitutionRosterConfig(institution: {
  canvasIdentityMatchField: string;
  identityMatchEmailEnabled: boolean;
  rosterLearnerRoles: string[];
}): InstitutionRosterConfig {
  return {
    canvasIdentityMatchField: institution.canvasIdentityMatchField || 'lis_person_sourcedid',
    identityMatchEmailEnabled: Boolean(institution.identityMatchEmailEnabled),
    rosterLearnerRoles: institution.rosterLearnerRoles,
  };
}

export function resolveInstitutionalId(raw: NrpsRawMember, config: InstitutionRosterConfig): string | null {
  const field = config.canvasIdentityMatchField;
  if (field === 'email' && !config.identityMatchEmailEnabled) {
    return null;
  }
  const rawValue = field === 'email' ? raw.email : raw[field];
  if (typeof rawValue !== 'string') {
    return null;
  }
  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function roleFragment(roleUri: string): string {
  const hashIndex = roleUri.lastIndexOf('#');
  return hashIndex === -1 ? roleUri : roleUri.slice(hashIndex + 1);
}

export function isEligibleForAttendance(status: string, roles: string[], learnerRoles: string[]): boolean {
  if (status !== 'Active') {
    return false;
  }
  return roles.some((role) => learnerRoles.includes(roleFragment(role)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- roster-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/roster-config.ts server/tests/lti/roster-config.test.ts
git commit -m "feat(lti): add institution roster-filter and identity-match config resolution"
```

---

### Task 5: Extend the mock-Canvas test harness with a token endpoint and paginated NRPS endpoint

**Files:**
- Modify: `server/tests/support/mock-canvas.ts`

**Interfaces:**
- Consumes: the real Phase 3 `mock-canvas.ts` harness's existing `app`/`baseUrl`/Fastify-server-lifecycle shape — re-confirm before editing (per the re-confirm note at the top of this plan).
- Produces (new additions to the harness's returned object): `tokenUrl: string`; `nrpsUrlFor(courseId: string): string`; `setCourseMembers(courseId: string, members: NrpsRawMember[]): void`; `setPageSize(n: number): void`; `expireAccessToken(token: string): void`; `rateLimitNextRequest(courseId: string): void` (one-shot, `Retry-After: 1`); `breakPaginationNextRequest(courseId: string): void` (one-shot, returns a body without a `members` array).

- [ ] **Step 1: Read the existing harness**

Read `server/tests/support/mock-canvas.ts` in full. Confirm it already registers `@fastify/formbody` (needed to parse the token endpoint's `application/x-www-form-urlencoded` body) on its Fastify instance — if not, add `app.register(formbody)` before the routes below, importing `formbody` from `@fastify/formbody`.

- [ ] **Step 2: Add the token endpoint and NRPS endpoint routes**

Add the following state and routes to the harness's setup function (the function that builds and starts the mock Canvas Fastify server), and include the new fields in its returned object:

```ts
// --- Phase 4 additions: OAuth2 client-credentials token endpoint + NRPS ---

const issuedTokens = new Set<string>();
const expiredTokens = new Set<string>();
const courseMembersByCourseId = new Map<string, NrpsRawMember[]>();
const rateLimitOnceForCourse = new Set<string>();
const breakPaginationOnceForCourse = new Set<string>();
let nrpsPageSize = 50;

app.post('/login/oauth2/token', async (request, reply) => {
  const body = request.body as Record<string, string>;
  if (
    body.grant_type !== 'client_credentials' ||
    body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
    !body.client_assertion
  ) {
    return reply.code(400).send({ error: 'invalid_request' });
  }
  const token = `mock-access-token-${randomUUID()}`;
  issuedTokens.add(token);
  return { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: body.scope ?? '' };
});

app.get('/nrps/:courseId/members', async (request, reply) => {
  const { courseId } = request.params as { courseId: string };
  const authHeader = request.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';

  if (!issuedTokens.has(token) || expiredTokens.has(token)) {
    return reply.code(401).send({ error: 'invalid_token' });
  }

  if (rateLimitOnceForCourse.has(courseId)) {
    rateLimitOnceForCourse.delete(courseId);
    reply.header('retry-after', '1');
    return reply.code(429).send({ error: 'rate_limited' });
  }

  if (breakPaginationOnceForCourse.has(courseId)) {
    breakPaginationOnceForCourse.delete(courseId);
    return { id: `${baseUrl}/nrps/${courseId}/members`, context: {}, notMembers: [] };
  }

  const allMembers = courseMembersByCourseId.get(courseId) ?? [];
  const page = Number((request.query as { page?: string }).page ?? '1');
  const start = (page - 1) * nrpsPageSize;
  const pageMembers = allMembers.slice(start, start + nrpsPageSize);
  const hasNext = start + nrpsPageSize < allMembers.length;

  if (hasNext) {
    reply.header('link', `<${baseUrl}/nrps/${courseId}/members?page=${page + 1}>; rel="next"`);
  }
  return { id: `${baseUrl}/nrps/${courseId}/members`, context: {}, members: pageMembers };
});
```

`randomUUID` must be imported from `node:crypto`. `NrpsRawMember` should be imported from `../../src/lti/roster-config.js`.

- [ ] **Step 3: Expose the new controls on the harness's returned object**

Find the harness's `return { ... }` (or equivalent object it hands back to tests) and add:

```ts
    tokenUrl: `${baseUrl}/login/oauth2/token`,
    nrpsUrlFor: (courseId: string) => `${baseUrl}/nrps/${courseId}/members`,
    setCourseMembers: (courseId: string, members: NrpsRawMember[]) => {
      courseMembersByCourseId.set(courseId, members);
    },
    setPageSize: (n: number) => {
      nrpsPageSize = n;
    },
    expireAccessToken: (token: string) => {
      expiredTokens.add(token);
    },
    rateLimitNextRequest: (courseId: string) => {
      rateLimitOnceForCourse.add(courseId);
    },
    breakPaginationNextRequest: (courseId: string) => {
      breakPaginationOnceForCourse.add(courseId);
    },
```

- [ ] **Step 4: Self-test the harness**

Add a short test to confirm the harness itself works before relying on it, in `server/tests/support/mock-canvas-nrps.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockCanvas } from './mock-canvas.js';

describe('mock-canvas NRPS/token extensions', () => {
  let platform: Awaited<ReturnType<typeof startMockCanvas>>;

  beforeAll(async () => {
    platform = await startMockCanvas();
  });

  afterAll(async () => {
    await platform.close();
  });

  it('issues a token and serves paginated members with it', async () => {
    platform.setCourseMembers('course-1', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'] },
      { user_id: 'u2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'] },
    ]);
    platform.setPageSize(1);

    const tokenResponse = await fetch(platform.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'irrelevant-for-this-mock',
        scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

    const page1 = await fetch(platform.nrpsUrlFor('course-1'), { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(page1.status).toBe(200);
    expect(page1.headers.get('link')).toContain('page=2');
    const page1Body = (await page1.json()) as { members: unknown[] };
    expect(page1Body.members).toHaveLength(1);
  });
});
```

Adjust `startMockCanvas` above to whatever the real Phase 3 harness's setup-function name actually is.

- [ ] **Step 5: Run the self-test**

Run: `npm test -- mock-canvas-nrps.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tests/support/mock-canvas.ts server/tests/support/mock-canvas-nrps.test.ts
git commit -m "test(lti): extend mock-Canvas harness with token and paginated NRPS endpoints"
```

---

### Task 6: `token-client.ts` — client-credentials grant + access-token cache

**Files:**
- Create: `server/src/lti/token-client.ts`
- Test: `server/tests/lti/token-client.test.ts`

**Interfaces:**
- Consumes: `server/tests/support/mock-canvas.ts`'s `tokenUrl` (Task 5); a `SigningKeyRef` (`{ kid: string; privateKey: CryptoKey }`) the test constructs via `jose.generateKeyPair('RS256')` — this mirrors, but is decoupled from, Phase 3's real `getActiveSigningKey()` so this module's tests don't depend on Phase 3's signing-key storage mechanism.
- Produces: `SigningKeyRef` type; `buildClientAssertion(registration, signingKey): Promise<string>`; `getAccessToken(registration, scopes: string[], deps: { signingKey: SigningKeyRef; fetchImpl?: typeof fetch }): Promise<string>`; `clearAccessTokenCache(registrationId: string, scopes: string[]): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/lti/token-client.test.ts
import { generateKeyPair, decodeProtectedHeader, decodeJwt } from 'jose';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildClientAssertion, getAccessToken, clearAccessTokenCache, type SigningKeyRef } from '../../src/lti/token-client.js';
import { startMockCanvas } from '../support/mock-canvas.js';

describe('token-client', () => {
  let platform: Awaited<ReturnType<typeof startMockCanvas>>;
  let signingKey: SigningKeyRef;
  const registration = { id: 'reg-1', clientId: 'client-abc', tokenEndpoint: '' };

  beforeAll(async () => {
    platform = await startMockCanvas();
    registration.tokenEndpoint = platform.tokenUrl;
    const { privateKey } = await generateKeyPair('RS256');
    signingKey = { kid: 'test-kid-1', privateKey };
  });

  afterAll(async () => {
    await platform.close();
  });

  beforeEach(() => {
    clearAccessTokenCache(registration.id, ['scope-a']);
    clearAccessTokenCache(registration.id, ['scope-b']);
  });

  it('builds a client assertion with the required claims and kid', async () => {
    const assertion = await buildClientAssertion(registration, signingKey);
    const header = decodeProtectedHeader(assertion);
    const payload = decodeJwt(assertion);

    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('test-kid-1');
    expect(payload.sub).toBe('client-abc');
    expect(payload.aud).toBe(platform.tokenUrl);
    expect(typeof payload.jti).toBe('string');
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });

  it('fetches and caches an access token, reusing it on a second call with the same scopes', async () => {
    const first = await getAccessToken(registration, ['scope-a'], { signingKey });
    const second = await getAccessToken(registration, ['scope-a'], { signingKey });
    expect(second).toBe(first);
  });

  it('keeps token caches for different scope sets isolated', async () => {
    const scopeA = await getAccessToken(registration, ['scope-a'], { signingKey });
    const scopeB = await getAccessToken(registration, ['scope-b'], { signingKey });
    expect(scopeA).not.toBe(scopeB);
  });

  it('re-fetches after the cache is cleared', async () => {
    const first = await getAccessToken(registration, ['scope-a'], { signingKey });
    clearAccessTokenCache(registration.id, ['scope-a']);
    const second = await getAccessToken(registration, ['scope-a'], { signingKey });
    expect(second).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- token-client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// server/src/lti/token-client.ts
//
// OAuth 2.0 Client Credentials grant against Canvas's token endpoint
// (spec §16), using a signed JWT client assertion. Access tokens are
// cached in-memory per registration+scope-set and reused until
// approximately 60 seconds before expiry. Known limitation, accepted:
// the in-memory cache doesn't survive restarts or scale horizontally --
// fine at this app's current single-instance scale.

import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

export interface SigningKeyRef {
  kid: string;
  privateKey: CryptoKey;
}

interface TokenClientRegistration {
  id: string;
  clientId: string;
  tokenEndpoint: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(registrationId: string, scopes: string[]): string {
  return `${registrationId}:${[...scopes].sort().join(' ')}`;
}

export async function buildClientAssertion(registration: TokenClientRegistration, signingKey: SigningKeyRef): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: signingKey.kid })
    .setSubject(registration.clientId)
    .setIssuer(registration.clientId)
    .setAudience(registration.tokenEndpoint)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .setJti(randomUUID())
    .sign(signingKey.privateKey);
}

export async function getAccessToken(
  registration: TokenClientRegistration,
  scopes: string[],
  deps: { signingKey: SigningKeyRef; fetchImpl?: typeof fetch },
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const key = cacheKey(registration.id, scopes);
  const cached = tokenCache.get(key);
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - 60_000 > nowMs) {
    return cached.accessToken;
  }

  const assertion = await buildClientAssertion(registration, deps.signingKey);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
    scope: scopes.join(' '),
  });

  const response = await fetchImpl(registration.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Canvas token endpoint returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache.set(key, { accessToken: json.access_token, expiresAtMs: nowMs + json.expires_in * 1000 });
  return json.access_token;
}

export function clearAccessTokenCache(registrationId: string, scopes: string[]): void {
  tokenCache.delete(cacheKey(registrationId, scopes));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- token-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: clean. (If `CryptoKey` is not recognized as a global type, add `"lib": ["ES2022", "DOM"]` is not appropriate for a server package — instead confirm `@types/node`'s version in `package.json` includes `CryptoKey` in its `node:crypto`/global webcrypto types; Node 22+'s bundled types provide this. If a type error appears, use `import type { KeyObject } from 'node:crypto';` and widen `SigningKeyRef.privateKey` to `CryptoKey | KeyObject` instead.)

- [ ] **Step 6: Commit**

```bash
git add server/src/lti/token-client.ts server/tests/lti/token-client.test.ts
git commit -m "feat(lti): add Canvas client-credentials token client with caching"
```

---

### Task 7: `nrps.ts` part 1 — fixed contract types + `fetchRawMembershipPages`

**Files:**
- Create: `server/src/lti/nrps.ts`
- Test: `server/tests/lti/nrps.test.ts`

**Interfaces:**
- Consumes: `NrpsRawMember` from `roster-config.ts` (Task 4); `server/tests/support/mock-canvas.ts`'s `nrpsUrlFor`/`setCourseMembers`/`setPageSize`/`breakPaginationNextRequest` (Task 5).
- Produces: `CourseRosterMember` type, `CourseRosterResult` type (the fixed contract, exact shape reproduced at the top of this plan document), `fetchRawMembershipPages(nrpsUrl: string, accessToken: string, deps?: { fetchImpl?: typeof fetch }): Promise<{ ok: true; members: NrpsRawMember[] } | { ok: false; error: { kind: 'pagination-failure' | 'expired-token' | 'rate-limited' | 'network' | 'http-status' | 'bad-json'; message: string; retryable: boolean; retryAfterSeconds?: number } }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/lti/nrps.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetchRawMembershipPages } from '../../src/lti/nrps.js';
import { startMockCanvas } from '../support/mock-canvas.js';

describe('fetchRawMembershipPages', () => {
  let platform: Awaited<ReturnType<typeof startMockCanvas>>;
  let accessToken: string;

  beforeAll(async () => {
    platform = await startMockCanvas();
    const tokenResponse = await fetch(platform.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'irrelevant-for-this-mock',
        scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
      }),
    });
    ({ access_token: accessToken } = (await tokenResponse.json()) as { access_token: string });
  });

  afterAll(async () => {
    await platform.close();
  });

  it('follows Link-header pagination across multiple pages', async () => {
    platform.setCourseMembers('course-multi', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
      { user_id: 'u3', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-multi'), accessToken);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members.map((m) => m.user_id)).toEqual(['u1', 'u2', 'u3']);
    }
  });

  it('reports a pagination-failure when a page response has no members array', async () => {
    platform.setCourseMembers('course-broken', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    platform.breakPaginationNextRequest('course-broken');

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-broken'), accessToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('pagination-failure');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('reports expired-token on a 401', async () => {
    platform.setCourseMembers('course-expired', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    platform.expireAccessToken(accessToken);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-expired'), accessToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('expired-token');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('reports rate-limited with the Retry-After value on a 429', async () => {
    platform.setCourseMembers('course-429', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    platform.rateLimitNextRequest('course-429');

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-429'), accessToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });
});
```

Note: the `expired-token` test reuses a real token minted earlier in the suite, then expires it — run this test file with Vitest's default sequential-within-file execution (the default) so `platform.expireAccessToken(accessToken)` in one test doesn't leak into an earlier already-completed test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- nrps.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// server/src/lti/nrps.ts
//
// Fetches and normalizes a course's Canvas roster via NRPS (spec §18).
// `CourseRosterMember`/`CourseRosterResult`/`refreshCourseRoster` form a
// fixed contract Phase 5's `createSession` snapshots verbatim -- do not
// rename or reshape without updating Phase 5's plan document too.

import type { NrpsRawMember } from './roster-config.js';

export interface CourseRosterMember {
  ltiUserId: string;
  institutionalId: string | null;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  roles: string[];
  status: string;
  eligibleForAttendance: boolean;
}

export type CourseRosterErrorKind =
  | 'invalid-service-url'
  | 'expired-token'
  | 'rate-limited'
  | 'pagination-failure'
  | 'network'
  | 'http-status'
  | 'bad-json';

export type CourseRosterResult =
  | { ok: true; members: CourseRosterMember[]; fetchedAt: string }
  | { ok: false; error: { kind: CourseRosterErrorKind; message: string; retryable: boolean } };

interface RawPagesError {
  kind: CourseRosterErrorKind;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

export type FetchRawMembershipPagesResult = { ok: true; members: NrpsRawMember[] } | { ok: false; error: RawPagesError };

const MAX_PAGES = 100;

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return null;
}

export async function fetchRawMembershipPages(
  nrpsUrl: string,
  accessToken: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<FetchRawMembershipPagesResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const members: NrpsRawMember[] = [];
  let nextUrl: string | null = nrpsUrl;
  let pageCount = 0;

  while (nextUrl) {
    if (pageCount >= MAX_PAGES) {
      return { ok: false, error: { kind: 'pagination-failure', message: `Exceeded maximum of ${MAX_PAGES} NRPS pages.`, retryable: false } };
    }
    pageCount += 1;

    let response: Response;
    try {
      response = await fetchImpl(nextUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json',
        },
        redirect: 'manual',
      });
    } catch (err) {
      return {
        ok: false,
        error: { kind: 'network', message: err instanceof Error ? err.message : 'Network error fetching NRPS page.', retryable: true },
      };
    }

    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: { kind: 'pagination-failure', message: 'NRPS response was a redirect; redirects are not followed.', retryable: false } };
    }
    if (response.status === 401) {
      return { ok: false, error: { kind: 'expired-token', message: 'Canvas rejected the access token as expired or invalid.', retryable: true } };
    }
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      return {
        ok: false,
        error: {
          kind: 'rate-limited',
          message: `Canvas rate-limited the NRPS request (Retry-After: ${retryAfterHeader ?? 'unspecified'}).`,
          retryable: true,
          retryAfterSeconds,
        },
      };
    }
    if (!response.ok) {
      return { ok: false, error: { kind: 'http-status', message: `NRPS returned HTTP ${response.status}.`, retryable: false } };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, error: { kind: 'bad-json', message: 'NRPS response body was not valid JSON.', retryable: false } };
    }

    if (typeof json !== 'object' || json === null || !Array.isArray((json as { members?: unknown }).members)) {
      return { ok: false, error: { kind: 'pagination-failure', message: 'NRPS response was missing a "members" array.', retryable: false } };
    }
    members.push(...(json as { members: NrpsRawMember[] }).members);

    nextUrl = parseNextLink(response.headers.get('link'));
  }

  return { ok: true, members };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- nrps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/nrps.ts server/tests/lti/nrps.test.ts
git commit -m "feat(lti): add paginated NRPS membership fetching"
```

---

### Task 8: `nrps.ts` part 2 — `normalizeMember`

**Files:**
- Modify: `server/src/lti/nrps.ts`
- Modify: `server/tests/lti/nrps.test.ts`

**Interfaces:**
- Consumes: `resolveInstitutionalId`/`isEligibleForAttendance`/`InstitutionRosterConfig`/`NrpsRawMember` from `roster-config.ts` (Task 4); `CourseRosterMember` (Task 7, same file).
- Produces: `normalizeMember(raw: NrpsRawMember, config: InstitutionRosterConfig): CourseRosterMember`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/lti/nrps.test.ts`:

```ts
import { normalizeMember } from '../../src/lti/nrps.js';
import type { InstitutionRosterConfig } from '../../src/lti/roster-config.js';

describe('normalizeMember', () => {
  const config: InstitutionRosterConfig = {
    canvasIdentityMatchField: 'lis_person_sourcedid',
    identityMatchEmailEnabled: false,
    rosterLearnerRoles: ['Learner'],
  };
  const learnerRole = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
  const instructorRole = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

  it('normalizes an active learner as eligible', () => {
    const raw = {
      user_id: 'u1',
      status: 'Active',
      roles: [learnerRole],
      name: 'Jane Student',
      given_name: 'Jane',
      family_name: 'Student',
      email: 'jane@example.edu',
      lis_person_sourcedid: '001234',
    };
    const member = normalizeMember(raw, config);
    expect(member).toEqual({
      ltiUserId: 'u1',
      institutionalId: '001234',
      displayName: 'Jane Student',
      givenName: 'Jane',
      familyName: 'Student',
      email: 'jane@example.edu',
      roles: [learnerRole],
      status: 'Active',
      eligibleForAttendance: true,
    });
  });

  it('normalizes an inactive learner as ineligible', () => {
    const raw = { user_id: 'u2', status: 'Inactive', roles: [learnerRole] };
    expect(normalizeMember(raw, config).eligibleForAttendance).toBe(false);
  });

  it('excludes an instructor from eligibility', () => {
    const raw = { user_id: 'u3', status: 'Active', roles: [instructorRole] };
    expect(normalizeMember(raw, config).eligibleForAttendance).toBe(false);
  });

  it('honors a custom configured learner role', () => {
    const customConfig: InstitutionRosterConfig = { ...config, rosterLearnerRoles: ['Learner', 'ProxyLearner'] };
    const raw = { user_id: 'u4', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#ProxyLearner'] };
    expect(normalizeMember(raw, customConfig).eligibleForAttendance).toBe(true);
  });

  it('leaves institutionalId null when the SIS ID field is missing', () => {
    const raw = { user_id: 'u5', status: 'Active', roles: [learnerRole] };
    expect(normalizeMember(raw, config).institutionalId).toBeNull();
  });

  it('normalizes two members sharing the same institutionalId independently (no dedup)', () => {
    const rawA = { user_id: 'u6', status: 'Active', roles: [learnerRole], lis_person_sourcedid: 'DUP1' };
    const rawB = { user_id: 'u7', status: 'Active', roles: [learnerRole], lis_person_sourcedid: 'DUP1' };
    const memberA = normalizeMember(rawA, config);
    const memberB = normalizeMember(rawB, config);
    expect(memberA.institutionalId).toBe('DUP1');
    expect(memberB.institutionalId).toBe('DUP1');
    expect(memberA.ltiUserId).not.toBe(memberB.ltiUserId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- nrps.test.ts`
Expected: FAIL (`normalizeMember` not exported).

- [ ] **Step 3: Implement**

Append to `server/src/lti/nrps.ts` (add the import at the top alongside the existing `NrpsRawMember` import):

```ts
import { resolveInstitutionalId, isEligibleForAttendance, type InstitutionRosterConfig } from './roster-config.js';
```

```ts
export function normalizeMember(raw: NrpsRawMember, config: InstitutionRosterConfig): CourseRosterMember {
  const roles = Array.isArray(raw.roles) ? raw.roles : [];
  return {
    ltiUserId: raw.user_id,
    institutionalId: resolveInstitutionalId(raw, config),
    displayName: raw.name ?? null,
    givenName: raw.given_name ?? null,
    familyName: raw.family_name ?? null,
    email: raw.email ?? null,
    roles,
    status: raw.status,
    eligibleForAttendance: isEligibleForAttendance(raw.status, roles, config.rosterLearnerRoles),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- nrps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/nrps.ts server/tests/lti/nrps.test.ts
git commit -m "feat(lti): normalize raw NRPS members into the CourseRosterMember contract"
```

---

### Task 9: `roster-store.ts` — `upsertCourseMembers`

**Files:**
- Create: `server/src/attendance/roster-store.ts`
- Test: `server/tests/attendance/roster-store.test.ts`

**Interfaces:**
- Consumes: `db` from `server/src/database/client.js`; `courseMembers`/`courses` from `server/src/database/schema.js` (Task 1); `CourseRosterMember` from `../lti/nrps.js` (Task 7, type-only import — no runtime circular dependency).
- Produces: `CourseMemberRow` type (`typeof courseMembers.$inferSelect`); `UpsertRosterSummary` type (`{ added: number; removed: number; unchanged: number }`); `upsertCourseMembers(courseId: string, members: CourseRosterMember[]): Promise<UpsertRosterSummary>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/attendance/roster-store.test.ts
import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/database/client.js';
import { institutions, courses, courseMembers } from '../../src/database/schema.js';
import { upsertCourseMembers } from '../../src/attendance/roster-store.js';
import type { CourseRosterMember } from '../../src/lti/nrps.js';
import { resetDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';

function member(overrides: Partial<CourseRosterMember> & { ltiUserId: string }): CourseRosterMember {
  return {
    institutionalId: null,
    displayName: null,
    givenName: null,
    familyName: null,
    email: null,
    roles: [],
    status: 'Active',
    eligibleForAttendance: true,
    ...overrides,
  };
}

describe('upsertCourseMembers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('adds new members, marks dropped members removed (not deleted), and leaves unchanged members alone', async () => {
    const { courseId } = await seedInstitutionAndCourse();

    const firstRefresh = await upsertCourseMembers(courseId, [
      member({ ltiUserId: 'u1', institutionalId: '001' }),
      member({ ltiUserId: 'u2', institutionalId: '002' }),
    ]);
    expect(firstRefresh).toEqual({ added: 2, removed: 0, unchanged: 0 });

    const secondRefresh = await upsertCourseMembers(courseId, [
      member({ ltiUserId: 'u1', institutionalId: '001' }),
      member({ ltiUserId: 'u3', institutionalId: '003' }),
    ]);
    expect(secondRefresh).toEqual({ added: 1, removed: 1, unchanged: 1 });

    const rows = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(rows).toHaveLength(3);
    const u2 = rows.find((r) => r.ltiUserId === 'u2');
    expect(u2?.status).toBe('removed');
    const u1 = rows.find((r) => r.ltiUserId === 'u1');
    expect(u1?.status).toBe('Active');
  });

  it('updates courses.rosterCachedAt on every call', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    const before = Date.now();
    await upsertCourseMembers(courseId, [member({ ltiUserId: 'u1' })]);
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
    expect(course.rosterCachedAt).not.toBeNull();
    expect(course.rosterCachedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
```

- [ ] **Step 2: Add the `seedInstitutionAndCourse` test helper if it doesn't already exist**

Check `server/tests/support/seed.ts` for an existing helper of this shape. If Phase 3's `seedInstitutionAndRegistration` already produces an institution+registration+deployment but not a `courses` row, add:

```ts
// server/tests/support/seed.ts (append)
import { courses } from '../../src/database/schema.js';
import { db } from '../../src/database/client.js';

export async function seedInstitutionAndCourse(): Promise<{ institutionId: string; courseId: string }> {
  const { institutionId, deploymentId } = await seedInstitutionAndRegistration();
  const [course] = await db
    .insert(courses)
    .values({
      institutionId,
      deploymentId,
      ltiContextId: `course-${crypto.randomUUID()}`,
      label: 'TEST-101',
      title: 'Test Course',
    })
    .returning();
  return { institutionId, courseId: course.id };
}
```

Adjust field names to whatever `seedInstitutionAndRegistration`'s real Phase 3 return shape is (re-confirm per the top-of-plan note) — it must return at least an `institutionId` and a `deploymentId` usable as `courses.deploymentId`'s FK target.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- roster-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// server/src/attendance/roster-store.ts
//
// Persists the Canvas roster fetched by lti/nrps.ts into course_members.
// Never deletes a row that drops off the roster -- it's marked
// status: 'removed' instead, so nothing holding a course_members.id
// (e.g. a historical attendance_session_members snapshot in Phase 5)
// ever dangles.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../database/client.js';
import { courseMembers, courses } from '../database/schema.js';
import type { CourseRosterMember } from '../lti/nrps.js';

export type CourseMemberRow = typeof courseMembers.$inferSelect;

export interface UpsertRosterSummary {
  added: number;
  removed: number;
  unchanged: number;
}

export async function upsertCourseMembers(courseId: string, members: CourseRosterMember[]): Promise<UpsertRosterSummary> {
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    const existingByLtiUserId = new Map(existing.map((row) => [row.ltiUserId, row]));
    const freshLtiUserIds = new Set(members.map((m) => m.ltiUserId));

    let added = 0;
    let unchanged = 0;

    for (const member of members) {
      if (existingByLtiUserId.has(member.ltiUserId)) {
        unchanged += 1;
      } else {
        added += 1;
      }

      await tx
        .insert(courseMembers)
        .values({
          courseId,
          ltiUserId: member.ltiUserId,
          institutionalId: member.institutionalId,
          displayName: member.displayName,
          givenName: member.givenName,
          familyName: member.familyName,
          email: member.email,
          roles: member.roles,
          status: member.status,
          lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [courseMembers.courseId, courseMembers.ltiUserId],
          set: {
            institutionalId: member.institutionalId,
            displayName: member.displayName,
            givenName: member.givenName,
            familyName: member.familyName,
            email: member.email,
            roles: member.roles,
            status: member.status,
            lastSeenAt: new Date(),
          },
        });
    }

    const droppedLtiUserIds = existing
      .filter((row) => !freshLtiUserIds.has(row.ltiUserId) && row.status !== 'removed')
      .map((row) => row.ltiUserId);

    if (droppedLtiUserIds.length > 0) {
      await tx
        .update(courseMembers)
        .set({ status: 'removed', lastSeenAt: new Date() })
        .where(and(eq(courseMembers.courseId, courseId), inArray(courseMembers.ltiUserId, droppedLtiUserIds)));
    }

    await tx.update(courses).set({ rosterCachedAt: new Date() }).where(eq(courses.id, courseId));

    return { added, removed: droppedLtiUserIds.length, unchanged };
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- roster-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/attendance/roster-store.ts server/tests/attendance/roster-store.test.ts server/tests/support/seed.ts
git commit -m "feat(attendance): add course-member roster upsert with removed-not-deleted semantics"
```

---

### Task 10: `roster-store.ts` — staleness check, cached-roster read, duplicate-preserving lookup

**Files:**
- Modify: `server/src/attendance/roster-store.ts`
- Modify: `server/tests/attendance/roster-store.test.ts`

**Interfaces:**
- Produces: `isRosterStale(rosterCachedAt: Date | null, nowMs?: number): boolean`; `getCachedRoster(courseId: string): Promise<{ members: CourseMemberRow[]; rosterCachedAt: Date | null } | null>`; `findCourseMembersByInstitutionalId(courseId: string, institutionalId: string): Promise<CourseMemberRow[]>`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/attendance/roster-store.test.ts`:

```ts
import { isRosterStale, getCachedRoster, findCourseMembersByInstitutionalId } from '../../src/attendance/roster-store.js';

describe('isRosterStale', () => {
  it('is stale when there is no cached timestamp', () => {
    expect(isRosterStale(null)).toBe(true);
  });

  it('is not stale within the 5-minute TTL', () => {
    const now = Date.now();
    expect(isRosterStale(new Date(now - 4 * 60 * 1000), now)).toBe(false);
  });

  it('is stale past the 5-minute TTL', () => {
    const now = Date.now();
    expect(isRosterStale(new Date(now - 6 * 60 * 1000), now)).toBe(true);
  });
});

describe('getCachedRoster', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null for a course with no roster row', async () => {
    expect(await getCachedRoster('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('returns the cached members and cache timestamp after an upsert', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    await upsertCourseMembers(courseId, [member({ ltiUserId: 'u1', institutionalId: '001' })]);

    const cached = await getCachedRoster(courseId);
    expect(cached).not.toBeNull();
    expect(cached!.members).toHaveLength(1);
    expect(cached!.rosterCachedAt).not.toBeNull();
  });
});

describe('findCourseMembersByInstitutionalId', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns every member sharing an institutionalId, never merging or dropping duplicates', async () => {
    const { courseId } = await seedInstitutionAndCourse();
    await upsertCourseMembers(courseId, [
      member({ ltiUserId: 'u1', institutionalId: 'DUP1' }),
      member({ ltiUserId: 'u2', institutionalId: 'DUP1' }),
      member({ ltiUserId: 'u3', institutionalId: 'UNIQUE' }),
    ]);

    const dupes = await findCourseMembersByInstitutionalId(courseId, 'DUP1');
    expect(dupes).toHaveLength(2);
    expect(dupes.map((m) => m.ltiUserId).sort()).toEqual(['u1', 'u2']);

    const unique = await findCourseMembersByInstitutionalId(courseId, 'UNIQUE');
    expect(unique).toHaveLength(1);

    const none = await findCourseMembersByInstitutionalId(courseId, 'NOPE');
    expect(none).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- roster-store.test.ts`
Expected: FAIL (`isRosterStale`/`getCachedRoster`/`findCourseMembersByInstitutionalId` not exported).

- [ ] **Step 3: Implement**

Append to `server/src/attendance/roster-store.ts`:

```ts
const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000;

export function isRosterStale(rosterCachedAt: Date | null, nowMs: number = Date.now()): boolean {
  if (rosterCachedAt === null) {
    return true;
  }
  return nowMs - rosterCachedAt.getTime() > ROSTER_CACHE_TTL_MS;
}

export async function getCachedRoster(courseId: string): Promise<{ members: CourseMemberRow[]; rosterCachedAt: Date | null } | null> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  if (!course) {
    return null;
  }
  const members = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
  return { members, rosterCachedAt: course.rosterCachedAt };
}

export async function findCourseMembersByInstitutionalId(courseId: string, institutionalId: string): Promise<CourseMemberRow[]> {
  return db
    .select()
    .from(courseMembers)
    .where(and(eq(courseMembers.courseId, courseId), eq(courseMembers.institutionalId, institutionalId)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- roster-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/roster-store.ts server/tests/attendance/roster-store.test.ts
git commit -m "feat(attendance): add roster-staleness check and duplicate-preserving member lookup"
```

---

### Task 11: `nrps.ts` part 3 — `refreshCourseRoster` orchestrator

**Files:**
- Modify: `server/src/lti/nrps.ts`
- Modify: `server/tests/lti/nrps.test.ts`

**Interfaces:**
- Consumes: `validateCanvasServiceUrl` (Task 3); `getAccessToken`/`clearAccessTokenCache`/`SigningKeyRef` (Task 6); `NRPS_MEMBERSHIP_READONLY_SCOPE` (Task 2); `resolveInstitutionRosterConfig` (Task 4); `upsertCourseMembers` (Task 9); `fetchRawMembershipPages`/`normalizeMember` (Tasks 7-8, same file); `db`/`courses`/`institutions`/`ltiDeployments`/`ltiRegistrations` from `server/src/database/schema.js`.
- Produces: `refreshCourseRoster(courseId: string, deps?: { fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>; maxRateLimitRetries?: number }): Promise<CourseRosterResult>` — the fixed-contract function.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/lti/nrps.test.ts`:

```ts
import { refreshCourseRoster } from '../../src/lti/nrps.js';
import { db } from '../../src/database/client.js';
import { courses, courseMembers } from '../../src/database/schema.js';
import { eq } from 'drizzle-orm';
import { resetDb } from '../support/db.js';
import { seedInstitutionAndCourseWithRegistration } from '../support/seed.js';

describe('refreshCourseRoster', () => {
  let platform: Awaited<ReturnType<typeof startMockCanvas>>;

  beforeAll(async () => {
    platform = await startMockCanvas();
  });

  afterAll(async () => {
    await platform.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it('fetches, normalizes, and persists the roster on a successful launch context', async () => {
    const { courseId } = await seedInstitutionAndCourseWithRegistration(platform, { nrpsUrl: platform.nrpsUrlFor('course-a') });
    platform.setCourseMembers('course-a', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '001' },
    ]);

    const result = await refreshCourseRoster(courseId, { sleepImpl: async () => {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(1);
      expect(result.members[0].institutionalId).toBe('001');
    }
    const rows = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(rows).toHaveLength(1);
  });

  it('retries once after clearing the token cache on an expired token, then succeeds', async () => {
    const { courseId, registrationId } = await seedInstitutionAndCourseWithRegistration(platform, {
      nrpsUrl: platform.nrpsUrlFor('course-b'),
    });
    platform.setCourseMembers('course-b', [{ user_id: 'u1', status: 'Active', roles: [] }]);

    // Prime the cache with a token, then expire it server-side so the
    // first NRPS call inside refreshCourseRoster gets a 401.
    const primingResult = await refreshCourseRoster(courseId, { sleepImpl: async () => {} });
    expect(primingResult.ok).toBe(true);

    // Simulate the cached token going stale on Canvas's side without our
    // cache knowing yet.
    const cachedTokenResponse = await fetch(platform.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'irrelevant',
        scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
      }),
    });
    // This call doesn't affect our real cache directly; instead we force
    // the *actually cached* token to fail by expiring every token this
    // registration+scope pair could have cached. Simplest reliable way:
    // clear our own cache's underlying token via clearAccessTokenCache
    // isn't exported for this scope from here, so instead expire every
    // token the platform has issued so far, forcing a real 401 on the
    // next NRPS call before refreshCourseRoster's own retry-once logic
    // clears its cache and re-authenticates.
    void cachedTokenResponse;
    expect(true).toBe(true); // placeholder assertion removed below
  });

  it('retries after a 429, honoring Retry-After, then succeeds', async () => {
    const { courseId } = await seedInstitutionAndCourseWithRegistration(platform, { nrpsUrl: platform.nrpsUrlFor('course-c') });
    platform.setCourseMembers('course-c', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    platform.rateLimitNextRequest('course-c');

    const result = await refreshCourseRoster(courseId, { sleepImpl: async () => {} });

    expect(result.ok).toBe(true);
  });

  it('fails with invalid-service-url when the course has no nrpsUrl', async () => {
    const { courseId } = await seedInstitutionAndCourseWithRegistration(platform, { nrpsUrl: null });

    const result = await refreshCourseRoster(courseId, { sleepImpl: async () => {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-service-url');
    }
  });
});
```

The second test above (`retries once after clearing the token cache on an expired token`) is intentionally left with a placeholder-free but weak assertion because reliably forcing our real in-memory `token-client.ts` cache to hold an already-expired-on-Canvas's-side token requires either exposing `clearAccessTokenCache`'s cache key from `nrps.ts` or controlling wall-clock time. Replace it with the following, which does both precisely, before moving to Step 2:

```ts
  it('retries once after clearing the token cache on an expired token, then succeeds', async () => {
    const { courseId } = await seedInstitutionAndCourseWithRegistration(platform, { nrpsUrl: platform.nrpsUrlFor('course-b') });
    platform.setCourseMembers('course-b', [{ user_id: 'u1', status: 'Active', roles: [] }]);

    const firstResult = await refreshCourseRoster(courseId, { sleepImpl: async () => {} });
    expect(firstResult.ok).toBe(true);

    // Extract the access token our cache is now holding by observing the
    // Authorization header on the next NRPS request via a spying fetchImpl,
    // then expire exactly that token on the mock platform and refresh again.
    let capturedToken: string | undefined;
    const spyFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');
      if (auth?.startsWith('Bearer ') && typeof input === 'string' && input.includes('/nrps/')) {
        capturedToken = auth.slice('Bearer '.length);
      }
      return fetch(input, init);
    };
    await refreshCourseRoster(courseId, { fetchImpl: spyFetch, sleepImpl: async () => {} });
    expect(capturedToken).toBeDefined();

    platform.expireAccessToken(capturedToken!);
    const retriedResult = await refreshCourseRoster(courseId, { sleepImpl: async () => {} });

    expect(retriedResult.ok).toBe(true);
  });
```

- [ ] **Step 2: Add the `seedInstitutionAndCourseWithRegistration` test helper**

Add to `server/tests/support/seed.ts`, adjusting field names to the real Phase 3 `institutions`/`ltiRegistrations`/`ltiDeployments` schema (re-confirm per the top-of-plan note):

```ts
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';

export async function seedInstitutionAndCourseWithRegistration(
  platform: { tokenUrl: string },
  options: { nrpsUrl: string | null },
): Promise<{ institutionId: string; courseId: string; registrationId: string }> {
  const [institution] = await db
    .insert(institutions)
    .values({ slug: `test-${crypto.randomUUID()}`, displayName: 'Test University', timezone: 'America/New_York', enabled: true })
    .returning();

  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://canvas.example.edu',
      clientId: `client-${crypto.randomUUID()}`,
      oidcAuthEndpoint: 'https://canvas.example.edu/api/lti/authorize_redirect',
      tokenEndpoint: platform.tokenUrl,
      tokenAudience: platform.tokenUrl,
      platformJwksUri: 'https://canvas.example.edu/api/lti/security/jwks',
      enabled: true,
    })
    .returning();

  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: `deploy-${crypto.randomUUID()}`, enabled: true })
    .returning();

  const [course] = await db
    .insert(courses)
    .values({
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiContextId: `course-${crypto.randomUUID()}`,
      label: 'TEST-101',
      title: 'Test Course',
      nrpsUrl: options.nrpsUrl,
    })
    .returning();

  return { institutionId: institution.id, courseId: course.id, registrationId: registration.id };
}
```

Note `platform.tokenUrl` is used as both `tokenEndpoint` and the trusted-host source for `validateCanvasServiceUrl` — this only works because `service-url.ts`'s host check compares against `new URL(registration.tokenEndpoint).host`, and the mock platform's NRPS URL shares the same host/port as its token URL (both come from the same in-process Fastify server's `baseUrl`).

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- nrps.test.ts`
Expected: FAIL (`refreshCourseRoster` not exported).

- [ ] **Step 4: Implement**

Append to `server/src/lti/nrps.ts` (add these imports at the top alongside the existing ones):

```ts
import { eq } from 'drizzle-orm';
import { db } from '../database/client.js';
import { courses, institutions, ltiDeployments, ltiRegistrations } from '../database/schema.js';
import { validateCanvasServiceUrl } from './service-url.js';
import { getAccessToken, clearAccessTokenCache, type SigningKeyRef } from './token-client.js';
import { getActiveSigningKey } from './signing-keys.js';
import { NRPS_MEMBERSHIP_READONLY_SCOPE } from './scopes.js';
```

**Re-confirm** `getActiveSigningKey`'s real export name/path from Phase 3's `server/src/lti/signing-keys.ts` before this import — this plan assumes it exists and returns `Promise<SigningKeyRef>` (`{ kid: string; privateKey: CryptoKey }`); adapt if the real shape differs.

```ts
async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CourseRosterContext {
  courseId: string;
  nrpsUrl: string | null;
  registration: { id: string; clientId: string; tokenEndpoint: string };
  institution: { canvasIdentityMatchField: string; identityMatchEmailEnabled: boolean; rosterLearnerRoles: string[] };
}

async function loadCourseRosterContext(courseId: string): Promise<CourseRosterContext | null> {
  const rows = await db
    .select({
      courseId: courses.id,
      nrpsUrl: courses.nrpsUrl,
      institutionId: institutions.id,
      canvasIdentityMatchField: institutions.canvasIdentityMatchField,
      identityMatchEmailEnabled: institutions.identityMatchEmailEnabled,
      rosterLearnerRoles: institutions.rosterLearnerRoles,
      registrationId: ltiRegistrations.id,
      registrationClientId: ltiRegistrations.clientId,
      registrationTokenEndpoint: ltiRegistrations.tokenEndpoint,
    })
    .from(courses)
    .innerJoin(institutions, eq(courses.institutionId, institutions.id))
    .innerJoin(ltiDeployments, eq(courses.deploymentId, ltiDeployments.id))
    .innerJoin(ltiRegistrations, eq(ltiDeployments.registrationId, ltiRegistrations.id))
    .where(eq(courses.id, courseId));

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    courseId: row.courseId,
    nrpsUrl: row.nrpsUrl,
    registration: { id: row.registrationId, clientId: row.registrationClientId, tokenEndpoint: row.registrationTokenEndpoint },
    institution: {
      canvasIdentityMatchField: row.canvasIdentityMatchField,
      identityMatchEmailEnabled: row.identityMatchEmailEnabled,
      rosterLearnerRoles: row.rosterLearnerRoles,
    },
  };
}

export interface RefreshCourseRosterDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

export async function refreshCourseRoster(courseId: string, deps: RefreshCourseRosterDeps = {}): Promise<CourseRosterResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const maxRateLimitRetries = deps.maxRateLimitRetries ?? 3;

  const context = await loadCourseRosterContext(courseId);
  if (!context) {
    return { ok: false, error: { kind: 'invalid-service-url', message: `Course ${courseId} not found.`, retryable: false } };
  }
  if (!context.nrpsUrl) {
    return { ok: false, error: { kind: 'invalid-service-url', message: 'Course has no NRPS service URL from its launch context.', retryable: false } };
  }

  const urlCheck = validateCanvasServiceUrl(context.nrpsUrl, context.registration);
  if (!urlCheck.ok) {
    return { ok: false, error: { kind: 'invalid-service-url', message: `NRPS URL failed validation: ${urlCheck.error}`, retryable: false } };
  }

  const rosterConfig = resolveInstitutionRosterConfig(context.institution);
  const signingKey: SigningKeyRef = await getActiveSigningKey();

  let tokenRetried = false;
  let rateLimitAttempt = 0;

  for (;;) {
    const accessToken = await getAccessToken(context.registration, [NRPS_MEMBERSHIP_READONLY_SCOPE], { signingKey, fetchImpl });
    const pages = await fetchRawMembershipPages(context.nrpsUrl, accessToken, { fetchImpl });

    if (pages.ok) {
      const members = pages.members.map((raw) => normalizeMember(raw, rosterConfig));
      const fetchedAt = new Date().toISOString();
      await upsertCourseMembers(courseId, members);
      return { ok: true, members, fetchedAt };
    }

    if (pages.error.kind === 'expired-token' && !tokenRetried) {
      tokenRetried = true;
      clearAccessTokenCache(context.registration.id, [NRPS_MEMBERSHIP_READONLY_SCOPE]);
      continue;
    }

    if (pages.error.kind === 'rate-limited' && rateLimitAttempt < maxRateLimitRetries) {
      rateLimitAttempt += 1;
      await sleepImpl((pages.error.retryAfterSeconds ?? 1) * 1000);
      continue;
    }

    return { ok: false, error: { kind: pages.error.kind, message: pages.error.message, retryable: pages.error.retryable } };
  }
}
```

Add the import for `upsertCourseMembers` and `resolveInstitutionRosterConfig` at the top of the file alongside the others:

```ts
import { upsertCourseMembers } from '../attendance/roster-store.js';
import { resolveInstitutionRosterConfig } from './roster-config.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- nrps.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite, typecheck, and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/lti/nrps.ts server/tests/lti/nrps.test.ts server/tests/support/seed.ts
git commit -m "feat(lti): add refreshCourseRoster orchestrator with token-retry and rate-limit backoff"
```

---

### Task 12: `GET /api/course/roster` route

**Files:**
- Create: `server/src/routes/course-roster.ts`
- Test: `server/tests/routes/course-roster.test.ts`

**Interfaces:**
- Consumes: `getCachedRoster`/`isRosterStale` (Task 10); `refreshCourseRoster` (Task 11); `requireSession` preHandler from `server/src/auth/middleware.js` (Phase 3 — re-confirm shape) decorating `request.appSession: { courseId: string; ... }`.
- Produces: `registerCourseRosterRoutes(app: FastifyInstance): void` (registers both `GET /api/course/roster` here and `POST /api/course/roster/refresh` in Task 13, same file, same registration function).

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/routes/course-roster.test.ts
import Fastify from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerCourseRosterRoutes } from '../../src/routes/course-roster.js';

const mockRefreshCourseRoster = vi.fn();
const mockGetCachedRoster = vi.fn();

vi.mock('../../src/lti/nrps.js', () => ({
  refreshCourseRoster: (...args: unknown[]) => mockRefreshCourseRoster(...args),
}));
vi.mock('../../src/attendance/roster-store.js', () => ({
  getCachedRoster: (...args: unknown[]) => mockGetCachedRoster(...args),
  isRosterStale: (rosterCachedAt: Date | null) => rosterCachedAt === null || Date.now() - rosterCachedAt.getTime() > 5 * 60 * 1000,
}));

function buildTestApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    (request as { appSession?: unknown }).appSession = { courseId: 'course-1', institutionId: 'inst-1', ltiSubject: 'sub-1' };
  });
  registerCourseRosterRoutes(app);
  return app;
}

describe('GET /api/course/roster', () => {
  beforeEach(() => {
    mockRefreshCourseRoster.mockReset();
    mockGetCachedRoster.mockReset();
  });

  it('serves the cache without refreshing when it is fresh', async () => {
    mockGetCachedRoster.mockResolvedValue({
      members: [{ ltiUserId: 'u1', institutionalId: '001', displayName: 'Jane', givenName: null, familyName: null, email: null, roles: [], status: 'Active', lastSeenAt: new Date() }],
      rosterCachedAt: new Date(),
    });

    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(response.statusCode).toBe(200);
    expect(response.json().stale).toBe(false);
    expect(mockRefreshCourseRoster).not.toHaveBeenCalled();
  });

  it('refreshes inline when the cache is stale', async () => {
    mockGetCachedRoster.mockResolvedValue({ members: [], rosterCachedAt: new Date(Date.now() - 10 * 60 * 1000) });
    mockRefreshCourseRoster.mockResolvedValue({
      ok: true,
      fetchedAt: new Date().toISOString(),
      members: [{ ltiUserId: 'u1', institutionalId: '001', displayName: null, givenName: null, familyName: null, email: null, roles: [], status: 'Active', eligibleForAttendance: true }],
    });

    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(response.statusCode).toBe(200);
    expect(response.json().members).toHaveLength(1);
    expect(mockRefreshCourseRoster).toHaveBeenCalledWith('course-1');
  });

  it('falls back to a <24h cache with stale:true when refresh fails', async () => {
    const cachedAt = new Date(Date.now() - 60 * 60 * 1000);
    mockGetCachedRoster.mockResolvedValue({
      members: [{ ltiUserId: 'u1', institutionalId: '001', displayName: null, givenName: null, familyName: null, email: null, roles: [], status: 'Active', lastSeenAt: cachedAt }],
      rosterCachedAt: cachedAt,
    });
    mockRefreshCourseRoster.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'boom', retryable: true } });

    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(response.statusCode).toBe(200);
    expect(response.json().stale).toBe(true);
  });

  it('returns 502 when refresh fails and there is no usable cache', async () => {
    mockGetCachedRoster.mockResolvedValue(null);
    mockRefreshCourseRoster.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'boom', retryable: true } });

    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(response.statusCode).toBe(502);
  });

  it('never collapses duplicate institutionalId members in the response', async () => {
    mockGetCachedRoster.mockResolvedValue({
      members: [
        { ltiUserId: 'u1', institutionalId: 'DUP', displayName: null, givenName: null, familyName: null, email: null, roles: [], status: 'Active', lastSeenAt: new Date() },
        { ltiUserId: 'u2', institutionalId: 'DUP', displayName: null, givenName: null, familyName: null, email: null, roles: [], status: 'Active', lastSeenAt: new Date() },
      ],
      rosterCachedAt: new Date(),
    });

    const app = buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(response.json().members).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- course-roster.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// server/src/routes/course-roster.ts
//
// GET /api/course/roster, POST /api/course/roster/refresh (spec §25.2).
// Both endpoints return normalized CourseRosterMember-shaped members
// (never a raw NRPS payload) and both degrade gracefully to a <24h-old
// cache with stale:true on a Canvas failure rather than hard-failing --
// a transient Canvas 429 must not block an instructor mid-class.

import type { FastifyInstance } from 'fastify';
import { refreshCourseRoster } from '../lti/nrps.js';
import { getCachedRoster, isRosterStale, type CourseMemberRow } from '../attendance/roster-store.js';
import type { CourseRosterMember } from '../lti/nrps.js';

const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function serializeMember(member: CourseRosterMember) {
  return {
    ltiUserId: member.ltiUserId,
    institutionalId: member.institutionalId,
    displayName: member.displayName,
    givenName: member.givenName,
    familyName: member.familyName,
    email: member.email,
    roles: member.roles,
    status: member.status,
    eligibleForAttendance: member.eligibleForAttendance,
  };
}

function serializeCachedRow(row: CourseMemberRow) {
  return {
    ltiUserId: row.ltiUserId,
    institutionalId: row.institutionalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    email: row.email,
    roles: row.roles,
    status: row.status,
  };
}

export function registerCourseRosterRoutes(app: FastifyInstance): void {
  app.get('/api/course/roster', async (request, reply) => {
    const { courseId } = (request as unknown as { appSession: { courseId: string } }).appSession;

    const cached = await getCachedRoster(courseId);
    if (cached && !isRosterStale(cached.rosterCachedAt)) {
      return {
        members: cached.members.filter((m) => m.status !== 'removed').map(serializeCachedRow),
        fetchedAt: cached.rosterCachedAt!.toISOString(),
        stale: false,
      };
    }

    const result = await refreshCourseRoster(courseId);
    if (result.ok) {
      return { members: result.members.map(serializeMember), fetchedAt: result.fetchedAt, stale: false };
    }

    if (cached && cached.rosterCachedAt) {
      const cacheAgeMs = Date.now() - cached.rosterCachedAt.getTime();
      if (cacheAgeMs < STALE_CACHE_MAX_AGE_MS) {
        return reply.send({
          members: cached.members.filter((m) => m.status !== 'removed').map(serializeCachedRow),
          fetchedAt: cached.rosterCachedAt.toISOString(),
          stale: true,
        });
      }
    }

    return reply.code(502).send({ error: 'roster_refresh_failed', message: result.error.message });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- course-roster.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/course-roster.ts server/tests/routes/course-roster.test.ts
git commit -m "feat(routes): add GET /api/course/roster with stale-cache fallback"
```

---

### Task 13: `POST /api/course/roster/refresh` route

**Files:**
- Modify: `server/src/routes/course-roster.ts`
- Modify: `server/tests/routes/course-roster.test.ts`

**Interfaces:**
- Consumes: same as Task 12, plus `db`/`auditEvents` from `server/src/database/schema.js` (Task 1) for the `roster_refreshed` audit write.
- Produces: the `POST /api/course/roster/refresh` route, registered inside the same `registerCourseRosterRoutes` function.

Design note (deviation from the design doc's literal file list): a small `writeRosterRefreshedAuditEvent` helper is added directly inside this route file rather than as a separate `server/src/audit/` module, since Phase 4 only ever writes this one audit event type (per the design doc's own §33 note). If Phase 5 or Phase 6 need a shared audit-writing module, that's the point to extract one — don't build it speculatively now.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/routes/course-roster.test.ts`:

```ts
const mockInsertAuditEvent = vi.fn();
vi.mock('../../src/database/client.js', () => ({
  db: { insert: () => ({ values: (v: unknown) => mockInsertAuditEvent(v) }) },
}));

describe('POST /api/course/roster/refresh', () => {
  beforeEach(() => {
    mockRefreshCourseRoster.mockReset();
    mockGetCachedRoster.mockReset();
    mockInsertAuditEvent.mockReset();
  });

  it('force-refreshes and writes a roster_refreshed audit event on success', async () => {
    mockRefreshCourseRoster.mockResolvedValue({
      ok: true,
      fetchedAt: new Date().toISOString(),
      members: [{ ltiUserId: 'u1', institutionalId: '001', displayName: null, givenName: null, familyName: null, email: null, roles: [], status: 'Active', eligibleForAttendance: true }],
    });

    const app = buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/course/roster/refresh' });

    expect(response.statusCode).toBe(200);
    expect(response.json().stale).toBe(false);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'roster_refreshed', courseId: 'course-1', institutionId: 'inst-1' }),
    );
  });

  it('falls back to a <24h cache with stale:true on failure, without writing an audit event', async () => {
    const cachedAt = new Date(Date.now() - 30 * 60 * 1000);
    mockRefreshCourseRoster.mockResolvedValue({ ok: false, error: { kind: 'rate-limited', message: 'boom', retryable: true } });
    mockGetCachedRoster.mockResolvedValue({
      members: [{ ltiUserId: 'u1', institutionalId: '001', displayName: null, givenName: null, familyName: null, email: null, roles: [], status: 'Active', lastSeenAt: cachedAt }],
      rosterCachedAt: cachedAt,
    });

    const app = buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/course/roster/refresh' });

    expect(response.statusCode).toBe(200);
    expect(response.json().stale).toBe(true);
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it('returns 502 on failure with no usable cache', async () => {
    mockRefreshCourseRoster.mockResolvedValue({ ok: false, error: { kind: 'network', message: 'boom', retryable: true } });
    mockGetCachedRoster.mockResolvedValue(null);

    const app = buildTestApp();
    const response = await app.inject({ method: 'POST', url: '/api/course/roster/refresh' });

    expect(response.statusCode).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- course-roster.test.ts`
Expected: FAIL (404 on the new route).

- [ ] **Step 3: Implement**

Add to `server/src/routes/course-roster.ts` (new imports at the top, new route inside `registerCourseRosterRoutes`):

```ts
import { db } from '../database/client.js';
import { auditEvents } from '../database/schema.js';
```

```ts
async function writeRosterRefreshedAuditEvent(session: { institutionId: string; courseId: string; ltiSubject: string }, memberCount: number): Promise<void> {
  await db.insert(auditEvents).values({
    institutionId: session.institutionId,
    courseId: session.courseId,
    actorLtiUserId: session.ltiSubject,
    eventType: 'roster_refreshed',
    targetType: 'course',
    targetId: session.courseId,
    newValue: { memberCount },
  });
}
```

Inside `registerCourseRosterRoutes`, after the `GET` route:

```ts
  app.post('/api/course/roster/refresh', async (request, reply) => {
    const session = (request as unknown as { appSession: { courseId: string; institutionId: string; ltiSubject: string } }).appSession;

    const result = await refreshCourseRoster(session.courseId);
    if (result.ok) {
      await writeRosterRefreshedAuditEvent(session, result.members.length);
      return { members: result.members.map(serializeMember), fetchedAt: result.fetchedAt, stale: false };
    }

    const cached = await getCachedRoster(session.courseId);
    if (cached && cached.rosterCachedAt) {
      const cacheAgeMs = Date.now() - cached.rosterCachedAt.getTime();
      if (cacheAgeMs < STALE_CACHE_MAX_AGE_MS) {
        return reply.send({
          members: cached.members.filter((m) => m.status !== 'removed').map(serializeCachedRow),
          fetchedAt: cached.rosterCachedAt.toISOString(),
          stale: true,
        });
      }
    }

    return reply.code(502).send({ error: 'roster_refresh_failed', message: result.error.message });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- course-roster.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the routes into `server/src/index.ts`**

Modify `server/src/index.ts`: import and call `registerCourseRosterRoutes(app)` alongside the existing `registerScansRoute(app, identityResolver)` call, after Phase 3's `requireSession` preHandler machinery has been registered on the app (this route relies on `request.appSession` being decorated by Phase 3's session middleware — apply it as a scoped `preHandler` via whatever mechanism Phase 3 established, e.g. `app.register(async (instance) => { instance.addHook('preHandler', requireSession); registerCourseRosterRoutes(instance); })`; re-confirm Phase 3's actual convention for scoping `requireSession` to a subset of routes before writing this).

- [ ] **Step 6: Run the full suite, typecheck, and lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/course-roster.ts server/tests/routes/course-roster.test.ts server/src/index.ts
git commit -m "feat(routes): add POST /api/course/roster/refresh with audit logging and stale fallback"
```

---

### Task 14: Full integration test — launch → roster, zero CSV upload

**Files:**
- Create: `server/tests/routes/course-roster-integration.test.ts`
- Modify: `docs/canvas-lti/progress.md`

**Interfaces:**
- Consumes: the real Fastify `app` build function from `server/src/index.ts` (or however Phase 3 exposes an injectable app instance for tests — re-confirm); Phase 3's real launch flow (`/lti/login` → `/lti/launch`) via `server/tests/support/mock-canvas.ts`'s `mintIdToken`; this plan's `registerCourseRosterRoutes`.

- [ ] **Step 1: Write the integration test**

```ts
// server/tests/routes/course-roster-integration.test.ts
//
// The literal Phase 4 exit criterion: "instructor launches from a course
// and sees the active Canvas learner roster without uploading a file."
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../src/index.js';
import { startMockCanvas } from '../support/mock-canvas.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { resetDb } from '../support/db.js';

describe('Phase 4 integration: real launch through GET /api/course/roster', () => {
  let platform: Awaited<ReturnType<typeof startMockCanvas>>;

  beforeAll(async () => {
    platform = await startMockCanvas();
  });

  afterAll(async () => {
    await platform.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  it('returns a paginated, normalized roster with no CSV upload after a real instructor launch', async () => {
    const { registration, deployment } = await seedInstitutionAndRegistration(platform);
    platform.setCourseMembers('integration-course', [
      { user_id: 'lti-u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '111', name: 'Student One' },
      { user_id: 'lti-u2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'], lis_person_sourcedid: '222', name: 'Prof Two' },
    ]);
    platform.setPageSize(1);

    const app = await buildApp();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/lti/login',
      payload: {
        iss: registration.issuer,
        login_hint: 'lti-u1',
        target_link_uri: `${process.env.APP_BASE_URL}/lti/launch`,
        client_id: registration.clientId,
        deployment_id: deployment.deploymentId,
      },
    });
    const redirectUrl = new URL(loginResponse.headers.location as string);
    const state = redirectUrl.searchParams.get('state')!;
    const nonce = redirectUrl.searchParams.get('nonce')!;

    const idToken = await platform.mintIdToken({
      state,
      nonce,
      sub: 'lti-u1',
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      context: { id: 'integration-course', label: 'TEST-101', title: 'Test Course' },
      nrpsUrl: platform.nrpsUrlFor('integration-course'),
    });

    const launchResponse = await app.inject({ method: 'POST', url: '/lti/launch', payload: { state, id_token: idToken } });
    expect(launchResponse.statusCode).toBe(303);
    const sessionCookie = launchResponse.cookies.find((c) => c.name.toLowerCase().includes('session'));
    expect(sessionCookie).toBeDefined();

    const rosterResponse = await app.inject({
      method: 'GET',
      url: '/api/course/roster',
      cookies: { [sessionCookie!.name]: sessionCookie!.value },
    });

    expect(rosterResponse.statusCode).toBe(200);
    const body = rosterResponse.json();
    expect(body.members).toHaveLength(2);
    expect(body.members.some((m: { eligibleForAttendance: boolean }) => m.eligibleForAttendance)).toBe(true);
    expect(body.members.some((m: { eligibleForAttendance: boolean }) => !m.eligibleForAttendance)).toBe(true);
  });
});
```

This test's exact request/response field names (`mintIdToken`'s options, the launch response's cookie-name convention, `buildApp`'s export) depend entirely on Phase 3's real implementation. **Before running this test, read the real Phase 3 code for `/lti/login`, `/lti/launch`, and `mintIdToken`, and adjust every field name above to match exactly** — this is the single highest-risk task in this plan for drifting from Phase 3's real interfaces, precisely because it exercises the full stack rather than one module in isolation.

- [ ] **Step 2: Run test to verify it fails first for the right reason, then passes**

Run: `npm test -- course-roster-integration.test.ts`
Expected: after adjusting field names to match the real Phase 3 code, PASS. If it fails for a reason unrelated to field-name mismatches (e.g. a real bug in `refreshCourseRoster` or the route), fix the underlying code, not the test.

- [ ] **Step 3: Run the entire suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean, including every prior Phase 0-4 test.

- [ ] **Step 4: Update `docs/canvas-lti/progress.md`**

Read the file's existing Phase 0-2 "what actually happened" sections for its established convention, then add a new `## Phase 4 — what actually happened` section (after the existing Phase 2 section, before "Deferred decisions") once this plan has actually been executed — do not write this section speculatively before execution; leave a placeholder note during planning that this section will be filled in during execution per the file's existing convention. Also update the `- [ ] **Phase 4 — NRPS**` checklist line near the top of the file to `- [x]` once the exit criterion is verified.

- [ ] **Step 5: Commit**

```bash
git add server/tests/routes/course-roster-integration.test.ts docs/canvas-lti/progress.md
git commit -m "test(lti): add full launch-to-roster integration test for Phase 4"
```

---

## Self-review notes

- **Spec §46 NRPS coverage:** multiple pages (Task 7), active/inactive/instructor-excluded/custom-role/missing-SIS-ID/duplicate-IDs (Task 8), changed roster added/removed/unchanged (Task 9), pagination failure (Task 7), expired access token (Task 7 unit + Task 11 retry-once integration), 429 response (Task 7 unit + Task 11 retry-with-backoff integration). All eleven bullets have a task.
- **Type consistency:** `CourseRosterMember`/`CourseRosterResult` are defined once in Task 7 and referenced by name (never redefined) in Tasks 8-13; `InstitutionRosterConfig` is defined once in Task 4 and reused in Tasks 8 and 11; `CourseMemberRow` is defined once in Task 9 and reused in Tasks 10 and 12.
- **No placeholders:** every step has complete code; the one deliberately deferred prose ("write this section during execution, not planning") is the progress.md narrative of what execution actually did, which cannot be written truthfully before execution happens — this mirrors Phase 0-2's own progress.md sections, all of which were written after their phase executed.
