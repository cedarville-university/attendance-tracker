# Canvas LTI Phase 4 — NRPS Roster Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instructors launching from a Canvas course see the live Canvas learner roster through NRPS, with zero CSV upload, and a cached-roster fallback that survives transient Canvas failures.

**Architecture:** `server/src/lti/nrps.ts` orchestrates: OAuth2 client-credentials token acquisition (`token-client.ts`), a paginated authenticated fetch of Canvas's Names and Role Provisioning Service (NRPS) endpoint, and normalization of raw Canvas membership records into a stable `CourseRosterMember` shape. `server/src/attendance/roster-store.ts` persists that roster into a new `course_members` table (upsert, never delete — dropped members are marked `status: 'removed'`), exposes cache-staleness/lookup helpers, and owns the **shared** `getRosterWithFallback` degradation helper that both the Phase 4 roster routes and Phase 5's Start-Attendance flow call. Two new routes (`GET /api/course/roster`, `POST /api/course/roster/refresh`) expose this to the authenticated frontend, both degrading gracefully to a &lt;24h-old cache with `stale: true` rather than hard-failing when Canvas is unreachable.

The NRPS/AGS service endpoints are captured **at launch time** by a small retrofit of the shipped Phase 3 launch path (Task 1) and persisted verbatim onto the `courses` row; every outbound Canvas call reads that persisted value and never reconstructs it.

**Tech Stack:** `jose` (client-assertion JWT signing, already a Phase 3 dependency), `drizzle-orm` + `pg` (already Phase 3 dependencies), Fastify, Vitest. **No new npm dependencies this phase.**

## Phase 3 interfaces this plan builds on (verified against shipped HEAD `caf7e95`)

This plan is written against the **real, shipped** Phase 3 code, not an earlier design doc. The load-bearing facts:

- **No importable `db` singleton.** `server/src/database/client.ts` exports `createDbClient(url) => { db, pool }`, the `Database` / `DbClient` types, and `applyMigrations(client)`. Database access is dependency-injected everywhere: every lib function that touches the DB takes `db: Database` as its **first** parameter (see `createOidcTransaction(db, params)`, `findOrCreateCourse(db, params)`, `createSession(db, params)`); every route module is `registerXRoute(app, deps)` with `deps` carrying `db` plus injected collaborators (see `registerMeRoute(app, { requireSession, db })`); `server/src/index.ts` is the only caller of `createDbClient`. Tests use `import { getTestDb, resetDb, closeTestDb } from '../support/db.js'` and `getTestDb().db`, with `afterAll(() => closeTestDb())` at **file** scope.
- **`getActiveSigningKey`** in `server/src/lti/signing-keys.ts` is **synchronous** and **requires the loaded key array**: `getActiveSigningKey(keys: ToolSigningKey[]): ToolSigningKey`. `ToolSigningKey = { kid: string; status: 'active' | 'previous'; privateKey: CryptoKey; publicJwk: Record<string, unknown> }`. The array is loaded once at boot in `index.ts` via `loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON)`. There is no zero-arg / module-level accessor — the active key must be **injected** into the token client and roster orchestrator.
- **`request.appSession`** is already augmented on `FastifyRequest` in `server/src/auth/middleware.ts` (`appSession?: AppSession`, no `as any` needed). `AppSession = { id, institutionId, deploymentId, ltiSubject, displayName, courseId, roles, csrfSecret }`, populated by `createRequireSession(db)` → `requireSession`. `createRequireCsrf(expectedOrigin)` is the CSRF factory. `appSession.deploymentId` is the `lti_deployments.id` **row UUID**, not Canvas's business deployment-id string.
- **`LtiRegistration`** (`server/src/lti/types.ts`) fields: `id, institutionId, issuer, clientId, oidcAuthEndpoint, tokenEndpoint, tokenAudience, platformJwksUri, enabled`. `tokenAudience` is a **separate** column from `tokenEndpoint` (schema.ts:24) — seeded from Canvas discovery; POST the client assertion to `tokenEndpoint`, sign its `aud` as `tokenAudience` (spec §16).
- **`server/tests/support/seed.ts`** exports `seedInstitutionAndRegistration(db, platform, overrides?)` → `SeededRegistration = { institutionId, registrationId, deploymentRowId, clientId, deploymentId }`. `deploymentId` is Canvas's **business string** (`'mock-deployment-1'`); `deploymentRowId` is the `lti_deployments.id` UUID. `courses.deploymentId` is a NOT NULL FK to `lti_deployments.id` — always pass `deploymentRowId` there. There is **no** `seedInstitutionAndCourse` yet — Task 10 adds one.
- **`server/tests/support/mock-canvas.ts`** is `class MockCanvasPlatform`: `new MockCanvasPlatform()`, then `await platform.start()` / `await platform.stop()`. `get jwksUri` valid after `start()`. `readonly issuer = 'https://mock-canvas.test'`. `mintIdToken(overrides?, options?)` — `MintTokenOverrides` keys are exactly `iss, aud, azp, sub, nonce, exp, iat, nbf, deploymentId, version, messageType, contextId, roles, extraClaims`; arbitrary extra claims (NRPS/AGS) go through `extraClaims`. `MintTokenOptions` keys: `kid, alg`. There is **no** `startMockCanvas()` function and **no** `.close()` method (`.stop()`) — Task 6 adds methods to the class, it does not reintroduce a free function.
- **`server/tests/support/db.ts`** `TRUNCATE_ORDER` currently lists six tables; Task 2 adds `course_members` and `audit_events` to it (same task that adds those tables to `schema.ts`).
- **Migrations** are schema-first: edit `server/src/database/schema.ts`, run `npx drizzle-kit generate` (config at repo-root `drizzle.config.ts`, `out: './migrations'`), commit the generated `NNNN_*.sql` + `meta/` changes. Same workflow that produced `0000_lethal_rockslide.sql`.

If any real file differs from the above when a task runs, **adapt the task's call sites to the real code — never change Phase 3's already-shipped public interfaces to fit this plan.** The one sanctioned exception is Task 1's additive retrofit of `schema.ts` / `claims.ts` / `launch.ts` / `registrations.ts` for NRPS/AGS persistence (spec §18.1, §26).

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

// Raw, non-throwing single fetch (Task 11). NEVER throws on a transient Canvas error.
export async function refreshCourseRoster(
  db: Database,
  courseId: string,
  deps: { signingKey: ToolSigningKey; fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>; maxRateLimitRetries?: number },
): Promise<CourseRosterResult>;

// Shared stale-cache degradation helper (Task 12). Phase 4 routes AND Phase 5 createSession call THIS,
// never refreshCourseRoster directly. Throws RosterUnavailableError only when there is neither a fresh
// fetch NOR a <24h-old cache.
export async function getRosterWithFallback(
  db: Database,
  courseId: string,
  deps: { signingKey: ToolSigningKey; fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ members: CourseRosterMember[]; fetchedAt: string; stale: boolean; refreshed: boolean }>;
```

Phase 5's `createSession` snapshots `CourseRosterMember[]` verbatim into `attendance_session_members.snapshot_data` and calls `getRosterWithFallback` (not `refreshCourseRoster`). If any of these shapes change, Phase 5's plan document must be updated in lockstep.

## Global Constraints

- No new npm dependencies (`jose` / `drizzle-orm` / `pg` already cover the stack).
- **Dependency injection, always.** No module-level `db` handle, no module-level signing-key handle. Every DB-touching function takes `db: Database` first; every route module takes a `deps` object; the active `ToolSigningKey` is threaded from `index.ts` into the token client and roster orchestrator. Tests use `getTestDb().db`.
- Outbound URLs to Canvas (NRPS `context_memberships_url`, AGS `lineitems`) come **only** from the signature-verified launch JWT, persisted onto the `courses` row at launch time (Task 1), and are used **verbatim** — no reconstruction, no host-allowlist rebuild, no scheme rewrite. The route/store never accepts a Canvas URL from a request body (spec §31.7 SSRF; the trust anchor is the signed launch's provenance).
- The in-process mock Canvas serves plain `http://127.0.0.1:<port>`. `validateCanvasServiceUrl` accepts both `http:` and `https:` (production Canvas endpoints are always `https:`; the persisted value carries its own scheme).
- Institutional IDs are normalized as trimmed strings and are **never** coerced to integers — leading zeroes are meaningful (spec §20).
- Never match roster identity by student display name (spec §20). Email matching is opt-in via `identityMatchEmailEnabled` (spec §20).
- Multiple `course_members` rows may share an `institutionalId` within a course; never merge or drop duplicates — `findCourseMembersByInstitutionalId` returns an array (spec §20).
- Members no longer present in a fresh NRPS fetch are marked `status: 'removed'`, never deleted (avoids dangling references from a Phase 5 `attendance_session_members` snapshot holding a `course_members.id`).
- Do not log full NRPS payloads, Canvas access tokens, or rendered NRPS/token request URLs with embedded credentials (spec §31.8).
- Roster cache TTL is 5 minutes (spec §18.4). `GET /api/course/roster` serves a &lt;5-min cache without contacting Canvas. Both routes fall back to a &lt;24h-old cache with `stale: true` rather than hard-failing on a transient Canvas error (a transient Canvas 429 must not block an instructor mid-class).
- `roster_refreshed` is written to `audit_events` (spec §33) whenever a live Canvas refresh actually succeeds — on the `GET`-triggered refresh **and** on `POST /api/course/roster/refresh`. A pure cache hit and a stale-cache fallback write nothing. Every audit row carries `request_id` = the Fastify request id (spec §31.9 correlation id).
- All new routes require `requireSession` (spec §25). `POST /api/course/roster/refresh` additionally requires `requireCsrf` and rejects form-encoded bodies (spec §15).
- Use parameterized queries via Drizzle only — never string-concatenate SQL (spec §31.6).
- `roles` arrays store raw NRPS role URNs verbatim.
- `npm test` / `npm run lint` / `npm run typecheck` stay clean after **every** task; Phase 3's 165 tests must still pass after the Task 1 retrofit (new columns nullable, new claims optional).

---

## File/module layout

```
server/src/database/
  schema.ts            # MODIFY (Task 1) add courses.nrps_url/ags_lineitems_url/last_launched_at
                       # MODIFY (Task 2) add institutions roster-config cols, courses.roster_cached_at,
                       #                  course_members, audit_events

server/src/lti/
  claims.ts            # MODIFY (Task 1) two OPTIONAL service claims (NRPS + AGS endpoint)
  launch.ts            # MODIFY (Task 1) pass NRPS/AGS endpoints into findOrCreateCourse
  registrations.ts     # MODIFY (Task 1) findOrCreateCourse -> find-or-create-THEN-update-launch-metadata
  scopes.ts            # NEW (Task 3)  named IMS NRPS scope constant
  service-url.ts       # NEW (Task 4)  Canvas service-URL validation (verbatim-use SSRF guard)
  roster-config.ts     # NEW (Task 5)  per-institution roster-filter / identity-match resolution
  token-client.ts      # NEW (Task 7)  OAuth2 client-credentials grant + access-token cache
  nrps.ts              # NEW (Tasks 8/9/11) fixed-contract types + pagination + normalize + orchestrator

server/src/attendance/
  roster-store.ts      # NEW (Tasks 10/12) course_members upsert, staleness, cached reads,
                       #                    getRosterWithFallback shared degradation helper

server/src/routes/
  course-roster.ts     # NEW (Tasks 13/14) GET /api/course/roster, POST /api/course/roster/refresh

server/src/index.ts    # MODIFY (Task 14) compose registerCourseRosterRoutes on the root app

server/tests/lti/
  launch-nrps-persistence.test.ts   # NEW (Task 1)
  scopes.test.ts                    # NEW (Task 3)
  service-url.test.ts               # NEW (Task 4)
  roster-config.test.ts             # NEW (Task 5)
  token-client.test.ts              # NEW (Task 7)
  nrps.test.ts                      # NEW (Tasks 8/9/11)

server/tests/attendance/
  roster-store.test.ts              # NEW (Tasks 10/12)

server/tests/routes/
  course-roster.test.ts             # NEW (Tasks 13/14)
  course-roster-integration.test.ts # NEW (Task 15)

server/tests/database/
  schema.test.ts                    # MODIFY (Task 2) Phase 4 schema smoke test

server/tests/support/
  mock-canvas.ts       # MODIFY (Task 6) add token endpoint + paginated NRPS endpoint to the class
  db.ts                # MODIFY (Task 2) course_members + audit_events in TRUNCATE_ORDER
  seed.ts              # MODIFY (Task 10) add seedInstitutionAndCourse(db, platform, overrides?)
```

Task count: **15** (was 14; the schema work is split into a Phase-3 retrofit task and a Phase-4 additions task, and the shared `getRosterWithFallback` helper is its own task).

---

### Task 1: Launch-time NRPS/AGS endpoint capture (Phase 3 retrofit)

Everything downstream depends on this: without it `courses.nrps_url` is always `NULL` and `refreshCourseRoster` can never obtain a service URL. This is an **additive** retrofit of shipped Phase 3 code (spec §18.1 "persist the signed service endpoint from the launch"; spec §26 lists these columns on `courses`).

**Files:**
- Modify: `server/src/database/schema.ts`
- Modify: `server/src/lti/claims.ts`
- Modify: `server/src/lti/registrations.ts`
- Modify: `server/src/lti/launch.ts`
- Test: `server/tests/lti/launch-nrps-persistence.test.ts` (new)

- [ ] **Step 1: Add the three spec-§26 columns to `courses`**

In `server/src/database/schema.ts`, inside the `courses` column object (after `title`, before `createdAt`):

```ts
    nrpsUrl: text('nrps_url'),
    agsLineitemsUrl: text('ags_lineitems_url'),
    lastLaunchedAt: timestamp('last_launched_at', { withTimezone: true }),
```

All three are nullable — a launch from a platform that didn't send the claim, and every pre-existing row, must stay valid. `text` and `timestamp` are already imported from `drizzle-orm/pg-core` for the other columns.

- [ ] **Step 2: Add the two OPTIONAL service claims to `claims.ts`**

In `server/src/lti/claims.ts`, extend `ltiClaimsSchema` with (add inside the `z.object({ ... })`):

```ts
  'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice': z
    .object({
      context_memberships_url: z.string().url(),
      service_versions: z.array(z.string()).optional(),
    })
    .optional(),
  'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint': z
    .object({
      lineitems: z.string().url().optional(),
      lineitem: z.string().url().optional(),
      scope: z.array(z.string()).optional(),
    })
    .optional(),
```

Both are `.optional()`, so a launch without them still validates — no new `ClaimsValidationFailureReason`, no new `LaunchFailureReason`. `ValidatedLtiClaims` (`z.infer<typeof ltiClaimsSchema>`) simply gains two optional fields. `validateLtiClaims` is otherwise unchanged (the `failsAt(...)` chain and invariant throw stay as-is). Zod object schemas strip unknown keys by default; declaring these keys is what makes them survive into `parsed.data`.

- [ ] **Step 3: `findOrCreateCourse` becomes find-or-create-**then-update-launch-metadata**

In `server/src/lti/registrations.ts`:

- Add `sql` to the drizzle import: `import { eq, and, sql } from 'drizzle-orm';`
- Extend `FindOrCreateCourseParams`:

```ts
export interface FindOrCreateCourseParams {
  institutionId: string;
  deploymentId: string;
  ltiContextId: string;
  label?: string;
  title?: string;
  nrpsUrl?: string | null;
  agsLineitemsUrl?: string | null;
}
```

- Rework the body so that after the course id is resolved (by the fast path, the insert, or the race-fallback select) it always writes launch metadata, then returns:

```ts
export async function findOrCreateCourse(db: Database, params: FindOrCreateCourseParams): Promise<{ id: string }> {
  const courseMatch = and(eq(courses.deploymentId, params.deploymentId), eq(courses.ltiContextId, params.ltiContextId));

  const resolveId = async (): Promise<string> => {
    const existing = await db.select().from(courses).where(courseMatch).limit(1);
    if (existing[0]) return existing[0].id;

    const [inserted] = await db
      .insert(courses)
      .values({
        institutionId: params.institutionId,
        deploymentId: params.deploymentId,
        ltiContextId: params.ltiContextId,
        label: params.label ?? null,
        title: params.title ?? null,
      })
      .onConflictDoNothing({ target: [courses.deploymentId, courses.ltiContextId] })
      .returning();
    if (inserted) return inserted.id;

    const [winner] = await db.select().from(courses).where(courseMatch).limit(1);
    if (!winner) {
      throw new Error('findOrCreateCourse: insert conflicted but no row found on fallback select');
    }
    return winner.id;
  };

  const courseId = await resolveId();

  // Refresh launch metadata on EVERY launch. Canvas can rotate the NRPS/AGS URLs, so overwrite them
  // whenever the claim is present; never null out a previously-good value when a later launch omits it.
  // Build the SET payload as an inline object literal with conditional spreads so Drizzle infers
  // `PgUpdateSetSource<typeof courses>` directly — a `const launchUpdate: Record<string, unknown>`
  // annotation is a strict-mode `.set()` typecheck error.
  await db
    .update(courses)
    .set({
      lastLaunchedAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(params.nrpsUrl != null ? { nrpsUrl: params.nrpsUrl } : {}),
      ...(params.agsLineitemsUrl != null ? { agsLineitemsUrl: params.agsLineitemsUrl } : {}),
    })
    .where(eq(courses.id, courseId));

  return { id: courseId };
}
```

The existing `registrations.test.ts` cases assert only `second.id === first.id` and concurrent-dedup, and count nothing new — the extra `UPDATE` keeps them green. Verify after Step 5.

- [ ] **Step 4: Pass the endpoints from `verifyLaunch` into `findOrCreateCourse`**

In `server/src/lti/launch.ts`, in `verifyLaunch`, replace the `findOrCreateCourse` call:

```ts
  const context = claims['https://purl.imsglobal.org/spec/lti/claim/context'];
  const nrpsClaim = claims['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice'];
  const agsClaim = claims['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'];
  const course = await findOrCreateCourse(deps.db, {
    institutionId: registration.institutionId,
    // deployment.id is the lti_deployments ROW UUID, which is what courses.deployment_id FKs to.
    deploymentId: deployment.id,
    ltiContextId: context.id,
    label: context.label,
    title: context.title,
    nrpsUrl: nrpsClaim?.context_memberships_url ?? null,
    agsLineitemsUrl: agsClaim?.lineitems ?? null,
  });
```

Nothing else in `launch.ts` changes; `VerifyLaunchResult` is unchanged.

- [ ] **Step 5: Note on `mock-canvas.ts` — no change needed here**

`mintIdToken` already spreads `...overrides.extraClaims` into the payload. A launch test emits the NRPS claim with:

```ts
extraClaims: {
  'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice': { context_memberships_url: '<url>' },
}
```

The paginated NRPS **endpoint** is added to the class in Task 6; Task 1's test does not fetch a roster, so it uses a plain string URL literal.

- [ ] **Step 6: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `migrations/000N_*.sql` with `ALTER TABLE "courses" ADD COLUMN "nrps_url" text;`, `... "ags_lineitems_url" text;`, `... "last_launched_at" timestamp with time zone;`. Read it and confirm exactly those three additive `ALTER`s and no destructive statements. Commit the SQL + `migrations/meta/` changes.

- [ ] **Step 7: Write the retrofit test**

```ts
// server/tests/lti/launch-nrps-persistence.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { registerLtiLaunchRoute } from '../../src/routes/lti-launch.js';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { courses } from '../../src/database/schema.js';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const AGS_CLAIM = 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint';

afterAll(async () => {
  await closeTestDb();
});

describe('launch persists NRPS/AGS service endpoints (Phase 3 retrofit)', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;
  let seeded: Awaited<ReturnType<typeof seedInstitutionAndRegistration>>;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
    // Seed the institution / registration / deployment ONCE per test. seedInstitutionAndRegistration
    // inserts an lti_registrations row keyed by unique(issuer, clientId) — both fixed constants — so a
    // second call inside the same test throws; and two deployment UUIDs would create two courses rows.
    // Each launch() below reuses this single registration/deployment and only mints a fresh OIDC
    // transaction + id_token, so repeated launches of the same context update ONE courses row in place.
    seeded = await seedInstitutionAndRegistration(getTestDb().db, platform);
  });
  afterEach(async () => {
    await platform.stop();
  });

  function buildTestApp() {
    const app = Fastify({ logger: false });
    app.register(fastifyCookie);
    app.register(fastifyFormbody);
    registerLtiLaunchRoute(app, {
      db: getTestDb().db,
      jwksCache,
      clockSkewSeconds: 120,
      sessionTtlHours: 8,
      appBaseUrl: 'https://app.test',
    });
    return app;
  }

  async function launch(extraClaims: Record<string, unknown>) {
    const { db } = getTestDb();
    // No re-seed here — `seeded` is created once in beforeEach. Each call only mints a fresh OIDC
    // transaction + id_token against the already-seeded institution/registration/deployment.
    const tx = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });
    const idToken = await platform.mintIdToken({ nonce: tx.nonce, deploymentId: seeded.deploymentId, extraClaims });
    const res = await buildTestApp().inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: tx.state, id_token: idToken }).toString(),
    });
    expect(res.statusCode).toBe(303);
    return db;
  }

  it('persists courses.nrpsUrl / agsLineitemsUrl / lastLaunchedAt from the launch claims', async () => {
    const db = await launch({
      [NRPS_CLAIM]: { context_memberships_url: 'https://canvas.example.edu/api/lti/courses/1/names_and_roles' },
      [AGS_CLAIM]: { lineitems: 'https://canvas.example.edu/api/lti/courses/1/line_items', scope: [] },
    });
    const [course] = await db.select().from(courses);
    expect(course.nrpsUrl).toBe('https://canvas.example.edu/api/lti/courses/1/names_and_roles');
    expect(course.agsLineitemsUrl).toBe('https://canvas.example.edu/api/lti/courses/1/line_items');
    expect(course.lastLaunchedAt).not.toBeNull();
  });

  it('leaves nrpsUrl / agsLineitemsUrl null when the launch omits those claims, and still succeeds', async () => {
    const db = await launch({});
    const [course] = await db.select().from(courses);
    expect(course.nrpsUrl).toBeNull();
    expect(course.agsLineitemsUrl).toBeNull();
    expect(course.lastLaunchedAt).not.toBeNull();
  });

  it('refreshes a rotated nrpsUrl on the next launch of the same course', async () => {
    await launch({ [NRPS_CLAIM]: { context_memberships_url: 'https://canvas.example.edu/nrps/v1' } });
    const db = await launch({ [NRPS_CLAIM]: { context_memberships_url: 'https://canvas.example.edu/nrps/v2' } });
    const rows = await db.select().from(courses);
    expect(rows).toHaveLength(1);
    expect(rows[0].nrpsUrl).toBe('https://canvas.example.edu/nrps/v2');
  });
});
```

- [ ] **Step 8: Run the retrofit test, then the full suite**

Run: `npm test -- launch-nrps-persistence.test.ts`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean — Phase 3's 165 tests still pass (new columns nullable, new claims optional).

- [ ] **Step 9: Commit**

```bash
git add server/src/database/schema.ts server/src/lti/claims.ts server/src/lti/registrations.ts \
        server/src/lti/launch.ts migrations/ server/tests/lti/launch-nrps-persistence.test.ts
git commit -m "feat(lti): capture and persist NRPS/AGS service endpoints at launch time"
```

---

### Task 2: Phase 4 schema — institution roster config, `course_members`, `audit_events`, `roster_cached_at`

**Files:**
- Modify: `server/src/database/schema.ts`
- Modify: `server/tests/support/db.ts`
- Test: `server/tests/database/schema.test.ts` (extend the existing Phase 3 file)

- [ ] **Step 1: Add the institution roster-config columns and `courses.rosterCachedAt`**

In `server/src/database/schema.ts`:

- Add `sql` to the top import: `import { sql } from 'drizzle-orm';` (new line; `drizzle-orm/pg-core` already provides `pgTable, uuid, text, boolean, timestamp, jsonb, unique`).
- In `institutions` (after `enabled`, before `createdAt`):

```ts
  canvasIdentityMatchField: text('canvas_identity_match_field').notNull().default('lis_person_sourcedid'),
  identityMatchEmailEnabled: boolean('identity_match_email_enabled').notNull().default(false),
  rosterLearnerRoles: jsonb('roster_learner_roles').$type<string[]>().notNull().default(sql`'["Learner"]'::jsonb`),
```

- In `courses` (after `lastLaunchedAt` from Task 1, before `createdAt`):

```ts
    rosterCachedAt: timestamp('roster_cached_at', { withTimezone: true }),
```

<!-- USER RULING (2026-08-27): KEEP the explicit nullable `courses.roster_cached_at` column. Do NOT
     switch to deriving roster freshness from `max(course_members.last_seen_at)`. This column is the
     single source of truth for the spec §18.4 five-minute cache TTL and is set on every successful
     roster fetch (Task 10 `upsertCourseMembers`, Task 12 `getRosterWithFallback`). Not in spec §26's
     `courses` column list, but a sanctioned additive app-level column. Resolved — plan design unchanged. -->

- [ ] **Step 2: Add the `courseMembers` table (array-form third arg — matches the rest of `schema.ts`)**

Append:

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
  (t) => [unique().on(t.courseId, t.ltiUserId)],
);
```

- [ ] **Step 3: Add the `auditEvents` table**

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

`attendanceSessionId` deliberately has **no** FK constraint yet — `attendance_sessions` does not exist until Phase 5, which adds the FK via `ALTER TABLE`.

- [ ] **Step 4: Add both new tables to the test-DB reset path**

In `server/tests/support/db.ts`, prepend `'audit_events'` and `'course_members'` to `TRUNCATE_ORDER` (children before parents — both reference `courses` / `institutions`):

```ts
const TRUNCATE_ORDER = [
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

Without this a new table silently accumulates rows across test files (shared DB + `singleFork`).

- [ ] **Step 5: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: `migrations/000N_*.sql` with `ALTER TABLE "institutions" ADD COLUMN ...` (three), `ALTER TABLE "courses" ADD COLUMN "roster_cached_at" ...`, `CREATE TABLE "course_members" ...` (with `CONSTRAINT "course_members_course_id_lti_user_id_unique" UNIQUE(...)`), `CREATE TABLE "audit_events" ...`. Read and confirm. Commit SQL + `meta/`.

- [ ] **Step 6: Extend the schema smoke test (insert a REAL row chain)**

Append to `server/tests/database/schema.test.ts` inside the existing `describe('schema smoke test', ...)`:

```ts
  it('persists the Phase 4 columns and course_members / audit_events rows', async () => {
    const { db } = getTestDb();

    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'p4-smoke', displayName: 'Phase 4 Smoke U', timezone: 'UTC', enabled: true })
      .returning();
    expect(institution.canvasIdentityMatchField).toBe('lis_person_sourcedid');
    expect(institution.identityMatchEmailEnabled).toBe(false);
    expect(institution.rosterLearnerRoles).toEqual(['Learner']);

    const [registration] = await db
      .insert(ltiRegistrations)
      .values({
        institutionId: institution.id,
        issuer: 'https://p4-smoke.test',
        clientId: 'client-p4',
        oidcAuthEndpoint: 'https://p4-smoke.test/authorize',
        tokenEndpoint: 'https://p4-smoke.test/token',
        tokenAudience: 'https://p4-smoke.test/token',
        platformJwksUri: 'https://p4-smoke.test/jwks',
        enabled: true,
      })
      .returning();
    const [deployment] = await db
      .insert(ltiDeployments)
      .values({ registrationId: registration.id, deploymentId: 'deploy-p4', enabled: true, configuration: {} })
      .returning();
    const [course] = await db
      .insert(courses)
      .values({
        institutionId: institution.id,
        deploymentId: deployment.id, // lti_deployments.id ROW UUID (NOT NULL FK)
        ltiContextId: 'course-p4',
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
        institutionalId: '0001234',
        roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
        status: 'Active',
      })
      .returning();
    expect(member.institutionalId).toBe('0001234');

    const [event] = await db
      .insert(auditEvents)
      .values({
        institutionId: institution.id,
        courseId: course.id,
        eventType: 'roster_refreshed',
        targetType: 'course',
        targetId: course.id,
        newValue: { memberCount: 1 },
        requestId: 'req-abc',
      })
      .returning();
    expect(event.eventType).toBe('roster_refreshed');
    expect(event.requestId).toBe('req-abc');
  });
```

Add `courseMembers, auditEvents` to the file's `schema.js` import.

- [ ] **Step 7: Run the test, typecheck, lint**

Run: `npm test -- schema.test.ts && npm run typecheck && npm run lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/database/schema.ts server/tests/support/db.ts server/tests/database/schema.test.ts migrations/
git commit -m "feat(lti): add course_members/audit_events tables and institution roster-config columns"
```

---

### Task 3: `scopes.ts`

**Files:**
- Create: `server/src/lti/scopes.ts`
- Test: `server/tests/lti/scopes.test.ts`

<!-- reviser note (Q10): AGS_LINEITEM_SCOPE / AGS_SCORE_SCOPE were pre-staged dead exports (unused
     until Phase 6). Per the Phase 3 review's YAGNI precedent they are DEFERRED to Phase 6 and are not
     defined here. courses.ags_lineitems_url is still persisted at launch (Task 1) so Phase 6 has the
     data it needs; the scope constants land with the first code that uses them. -->

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/scopes.test.ts
import { describe, it, expect } from 'vitest';
import { NRPS_MEMBERSHIP_READONLY_SCOPE } from '../../src/lti/scopes.js';

describe('LTI Advantage scope constants', () => {
  it('exposes the exact 1EdTech-documented NRPS membership read scope URI', () => {
    expect(NRPS_MEMBERSHIP_READONLY_SCOPE).toBe(
      'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- scopes.test.ts`

- [ ] **Step 3: Implement**

```ts
// server/src/lti/scopes.ts
//
// Named IMS LTI Advantage scope URIs. These are the literal standardized 1EdTech URIs that Canvas's
// Developer Key UI populates for each capability -- reproduce them verbatim, never paraphrase.
// Only the NRPS membership read scope is needed this phase; AGS scopes land in Phase 6 with the code
// that uses them.

export const NRPS_MEMBERSHIP_READONLY_SCOPE =
  'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- scopes.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/scopes.ts server/tests/lti/scopes.test.ts
git commit -m "feat(lti): add NRPS membership read scope constant"
```

---

### Task 4: `service-url.ts` — Canvas service-URL SSRF guard (verbatim-use)

**Files:**
- Create: `server/src/lti/service-url.ts`
- Test: `server/tests/lti/service-url.test.ts`

**Interfaces:**
- Produces: `validateCanvasServiceUrl(url: string): { ok: boolean; error?: 'malformed-url' | 'unsupported-scheme' | 'embedded-credentials' }`.

Design: the NRPS/AGS URL comes only from a signature-verified launch JWT and is persisted verbatim onto `courses` (Task 1). Per spec §31.7 the trust anchor is that provenance — the value is **used exactly as stored**, with no host-allowlist reconstruction. This guard is a cheap structural sanity check for the two things §31.7 still calls out that don't depend on host policy: an absolute `http(s)` scheme and the absence of embedded credentials. Redirect rejection ("disable unrestricted redirects") is enforced at the outbound `fetch` call sites in `nrps.ts` / `token-client.ts` via `redirect: 'manual'` + treating any 3xx as a failure — not here.

<!-- USER SIGN-OFF (2026-08-27): APPROVED — no outbound host allowlist is added. Canvas NRPS/AGS URLs
     are used verbatim from the values persisted on the `courses` row at launch; the SSRF trust anchor
     is the signature-verified launch JWT's provenance (spec §31.7). Rationale retained for the record:
     the pre-fix version anchored the host check on `new URL(registration.tokenEndpoint).host`, which is
     wrong on real Canvas — spec §11 says Instructure-hosted Canvas shares ONE issuer across many
     per-institution Canvas domains and the OAuth2 token host is a distinct global/regional host, so the
     NRPS host never equals the token host and every production fetch would be rejected. Per constraints
     D3 verbatim-use is the primary rule. A future per-institution service-host policy could add an
     allowlist anchored on the registration `issuer` origin; none is added now. Resolved. -->

- [ ] **Step 1: Write the failing tests** (note: title uses double quotes so the apostrophe does not break the parser)

```ts
// server/tests/lti/service-url.test.ts
import { describe, it, expect } from 'vitest';
import { validateCanvasServiceUrl } from '../../src/lti/service-url.js';

describe('validateCanvasServiceUrl', () => {
  it("accepts an absolute https URL on the registration's Canvas host", () => {
    expect(
      validateCanvasServiceUrl('https://school.instructure.com/api/lti/courses/1/names_and_roles'),
    ).toEqual({ ok: true });
  });

  it('accepts an absolute http URL (the in-process mock Canvas serves plain http)', () => {
    expect(validateCanvasServiceUrl('http://127.0.0.1:54321/nrps/course-1/members')).toEqual({ ok: true });
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateCanvasServiceUrl('ftp://school.instructure.com/roster')).toEqual({
      ok: false,
      error: 'unsupported-scheme',
    });
  });

  it('rejects a URL with embedded credentials', () => {
    expect(validateCanvasServiceUrl('https://user:pass@school.instructure.com/roster')).toEqual({
      ok: false,
      error: 'embedded-credentials',
    });
  });

  it('rejects a malformed URL', () => {
    expect(validateCanvasServiceUrl('not a url')).toEqual({ ok: false, error: 'malformed-url' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- service-url.test.ts`

- [ ] **Step 3: Implement**

```ts
// server/src/lti/service-url.ts
//
// Structural sanity check for a Canvas-provided service URL (NRPS membership endpoint, AGS line-items
// endpoint). The URL comes only from a signature-verified LTI launch JWT and is persisted verbatim
// onto the courses row -- that provenance is the SSRF trust anchor (spec §31.7). This function does
// NOT rebuild a host allowlist. Redirect rejection happens at the fetch call site (`redirect:'manual'`).

export interface ServiceUrlValidationResult {
  ok: boolean;
  error?: 'malformed-url' | 'unsupported-scheme' | 'embedded-credentials';
}

export function validateCanvasServiceUrl(url: string): ServiceUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'malformed-url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'unsupported-scheme' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'embedded-credentials' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- service-url.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/service-url.ts server/tests/lti/service-url.test.ts
git commit -m "feat(lti): add Canvas service-URL structural validation"
```

---

### Task 5: `roster-config.ts` — institution roster-filter / identity-match resolution

**Files:**
- Create: `server/src/lti/roster-config.ts`
- Test: `server/tests/lti/roster-config.test.ts`

**Interfaces:**
- Consumes: an institution row shape `{ canvasIdentityMatchField: string; identityMatchEmailEnabled: boolean; rosterLearnerRoles: string[] }` (Task 2 columns).
- Produces: `InstitutionRosterConfig`, `NrpsRawMember`, `resolveInstitutionRosterConfig(institution)`, `resolveInstitutionalId(raw, config)`, `isEligibleForAttendance(status, roles, learnerRoles)`. All pure — no DB.

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
  it('defaults rosterLearnerRoles to ["Learner"] when the institution row has none (spec §18.2)', () => {
    const config = resolveInstitutionRosterConfig({
      canvasIdentityMatchField: 'lis_person_sourcedid',
      identityMatchEmailEnabled: false,
      rosterLearnerRoles: [],
    });
    expect(config.rosterLearnerRoles).toEqual(['Learner']);
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
  const baseConfig = {
    canvasIdentityMatchField: 'lis_person_sourcedid',
    identityMatchEmailEnabled: false,
    rosterLearnerRoles: ['Learner'],
  };

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

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- roster-config.test.ts`

- [ ] **Step 3: Implement**

```ts
// server/src/lti/roster-config.ts
//
// Per-institution NRPS roster-filtering and identity-matching config (spec §18.2, §20, §52). Role
// matching is exact-fragment comparison on role URNs -- never substring. Institutional IDs are always
// trimmed strings, never coerced to numbers (leading zeroes are meaningful).

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
  // Spec §18.2: the default candidate rule is `status = Active AND role contains Learner`. If the row
  // somehow carries an empty list (bad seed, manual edit, a future migration), fall back to ['Learner']
  // in code rather than silently disabling attendance for everyone.
  const learnerRoles =
    Array.isArray(institution.rosterLearnerRoles) && institution.rosterLearnerRoles.length > 0
      ? institution.rosterLearnerRoles
      : ['Learner'];
  return {
    canvasIdentityMatchField: institution.canvasIdentityMatchField || 'lis_person_sourcedid',
    identityMatchEmailEnabled: Boolean(institution.identityMatchEmailEnabled),
    rosterLearnerRoles: learnerRoles,
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

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- roster-config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/roster-config.ts server/tests/lti/roster-config.test.ts
git commit -m "feat(lti): add institution roster-filter and identity-match resolution"
```

---

### Task 6: Extend `MockCanvasPlatform` with a token endpoint and a paginated NRPS endpoint

**Files:**
- Modify: `server/tests/support/mock-canvas.ts`
- Test: `server/tests/support/mock-canvas-nrps.test.ts` (new self-test)

This adds **instance state and methods to the existing `class MockCanvasPlatform`** — it does not add a free `startMockCanvas()` function. Callers keep using `new MockCanvasPlatform()` / `await platform.start()` / `await platform.stop()`.

**New surface on the class:**
- `get tokenUrl(): string`
- `nrpsUrlFor(courseId: string): string`
- `setCourseMembers(courseId: string, members: NrpsRawMember[]): void`
- `setPageSize(n: number): void`
- `expireAccessToken(token: string): void`
- `rateLimitNextRequest(courseId: string): void` — one-shot 429 with `Retry-After: 1`
- `breakPaginationOnNextPage(courseId: string): void` — one-shot; the next request for **page ≥ 2** of that course returns `200` with a body that has **no `members` array** (a genuine mid-pagination failure, not a first-page error)

- [ ] **Step 1: Read the file, then apply the additions**

Add `import fastifyFormbody from '@fastify/formbody';` and `import type { NrpsRawMember } from '../../src/lti/roster-config.js';` at the top. In the class, add the new private fields and register the two routes + `fastifyFormbody` in the constructor, and add the new getters/methods. The constructor already builds `this.app` and registers `/jwks`; extend it:

```ts
export class MockCanvasPlatform {
  readonly issuer = 'https://mock-canvas.test';
  private keys = new Map<string, MockKeyEntry>();
  private app: FastifyInstance;
  private port = 0;

  // --- Phase 4: token endpoint + paginated NRPS ---
  private issuedTokens = new Set<string>();
  private expiredTokens = new Set<string>();
  private courseMembers = new Map<string, NrpsRawMember[]>();
  private rateLimitOnce = new Set<string>();
  private breakNextPage = new Set<string>();
  private nrpsPageSize = 50;

  constructor() {
    this.app = Fastify({ logger: false });
    this.app.register(fastifyFormbody);
    this.app.get('/jwks', async () => ({ keys: [...this.keys.values()].map((k) => k.publicJwk) }));

    this.app.post('/login/oauth2/token', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, string>;
      if (
        body.grant_type !== 'client_credentials' ||
        body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
        !body.client_assertion
      ) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const token = `mock-access-token-${randomUUID()}`;
      this.issuedTokens.add(token);
      return { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: body.scope ?? '' };
    });

    this.app.get('/nrps/:courseId/members', async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!this.issuedTokens.has(token) || this.expiredTokens.has(token)) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const page = Number((request.query as { page?: string }).page ?? '1');

      if (this.rateLimitOnce.has(courseId)) {
        this.rateLimitOnce.delete(courseId);
        reply.header('retry-after', '1');
        return reply.code(429).send({ error: 'rate_limited' });
      }

      if (this.breakNextPage.has(courseId) && page >= 2) {
        this.breakNextPage.delete(courseId);
        return { id: this.nrpsUrlFor(courseId), context: {} }; // deliberately no `members`
      }

      const all = this.courseMembers.get(courseId) ?? [];
      const start = (page - 1) * this.nrpsPageSize;
      const slice = all.slice(start, start + this.nrpsPageSize);
      if (start + this.nrpsPageSize < all.length) {
        reply.header('link', `<${this.nrpsUrlFor(courseId)}?page=${page + 1}>; rel="next"`);
      }
      return { id: this.nrpsUrlFor(courseId), context: {}, members: slice };
    });
  }

  // ...existing start(), stop(), get jwksUri(), publishNewKey(), unpublishKey(), mintIdToken() UNCHANGED...

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get tokenUrl(): string {
    return `${this.baseUrl}/login/oauth2/token`;
  }

  nrpsUrlFor(courseId: string): string {
    return `${this.baseUrl}/nrps/${courseId}/members`;
  }

  setCourseMembers(courseId: string, members: NrpsRawMember[]): void {
    this.courseMembers.set(courseId, members);
  }
  setPageSize(n: number): void {
    this.nrpsPageSize = n;
  }
  expireAccessToken(token: string): void {
    this.expiredTokens.add(token);
  }
  rateLimitNextRequest(courseId: string): void {
    this.rateLimitOnce.add(courseId);
  }
  breakPaginationOnNextPage(courseId: string): void {
    this.breakNextPage.add(courseId);
  }
}
```

- [ ] **Step 2: Self-test the harness**

```ts
// server/tests/support/mock-canvas-nrps.test.ts
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
      scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('MockCanvasPlatform NRPS/token extensions', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('issues a token and serves paginated members with it', async () => {
    platform.setCourseMembers('c1', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);
    const token = await mintToken(platform);

    const p1 = await fetch(platform.nrpsUrlFor('c1'), { headers: { authorization: `Bearer ${token}` } });
    expect(p1.status).toBe(200);
    expect(p1.headers.get('link')).toContain('page=2');
    expect(((await p1.json()) as { members: unknown[] }).members).toHaveLength(1);
  });

  it('rejects an unknown bearer token with 401', async () => {
    const res = await fetch(platform.nrpsUrlFor('c1'), { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

Run: `npm test -- mock-canvas-nrps.test.ts`

- [ ] **Step 4: Commit**

```bash
git add server/tests/support/mock-canvas.ts server/tests/support/mock-canvas-nrps.test.ts
git commit -m "test(lti): extend MockCanvasPlatform with token and paginated NRPS endpoints"
```

---

### Task 7: `token-client.ts` — client-credentials grant + access-token cache

**Files:**
- Create: `server/src/lti/token-client.ts`
- Test: `server/tests/lti/token-client.test.ts`

**Interfaces:**
- Produces: `SigningKeyRef` (`{ kid: string; privateKey: CryptoKey }` — a structural subset of Phase 3's `ToolSigningKey`, so `getActiveSigningKey(...)`'s return value is assignable); `TokenClientRegistration` (`{ id; clientId; tokenEndpoint; tokenAudience }`); `buildClientAssertion(registration, signingKey): Promise<string>`; `getAccessToken(registration, scopes, deps: { signingKey: SigningKeyRef; fetchImpl?: typeof fetch }): Promise<string>`; `clearAccessTokenCache(registrationId, scopes): void`.

The client assertion's `aud` is `registration.tokenAudience` (spec §16 "the configured authorization-server audience"); the assertion is POSTed to `registration.tokenEndpoint`. These are distinct on real Canvas.

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/lti/token-client.test.ts
import { generateKeyPair, decodeProtectedHeader, decodeJwt } from 'jose';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  buildClientAssertion,
  getAccessToken,
  clearAccessTokenCache,
  type SigningKeyRef,
  type TokenClientRegistration,
} from '../../src/lti/token-client.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

describe('token-client', () => {
  let platform: MockCanvasPlatform;
  let signingKey: SigningKeyRef;
  let registration: TokenClientRegistration;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    const { privateKey } = await generateKeyPair('RS256');
    signingKey = { kid: 'test-kid-1', privateKey };
    registration = {
      id: 'reg-1',
      clientId: 'client-abc',
      tokenEndpoint: platform.tokenUrl,
      // Deliberately DIFFERENT from tokenEndpoint, to prove the assertion signs `aud` as tokenAudience.
      tokenAudience: 'https://sso.canvaslms.com/api/lti/authorize_redirect',
    };
  });

  afterAll(async () => {
    await platform.stop();
  });

  beforeEach(() => {
    clearAccessTokenCache(registration.id, ['scope-a']);
    clearAccessTokenCache(registration.id, ['scope-b']);
  });

  it('builds a client assertion with the required claims, kid, and aud = tokenAudience', async () => {
    const assertion = await buildClientAssertion(registration, signingKey);
    const header = decodeProtectedHeader(assertion);
    const payload = decodeJwt(assertion);

    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('test-kid-1');
    expect(payload.sub).toBe('client-abc');
    expect(payload.iss).toBe('client-abc');
    expect(payload.aud).toBe('https://sso.canvaslms.com/api/lti/authorize_redirect');
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

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- token-client.test.ts`

- [ ] **Step 3: Implement**

```ts
// server/src/lti/token-client.ts
//
// OAuth 2.0 Client Credentials grant against Canvas's token endpoint (spec §16), using a signed JWT
// client assertion. Access tokens are cached in-memory per registration + normalized-scope-set and
// reused until ~60s before expiry (spec §16.1). Accepted limitation: the in-memory cache does not
// survive restarts or scale horizontally -- fine at this app's single-instance scale.

import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';

export interface SigningKeyRef {
  kid: string;
  privateKey: CryptoKey;
}

export interface TokenClientRegistration {
  id: string;
  clientId: string;
  tokenEndpoint: string;
  tokenAudience: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

function cacheKey(registrationId: string, scopes: string[]): string {
  return `${registrationId}:${[...scopes].sort().join(' ')}`;
}

export async function buildClientAssertion(
  registration: TokenClientRegistration,
  signingKey: SigningKeyRef,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: signingKey.kid })
    .setSubject(registration.clientId)
    .setIssuer(registration.clientId)
    .setAudience(registration.tokenAudience) // spec §16: the configured authorization-server audience
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
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Canvas token endpoint returned a redirect; redirects are not followed.');
  }
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

- [ ] **Step 4: Run — expect PASS; then typecheck**

Run: `npm test -- token-client.test.ts && npm run typecheck`
Expected: clean. (`CryptoKey` is a global type in Node 22+'s bundled `@types/node`; if a type error appears, widen `SigningKeyRef.privateKey` to `CryptoKey | import('node:crypto').KeyObject`.)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/token-client.ts server/tests/lti/token-client.test.ts
git commit -m "feat(lti): add Canvas client-credentials token client with per-scope caching"
```

---

### Task 8: `nrps.ts` part 1 — fixed-contract types + `fetchRawMembershipPages`

**Files:**
- Create: `server/src/lti/nrps.ts`
- Test: `server/tests/lti/nrps.test.ts`

**Interfaces:**
- Consumes: `NrpsRawMember` from `roster-config.ts`; the Task 6 mock endpoints.
- Produces: `CourseRosterMember`, `CourseRosterErrorKind`, `CourseRosterResult` (the fixed contract), and `fetchRawMembershipPages(nrpsUrl, accessToken, deps?): Promise<{ ok: true; members: NrpsRawMember[] } | { ok: false; error: { kind; message; retryable; retryAfterSeconds? } }>`.

- [ ] **Step 1: Write the failing tests** (each token-mutating test mints its **own** token — no shared suite token)

```ts
// server/tests/lti/nrps.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetchRawMembershipPages } from '../../src/lti/nrps.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

async function mintToken(platform: MockCanvasPlatform): Promise<string> {
  const res = await fetch(platform.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'mock-assertion',
      scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('fetchRawMembershipPages', () => {
  let platform: MockCanvasPlatform;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('follows Link-header pagination across multiple pages', async () => {
    platform.setCourseMembers('course-multi', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
      { user_id: 'u3', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);
    const token = await mintToken(platform);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-multi'), token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members.map((m) => m.user_id)).toEqual(['u1', 'u2', 'u3']);
    }
  });

  it('reports a pagination-failure when a LATER page has no members array', async () => {
    platform.setCourseMembers('course-p2break', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);
    platform.breakPaginationOnNextPage('course-p2break'); // page >= 2 returns a body with no `members`
    const token = await mintToken(platform);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-p2break'), token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('pagination-failure');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('reports expired-token on a 401', async () => {
    platform.setCourseMembers('course-expired', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    const token = await mintToken(platform);
    platform.expireAccessToken(token);

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-expired'), token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('expired-token');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('reports rate-limited with the Retry-After value on a 429', async () => {
    platform.setCourseMembers('course-429', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    const token = await mintToken(platform);
    platform.rateLimitNextRequest('course-429');

    const result = await fetchRawMembershipPages(platform.nrpsUrlFor('course-429'), token);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- nrps.test.ts`

- [ ] **Step 3: Implement**

```ts
// server/src/lti/nrps.ts
//
// Fetches and normalizes a course's Canvas roster via NRPS (spec §18). CourseRosterMember /
// CourseRosterResult / refreshCourseRoster form a fixed contract Phase 5 snapshots verbatim -- do not
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

export type FetchRawMembershipPagesResult =
  | { ok: true; members: NrpsRawMember[] }
  | { ok: false; error: RawPagesError };

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
      return {
        ok: false,
        error: { kind: 'pagination-failure', message: `Exceeded maximum of ${MAX_PAGES} NRPS pages.`, retryable: false },
      };
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
      return {
        ok: false,
        error: { kind: 'pagination-failure', message: 'NRPS response was a redirect; redirects are not followed.', retryable: false },
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        error: { kind: 'expired-token', message: 'Canvas rejected the access token as expired or invalid.', retryable: true },
      };
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
      return {
        ok: false,
        error: { kind: 'pagination-failure', message: 'NRPS response was missing a "members" array.', retryable: false },
      };
    }
    members.push(...(json as { members: NrpsRawMember[] }).members);

    nextUrl = parseNextLink(response.headers.get('link'));
  }

  return { ok: true, members };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- nrps.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/nrps.ts server/tests/lti/nrps.test.ts
git commit -m "feat(lti): add paginated NRPS membership fetching"
```

---

### Task 9: `nrps.ts` part 2 — `normalizeMember`

**Files:**
- Modify: `server/src/lti/nrps.ts`
- Modify: `server/tests/lti/nrps.test.ts`

**Interfaces:**
- Consumes: `resolveInstitutionalId` / `isEligibleForAttendance` / `InstitutionRosterConfig` / `NrpsRawMember` from `roster-config.ts`; `CourseRosterMember` (same file).
- Produces: `normalizeMember(raw: NrpsRawMember, config: InstitutionRosterConfig): CourseRosterMember`.

- [ ] **Step 1: Append the failing tests to `server/tests/lti/nrps.test.ts`**

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
    expect(normalizeMember(raw, config)).toEqual({
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
    expect(normalizeMember({ user_id: 'u2', status: 'Inactive', roles: [learnerRole] }, config).eligibleForAttendance).toBe(false);
  });

  it('excludes an instructor from eligibility', () => {
    expect(normalizeMember({ user_id: 'u3', status: 'Active', roles: [instructorRole] }, config).eligibleForAttendance).toBe(false);
  });

  it('honors a custom configured learner role', () => {
    const customConfig: InstitutionRosterConfig = { ...config, rosterLearnerRoles: ['Learner', 'ProxyLearner'] };
    const raw = { user_id: 'u4', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#ProxyLearner'] };
    expect(normalizeMember(raw, customConfig).eligibleForAttendance).toBe(true);
  });

  it('leaves institutionalId null when the SIS ID field is missing', () => {
    expect(normalizeMember({ user_id: 'u5', status: 'Active', roles: [learnerRole] }, config).institutionalId).toBeNull();
  });

  it('normalizes two members sharing the same institutionalId independently (no dedup)', () => {
    const a = normalizeMember({ user_id: 'u6', status: 'Active', roles: [learnerRole], lis_person_sourcedid: 'DUP1' }, config);
    const b = normalizeMember({ user_id: 'u7', status: 'Active', roles: [learnerRole], lis_person_sourcedid: 'DUP1' }, config);
    expect(a.institutionalId).toBe('DUP1');
    expect(b.institutionalId).toBe('DUP1');
    expect(a.ltiUserId).not.toBe(b.ltiUserId);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (`normalizeMember` not exported)**

Run: `npm test -- nrps.test.ts`

- [ ] **Step 3: Implement — append to `server/src/lti/nrps.ts`**

Add to the top imports:

```ts
import { resolveInstitutionalId, isEligibleForAttendance, type InstitutionRosterConfig } from './roster-config.js';
```

Then:

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

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- nrps.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/nrps.ts server/tests/lti/nrps.test.ts
git commit -m "feat(lti): normalize raw NRPS members into the CourseRosterMember contract"
```

---

### Task 10: `roster-store.ts` part 1 — `upsertCourseMembers`, staleness, cached reads

**Files:**
- Create: `server/src/attendance/roster-store.ts`
- Modify: `server/tests/support/seed.ts` (add `seedInstitutionAndCourse`)
- Test: `server/tests/attendance/roster-store.test.ts`

**Interfaces:**
- Consumes: `db: Database`; `courseMembers` / `courses` / `institutions` from `schema.ts`; `CourseRosterMember` from `../lti/nrps.js` (type-only); `resolveInstitutionRosterConfig` / `isEligibleForAttendance` from `../lti/roster-config.js`.
- Produces: `CourseMemberRow` (`typeof courseMembers.$inferSelect`); `UpsertRosterSummary` (`{ added; removed; stillPresent }`); `upsertCourseMembers(db, courseId, members)`; `isRosterStale(rosterCachedAt, nowMs?)`; `getCachedRoster(db, courseId)`; `getCachedRosterAsMembers(db, courseId)`; `findCourseMembersByInstitutionalId(db, courseId, institutionalId)`; `cachedRowToMember(row, learnerRoles)`.

- [ ] **Step 1: Add `seedInstitutionAndCourse` to `server/tests/support/seed.ts`**

Append (`randomUUID` is already imported from `node:crypto`; add `courses` to the `schema.js` import):

```ts
import { courses } from '../../src/database/schema.js';

export interface SeededCourse extends SeededRegistration {
  courseId: string;
}

export async function seedInstitutionAndCourse(
  db: Database,
  platform: MockCanvasPlatform,
  overrides: SeedOverrides & { nrpsUrl?: string | null } = {},
): Promise<SeededCourse> {
  const seeded = await seedInstitutionAndRegistration(db, platform, overrides);
  const [course] = await db
    .insert(courses)
    .values({
      institutionId: seeded.institutionId,
      deploymentId: seeded.deploymentRowId, // lti_deployments.id ROW UUID -- never the business string
      ltiContextId: `ctx-${randomUUID()}`,
      label: 'TEST-101',
      title: 'Test Course',
      nrpsUrl: overrides.nrpsUrl ?? null,
    })
    .returning();
  return { ...seeded, courseId: course.id };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// server/tests/attendance/roster-store.test.ts
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { courses, courseMembers } from '../../src/database/schema.js';
import {
  upsertCourseMembers,
  isRosterStale,
  getCachedRoster,
  getCachedRosterAsMembers,
  findCourseMembersByInstitutionalId,
} from '../../src/attendance/roster-store.js';
import type { CourseRosterMember } from '../../src/lti/nrps.js';

let platform: MockCanvasPlatform;

beforeAll(async () => {
  platform = new MockCanvasPlatform();
  await platform.start();
});
afterAll(async () => {
  await platform.stop();
  await closeTestDb();
});

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

  it('adds new members, marks dropped members removed (not deleted), keeps still-present members', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);

    expect(await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', institutionalId: '001' }),
      member({ ltiUserId: 'u2', institutionalId: '002' }),
    ])).toEqual({ added: 2, removed: 0, stillPresent: 0 });

    expect(await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', institutionalId: '001' }),
      member({ ltiUserId: 'u3', institutionalId: '003' }),
    ])).toEqual({ added: 1, removed: 1, stillPresent: 1 });

    const rows = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.ltiUserId === 'u2')?.status).toBe('removed');
    expect(rows.find((r) => r.ltiUserId === 'u1')?.status).toBe('Active');
  });

  it('persists an attribute change on a still-present member (spec §46 "changed roster")', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1', displayName: 'Old Name' })]);

    const summary = await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1', displayName: 'New Name' })]);
    expect(summary).toEqual({ added: 0, removed: 0, stillPresent: 1 });

    const [row] = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(row.displayName).toBe('New Name');
  });

  it('re-activates a previously-removed member that reappears', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1' })]);
    await upsertCourseMembers(db, courseId, []); // u1 dropped -> status 'removed'
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1', status: 'Active' })]);

    const [row] = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    expect(row.status).toBe('Active');
  });

  it('updates courses.rosterCachedAt on every call', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    const before = Date.now();
    await upsertCourseMembers(db, courseId, [member({ ltiUserId: 'u1' })]);
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
    expect(course.rosterCachedAt).not.toBeNull();
    expect(course.rosterCachedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

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

describe('getCachedRoster / getCachedRosterAsMembers', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null for a course with no row', async () => {
    const { db } = getTestDb();
    expect(await getCachedRoster(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await getCachedRosterAsMembers(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('getCachedRosterAsMembers recomputes eligibleForAttendance on every row and excludes removed', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], status: 'Active' }),
      member({ ltiUserId: 'u2', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'], status: 'Active' }),
    ]);
    await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], status: 'Active' }),
    ]); // u2 dropped

    const cached = await getCachedRosterAsMembers(db, courseId);
    expect(cached).not.toBeNull();
    expect(cached!.members).toHaveLength(1);
    expect(cached!.members[0]).toMatchObject({ ltiUserId: 'u1', eligibleForAttendance: true });
    expect(cached!.members[0]).toHaveProperty('eligibleForAttendance');
  });
});

describe('findCourseMembersByInstitutionalId', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns every member sharing an institutionalId, never merging or dropping duplicates', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform);
    await upsertCourseMembers(db, courseId, [
      member({ ltiUserId: 'u1', institutionalId: 'DUP1' }),
      member({ ltiUserId: 'u2', institutionalId: 'DUP1' }),
      member({ ltiUserId: 'u3', institutionalId: 'UNIQUE' }),
    ]);

    expect((await findCourseMembersByInstitutionalId(db, courseId, 'DUP1')).map((m) => m.ltiUserId).sort()).toEqual(['u1', 'u2']);
    expect(await findCourseMembersByInstitutionalId(db, courseId, 'UNIQUE')).toHaveLength(1);
    expect(await findCourseMembersByInstitutionalId(db, courseId, 'NOPE')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run — expect FAIL (module not found)**

Run: `npm test -- roster-store.test.ts`

- [ ] **Step 4: Implement**

```ts
// server/src/attendance/roster-store.ts
//
// Persists the Canvas roster fetched by lti/nrps.ts into course_members. A row that drops off the
// roster is marked status: 'removed', never deleted, so a Phase 5 attendance_session_members snapshot
// holding a course_members.id never dangles. Also owns the shared getRosterWithFallback degradation
// helper (Task 12).

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { courseMembers, courses, institutions } from '../database/schema.js';
import type { CourseRosterMember } from '../lti/nrps.js';
import { resolveInstitutionRosterConfig, isEligibleForAttendance } from '../lti/roster-config.js';

export type CourseMemberRow = typeof courseMembers.$inferSelect;

export interface UpsertRosterSummary {
  added: number;
  removed: number;
  stillPresent: number;
}

export async function upsertCourseMembers(
  db: Database,
  courseId: string,
  members: CourseRosterMember[],
): Promise<UpsertRosterSummary> {
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
    const existingIds = new Set(existing.map((r) => r.ltiUserId));
    const freshIds = new Set(members.map((m) => m.ltiUserId));

    let added = 0;
    let stillPresent = 0;

    for (const m of members) {
      if (existingIds.has(m.ltiUserId)) stillPresent += 1;
      else added += 1;

      const values = {
        institutionalId: m.institutionalId,
        displayName: m.displayName,
        givenName: m.givenName,
        familyName: m.familyName,
        email: m.email,
        roles: m.roles,
        status: m.status,
        lastSeenAt: new Date(),
      };
      await tx
        .insert(courseMembers)
        .values({ courseId, ltiUserId: m.ltiUserId, ...values })
        .onConflictDoUpdate({ target: [courseMembers.courseId, courseMembers.ltiUserId], set: values });
    }

    const dropped = existing
      .filter((r) => !freshIds.has(r.ltiUserId) && r.status !== 'removed')
      .map((r) => r.ltiUserId);
    if (dropped.length > 0) {
      await tx
        .update(courseMembers)
        .set({ status: 'removed', lastSeenAt: new Date() })
        .where(and(eq(courseMembers.courseId, courseId), inArray(courseMembers.ltiUserId, dropped)));
    }

    await tx.update(courses).set({ rosterCachedAt: new Date() }).where(eq(courses.id, courseId));

    return { added, removed: dropped.length, stillPresent };
  });
}

const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000; // spec §18.4

export function isRosterStale(rosterCachedAt: Date | null, nowMs: number = Date.now()): boolean {
  if (rosterCachedAt === null) return true;
  return nowMs - rosterCachedAt.getTime() > ROSTER_CACHE_TTL_MS;
}

export async function getCachedRoster(
  db: Database,
  courseId: string,
): Promise<{ members: CourseMemberRow[]; rosterCachedAt: Date | null } | null> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
  if (!course) return null;
  const members = await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId));
  return { members, rosterCachedAt: course.rosterCachedAt };
}

export async function findCourseMembersByInstitutionalId(
  db: Database,
  courseId: string,
  institutionalId: string,
): Promise<CourseMemberRow[]> {
  return db
    .select()
    .from(courseMembers)
    .where(and(eq(courseMembers.courseId, courseId), eq(courseMembers.institutionalId, institutionalId)));
}

async function resolveLearnerRoles(db: Database, courseId: string): Promise<string[]> {
  const [row] = await db
    .select({
      canvasIdentityMatchField: institutions.canvasIdentityMatchField,
      identityMatchEmailEnabled: institutions.identityMatchEmailEnabled,
      rosterLearnerRoles: institutions.rosterLearnerRoles,
    })
    .from(courses)
    .innerJoin(institutions, eq(courses.institutionId, institutions.id))
    .where(eq(courses.id, courseId));
  return row ? resolveInstitutionRosterConfig(row).rosterLearnerRoles : ['Learner'];
}

// Single converter used by EVERY cache-read path so eligibleForAttendance is always present and always
// computed the same way (spec §25.2 "normalized members" -- one shape regardless of cache age).
export function cachedRowToMember(row: CourseMemberRow, learnerRoles: string[]): CourseRosterMember {
  const roles = (row.roles as string[]) ?? [];
  return {
    ltiUserId: row.ltiUserId,
    institutionalId: row.institutionalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    email: row.email,
    roles,
    status: row.status,
    eligibleForAttendance: isEligibleForAttendance(row.status, roles, learnerRoles),
  };
}

export async function getCachedRosterAsMembers(
  db: Database,
  courseId: string,
): Promise<{ members: CourseRosterMember[]; rosterCachedAt: Date | null } | null> {
  const cached = await getCachedRoster(db, courseId);
  if (!cached) return null;
  const learnerRoles = await resolveLearnerRoles(db, courseId);
  return {
    members: cached.members.filter((m) => m.status !== 'removed').map((m) => cachedRowToMember(m, learnerRoles)),
    rosterCachedAt: cached.rosterCachedAt,
  };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm test -- roster-store.test.ts`

- [ ] **Step 6: Commit**

```bash
git add server/src/attendance/roster-store.ts server/tests/attendance/roster-store.test.ts server/tests/support/seed.ts
git commit -m "feat(attendance): add course-member upsert, staleness check, and normalized cache reads"
```

---

### Task 11: `nrps.ts` part 3 — `refreshCourseRoster` orchestrator

**Files:**
- Modify: `server/src/lti/nrps.ts`
- Modify: `server/tests/lti/nrps.test.ts`

**Interfaces:**
- Consumes: `db: Database`; `validateCanvasServiceUrl` (Task 4); `getAccessToken` / `clearAccessTokenCache` (Task 7); `NRPS_MEMBERSHIP_READONLY_SCOPE` (Task 3); `resolveInstitutionRosterConfig` (Task 5); `upsertCourseMembers` (Task 10); `fetchRawMembershipPages` / `normalizeMember` (same file); `courses` / `institutions` / `ltiDeployments` / `ltiRegistrations` from `schema.ts`; `ToolSigningKey` (type-only) from `./signing-keys.js`.
- Produces: `RefreshCourseRosterDeps`; `refreshCourseRoster(db, courseId, deps): Promise<CourseRosterResult>` — the fixed-contract raw fetch. **Never throws on a transient Canvas error** (network failures during token acquisition are caught and returned as `{ ok: false, error: { kind: 'network', retryable: true } }`).

The active signing key is **injected** via `deps.signingKey` (D5 — there is no module-level accessor). The client assertion `aud` is `registration.tokenAudience` (D4).

- [ ] **Step 1: Append the failing tests to `server/tests/lti/nrps.test.ts`**

```ts
import { refreshCourseRoster } from '../../src/lti/nrps.js';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndCourse } from '../support/seed.js';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { courseMembers } from '../../src/database/schema.js';

// This file already has a MockCanvasPlatform in an outer describe; the refresh suite uses its own so
// the two lifecycles stay independent. Close the shared pg pool once, at file scope.
afterAll(async () => {
  await closeTestDb();
});

describe('refreshCourseRoster', () => {
  let platform: MockCanvasPlatform;
  let signingKey: ToolSigningKey;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    // Exercises the REAL getActiveSigningKey(keys) -- synchronous, takes the loaded array.
    signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
  });
  afterAll(async () => {
    await platform.stop();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('fetches, normalizes, and persists the roster (mock serves plain http)', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-a') });
    platform.setCourseMembers('course-a', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '001' },
    ]);
    platform.setPageSize(1);

    const result = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(1);
      expect(result.members[0].institutionalId).toBe('001');
    }
    expect(await db.select().from(courseMembers).where(eq(courseMembers.courseId, courseId))).toHaveLength(1);
  });

  it('retries once after clearing the token cache on an expired token, then succeeds', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-b') });
    platform.setCourseMembers('course-b', [{ user_id: 'u1', status: 'Active', roles: [] }]);

    const first = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(first.ok).toBe(true);

    // Capture the token our cache is now holding via a spying fetchImpl, expire exactly that token on
    // the mock, then refresh again -- refreshCourseRoster clears its cache on the 401 and re-auths.
    let captured: string | undefined;
    const spyFetch: typeof fetch = async (input, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth?.startsWith('Bearer ') && typeof input === 'string' && input.includes('/nrps/')) {
        captured = auth.slice('Bearer '.length);
      }
      return fetch(input as string, init);
    };
    await refreshCourseRoster(db, courseId, { signingKey, fetchImpl: spyFetch, sleepImpl: async () => {} });
    expect(captured).toBeDefined();

    platform.expireAccessToken(captured!);
    const retried = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(retried.ok).toBe(true);
  });

  it('retries after a 429, honoring Retry-After, then succeeds', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-c') });
    platform.setCourseMembers('course-c', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    platform.rateLimitNextRequest('course-c');

    const result = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(result.ok).toBe(true);
  });

  it('fails with invalid-service-url when the course has no nrpsUrl', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: null });

    const result = await refreshCourseRoster(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-service-url');
  });

  it('returns a non-throwing network error when token acquisition fails', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('course-d') });
    const deadFetch: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const result = await refreshCourseRoster(db, courseId, { signingKey, fetchImpl: deadFetch, sleepImpl: async () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.retryable).toBe(true);
    }
  });
});
```

Note: each `seedInstitutionAndCourse` call inserts a fresh `lti_registrations` row with a random `id`, so the module-level token cache in `token-client.ts` (keyed on `registrationId + scopes`) never leaks a token between tests.

- [ ] **Step 2: Run — expect FAIL (`refreshCourseRoster` not exported)**

Run: `npm test -- nrps.test.ts`

- [ ] **Step 3: Implement — append to `server/src/lti/nrps.ts`**

Add to the top imports:

```ts
import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { courses, institutions, ltiDeployments, ltiRegistrations } from '../database/schema.js';
import type { ToolSigningKey } from './signing-keys.js';
import { validateCanvasServiceUrl } from './service-url.js';
import { getAccessToken, clearAccessTokenCache } from './token-client.js';
import { NRPS_MEMBERSHIP_READONLY_SCOPE } from './scopes.js';
import { resolveInstitutionRosterConfig } from './roster-config.js';
import { upsertCourseMembers } from '../attendance/roster-store.js';
```

<!-- reviser note (B1): the import cycle nrps.ts (imports upsertCourseMembers) <-> roster-store.ts
     (Task 12 imports refreshCourseRoster) is safe -- neither module calls the other's exports at
     module load, only inside function bodies (ESM live bindings). This replaces the old "no runtime
     circular dependency" hand-wave, which existed only because of the removed db singleton. -->

```ts
async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CourseRosterContext {
  courseId: string;
  nrpsUrl: string | null;
  registration: { id: string; clientId: string; tokenEndpoint: string; tokenAudience: string };
  institution: { canvasIdentityMatchField: string; identityMatchEmailEnabled: boolean; rosterLearnerRoles: string[] };
}

async function loadCourseRosterContext(db: Database, courseId: string): Promise<CourseRosterContext | null> {
  const rows = await db
    .select({
      courseId: courses.id,
      nrpsUrl: courses.nrpsUrl,
      canvasIdentityMatchField: institutions.canvasIdentityMatchField,
      identityMatchEmailEnabled: institutions.identityMatchEmailEnabled,
      rosterLearnerRoles: institutions.rosterLearnerRoles,
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
    nrpsUrl: row.nrpsUrl,
    registration: {
      id: row.registrationId,
      clientId: row.registrationClientId,
      tokenEndpoint: row.registrationTokenEndpoint,
      tokenAudience: row.registrationTokenAudience,
    },
    institution: {
      canvasIdentityMatchField: row.canvasIdentityMatchField,
      identityMatchEmailEnabled: row.identityMatchEmailEnabled,
      rosterLearnerRoles: row.rosterLearnerRoles,
    },
  };
}

export interface RefreshCourseRosterDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

export async function refreshCourseRoster(
  db: Database,
  courseId: string,
  deps: RefreshCourseRosterDeps,
): Promise<CourseRosterResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  const maxRateLimitRetries = deps.maxRateLimitRetries ?? 3;

  const context = await loadCourseRosterContext(db, courseId);
  if (!context) {
    return { ok: false, error: { kind: 'invalid-service-url', message: `Course ${courseId} not found.`, retryable: false } };
  }
  if (!context.nrpsUrl) {
    return {
      ok: false,
      error: { kind: 'invalid-service-url', message: 'Course has no NRPS service URL from its launch context.', retryable: false },
    };
  }

  const urlCheck = validateCanvasServiceUrl(context.nrpsUrl);
  if (!urlCheck.ok) {
    return {
      ok: false,
      error: { kind: 'invalid-service-url', message: `NRPS URL failed validation: ${urlCheck.error}`, retryable: false },
    };
  }

  const rosterConfig = resolveInstitutionRosterConfig(context.institution);
  let tokenRetried = false;
  let rateLimitAttempt = 0;

  for (;;) {
    let accessToken: string;
    try {
      accessToken = await getAccessToken(
        {
          id: context.registration.id,
          clientId: context.registration.clientId,
          tokenEndpoint: context.registration.tokenEndpoint,
          tokenAudience: context.registration.tokenAudience,
        },
        [NRPS_MEMBERSHIP_READONLY_SCOPE],
        { signingKey: deps.signingKey, fetchImpl },
      );
    } catch (err) {
      // Never throw on a transient Canvas failure (D9): a dead token endpoint is a retryable network error.
      return {
        ok: false,
        error: { kind: 'network', message: err instanceof Error ? err.message : 'Token acquisition failed.', retryable: true },
      };
    }

    const pages = await fetchRawMembershipPages(context.nrpsUrl, accessToken, { fetchImpl });

    if (pages.ok) {
      const members = pages.members.map((raw) => normalizeMember(raw, rosterConfig));
      const fetchedAt = new Date().toISOString();
      await upsertCourseMembers(db, courseId, members);
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

- [ ] **Step 4: Run — expect PASS; then full suite + typecheck + lint**

Run: `npm test -- nrps.test.ts`
Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/nrps.ts server/tests/lti/nrps.test.ts
git commit -m "feat(lti): add refreshCourseRoster orchestrator (injected signing key, token retry, 429 backoff)"
```

---

### Task 12: `roster-store.ts` part 2 — `getRosterWithFallback` shared degradation helper

**Files:**
- Modify: `server/src/attendance/roster-store.ts`
- Modify: `server/tests/attendance/roster-store.test.ts`

**Interfaces:**
- Consumes: `refreshCourseRoster` from `../lti/nrps.js`; `getCachedRosterAsMembers` (same file); `ToolSigningKey` (type-only).
- Produces: `STALE_CACHE_MAX_AGE_MS` (24h, exported — Phase 5 reuses it); `RosterUnavailableError` (carries `.kind`); `getRosterWithFallback(db, courseId, deps): Promise<{ members; fetchedAt; stale; refreshed }>`.

Semantics: try a fresh `refreshCourseRoster`; on `ok` return `{ stale: false, refreshed: true }`. On any `{ ok: false }` fall back to the persisted roster **iff** it is `< 24h` old → `{ stale: true, refreshed: false }`. If there is no fresh fetch **and** no `<24h` cache, throw `RosterUnavailableError`. Both Phase 4 roster routes and Phase 5's `createSession` call this — never `refreshCourseRoster` directly.

- [ ] **Step 1: Append the failing tests to `server/tests/attendance/roster-store.test.ts`**

```ts
import {
  getRosterWithFallback,
  RosterUnavailableError,
  STALE_CACHE_MAX_AGE_MS,
} from '../../src/attendance/roster-store.js';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';

describe('getRosterWithFallback', () => {
  let signingKey: ToolSigningKey;

  beforeAll(async () => {
    signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('exports a 24h ceiling', () => {
    expect(STALE_CACHE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('returns a fresh roster with refreshed:true on a successful Canvas fetch', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-fresh') });
    platform.setCourseMembers('gw-fresh', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'] },
    ]);

    const result = await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(result).toMatchObject({ stale: false, refreshed: true });
    expect(result.members[0]).toHaveProperty('eligibleForAttendance', true);
  });

  it('falls back to a <24h cache with stale:true when the fresh fetch fails', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-stale') });
    platform.setCourseMembers('gw-stale', [
      { user_id: 'u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'] },
      { user_id: 'u2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] },
    ]);
    // Populate the cache with a real refresh, then break Canvas.
    await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await getRosterWithFallback(db, courseId, { signingKey, fetchImpl: dead, sleepImpl: async () => {} });
    expect(result).toMatchObject({ stale: true, refreshed: false });
    expect(result.members).toHaveLength(2);
    // SG3 shape parity: same keys as the fresh path.
    const fresh = await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    expect(Object.keys(result.members[0]).sort()).toEqual(Object.keys(fresh.members[0]).sort());
  });

  it('throws RosterUnavailableError when the fetch fails and there is no cache', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-none') });
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(getRosterWithFallback(db, courseId, { signingKey, fetchImpl: dead, sleepImpl: async () => {} })).rejects.toBeInstanceOf(
      RosterUnavailableError,
    );
  });

  it('throws RosterUnavailableError when the fetch fails and the cache is older than 24h', async () => {
    const { db } = getTestDb();
    const { courseId } = await seedInstitutionAndCourse(db, platform, { nrpsUrl: platform.nrpsUrlFor('gw-25h') });
    platform.setCourseMembers('gw-25h', [{ user_id: 'u1', status: 'Active', roles: [] }]);
    await getRosterWithFallback(db, courseId, { signingKey, sleepImpl: async () => {} });
    // Age the cache to 25 hours.
    await db.update(courses).set({ rosterCachedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }).where(eq(courses.id, courseId));
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(getRosterWithFallback(db, courseId, { signingKey, fetchImpl: dead, sleepImpl: async () => {} })).rejects.toBeInstanceOf(
      RosterUnavailableError,
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL (`getRosterWithFallback` not exported)**

Run: `npm test -- roster-store.test.ts`

- [ ] **Step 3: Implement — append to `server/src/attendance/roster-store.ts`**

Add to the top imports:

```ts
import { refreshCourseRoster } from '../lti/nrps.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
```

(Same benign nrps.ts ⇄ roster-store.ts cycle note as Task 11 — function-body use only.)

```ts
export const STALE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class RosterUnavailableError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.name = 'RosterUnavailableError';
    this.kind = kind;
  }
}

export interface RosterWithFallback {
  members: CourseRosterMember[];
  fetchedAt: string;
  stale: boolean;
  refreshed: boolean;
}

export interface GetRosterWithFallbackDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function getRosterWithFallback(
  db: Database,
  courseId: string,
  deps: GetRosterWithFallbackDeps,
): Promise<RosterWithFallback> {
  const now = deps.now ?? Date.now;

  const fresh = await refreshCourseRoster(db, courseId, {
    signingKey: deps.signingKey,
    fetchImpl: deps.fetchImpl,
    sleepImpl: deps.sleepImpl,
  });
  if (fresh.ok) {
    return { members: fresh.members, fetchedAt: fresh.fetchedAt, stale: false, refreshed: true };
  }

  const cached = await getCachedRosterAsMembers(db, courseId);
  if (cached && cached.rosterCachedAt && now() - cached.rosterCachedAt.getTime() < STALE_CACHE_MAX_AGE_MS) {
    return {
      members: cached.members,
      fetchedAt: cached.rosterCachedAt.toISOString(),
      stale: true,
      refreshed: false,
    };
  }

  throw new RosterUnavailableError(fresh.error.message, fresh.error.kind);
}
```

<!-- reviser note (D9): constraints D9 wrote getRosterWithFallback(db, courseId). A third `deps` param
     carrying { signingKey, fetchImpl?, sleepImpl?, now? } was added because refreshCourseRoster requires
     the injected active ToolSigningKey per D5 and that cannot be sourced at module level. Phase 5's
     createSession must likewise thread signingKey in from its route deps / index.ts. The return adds a
     `refreshed` boolean so callers can audit only real Canvas refreshes (SG4). -->

- [ ] **Step 4: Run — expect PASS; then full suite + typecheck + lint**

Run: `npm test -- roster-store.test.ts`
Run: `npm test && npm run typecheck && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add server/src/attendance/roster-store.ts server/tests/attendance/roster-store.test.ts
git commit -m "feat(attendance): add shared getRosterWithFallback stale-cache degradation helper"
```

---

### Task 13: `GET /api/course/roster` route

**Files:**
- Create: `server/src/routes/course-roster.ts`
- Test: `server/tests/routes/course-roster.test.ts`

**Interfaces:**
- Consumes: `getCachedRosterAsMembers` / `isRosterStale` / `getRosterWithFallback` / `RosterUnavailableError` from `../attendance/roster-store.js`; `auditEvents` from `../database/schema.js`; `Database` and `AppSession` types; `ToolSigningKey` type.
- Produces: `CourseRosterRouteDeps` (`{ db; requireSession; requireCsrf; signingKey }`); `registerCourseRosterRoutes(app, deps): void` — registers `GET /api/course/roster` here and `POST /api/course/roster/refresh` in Task 14, in the same function, following the shipped `registerMeRoute(app, { requireSession, db })` precedent.

GET behavior: serve a `<5-min` cache without contacting Canvas (`stale: false`, no audit). Otherwise call `getRosterWithFallback`; when it reports `refreshed: true` write a `roster_refreshed` audit row with `request_id = request.id` (SG4/§33/§31.9). On `RosterUnavailableError` return `502`. Every response body is `{ members: CourseRosterMember[]; fetchedAt: string; stale: boolean }` — one shape regardless of cache age (SG3).

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/routes/course-roster.test.ts
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerCourseRosterRoutes } from '../../src/routes/course-roster.js';
import { RosterUnavailableError } from '../../src/attendance/roster-store.js';
import type { Database } from '../../src/database/client.js';
import type { ToolSigningKey } from '../../src/lti/signing-keys.js';

const mockGetCachedRosterAsMembers = vi.fn();
const mockGetRosterWithFallback = vi.fn();

vi.mock('../../src/attendance/roster-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/attendance/roster-store.js')>();
  return {
    ...actual, // keeps the real RosterUnavailableError + isRosterStale
    getCachedRosterAsMembers: (...a: unknown[]) => mockGetCachedRosterAsMembers(...a),
    getRosterWithFallback: (...a: unknown[]) => mockGetRosterWithFallback(...a),
  };
});

function fullMember(overrides: Record<string, unknown> = {}) {
  return {
    ltiUserId: 'u1',
    institutionalId: '001',
    displayName: 'Jane',
    givenName: null,
    familyName: null,
    email: null,
    roles: [],
    status: 'Active',
    eligibleForAttendance: true,
    ...overrides,
  };
}

function buildTestApp(opts: { authenticated?: boolean } = { authenticated: true }) {
  const app = Fastify({ logger: false });
  const auditInsert = vi.fn();
  const db = { insert: () => ({ values: auditInsert }) } as unknown as Database;
  const requireSession = async (request: FastifyRequest) => {
    if (opts.authenticated) {
      request.appSession = {
        id: 's1',
        institutionId: 'inst-1',
        deploymentId: 'dep-1',
        ltiSubject: 'sub-1',
        displayName: null,
        courseId: 'course-1',
        roles: [],
        csrfSecret: 'secret',
      };
    }
  };
  const requireCsrf = async () => {};
  registerCourseRosterRoutes(app, { db, requireSession, requireCsrf, signingKey: {} as ToolSigningKey });
  return { app, auditInsert };
}

describe('GET /api/course/roster', () => {
  beforeEach(() => {
    mockGetCachedRosterAsMembers.mockReset();
    mockGetRosterWithFallback.mockReset();
  });

  it('serves a <5-min cache without contacting Canvas and without auditing', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue({ members: [fullMember()], rosterCachedAt: new Date() });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(false);
    expect(res.json().members[0]).toHaveProperty('eligibleForAttendance');
    expect(mockGetRosterWithFallback).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('refreshes when the cache is stale and audits the successful refresh', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue({ members: [], rosterCachedAt: new Date(Date.now() - 10 * 60 * 1000) });
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember()],
      fetchedAt: new Date().toISOString(),
      stale: false,
      refreshed: true,
    });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(1);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'roster_refreshed',
        institutionId: 'inst-1',
        courseId: 'course-1',
        targetId: 'course-1',
        actorLtiUserId: 'sub-1',
      }),
    );
    expect(auditInsert.mock.calls[0][0].requestId).toBeTruthy();
  });

  it('returns the degraded cache (stale:true) without auditing when refresh fails', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue(null);
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember()],
      fetchedAt: new Date().toISOString(),
      stale: true,
      refreshed: false,
    });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });

    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(true);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('returns 502 when the roster is entirely unavailable', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue(null);
    mockGetRosterWithFallback.mockRejectedValue(new RosterUnavailableError('boom', 'network'));
    const { app } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });
    expect(res.statusCode).toBe(502);
  });

  it('never collapses duplicate institutionalId members', async () => {
    mockGetCachedRosterAsMembers.mockResolvedValue(null);
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember({ ltiUserId: 'u1', institutionalId: 'DUP' }), fullMember({ ltiUserId: 'u2', institutionalId: 'DUP' })],
      fetchedAt: new Date().toISOString(),
      stale: false,
      refreshed: true,
    });
    const { app } = buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });
    expect(res.json().members).toHaveLength(2);
  });

  it('returns 401 when no session is established', async () => {
    const { app } = buildTestApp({ authenticated: false });
    const res = await app.inject({ method: 'GET', url: '/api/course/roster' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

Run: `npm test -- course-roster.test.ts`

- [ ] **Step 3: Implement**

```ts
// server/src/routes/course-roster.ts
//
// GET /api/course/roster, POST /api/course/roster/refresh (spec §25.2). Both return normalized
// CourseRosterMember-shaped members (never a raw NRPS payload), one shape regardless of cache age.
// Both degrade to a <24h cache with stale:true rather than hard-failing (a transient Canvas 429 must
// not block an instructor mid-class). A successful live refresh writes a roster_refreshed audit row
// (spec §33) carrying request.id as the correlation id (spec §31.9).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database/client.js';
import type { AppSession } from '../auth/session.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';
import { auditEvents } from '../database/schema.js';
import {
  getCachedRosterAsMembers,
  getRosterWithFallback,
  isRosterStale,
  RosterUnavailableError,
} from '../attendance/roster-store.js';
import type { CourseRosterMember } from '../lti/nrps.js';

export interface CourseRosterRouteDeps {
  db: Database;
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireCsrf: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  signingKey: ToolSigningKey;
}

function serializeMember(m: CourseRosterMember) {
  return {
    ltiUserId: m.ltiUserId,
    institutionalId: m.institutionalId,
    displayName: m.displayName,
    givenName: m.givenName,
    familyName: m.familyName,
    email: m.email,
    roles: m.roles,
    status: m.status,
    eligibleForAttendance: m.eligibleForAttendance,
  };
}

async function writeRosterRefreshedAuditEvent(
  db: Database,
  session: AppSession,
  memberCount: number,
  requestId: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    institutionId: session.institutionId,
    courseId: session.courseId,
    actorLtiUserId: session.ltiSubject,
    eventType: 'roster_refreshed',
    targetType: 'course',
    targetId: session.courseId,
    newValue: { memberCount },
    requestId,
  });
}

export function registerCourseRosterRoutes(app: FastifyInstance, deps: CourseRosterRouteDeps): void {
  app.get('/api/course/roster', { preHandler: deps.requireSession }, async (request, reply) => {
    const session = request.appSession;
    if (!session) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const cached = await getCachedRosterAsMembers(deps.db, session.courseId);
    if (cached && !isRosterStale(cached.rosterCachedAt)) {
      return {
        members: cached.members.map(serializeMember),
        fetchedAt: cached.rosterCachedAt!.toISOString(),
        stale: false,
      };
    }

    try {
      const roster = await getRosterWithFallback(deps.db, session.courseId, { signingKey: deps.signingKey });
      if (roster.refreshed) {
        await writeRosterRefreshedAuditEvent(deps.db, session, roster.members.length, request.id);
      }
      return { members: roster.members.map(serializeMember), fetchedAt: roster.fetchedAt, stale: roster.stale };
    } catch (err) {
      if (err instanceof RosterUnavailableError) {
        return reply.code(502).send({ error: 'roster_refresh_failed', message: err.message });
      }
      throw err;
    }
  });

  // POST /api/course/roster/refresh is added in Task 14, inside this same function.
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test -- course-roster.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/course-roster.ts server/tests/routes/course-roster.test.ts
git commit -m "feat(routes): add GET /api/course/roster with 5-min cache, stale fallback, and refresh audit"
```

---

### Task 14: `POST /api/course/roster/refresh` route

**Files:**
- Modify: `server/src/routes/course-roster.ts`
- Modify: `server/tests/routes/course-roster.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Produces: `POST /api/course/roster/refresh`, registered inside `registerCourseRosterRoutes`. `preHandler: [deps.requireSession, deps.requireCsrf]` — it is a state-mutating POST, so it also enforces spec §15 (rejects form-encoded bodies). It force-refreshes (`getRosterWithFallback`, which always attempts Canvas first), writes `roster_refreshed` on a successful live refresh, and degrades to a `<24h` cache on failure exactly like the GET path.

<!-- USER RULING (2026-08-27): APPROVED — `POST /api/course/roster/refresh` is CSRF-gated in Phase 4,
     ahead of Phase 5's web-client CSRF bootstrap (Phase 5 Task 13). No Phase 4 web caller of this
     endpoint exists, so there is no dead end; it is exercised by tests only until Phase 5 wires the
     browser CSRF/JSON plumbing (constraints D7). Rationale retained: constraints D6 documents the
     [requireSession, requireCsrf] pattern for Phase 5 mutating routes; it is applied here because this
     is a Phase 4 mutation and spec §15 forbids form-encoded mutations regardless of phase. Resolved. -->

- [ ] **Step 1: Append the failing tests to `server/tests/routes/course-roster.test.ts`**

```ts
import { createRequireCsrf } from '../../src/auth/middleware.js';

describe('POST /api/course/roster/refresh', () => {
  beforeEach(() => {
    mockGetCachedRosterAsMembers.mockReset();
    mockGetRosterWithFallback.mockReset();
  });

  it('force-refreshes and writes a roster_refreshed audit event on success', async () => {
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember()],
      fetchedAt: new Date().toISOString(),
      stale: false,
      refreshed: true,
    });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/course/roster/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(false);
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'roster_refreshed', courseId: 'course-1', institutionId: 'inst-1' }),
    );
  });

  it('falls back to a <24h cache with stale:true on failure, writing no audit event', async () => {
    mockGetRosterWithFallback.mockResolvedValue({
      members: [fullMember()],
      fetchedAt: new Date().toISOString(),
      stale: true,
      refreshed: false,
    });
    const { app, auditInsert } = buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/course/roster/refresh' });

    expect(res.statusCode).toBe(200);
    expect(res.json().stale).toBe(true);
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('returns 502 on failure with no usable cache', async () => {
    mockGetRosterWithFallback.mockRejectedValue(new RosterUnavailableError('boom', 'network'));
    const { app } = buildTestApp();

    const res = await app.inject({ method: 'POST', url: '/api/course/roster/refresh' });
    expect(res.statusCode).toBe(502);
  });

  it('rejects a form-encoded body with 403 (spec §15)', async () => {
    // Use the REAL requireCsrf here to exercise the content-type guard.
    const app = Fastify({ logger: false });
    const db = { insert: () => ({ values: vi.fn() }) } as unknown as Database;
    const requireSession = async (request: FastifyRequest) => {
      request.appSession = {
        id: 's1', institutionId: 'inst-1', deploymentId: 'dep-1', ltiSubject: 'sub-1',
        displayName: null, courseId: 'course-1', roles: [], csrfSecret: 'secret',
      };
    };
    registerCourseRosterRoutes(app, {
      db,
      requireSession,
      requireCsrf: createRequireCsrf('https://app.test'),
      signingKey: {} as ToolSigningKey,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/course/roster/refresh',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'x=1',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'form_encoded_mutation_rejected' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL (404 on the new route)**

Run: `npm test -- course-roster.test.ts`

- [ ] **Step 3: Implement — add the POST route inside `registerCourseRosterRoutes`, after the GET route**

```ts
  app.post(
    '/api/course/roster/refresh',
    { preHandler: [deps.requireSession, deps.requireCsrf] },
    async (request, reply) => {
      const session = request.appSession;
      if (!session) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }

      try {
        const roster = await getRosterWithFallback(deps.db, session.courseId, { signingKey: deps.signingKey });
        if (roster.refreshed) {
          await writeRosterRefreshedAuditEvent(deps.db, session, roster.members.length, request.id);
        }
        return { members: roster.members.map(serializeMember), fetchedAt: roster.fetchedAt, stale: roster.stale };
      } catch (err) {
        if (err instanceof RosterUnavailableError) {
          return reply.code(502).send({ error: 'roster_refresh_failed', message: err.message });
        }
        throw err;
      }
    },
  );
```

- [ ] **Step 4: Wire into `server/src/index.ts`**

Add imports:

```ts
import { registerCourseRosterRoutes } from './routes/course-roster.js';
import { createRequireSession, createRequireCsrf } from './auth/middleware.js';
import { loadSigningKeysFromEnv, getActiveSigningKey } from './lti/signing-keys.js';
```

(`createRequireSession` is already imported — add `createRequireCsrf` and `getActiveSigningKey` to the existing import lines.) Then, beside the existing `registerMeRoute(app, { requireSession, db })` call **on the root `app`** (NOT inside the rate-limited plugin scope — a class must be able to refresh the roster without hitting the §31.10 limit):

```ts
const requireSession = createRequireSession(db);
const requireCsrf = createRequireCsrf(env.APP_BASE_URL);
registerMeRoute(app, { requireSession, db });
registerCourseRosterRoutes(app, {
  db,
  requireSession,
  requireCsrf,
  signingKey: getActiveSigningKey(signingKeys),
});
```

(`signingKeys` is already loaded at boot: `const signingKeys = await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON)`.)

- [ ] **Step 5: Run — expect PASS; then full suite + typecheck + lint**

Run: `npm test -- course-roster.test.ts`
Run: `npm test && npm run typecheck && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/course-roster.ts server/tests/routes/course-roster.test.ts server/src/index.ts
git commit -m "feat(routes): add POST /api/course/roster/refresh (session+CSRF gated) with audit logging"
```

---

### Task 15: Full integration test — launch → roster, zero CSV upload

**Files:**
- Create: `server/tests/routes/course-roster-integration.test.ts`
- Modify: `docs/canvas-lti/progress.md` (during execution only — see Step 4)

The literal Phase 4 exit criterion (spec:2743): *instructor launches from a course and sees the active Canvas learner roster without uploading a file.* This test composes the real route modules onto a **local Fastify instance** (the Phase 3 route-test pattern — it does **not** import `server/src/index.ts`, which has no exports and binds a port at module load).

- [ ] **Step 1: Write the integration test**

```ts
// server/tests/routes/course-roster-integration.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { registerLtiLoginRoute } from '../../src/routes/lti-login.js';
import { registerLtiLaunchRoute } from '../../src/routes/lti-launch.js';
import { registerCourseRosterRoutes } from '../../src/routes/course-roster.js';
import { createAllowlist } from '../../src/lti/login.js';
import { findEnabledDeployment } from '../../src/lti/registrations.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { createRequireSession, createRequireCsrf } from '../../src/auth/middleware.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { auditEvents } from '../../src/database/schema.js';
import type { Database } from '../../src/database/client.js';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const APP_BASE_URL = 'https://app.test';
const TARGET = `${APP_BASE_URL}/index.html`;

function buildTestApp(db: Database, jwksCache: JwksCache, signingKey: ToolSigningKey) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  registerLtiLoginRoute(app, {
    appBaseUrl: APP_BASE_URL,
    allowedTargetLinkUris: createAllowlist([TARGET]),
    findEnabledDeployment: (iss, clientId, deploymentId) => findEnabledDeployment(db, iss, clientId, deploymentId),
    createTransaction: (params) => createOidcTransaction(db, { ...params, ttlSeconds: 300 }),
  });
  registerLtiLaunchRoute(app, { db, jwksCache, clockSkewSeconds: 120, sessionTtlHours: 8, appBaseUrl: APP_BASE_URL });
  registerCourseRosterRoutes(app, {
    db,
    requireSession: createRequireSession(db),
    requireCsrf: createRequireCsrf(APP_BASE_URL),
    signingKey,
  });
  return app;
}

describe('Phase 4 integration: real launch through GET /api/course/roster', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;
  let signingKey: ToolSigningKey;

  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(undefined));
  });
  afterAll(async () => {
    await platform.stop();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });

  it('returns a paginated, normalized roster with no CSV upload after a real instructor launch', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    platform.setCourseMembers('integration-course', [
      { user_id: 'lti-u1', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], lis_person_sourcedid: '111', name: 'Student One' },
      { user_id: 'lti-u2', status: 'Active', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'], lis_person_sourcedid: '222', name: 'Prof Two' },
    ]);
    platform.setPageSize(1);

    const app = buildTestApp(db, jwksCache, signingKey);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        iss: platform.issuer,
        login_hint: 'lti-u1',
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
      sub: 'lti-u1',
      deploymentId: seeded.deploymentId,
      contextId: 'integration-course',
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      extraClaims: {
        [NRPS_CLAIM]: { context_memberships_url: platform.nrpsUrlFor('integration-course') },
      },
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

    const rosterRes = await app.inject({
      method: 'GET',
      url: '/api/course/roster',
      cookies: { attendance_session: sessionToken! },
    });

    expect(rosterRes.statusCode).toBe(200);
    const body = rosterRes.json();
    expect(body.members).toHaveLength(2);
    expect(body.members.some((m: { eligibleForAttendance: boolean }) => m.eligibleForAttendance)).toBe(true);
    expect(body.members.some((m: { eligibleForAttendance: boolean }) => !m.eligibleForAttendance)).toBe(true);

    // The GET-triggered live refresh wrote a roster_refreshed audit row (spec §33).
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.eventType, 'roster_refreshed'));
    expect(audits).toHaveLength(1);
    expect(audits[0].requestId).toBeTruthy();
  });
});
```

`seededInstitutionAndRegistration`'s defaults (`clientId: 'mock-client-id'`, `deploymentId: 'mock-deployment-1'`) line up with `mintIdToken`'s defaults (`aud: 'mock-client-id'`, `deploymentId: 'mock-deployment-1'`) and `platform.issuer`, so no override juggling is needed beyond what is shown. The session cookie name is `attendance_session` (Phase 3 `SESSION_COOKIE_NAME`).

- [ ] **Step 2: Run — expect PASS**

Run: `npm test -- course-roster-integration.test.ts`
If it fails for a reason unrelated to field-name wiring (a real bug in `refreshCourseRoster` or a route), fix the underlying code, not the test.

- [ ] **Step 3: Run the entire suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all clean, including every Phase 0–3 test.

- [ ] **Step 4: Update `docs/canvas-lti/progress.md` (execution-time only)**

After this plan has actually executed, read the file's Phase 0–2 "what actually happened" sections for the established convention, then add a `## Phase 4 — what actually happened` section (after the Phase 2 section, before "Deferred decisions") and flip the `- [ ] **Phase 4 — NRPS**` checklist line near the top to `- [x]`. Do not write this section speculatively during planning — it narrates what execution did.

- [ ] **Step 5: Commit**

```bash
git add server/tests/routes/course-roster-integration.test.ts docs/canvas-lti/progress.md
git commit -m "test(lti): add full launch-to-roster integration test for Phase 4"
```

---

## Self-review notes

- **Spec §46 NRPS coverage:** multiple pages (Task 8); active / inactive / instructor-excluded / custom-role / missing-SIS-ID / duplicate-IDs (Task 9); changed roster — added / removed / still-present / attribute-change / re-activated (Task 10); pagination failure including a genuine mid-pagination (page ≥ 2) failure (Task 8); expired access token — unit (Task 8) + retry-once integration (Task 11); 429 response — unit (Task 8) + retry-with-backoff integration (Task 11); &lt;24h stale-cache fallback and the 24h ceiling → hard fail (Task 12). All eleven spec bullets have a task.
- **Type consistency:** `CourseRosterMember` / `CourseRosterResult` are defined once (Task 8) and referenced by name everywhere after. `InstitutionRosterConfig` / `NrpsRawMember` are defined once (Task 5). `CourseMemberRow` is defined once (Task 10). `getRosterWithFallback`'s return shape is defined once (Task 12) and consumed by both routes and by Phase 5.
- **DI:** no module imports a `db` handle or a signing-key handle. `db: Database` is the first parameter of every DB-touching function; the active `ToolSigningKey` is threaded from `index.ts` → route deps → `getRosterWithFallback` → `refreshCourseRoster` → `getAccessToken`. Tests use `getTestDb().db` and a real ephemeral key from `getActiveSigningKey(await loadSigningKeysFromEnv(undefined))`.
- **SSRF:** the NRPS/AGS URLs are captured from the signature-verified launch JWT (Task 1), persisted verbatim, and used verbatim; `validateCanvasServiceUrl` is a structural check only (scheme, embedded credentials) and accepts `http:` so the in-process mock works. No host allowlist is rebuilt (spec §11 makes a token-host anchor wrong on production Canvas).
- **Audit:** `roster_refreshed` is written whenever `getRosterWithFallback` reports `refreshed: true` — on both the `GET`-triggered refresh and `POST /api/course/roster/refresh` — with `request_id = request.id`. Pure cache hits and stale-cache fallbacks write nothing.
- **No placeholders:** every step carries complete code. The only deferred prose is the `progress.md` "what actually happened" narrative (Task 15 Step 4), which cannot be written truthfully before execution — mirroring every prior phase's `progress.md` section.

---

## Revision log

Maps each pre-flight finding (`phase4-plan-review-findings.md`) to the change that addresses it. All fixes applied per `plan-revision-constraints.md`.

### BLOCKERS

- **B1** (`import { db }` does not exist) → **fixed.** Every DB-touching function now takes `db: Database` first: `upsertCourseMembers`, `getCachedRoster`, `getCachedRosterAsMembers`, `findCourseMembersByInstitutionalId`, `getRosterWithFallback`, `refreshCourseRoster`, `loadCourseRosterContext`, `writeRosterRefreshedAuditEvent`, `findOrCreateCourse` (already DI), the seed helpers. Routes use `registerCourseRosterRoutes(app, { db, requireSession, requireCsrf, signingKey })`. Tests use `getTestDb().db`. The "no runtime circular dependency" hand-wave is replaced with an explicit note that the `nrps.ts ⇄ roster-store.ts` cycle is function-body-only (ESM live bindings). (Tasks 10–14.)
- **B2** (`getActiveSigningKey` is sync + takes an arg) → **fixed.** `refreshCourseRoster` / `getRosterWithFallback` receive the active `ToolSigningKey` via `deps.signingKey`; no `await`, no module-level accessor. Tests and `index.ts` obtain it via the real `getActiveSigningKey(keys)` (sync, array arg). The "Phase 3 interfaces" section documents the real signature. (Tasks 7, 11, 12, 14, 15.)
- **B3** (`nrps_url` never persisted at launch) → **fixed.** New **Task 1** retrofits `schema.ts` (three nullable `courses` columns), `claims.ts` (two optional service claims), `launch.ts` (passes the endpoints through), `registrations.ts` (`findOrCreateCourse` becomes find-or-create-**then-update-launch-metadata**, keeping the ON CONFLICT race fix). Everything downstream depends on Task 1.
- **B4** (`refreshCourseRoster` rejects the plain-http mock) → **fixed.** `validateCanvasServiceUrl` now accepts `http:` and `https:`. Task 11 success-path tests use `platform.nrpsUrlFor(...)` (plain http) and pass. (Task 4.)
- **B5** (Task 14/15 imports `buildApp` from `index.ts`) → **fixed.** Task 15 composes `registerLtiLoginRoute` + `registerLtiLaunchRoute` + `registerCourseRosterRoutes` onto a local `Fastify()` with `@fastify/cookie` + `@fastify/formbody`, mirroring `lti-launch.test.ts`. No `index.ts` import. (Task 15.)
- **B6** (`seedInstitutionAndRegistration` real shape) → **fixed.** All seed usage goes through the real `seedInstitutionAndRegistration(db, platform, overrides?)` → `{ institutionId, registrationId, deploymentRowId, clientId, deploymentId }`. New `seedInstitutionAndCourse(db, platform, overrides?)` (Task 10) inserts a course with `deploymentId: seeded.deploymentRowId` (the ROW UUID). Task 15 uses `seeded.clientId` / `seeded.deploymentId` (business string) for the login payload and `mintIdToken`. The old inline re-implemented seed and the bogus `{ registration, deployment }` destructure are gone. (Tasks 10, 11, 15.)
- **B7** (Task 7/8 429 test inherits the expired token) → **fixed.** The NRPS fetch tests no longer share a suite-level token; each token-mutating test calls a local `mintToken(platform)` for a fresh token. (Task 8.)
- **B8** (unescaped apostrophe breaks `service-url.test.ts`) → **fixed.** The offending `it(...)` titles use double quotes. (Task 4.)

### SPEC GAPS

- **SG1** (SSRF host check uses the wrong trust anchor) → **fixed.** `validateCanvasServiceUrl` no longer anchors on the token-endpoint host (or any host). Trust comes from the URL's provenance — a signature-verified launch JWT persisted verbatim (Task 1) and used verbatim. Structural checks retained: absolute `http(s)` scheme, no embedded credentials. Redirect rejection stays at the fetch call sites. Reviser note left re: a future per-institution service-host policy. (Task 4; note in Task 4.)
- **SG2** (client assertion `aud` = `tokenEndpoint`) → **fixed.** `TokenClientRegistration` carries `tokenAudience`; `buildClientAssertion` signs `aud` as `registration.tokenAudience`; the assertion is POSTed to `tokenEndpoint`. `loadCourseRosterContext` selects `ltiRegistrations.tokenAudience`. The token-client test uses a `tokenAudience` value deliberately different from `tokenEndpoint` and asserts on it. (Tasks 7, 11.)
- **SG3** (two different member shapes from `GET /api/course/roster`) → **fixed.** All cache reads go through one converter, `cachedRowToMember` / `getCachedRosterAsMembers`, which always computes `eligibleForAttendance` from the institution's `rosterLearnerRoles`. The route has a single `serializeMember`. `getRosterWithFallback` returns `CourseRosterMember[]` on every path. Tests assert key-parity between the fresh and stale paths. (Tasks 10, 12, 13.)
- **SG4** (`roster_refreshed` only on `POST /refresh`) → **fixed.** `getRosterWithFallback` reports `refreshed: boolean`; both the GET handler and the POST handler write a `roster_refreshed` audit row when `refreshed === true`, with `request_id = request.id` (spec §31.9 correlation id, now actually populated). Cache hits and stale fallbacks write nothing — documented. (Tasks 12, 13, 14; Global Constraints.)
- **SG5** (`last_launched_at` / `ags_lineitems_url` added but never written) → **fixed.** Both are written by the Task 1 launch retrofit (`findOrCreateCourse` sets `lastLaunchedAt = now()` on every launch and `agsLineitemsUrl` from the AGS endpoint claim when present). (Task 1.)
- **SG6** (`resolveInstitutionRosterConfig` doesn't enforce the §18.2 Learner default) → **fixed.** It falls back to `['Learner']` in code when the incoming list is empty. The Task 5 test titled *"defaults rosterLearnerRoles to ['Learner'] …"* now asserts `.toEqual(['Learner'])`. (Task 5.)

### QUALITY ITEMS

- **Q1** (schema test inserts an invalid `courses.deploymentId`) → **fixed.** The Task 2 smoke test inserts a real institution → registration → deployment → course chain and uses `deployment.id`. (Task 2 Step 6.)
- **Q2** (`course_members` / `audit_events` never added to the test-DB reset path) → **fixed.** Both prepended to `TRUNCATE_ORDER` in `server/tests/support/db.ts`, in the same task that creates the tables. (Task 2 Step 4.)
- **Q3** (`mock-canvas.ts` is a class, not `startMockCanvas()`) → **fixed.** Task 6 adds instance state, two routes registered in the constructor, and `get tokenUrl` / `nrpsUrlFor` / `setCourseMembers` / `setPageSize` / `expireAccessToken` / `rateLimitNextRequest` / `breakPaginationOnNextPage` methods to the class. Every test uses `new MockCanvasPlatform()` / `start()` / `stop()`. No free function, no `.close()`. (Tasks 6–15.)
- **Q4** (Task 15 `mintIdToken` uses non-existent option keys) → **fixed.** The call uses only real `MintTokenOverrides` keys: `nonce`, `sub`, `deploymentId`, `contextId`, `roles`, `extraClaims`. `state` is dropped (not part of the id_token); the NRPS claim goes through `extraClaims`. (Task 15.)
- **Q5** (`unchanged` counter misnamed, misses §46 "changed roster") → **fixed.** Renamed to `stillPresent`; Task 10 adds a test for an attribute change persisted on a still-present member and a test for a previously-removed member re-activating. (Task 10.)
- **Q6** (no test for a cache older than 24h → 502) → **fixed.** Task 12 adds a case that ages `rosterCachedAt` to 25h + fails the fetch and expects `RosterUnavailableError` (→ 502 at the route). (Task 12.)
- **Q7** (inaccurate spec §10 citation in `scopes.ts`) → **fixed.** The comment no longer cites §10; it just states these are the literal 1EdTech URIs Canvas's Developer Key UI populates. (Task 3.)
- **Q8** (deprecated object-return form for the `pgTable` third arg) → **fixed.** `courseMembers` uses the array form `(t) => [unique().on(t.courseId, t.ltiUserId)]`, matching the rest of `schema.ts`. (Task 2 Step 2.)
- **Q9** (unused `registrationId` → lint error) → **fixed.** The consolidated `seedInstitutionAndCourse` returns `SeededCourse` and tests destructure only what they use (`{ courseId }`). No unused binding. (Tasks 10, 11.)
- **Q10** (pre-staged dead `AGS_*` scope exports) → **fixed by deferral.** `AGS_LINEITEM_SCOPE` / `AGS_SCORE_SCOPE` are removed from Task 3 and deferred to Phase 6 (consistent with the Phase 3 review's YAGNI precedent). `courses.ags_lineitems_url` is still persisted at launch so Phase 6 has the data. Reviser note in Task 3.
- **Q11** (route auth wiring contradicts shipped precedent) → **fixed.** `registerCourseRosterRoutes(app, { db, requireSession, requireCsrf, signingKey })` with `{ preHandler: deps.requireSession }` on GET and `{ preHandler: [deps.requireSession, deps.requireCsrf] }` on POST, matching `registerMeRoute`. `request.appSession` is used through its real augmented type (no `as any`). (Tasks 13, 14.)
- **Q12** (`crypto.randomUUID()` unqualified in seed helpers) → **fixed.** `seedInstitutionAndCourse` uses `randomUUID` imported from `node:crypto` (already imported at the top of `seed.ts`). (Task 10.)
- **Q13** (the "no members array" test doesn't test a mid-pagination failure) → **fixed.** `breakPaginationOnNextPage(courseId)` fires only on page ≥ 2; Task 8's test primes two members at page size 1 so the failure genuinely occurs on page 2. (Tasks 6, 8.)
- **Q14** (Task 15 depends on `process.env.APP_BASE_URL`) → **fixed.** The integration test is self-contained: `APP_BASE_URL` / `TARGET` are local constants threaded through the route deps, exactly as `lti-launch.test.ts` passes `appBaseUrl`. (Task 15.)

### Notes left for re-review

- **Task 2** — `courses.roster_cached_at` is not in spec §26's `courses` column list. **RESOLVED 2026-08-27 (user ruling):** keep the explicit nullable column, set on every successful roster fetch; do NOT derive freshness from `max(course_members.last_seen_at)`. Plan design unchanged.
- **Task 4** — no host allowlist is enforced on outbound Canvas service URLs. **RESOLVED 2026-08-27 (user sign-off):** approved — verbatim use of the launch-persisted URL is the SSRF trust anchor (spec §31.7); no allowlist to be added. A future per-institution service-host policy could anchor on the registration `issuer` origin.
- **Task 12** — `getRosterWithFallback` takes a third `deps` param (constraints D9 wrote a two-arg signature); unavoidable because the injected `ToolSigningKey` (D5) cannot be sourced module-level. The return also gains `refreshed: boolean` for SG4. Phase 5's `createSession` must thread `signingKey` in the same way. (Still open — Phase 5 fix-pass item, not a Phase 4 blocker.)
- **Task 14** — `POST /api/course/roster/refresh` is gated by `requireCsrf` ahead of Phase 5's web-client CSRF bootstrap (Phase 5 Task 13). **RESOLVED 2026-08-27 (user ruling):** approved — no Phase 4 web caller exists, so no dead end; exercised by tests only until Phase 5 wires the browser CSRF/JSON plumbing (D7).

### RE-REVIEW FIX PASS (2026-08-27)

Addresses `.superpowers/sdd/phase4-5-rereview-findings.md` (re-review of `5a2b400`). All edits are plan text inside **Task 1** plus reviser-note resolutions; no task renumbering, no scope change. Phase 5-only items (C1, I1, M2, M3) are out of scope for this pass.

- **I2** (Task 1 Step 7 — retrofit test's `launch()` helper re-seeded on every call) → **fixed.** `seedInstitutionAndRegistration(db, platform)` moves out of `launch()` into `beforeEach`, captured in a describe-scoped `seeded` binding. `launch()` now only mints a fresh OIDC transaction + `id_token` against the already-seeded institution/registration/deployment. The "refreshes a rotated nrpsUrl on the next launch of the same course" test now genuinely exercises one `courses` row updated in place — no second `unique(issuer, clientId)` insert, no second deployment UUID, so `expect(rows).toHaveLength(1)` holds. Test intent otherwise unchanged.
- **M1** (Task 1 Step 3 — `const launchUpdate: Record<string, unknown>` passed to `db.update(courses).set(...)`) → **fixed.** The `SET` payload is now built as an inline object literal with conditional spreads (`{ lastLaunchedAt: sql\`now()\`, updatedAt: sql\`now()\`, ...(params.nrpsUrl != null ? { nrpsUrl: params.nrpsUrl } : {}), ...(params.agsLineitemsUrl != null ? { agsLineitemsUrl: params.agsLineitemsUrl } : {}) }`), so Drizzle infers `PgUpdateSetSource<typeof courses>` with no explicit annotation. Column names match the rest of the Phase 4 plan (`nrpsUrl`, `agsLineitemsUrl`, `lastLaunchedAt`).
- **Open item 1** (`courses.roster_cached_at`) → **resolved.** User ruling: keep the explicit nullable column, set on each successful roster fetch. Reviser note in Task 2 Step 1 and the "Notes left for re-review" bullet updated.
- **Open item 4** (no outbound host allowlist for Canvas NRPS/AGS URLs) → **resolved.** User sign-off: approved; verbatim use, provenance = the signature-verified launch JWT. Reviser note in Task 4 and its "Notes left for re-review" bullet updated.
- **Open item 5** (`POST /roster/refresh` CSRF-gated in Phase 4 ahead of Phase 5 Task 13) → **resolved.** User ruling: approved; no Phase 4 web caller, so no dead end. Reviser note in Task 14 and its "Notes left for re-review" bullet updated.
