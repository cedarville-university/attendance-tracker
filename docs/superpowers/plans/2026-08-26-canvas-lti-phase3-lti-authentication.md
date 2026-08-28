# Canvas LTI Phase 3 — LTI Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Canvas LTI 1.3 login/launch authentication (`/lti/login`, `/lti/launch`, `/lti/jwks`), application sessions, CSRF protection, and `GET /api/me`, so that a valid instructor Canvas launch creates a working session and every malformed/replayed/unauthorized launch is rejected before any session is created.

**Architecture:** Hand-rolled LTI 1.3 orchestration on top of `jose`. No maintained Node LTI 1.3 framework was adopted because the available ones (`ltijs` and friends) own their own datastore, session model, and Express-style routing, which would fight this repo's Fastify + Drizzle conventions and hide exactly the validation steps spec §45 requires us to test case-by-case; `jose` gives us JWT verification without taking over anything else. PostgreSQL via Drizzle ORM stores institutions/registrations/deployments/OIDC transactions/courses/app sessions. Two independent JWKS surfaces: `jwks-cache.ts` verifies inbound Canvas launch JWTs against Canvas's platform JWKS; `signing-keys.ts` + `/lti/jwks` publish this app's own public keys (used starting Phase 4/6, but built now as it's part of the LTI registration). Opaque, server-side, hashed-at-rest application sessions (no client-readable JWT session token). All new routes follow the existing `registerXRoute(app, deps)` convention from `server/src/routes/scans.ts`.

**Tech Stack:** Fastify 5, `jose` (JWT sign/verify), `drizzle-orm` + `pg` (PostgreSQL), `zod` (validation), `@fastify/cookie`, `@fastify/formbody`, `@fastify/helmet`, `@fastify/rate-limit`, Vitest, TypeScript (ES2022/NodeNext/strict).

## Global Constraints

- Node 22+ (`crypto.randomUUID()`/`crypto.randomBytes()` used app-side; **no `uuid` npm package**).
- Only `RS256` is ever accepted for verifying inbound Canvas launch JWTs — reject every other algorithm before signature verification, never accept `alg: none` (spec §13.2).
- Role authorization MUST use exact full-URI set comparison — **never** `role.includes("Instructor")` or any substring match (spec §13.9).
- `target_link_uri` MUST be validated against an explicit exact-match allowlist, never pattern-matched (spec §12.1).
- Never derive Canvas endpoints (issuer, JWKS URI, token endpoint) from a Canvas hostname — always read them from the `lti_registrations` table, populated from Canvas's own `.well-known/openid-configuration` and JWKS discovery responses (spec §11).
- Store only **hashes** of `state`, `nonce`, and the application session token — never the raw values (spec §12.2, §14).
- Never log: `id_token`, session cookies, CSRF tokens, or any signing/private key material (spec §31.8).
- `/lti/jwks` must only ever expose `{kid, kty, use, alg, n, e}` — no private key fields (`d`, `p`, `q`, `dp`, `dq`, `qi`) ever appear in that response (spec §17).
- Every §45 test-matrix **failure** case must assert that **no `app_sessions` row was created** as a result of the failed attempt. Concretely: cases 1 and 12 are success cases (a valid launch, and an unknown `kid` that a JWKS refresh resolves), so they legitimately create a session; case 24 (target-link open-redirect attempt) is rejected at **login** time by `/lti/login`, which has no session-creation code path at all, so Task 14 asserts no OIDC transaction is created instead; every one of the remaining 21 failure cases is asserted end-to-end through `verifyLaunch` in Task 23's sweep (or its dedicated tests for cases 2 and 7) with a `SELECT * FROM app_sessions` count of zero.
- Session cookie `Secure` flag must be conditional on `APP_BASE_URL` starting with `https://` (breaks local HTTP dev otherwise).
- `npm test`, `npm run lint`, and `npm run typecheck` must stay clean after every task.
- Local Postgres for tests/dev is the existing `docker-compose.yml` service — user/password/db all `attendance_tracker`, port 5432. Start it with `docker compose up -d` before running any task that touches the database.
- From Task 4 onward **`npm test` requires a running Postgres** — Vitest's `globalSetup` migrates the test database before any test file runs, including the 52 existing Phase 0-2 server tests and the `web/tests/**` browser tests, none of which touch the database themselves. `npm test` uses `TEST_DATABASE_URL`, which defaults to a **separate** `attendance_tracker_test` database (created automatically by the global setup) so the suite's `TRUNCATE`s never wipe the `DATABASE_URL` dev database. Task 27 documents both variables in `README.md`. CI is out of scope for this plan (there is no CI workflow in this repo yet — it arrives in Phase 7 per spec §40).

---

## File Structure

New files this plan creates:

```
drizzle.config.ts                                    # drizzle-kit config (repo root)
migrations/                                           # generated by `drizzle-kit generate`, committed

server/src/config/env.ts                              # zod-validated environment config
server/src/database/schema.ts                         # Drizzle table definitions
server/src/database/client.ts                         # Pool + drizzle() factory + applyMigrations()
server/src/database/seed-registration.ts               # CLI: upsert institution/registration/deployment
server/src/lti/types.ts                                # LtiInstitution/LtiRegistration/LtiDeployment/EnabledDeployment types
server/src/lti/signing-keys.ts                          # this app's own RSA signing keys (active/previous)
server/src/lti/jwks-route.ts                            # buildJwksResponse() -- public fields only
server/src/lti/registrations.ts                         # findEnabledDeployment/findRegistrationById/etc.
server/src/lti/oidc-transactions.ts                      # create + atomic single-use consume (state+nonce)
server/src/lti/login.ts                                  # buildLoginRedirect() -- pure, framework-agnostic
server/src/lti/jwks-cache.ts                             # per-registration Canvas JWKS cache
server/src/lti/claims.ts                                 # zod schema for required LTI claims
server/src/lti/roles.ts                                  # authorizeInstructorRole() -- exact-URI comparison
server/src/lti/launch.ts                                 # verifyLaunch() -- orchestrates the full §45 matrix
server/src/auth/session.ts                               # createSession/findValidSession/revokeSession
server/src/auth/csrf.ts                                  # verifyCsrfToken/verifyOrigin
server/src/auth/cookies.ts                               # session cookie name/options
server/src/auth/middleware.ts                            # requireSession/requireCsrf Fastify preHandlers
server/src/routes/lti-jwks.ts                            # GET /lti/jwks
server/src/routes/lti-login.ts                           # GET+POST /lti/login
server/src/routes/lti-launch.ts                          # POST /lti/launch
server/src/routes/me.ts                                  # GET /api/me

server/tests/support/db.ts                              # test DB connection, migrate(), resetDb()
server/tests/support/mock-canvas.ts                       # in-process fake Canvas platform (JWKS + mintIdToken)
server/tests/support/mock-canvas.test.ts                  # self-test: harness's tokens verify against its JWKS
server/tests/support/seed.ts                              # seedInstitutionAndRegistration()
server/tests/support/global-setup.ts                       # Vitest globalSetup: creates + migrates the test DB once
server/tests/config/env.test.ts
server/tests/database/migrations.test.ts
server/tests/database/schema.test.ts
server/tests/lti/signing-keys.test.ts
server/tests/lti/jwks-route.test.ts
server/tests/lti/registrations.test.ts
server/tests/lti/oidc-transactions.test.ts
server/tests/lti/login.test.ts
server/tests/lti/jwks-cache.test.ts
server/tests/lti/claims.test.ts
server/tests/lti/roles.test.ts
server/tests/lti/launch.test.ts
server/tests/auth/session.test.ts
server/tests/auth/csrf-middleware.test.ts
server/tests/routes/lti-jwks.test.ts
server/tests/routes/lti-login.test.ts
server/tests/routes/lti-launch.test.ts
server/tests/routes/me.test.ts
server/tests/routes/hardening.test.ts                    # helmet CSP / Permissions-Policy / rate-limit config

docs/canvas-installation.md                              # Canvas registration (Admin -> Apps, JSON) -- Phase 7 post-deploy step
```

Modified files:

```
package.json                  # + jose@^6, drizzle-orm, pg, @fastify/cookie, @fastify/formbody,
                               #   @fastify/helmet, @fastify/rate-limit; devDeps + drizzle-kit, @types/pg
package-lock.json             # regenerated by the installs above
eslint.config.js              # + @typescript-eslint/no-unused-vars override for server/**/*.ts
vitest.config.ts              # + globalSetup, + singleFork pool (shared test DB is truncated per file)
server/src/index.ts           # wire env/db/signing-keys/all new routes/helmet/rate-limit/Permissions-Policy
README.md                     # Phase 3 env var table + "tests require Postgres" note
docs/canvas-lti/progress.md   # Phase 3 status note; real-Canvas verification listed under Phase 7
```

---

## Task 1: Install npm dependencies + widen the server lint rule

**Files:**
- Modify: `package.json`, `package-lock.json`, `eslint.config.js`

- [ ] **Step 1: Install runtime dependencies**

Run: `npm install jose@^6 drizzle-orm pg @fastify/cookie @fastify/formbody @fastify/helmet @fastify/rate-limit`

`jose` is pinned to the v6 major deliberately. v6 is the first major whose `importPKCS8`/`generateKeyPair`/`importJWK` return a Web Crypto `CryptoKey`, which is what `ToolSigningKey.privateKey: CryptoKey` (Task 6) is typed as; on v5 those return jose's own `KeyLike`, which is not assignable to `CryptoKey` and fails `npm run typecheck`. Do not let a `^` range float this back to v5.

- [ ] **Step 2: Install dev dependencies**

Run: `npm install --save-dev drizzle-kit @types/pg`

- [ ] **Step 3: Widen `@typescript-eslint/no-unused-vars` for `server/**/*.ts`**

`@typescript-eslint/no-unused-vars` defaults to `ignoreRestSiblings: false` with no `argsIgnorePattern`/`varsIgnorePattern`, so several tests and hooks later in this plan (`const { DATABASE_URL, ...rest }` in Task 2, `const { iss, ...missingIss }` in Task 14, the `_context`/`_roles` omit-destructures in Tasks 16 and 22, the `_request` hook parameter in Task 27) would each fail `npm run lint`. The existing `web/**/*.js` block already carries the equivalent override; mirror it for the TypeScript side.

Edit the existing `server/**/*.ts` block in `eslint.config.js` (the one that only sets `languageOptions.globals`, **not** the `tseslint.configs.recommended` spread above it) so it reads:

```js
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow destructuring a property out of an object solely to exclude it from a
      // `...rest` spread (same reason as the web/**/*.js override above), and allow a
      // leading underscore to mark a deliberately-unused binding or handler parameter.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
```

- [ ] **Step 4: Verify install and lint config**

Run: `npm run typecheck && npm run lint`
Expected: both pass (no new `.ts` files reference the new packages yet, so this just confirms nothing broke and that `eslint.config.js` is still syntactically valid).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json eslint.config.js
git commit -m "chore: add LTI auth dependencies (jose v6, drizzle-orm, pg, fastify plugins) and widen server lint rule"
```

---

## Task 2: Environment configuration (`config/env.ts`)

**Files:**
- Create: `server/src/config/env.ts`
- Test: `server/tests/config/env.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?: Record<string, string | undefined>): Env` (defaults to `process.env`), `parseAllowedTargetLinkUris(env: Env): string[]`, `type Env`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/config/env.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv, parseAllowedTargetLinkUris } from '../../src/config/env.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker',
  APP_BASE_URL: 'http://localhost:3000',
  ALLOWED_TARGET_LINK_URIS: 'http://localhost:3000/index.html, http://localhost:3000/scanner.html',
};

describe('loadEnv', () => {
  it('parses required vars and applies defaults for optional ones', () => {
    const env = loadEnv(BASE_ENV);
    expect(env.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(env.CLOCK_SKEW_SECONDS).toBe(120);
    expect(env.LOGIN_TRANSACTION_TTL_SECONDS).toBe(300);
    expect(env.APP_SESSION_TTL_HOURS).toBe(8);
  });

  it('throws when a required var is missing', () => {
    const { DATABASE_URL, ...rest } = BASE_ENV;
    expect(() => loadEnv(rest)).toThrow(/Invalid environment configuration/);
  });

  it('coerces numeric overrides from strings', () => {
    const env = loadEnv({ ...BASE_ENV, CLOCK_SKEW_SECONDS: '60' });
    expect(env.CLOCK_SKEW_SECONDS).toBe(60);
  });
});

describe('parseAllowedTargetLinkUris', () => {
  it('splits, trims, and drops empty entries', () => {
    const env = loadEnv(BASE_ENV);
    expect(parseAllowedTargetLinkUris(env)).toEqual([
      'http://localhost:3000/index.html',
      'http://localhost:3000/scanner.html',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/config/env.test.ts`
Expected: FAIL with "Cannot find module '../../src/config/env.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/config/env.ts
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  ALLOWED_TARGET_LINK_URIS: z.string().min(1),
  LTI_TOOL_SIGNING_KEYS_JSON: z.string().optional(),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(120),
  LOGIN_TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  APP_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function parseAllowedTargetLinkUris(env: Env): string[] {
  return env.ALLOWED_TARGET_LINK_URIS.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/config/env.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/config/env.ts server/tests/config/env.test.ts
git commit -m "feat: add zod-validated environment configuration for LTI auth"
```

---

## Task 3: Drizzle schema + migration

**Files:**
- Create: `server/src/database/schema.ts`, `drizzle.config.ts`, `migrations/` (generated)
- Test: none yet (schema is exercised by Task 5's smoke test)

**Interfaces:**
- Produces: Drizzle tables `institutions`, `ltiRegistrations`, `ltiDeployments`, `oidcTransactions`, `courses`, `appSessions`, each with its exact TypeScript column names as used by every later task in this plan.

- [ ] **Step 1: Write the schema**

```ts
// server/src/database/schema.ts
import { pgTable, uuid, text, boolean, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';

export const institutions = pgTable('institutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const ltiRegistrations = pgTable(
  'lti_registrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    oidcAuthEndpoint: text('oidc_auth_endpoint').notNull(),
    tokenEndpoint: text('token_endpoint').notNull(),
    tokenAudience: text('token_audience').notNull(),
    platformJwksUri: text('platform_jwks_uri').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.issuer, t.clientId)],
);

export const ltiDeployments = pgTable(
  'lti_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => ltiRegistrations.id),
    deploymentId: text('deployment_id').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    configuration: jsonb('configuration').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.registrationId, t.deploymentId)],
);

export const oidcTransactions = pgTable(
  'oidc_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => ltiRegistrations.id),
    // NOTE: `oidcTransactions.deploymentId` is Canvas's *business* deployment ID (the opaque
    // string Canvas puts in the launch JWT's deployment_id claim), stored as text. It is NOT the
    // `lti_deployments.id` row UUID. `appSessions.deploymentId` below is the opposite: a row UUID
    // FK. Look up one from the other with findDeploymentByBusinessId() (Task 9). Test helpers use
    // the naming precedent `SeededRegistration.deploymentRowId` (Task 11) for the UUID.
    deploymentId: text('deployment_id').notNull(),
    stateHash: text('state_hash').notNull(),
    nonceHash: text('nonce_hash').notNull(),
    targetLinkUri: text('target_link_uri').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.stateHash)],
);

export const courses = pgTable(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => ltiDeployments.id),
    ltiContextId: text('lti_context_id').notNull(),
    label: text('label'),
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.deploymentId, t.ltiContextId)],
);

export const appSessions = pgTable(
  'app_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionTokenHash: text('session_token_hash').notNull(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id),
    // NOTE: unlike `oidcTransactions.deploymentId` (Canvas's business deployment ID, text), this
    // column is the `lti_deployments.id` **row UUID** FK. Same property name, different meaning --
    // when wiring the two together always convert explicitly via findDeploymentByBusinessId().
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => ltiDeployments.id),
    ltiSubject: text('lti_subject').notNull(),
    displayName: text('display_name'),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    roles: jsonb('roles').notNull(),
    csrfSecret: text('csrf_secret').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.sessionTokenHash)],
);
```

Note: the `courses` table deliberately **omits** three columns spec §26 lists — `nrps_url`, `ags_lineitems_url`, and `last_launched_at`. `nrps_url` and `ags_lineitems_url` come from the launch JWT's NRPS/AGS service claims, which nothing reads until Phase 4 (NRPS) and Phase 6 (AGS); `last_launched_at` is only meaningful once Phase 5's persistent attendance surfaces course activity. All three are added by Phase 4's migration via `ALTER TABLE`, so adding them now would mean shipping three permanently-null columns and a migration Phase 4 would have to work around.

Note: `app_sessions.display_name` is a deliberate one-column addition beyond spec §26's literal list. Spec §26 doesn't give `app_sessions` a name column, but `GET /api/me`'s required response shape (§25.1) includes `user.displayName`, and NRPS-sourced names don't exist until Phase 4. This column is nullable and populated from the launch JWT's optional `name` claim, falling back to `lti_subject` when absent (wired in Task 23).

- [ ] **Step 2: Write `drizzle.config.ts`**

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/src/database/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker',
  },
});
```

- [ ] **Step 3: Generate the migration**

Run: `docker compose up -d` (ensure Postgres is running), then `npx drizzle-kit generate`
Expected: a new file appears under `migrations/`, e.g. `migrations/0000_*.sql`, containing `CREATE TABLE` statements for all six tables.

- [ ] **Step 4: Commit**

```bash
git add server/src/database/schema.ts drizzle.config.ts migrations/
git commit -m "feat: add Drizzle schema for LTI institutions/registrations/deployments/sessions"
```

---

## Task 4: Database client + test DB support

**Files:**
- Create: `server/src/database/client.ts`, `server/tests/support/db.ts`, `server/tests/support/global-setup.ts`, `server/tests/database/migrations.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `createDbClient(databaseUrl: string): DbClient`, `type DbClient = { db: Database; pool: Pool }`, `type Database`, `applyMigrations(client: DbClient): Promise<void>`.
- Produces (test support): `TEST_DATABASE_URL: string`, `getTestDb(): DbClient`, `migrate(): Promise<void>`, `resetDb(): Promise<void>`, `closeTestDb(): Promise<void>`.

- [ ] **Step 1: Write `database/client.ts`**

```ts
// server/src/database/client.ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

export function createDbClient(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type DbClient = ReturnType<typeof createDbClient>;
export type Database = DbClient['db'];

export async function applyMigrations(client: DbClient): Promise<void> {
  await migrate(client.db, { migrationsFolder: 'migrations' });
}
```

- [ ] **Step 2: Write `tests/support/db.ts`**

```ts
// server/tests/support/db.ts
import { sql } from 'drizzle-orm';
import { createDbClient, applyMigrations, type DbClient } from '../../src/database/client.js';

// Deliberately a DIFFERENT database from the docker-compose default `attendance_tracker` that
// DATABASE_URL points at: resetDb() below TRUNCATEs every table, so if the test suite shared the
// dev database, `npm test` would silently wipe whatever the developer had seeded there (including
// Task 28's manual smoke-test registration). The global setup creates this database if it does
// not exist yet, so no manual `createdb` step is needed.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_test';

let client: DbClient | undefined;

export function getTestDb(): DbClient {
  if (!client) {
    client = createDbClient(TEST_DATABASE_URL);
  }
  return client;
}

export async function migrate(): Promise<void> {
  await applyMigrations(getTestDb());
}

const TRUNCATE_ORDER = [
  'app_sessions',
  'courses',
  'oidc_transactions',
  'lti_deployments',
  'lti_registrations',
  'institutions',
];

export async function resetDb(): Promise<void> {
  const { db } = getTestDb();
  await db.execute(sql.raw(`TRUNCATE TABLE ${TRUNCATE_ORDER.join(', ')} RESTART IDENTITY CASCADE`));
}

export async function closeTestDb(): Promise<void> {
  if (client) {
    await client.pool.end();
    client = undefined;
  }
}
```

- [ ] **Step 3: Write `tests/support/global-setup.ts`**

```ts
// server/tests/support/global-setup.ts
import { Client } from 'pg';
import { TEST_DATABASE_URL, migrate, closeTestDb } from './db.js';

// `npm test` must never touch the developer's DATABASE_URL database, so TEST_DATABASE_URL points at
// a separate `attendance_tracker_test` database. Create it on first run against a fresh
// `docker compose up -d` so no manual `createdb` step is required.
async function ensureTestDatabaseExists(): Promise<void> {
  const target = new URL(TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount === 0) {
      // A database name cannot be a bound parameter. `databaseName` comes from developer
      // configuration (TEST_DATABASE_URL), never from request input, and is quoted defensively.
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function setup(): Promise<void> {
  await ensureTestDatabaseExists();
  await migrate();
  await closeTestDb();
}
```

- [ ] **Step 4: Wire global setup into Vitest**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['web/tests/**/*.test.js', 'server/tests/**/*.test.ts'],
    globalSetup: ['server/tests/support/global-setup.ts'],
    // Every DB-touching test file calls resetDb() in beforeEach, which TRUNCATEs all six tables in
    // the one shared test database. Vitest 3 runs test FILES in parallel by default, so without
    // this one file's TRUNCATE would delete another file's in-flight rows and produce
    // nondeterministic failures that look like implementation bugs. Run the files serially in a
    // single fork instead; the suite is small and DB-bound, so the wall-clock cost is minimal.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
```

- [ ] **Step 5: Write a real migration-verification test**

This asserts something rather than relying on "No test files found" (which Vitest treats as a failing run and which would not prove `globalSetup` executed at all).

```ts
// server/tests/database/migrations.test.ts
import { afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, closeTestDb } from '../support/db.js';

afterAll(async () => {
  await closeTestDb();
});

describe('test-database global setup', () => {
  it('creates the test database and applies every Phase 3 migration to it', async () => {
    const { db } = getTestDb();
    const result = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tableNames = (result.rows as { table_name: string }[]).map((row) => row.table_name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        'app_sessions',
        'courses',
        'institutions',
        'lti_deployments',
        'lti_registrations',
        'oidc_transactions',
      ]),
    );
  });
});
```

- [ ] **Step 6: Run the verification test**

Run: `docker compose up -d && npx vitest run server/tests/database/migrations.test.ts`
Expected: PASS (1 test). If it fails, fix `applyMigrations`/`ensureTestDatabaseExists`/`TEST_DATABASE_URL` before proceeding — every later task depends on this working.

Also confirm the dev database was left alone: `psql postgres://attendance_tracker:attendance_tracker@localhost:5432/postgres -c '\l'` should now list **both** `attendance_tracker` and `attendance_tracker_test`.

- [ ] **Step 7: Commit**

```bash
git add server/src/database/client.ts server/tests/support/db.ts server/tests/support/global-setup.ts server/tests/database/migrations.test.ts vitest.config.ts
git commit -m "feat: add Drizzle DB client and isolated test-database migration/reset support"
```

---

## Task 5: Schema smoke test

**Files:**
- Test: `server/tests/database/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/database/schema.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses, appSessions, oidcTransactions } from '../../src/database/schema.js';

// File scope, not inside a describe: the pg pool in tests/support/db.ts is module-level and shared
// by every describe in this file, so closing it from inside one describe would leave any later
// describe's re-created pool open (Vitest then warns about a hanging process).
afterAll(async () => {
  await closeTestDb();
});

describe('schema smoke test', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('can insert and read a full row chain across every Phase 3 table', async () => {
    const { db } = getTestDb();

    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'smoke-test', displayName: 'Smoke Test University', timezone: 'UTC', enabled: true })
      .returning();
    expect(institution.id).toBeTruthy();

    const [registration] = await db
      .insert(ltiRegistrations)
      .values({
        institutionId: institution.id,
        issuer: 'https://smoke.test',
        clientId: 'client-smoke',
        oidcAuthEndpoint: 'https://smoke.test/authorize',
        tokenEndpoint: 'https://smoke.test/token',
        tokenAudience: 'https://smoke.test/token',
        platformJwksUri: 'https://smoke.test/jwks',
        enabled: true,
      })
      .returning();

    const [deployment] = await db
      .insert(ltiDeployments)
      .values({ registrationId: registration.id, deploymentId: 'deploy-smoke', enabled: true, configuration: {} })
      .returning();

    const [transaction] = await db
      .insert(oidcTransactions)
      .values({
        registrationId: registration.id,
        deploymentId: deployment.deploymentId,
        stateHash: 'state-hash-smoke',
        nonceHash: 'nonce-hash-smoke',
        targetLinkUri: 'https://smoke.test/index.html',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })
      .returning();
    expect(transaction.consumedAt).toBeNull();

    const [course] = await db
      .insert(courses)
      .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'course-smoke', label: 'SMOKE101', title: 'Smoke Course' })
      .returning();

    const [session] = await db
      .insert(appSessions)
      .values({
        sessionTokenHash: 'session-hash-smoke',
        institutionId: institution.id,
        deploymentId: deployment.id,
        ltiSubject: 'user-smoke',
        courseId: course.id,
        roles: ['Instructor'],
        csrfSecret: 'csrf-smoke',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      })
      .returning();

    expect(session.ltiSubject).toBe('user-smoke');
    expect(session.roles).toEqual(['Instructor']);
  });

  it('enforces UNIQUE(issuer, client_id) on lti_registrations', async () => {
    const { db } = getTestDb();
    const [institution] = await db
      .insert(institutions)
      .values({ slug: 'dup-test', displayName: 'Dup Test', timezone: 'UTC', enabled: true })
      .returning();

    const values = {
      institutionId: institution.id,
      issuer: 'https://dup.test',
      clientId: 'client-dup',
      oidcAuthEndpoint: 'https://dup.test/authorize',
      tokenEndpoint: 'https://dup.test/token',
      tokenAudience: 'https://dup.test/token',
      platformJwksUri: 'https://dup.test/jwks',
      enabled: true,
    };
    await db.insert(ltiRegistrations).values(values);

    await expect(db.insert(ltiRegistrations).values(values)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes cleanly**

Run: `docker compose up -d && npx vitest run server/tests/database/schema.test.ts`
Expected: PASS (2 tests) — the schema from Task 3 already exists, so this is a verification run, not a red/green cycle. If it fails, fix the schema or migration before proceeding.

- [ ] **Step 3: Commit**

```bash
git add server/tests/database/schema.test.ts
git commit -m "test: add schema smoke test covering every Phase 3 table"
```

---

## Task 6: Tool's own signing keys (`lti/signing-keys.ts`)

**Files:**
- Create: `server/src/lti/signing-keys.ts`
- Test: `server/tests/lti/signing-keys.test.ts`

**Interfaces:**
- Produces: `interface ToolSigningKey { kid: string; status: 'active' | 'previous'; privateKey: CryptoKey; publicJwk: Record<string, unknown> }`, `loadSigningKeysFromEnv(json: string | undefined): Promise<ToolSigningKey[]>`, `getActiveSigningKey(keys: ToolSigningKey[]): ToolSigningKey`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/signing-keys.test.ts
import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { loadSigningKeysFromEnv, getActiveSigningKey, type ToolSigningKey } from '../../src/lti/signing-keys.js';

describe('loadSigningKeysFromEnv', () => {
  it('generates a single ephemeral active key when no env var is set', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe('active');
    expect(keys[0].publicJwk).not.toHaveProperty('d');
    expect(keys[0].publicJwk.kid).toBe(keys[0].kid);
  });

  it('loads active and previous keys from LTI_TOOL_SIGNING_KEYS_JSON', async () => {
    const { privateKey: activePrivate } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const { privateKey: previousPrivate } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const json = JSON.stringify([
      { kid: 'active-1', privateKeyPkcs8Pem: await exportPKCS8(activePrivate), status: 'active' },
      { kid: 'previous-1', privateKeyPkcs8Pem: await exportPKCS8(previousPrivate), status: 'previous' },
    ]);

    const keys = await loadSigningKeysFromEnv(json);

    expect(keys.map((k) => k.kid).sort()).toEqual(['active-1', 'previous-1']);
    expect(getActiveSigningKey(keys).kid).toBe('active-1');
    for (const key of keys) {
      expect(key.publicJwk).not.toHaveProperty('d');
      expect(key.publicJwk).not.toHaveProperty('p');
    }
  });

  it('getActiveSigningKey throws when no key is marked active', () => {
    const keys: ToolSigningKey[] = [{ kid: 'x', status: 'previous', privateKey: {} as CryptoKey, publicJwk: {} }];
    expect(() => getActiveSigningKey(keys)).toThrow(/No active tool signing key/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/signing-keys.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/signing-keys.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/signing-keys.ts
import { generateKeyPair, exportJWK, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';

export interface ToolSigningKey {
  kid: string;
  status: 'active' | 'previous';
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

interface RawSigningKeyConfig {
  kid: string;
  privateKeyPkcs8Pem: string;
  status: 'active' | 'previous';
}

async function toPublicJwk(privateKey: CryptoKey, kid: string): Promise<Record<string, unknown>> {
  const full = (await exportJWK(privateKey)) as { kty: string; n: string; e: string };
  return { kty: full.kty, n: full.n, e: full.e, kid, use: 'sig', alg: 'RS256' };
}

async function generateEphemeralSigningKey(): Promise<ToolSigningKey> {
  const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const kid = randomUUID();
  return { kid, status: 'active', privateKey, publicJwk: await toPublicJwk(privateKey, kid) };
}

export async function loadSigningKeysFromEnv(json: string | undefined): Promise<ToolSigningKey[]> {
  if (!json) {
    return [await generateEphemeralSigningKey()];
  }

  const raw = JSON.parse(json) as RawSigningKeyConfig[];
  return Promise.all(
    raw.map(async (entry) => {
      // `extractable: true` is REQUIRED: importPKCS8 defaults to extractable:false, and
      // toPublicJwk() below calls exportJWK() on this key to derive the public JWK that
      // GET /lti/jwks publishes. Without it, exportJWK throws at boot and /lti/jwks never works.
      // (The ephemeral path above passes the same flag to generateKeyPair for the same reason.)
      const privateKey = await importPKCS8(entry.privateKeyPkcs8Pem, 'RS256', { extractable: true });
      return { kid: entry.kid, status: entry.status, privateKey, publicJwk: await toPublicJwk(privateKey, entry.kid) };
    }),
  );
}

// Consumed by Phase 4's Canvas service-token client, which signs the `client_assertion` JWT for the
// OAuth2 token endpoint with the active key. Phase 3 itself only publishes the public halves at
// GET /lti/jwks, so within this plan this function is exercised only by its own unit test.
export function getActiveSigningKey(keys: ToolSigningKey[]): ToolSigningKey {
  const active = keys.find((k) => k.status === 'active');
  if (!active) {
    throw new Error('No active tool signing key configured.');
  }
  return active;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/signing-keys.test.ts`
Expected: PASS (3 tests)

**Deferred (spec §17.2):** the spec asks for a *configurable overlap/retention period* (it suggests seven days) after which a `previous` public key stops being published. Phase 3 does not implement a timer or a retention column: rotation is entirely env-driven, so the operator controls the overlap by leaving the old key in `LTI_TOOL_SIGNING_KEYS_JSON` with `status: 'previous'` and removing that entry once the overlap has elapsed. The spec's hard requirements — publish active + previous, sign only with active, rotate without code changes — are all met. A scheduled/automatic retention policy is deferred to Phase 8 hardening; note it in `docs/canvas-installation.md`-adjacent operations docs when Phase 7/8 add them.

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/signing-keys.ts server/tests/lti/signing-keys.test.ts
git commit -m "feat: add tool signing key loading (env-configured or ephemeral) with active/previous rotation"
```

---

## Task 7: Public JWKS response builder (`lti/jwks-route.ts`)

**Files:**
- Create: `server/src/lti/jwks-route.ts`
- Test: `server/tests/lti/jwks-route.test.ts`

**Interfaces:**
- Consumes: `ToolSigningKey` from Task 6.
- Produces: `interface JwksResponse { keys: Record<string, unknown>[] }`, `buildJwksResponse(keys: ToolSigningKey[]): JwksResponse`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/jwks-route.test.ts
import { describe, it, expect } from 'vitest';
import { buildJwksResponse } from '../../src/lti/jwks-route.js';
import { loadSigningKeysFromEnv } from '../../src/lti/signing-keys.js';

describe('buildJwksResponse', () => {
  it('exposes only public fields, never private key material', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    const response = buildJwksResponse(keys);

    expect(response.keys).toHaveLength(1);
    const jwk = response.keys[0];
    expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'].sort());
    expect(jwk).not.toHaveProperty('d');
    expect(jwk).not.toHaveProperty('p');
    expect(jwk).not.toHaveProperty('q');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/jwks-route.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/jwks-route.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/jwks-route.ts
import type { ToolSigningKey } from './signing-keys.js';

export interface JwksResponse {
  keys: Record<string, unknown>[];
}

export function buildJwksResponse(keys: ToolSigningKey[]): JwksResponse {
  return { keys: keys.map((key) => key.publicJwk) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/jwks-route.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/jwks-route.ts server/tests/lti/jwks-route.test.ts
git commit -m "feat: add public JWKS response builder"
```

---

## Task 8: `GET /lti/jwks` route

**Files:**
- Create: `server/src/routes/lti-jwks.ts`
- Test: `server/tests/routes/lti-jwks.test.ts`

**Interfaces:**
- Consumes: `buildJwksResponse` (Task 7), `ToolSigningKey` (Task 6).
- Produces: `registerLtiJwksRoute(app: FastifyInstance, signingKeys: ToolSigningKey[]): void`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/routes/lti-jwks.test.ts
import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerLtiJwksRoute } from '../../src/routes/lti-jwks.js';
import { loadSigningKeysFromEnv } from '../../src/lti/signing-keys.js';

describe('GET /lti/jwks', () => {
  it('returns the public JWKS with no private material', async () => {
    const keys = await loadSigningKeysFromEnv(undefined);
    const app = Fastify({ logger: false });
    registerLtiJwksRoute(app, keys);

    const response = await app.inject({ method: 'GET', url: '/lti/jwks' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(body.keys[0].kid).toBe(keys[0].kid);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/routes/lti-jwks.test.ts`
Expected: FAIL with "Cannot find module '../../src/routes/lti-jwks.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/routes/lti-jwks.ts
import type { FastifyInstance } from 'fastify';
import { buildJwksResponse } from '../lti/jwks-route.js';
import type { ToolSigningKey } from '../lti/signing-keys.js';

export function registerLtiJwksRoute(app: FastifyInstance, signingKeys: ToolSigningKey[]): void {
  app.get('/lti/jwks', async () => buildJwksResponse(signingKeys));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/routes/lti-jwks.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/lti-jwks.ts server/tests/routes/lti-jwks.test.ts
git commit -m "feat: add GET /lti/jwks route"
```

---

## Task 9: LTI types + registration lookup (`lti/types.ts`, `lti/registrations.ts`)

**Files:**
- Create: `server/src/lti/types.ts`, `server/src/lti/registrations.ts`
- Test: `server/tests/lti/registrations.test.ts`

**Interfaces:**
- Consumes: `Database` (Task 4), `institutions`/`ltiRegistrations`/`ltiDeployments`/`courses` (Task 3).
- Produces: `interface LtiInstitution/LtiRegistration/LtiDeployment/EnabledDeployment` (types.ts); `findEnabledDeployment(db, iss, clientId, deploymentId): Promise<EnabledDeployment | null>`, `findRegistrationById(db, id): Promise<LtiRegistration | null>`, `findDeploymentByBusinessId(db, registrationId, deploymentId): Promise<LtiDeployment | null>`, `findOrCreateCourse(db, params): Promise<{ id: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/registrations.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments } from '../../src/database/schema.js';
import {
  findEnabledDeployment,
  findRegistrationById,
  findDeploymentByBusinessId,
  findOrCreateCourse,
} from '../../src/lti/registrations.js';

async function seedRow(overrides: { deploymentEnabled?: boolean } = {}) {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'cedarville', displayName: 'Cedarville University', timezone: 'America/New_York', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://canvas.instructure.com',
      clientId: 'client-1',
      oidcAuthEndpoint: 'https://canvas.instructure.com/api/lti/authorize_redirect',
      tokenEndpoint: 'https://canvas.instructure.com/login/oauth2/token',
      tokenAudience: 'https://canvas.instructure.com/login/oauth2/token',
      platformJwksUri: 'https://canvas.instructure.com/api/lti/security/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'deploy-1', enabled: overrides.deploymentEnabled ?? true, configuration: {} })
    .returning();
  return { institution, registration, deployment };
}

// File scope, not inside the first describe: db.ts's pg pool is module-level and shared by every
// describe below, so closing it from inside one describe would leave the pools the later describes
// re-create open (Vitest then warns about a hanging process).
afterAll(async () => {
  await closeTestDb();
});

describe('findEnabledDeployment', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null when no matching registration exists', async () => {
    const { db } = getTestDb();
    const result = await findEnabledDeployment(db, 'https://unknown.test', 'client-x', 'deploy-x');
    expect(result).toBeNull();
  });

  it('returns institution/registration/deployment for a matching, enabled row set', async () => {
    const { db } = getTestDb();
    await seedRow();

    const result = await findEnabledDeployment(db, 'https://canvas.instructure.com', 'client-1', 'deploy-1');

    expect(result?.institution.slug).toBe('cedarville');
    expect(result?.registration.clientId).toBe('client-1');
    expect(result?.deployment.deploymentId).toBe('deploy-1');
  });

  it('returns null when the deployment is disabled', async () => {
    const { db } = getTestDb();
    await seedRow({ deploymentEnabled: false });

    const result = await findEnabledDeployment(db, 'https://canvas.instructure.com', 'client-1', 'deploy-1');
    expect(result).toBeNull();
  });
});

describe('findRegistrationById / findDeploymentByBusinessId', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('looks up a registration by its primary key and a deployment by its business deployment_id', async () => {
    const { db } = getTestDb();
    const { registration, deployment } = await seedRow();

    const foundRegistration = await findRegistrationById(db, registration.id);
    expect(foundRegistration?.issuer).toBe('https://canvas.instructure.com');

    const foundDeployment = await findDeploymentByBusinessId(db, registration.id, 'deploy-1');
    expect(foundDeployment?.id).toBe(deployment.id);

    expect(await findDeploymentByBusinessId(db, registration.id, 'no-such-deployment')).toBeNull();
  });
});

describe('findOrCreateCourse', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a course on first call and reuses it on a second call with the same context', async () => {
    const { db } = getTestDb();
    const { institution, deployment } = await seedRow();

    const first = await findOrCreateCourse(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiContextId: 'course-abc',
      label: 'CS101',
      title: 'Intro to CS',
    });
    const second = await findOrCreateCourse(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiContextId: 'course-abc',
    });

    expect(second.id).toBe(first.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/registrations.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/registrations.js'"

- [ ] **Step 3: Write `lti/types.ts`**

```ts
// server/src/lti/types.ts
export interface LtiInstitution {
  id: string;
  slug: string;
  displayName: string;
  enabled: boolean;
}

export interface LtiRegistration {
  id: string;
  institutionId: string;
  issuer: string;
  clientId: string;
  oidcAuthEndpoint: string;
  tokenEndpoint: string;
  tokenAudience: string;
  platformJwksUri: string;
  enabled: boolean;
}

export interface LtiDeployment {
  id: string;
  registrationId: string;
  deploymentId: string;
  enabled: boolean;
}

export interface EnabledDeployment {
  institution: LtiInstitution;
  registration: LtiRegistration;
  deployment: LtiDeployment;
}

// NOTE: this file deliberately does NOT declare a hand-written `LaunchClaims`/`LtiContextClaim`
// pair. The launch JWT's claim shape has exactly one source of truth: the zod schema in
// `lti/claims.ts` (Task 16) and its inferred `ValidatedLtiClaims` type. A parallel hand-written
// interface would be a second, unenforced definition that could drift from the validator.
```

- [ ] **Step 4: Write `lti/registrations.ts`**

```ts
// server/src/lti/registrations.ts
import { eq, and } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../database/schema.js';
import type { EnabledDeployment, LtiRegistration, LtiDeployment } from './types.js';

export async function findEnabledDeployment(
  db: Database,
  iss: string,
  clientId: string,
  deploymentId: string,
): Promise<EnabledDeployment | null> {
  const rows = await db
    .select({ institution: institutions, registration: ltiRegistrations, deployment: ltiDeployments })
    .from(ltiDeployments)
    .innerJoin(ltiRegistrations, eq(ltiDeployments.registrationId, ltiRegistrations.id))
    .innerJoin(institutions, eq(ltiRegistrations.institutionId, institutions.id))
    .where(
      and(
        eq(ltiRegistrations.issuer, iss),
        eq(ltiRegistrations.clientId, clientId),
        eq(ltiDeployments.deploymentId, deploymentId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || !row.institution.enabled || !row.registration.enabled || !row.deployment.enabled) {
    return null;
  }

  return {
    institution: { id: row.institution.id, slug: row.institution.slug, displayName: row.institution.displayName, enabled: row.institution.enabled },
    registration: {
      id: row.registration.id,
      institutionId: row.registration.institutionId,
      issuer: row.registration.issuer,
      clientId: row.registration.clientId,
      oidcAuthEndpoint: row.registration.oidcAuthEndpoint,
      tokenEndpoint: row.registration.tokenEndpoint,
      tokenAudience: row.registration.tokenAudience,
      platformJwksUri: row.registration.platformJwksUri,
      enabled: row.registration.enabled,
    },
    deployment: { id: row.deployment.id, registrationId: row.deployment.registrationId, deploymentId: row.deployment.deploymentId, enabled: row.deployment.enabled },
  };
}

export async function findRegistrationById(db: Database, id: string): Promise<LtiRegistration | null> {
  const rows = await db.select().from(ltiRegistrations).where(eq(ltiRegistrations.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    institutionId: row.institutionId,
    issuer: row.issuer,
    clientId: row.clientId,
    oidcAuthEndpoint: row.oidcAuthEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    tokenAudience: row.tokenAudience,
    platformJwksUri: row.platformJwksUri,
    enabled: row.enabled,
  };
}

export async function findDeploymentByBusinessId(
  db: Database,
  registrationId: string,
  deploymentId: string,
): Promise<LtiDeployment | null> {
  const rows = await db
    .select()
    .from(ltiDeployments)
    .where(and(eq(ltiDeployments.registrationId, registrationId), eq(ltiDeployments.deploymentId, deploymentId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, registrationId: row.registrationId, deploymentId: row.deploymentId, enabled: row.enabled };
}

export interface FindOrCreateCourseParams {
  institutionId: string;
  deploymentId: string;
  ltiContextId: string;
  label?: string;
  title?: string;
}

export async function findOrCreateCourse(db: Database, params: FindOrCreateCourseParams): Promise<{ id: string }> {
  const existing = await db
    .select()
    .from(courses)
    .where(and(eq(courses.deploymentId, params.deploymentId), eq(courses.ltiContextId, params.ltiContextId)))
    .limit(1);
  if (existing[0]) {
    return { id: existing[0].id };
  }

  const [row] = await db
    .insert(courses)
    .values({
      institutionId: params.institutionId,
      deploymentId: params.deploymentId,
      ltiContextId: params.ltiContextId,
      label: params.label ?? null,
      title: params.title ?? null,
    })
    .returning();
  return { id: row.id };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/registrations.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/lti/types.ts server/src/lti/registrations.ts server/tests/lti/registrations.test.ts
git commit -m "feat: add LTI types and registration/deployment/course lookup"
```

---

## Task 10: Mock Canvas platform test harness

**Files:**
- Create: `server/tests/support/mock-canvas.ts`
- Test: `server/tests/support/mock-canvas.test.ts`

**Interfaces:**
- Produces: `class MockCanvasPlatform` with `issuer: string`, `jwksUri: string` (getter, valid only after `start()`), `start(): Promise<void>`, `stop(): Promise<void>`, `publishNewKey(kid: string): Promise<void>`, `unpublishKey(kid: string): void`, `mintIdToken(overrides?: MintTokenOverrides, options?: MintTokenOptions): Promise<string>`.
- `MintTokenOverrides`: `{ iss?, aud?, azp?, sub?, nonce?, exp?, iat?, nbf?, deploymentId?, version?, messageType?, contextId?: string | null, roles?: string[] | null, extraClaims?: Record<string, unknown> }`. Passing `contextId: null` or `roles: null` omits that claim entirely (for the missing_context/missing_roles test cases).
- `MintTokenOptions`: `{ kid?: string, alg?: string }`.

This is a **real second in-process Fastify server** (not mocked `fetch`), so `jwks-cache.ts`'s actual network call is exercised in later tests.

- [ ] **Step 1: Write the failing self-test**

```ts
// server/tests/support/mock-canvas.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { jwtVerify, importJWK } from 'jose';
import { MockCanvasPlatform } from './mock-canvas.js';

describe('MockCanvasPlatform', () => {
  let platform: MockCanvasPlatform | undefined;

  afterEach(async () => {
    await platform?.stop();
    platform = undefined;
  });

  it('mints ID tokens that verify against its own published JWKS', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    const token = await platform.mintIdToken();
    const jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: Record<string, unknown>[] };
    expect(jwksResponse.keys).toHaveLength(1);

    const publicKey = await importJWK(jwksResponse.keys[0], 'RS256');
    const { payload } = await jwtVerify(token, publicKey);
    expect(payload.iss).toBe(platform.issuer);
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/version']).toBe('1.3.0');
  });

  it('publishNewKey/unpublishKey control what appears in the JWKS response', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    await platform.publishNewKey('rotated-kid');
    let jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: { kid: string }[] };
    expect(jwksResponse.keys.map((k) => k.kid)).toContain('rotated-kid');

    platform.unpublishKey('rotated-kid');
    jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: { kid: string }[] };
    expect(jwksResponse.keys.map((k) => k.kid)).not.toContain('rotated-kid');
  });

  it('mintIdToken supports omitting context/roles for the missing_context/missing_roles test cases', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();

    const token = await platform.mintIdToken({ contextId: null, roles: null });
    const jwksResponse = (await fetch(platform.jwksUri).then((r) => r.json())) as { keys: Record<string, unknown>[] };
    const publicKey = await importJWK(jwksResponse.keys[0], 'RS256');
    const { payload } = await jwtVerify(token, publicKey);

    expect(payload['https://purl.imsglobal.org/spec/lti/claim/context']).toBeUndefined();
    expect(payload['https://purl.imsglobal.org/spec/lti/claim/roles']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/support/mock-canvas.test.ts`
Expected: FAIL with "Cannot find module './mock-canvas.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/tests/support/mock-canvas.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';

interface MockKeyEntry {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

export interface MintTokenOverrides {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  sub?: string;
  nonce?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  deploymentId?: string;
  version?: string;
  messageType?: string;
  contextId?: string | null;
  roles?: string[] | null;
  extraClaims?: Record<string, unknown>;
}

export interface MintTokenOptions {
  kid?: string;
  alg?: string;
}

export class MockCanvasPlatform {
  readonly issuer = 'https://mock-canvas.test';
  private keys = new Map<string, MockKeyEntry>();
  private app: FastifyInstance;
  private port = 0;

  constructor() {
    this.app = Fastify({ logger: false });
    this.app.get('/jwks', async () => ({ keys: [...this.keys.values()].map((k) => k.publicJwk) }));
  }

  async start(): Promise<void> {
    const address = await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.port = Number(new URL(address).port);
    await this.publishNewKey('default-kid');
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  get jwksUri(): string {
    return `http://127.0.0.1:${this.port}/jwks`;
  }

  async publishNewKey(kid: string): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const publicJwk = await exportJWK(publicKey);
    this.keys.set(kid, { kid, privateKey, publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' } });
  }

  unpublishKey(kid: string): void {
    this.keys.delete(kid);
  }

  async mintIdToken(overrides: MintTokenOverrides = {}, options: MintTokenOptions = {}): Promise<string> {
    const kid = options.kid ?? 'default-kid';
    if (!this.keys.has(kid)) {
      await this.publishNewKey(kid);
    }
    const entry = this.keys.get(kid);
    if (!entry) {
      throw new Error(`mock-canvas: no key published for kid "${kid}"`);
    }

    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: overrides.iss ?? this.issuer,
      aud: overrides.aud ?? 'mock-client-id',
      sub: overrides.sub ?? 'mock-user-1',
      exp: overrides.exp ?? now + 3600,
      iat: overrides.iat ?? now,
      nonce: overrides.nonce ?? randomUUID(),
      'https://purl.imsglobal.org/spec/lti/claim/version': overrides.version ?? '1.3.0',
      'https://purl.imsglobal.org/spec/lti/claim/message_type': overrides.messageType ?? 'LtiResourceLinkRequest',
      'https://purl.imsglobal.org/spec/lti/claim/deployment_id': overrides.deploymentId ?? 'mock-deployment-1',
      name: 'Mock Instructor',
      ...overrides.extraClaims,
    };
    if (overrides.azp) payload.azp = overrides.azp;
    if (overrides.nbf !== undefined) payload.nbf = overrides.nbf;
    if (overrides.contextId !== null) {
      payload['https://purl.imsglobal.org/spec/lti/claim/context'] = {
        id: overrides.contextId ?? 'mock-course-1',
        label: 'MOCK101',
        title: 'Mock Course',
      };
    }
    if (overrides.roles !== null) {
      payload['https://purl.imsglobal.org/spec/lti/claim/roles'] = overrides.roles ?? [
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
      ];
    }

    return new SignJWT(payload).setProtectedHeader({ alg: options.alg ?? 'RS256', kid }).sign(entry.privateKey);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/support/mock-canvas.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/tests/support/mock-canvas.ts server/tests/support/mock-canvas.test.ts
git commit -m "test: add in-process mock Canvas platform (real JWKS server + ID token minting)"
```

---

## Task 11: Seed helper (`tests/support/seed.ts`)

**Files:**
- Create: `server/tests/support/seed.ts`

**Interfaces:**
- Consumes: `Database` (Task 4), `MockCanvasPlatform` (Task 10).
- Produces: `seedInstitutionAndRegistration(db, platform, overrides?): Promise<SeededRegistration>` where `SeededRegistration = { institutionId: string; registrationId: string; deploymentRowId: string; clientId: string; deploymentId: string }`.

This task has no standalone test — it's exercised by every subsequent task that needs a seeded registration (starting Task 12).

- [ ] **Step 1: Write `tests/support/seed.ts`**

```ts
// server/tests/support/seed.ts
import { randomUUID } from 'node:crypto';
import type { Database } from '../../src/database/client.js';
import { institutions, ltiRegistrations, ltiDeployments } from '../../src/database/schema.js';
import type { MockCanvasPlatform } from './mock-canvas.js';

export interface SeededRegistration {
  institutionId: string;
  registrationId: string;
  deploymentRowId: string;
  clientId: string;
  deploymentId: string;
}

export interface SeedOverrides {
  clientId?: string;
  deploymentId?: string;
}

export async function seedInstitutionAndRegistration(
  db: Database,
  platform: MockCanvasPlatform,
  overrides: SeedOverrides = {},
): Promise<SeededRegistration> {
  const clientId = overrides.clientId ?? 'mock-client-id';
  const deploymentId = overrides.deploymentId ?? 'mock-deployment-1';

  const [institution] = await db
    .insert(institutions)
    .values({ slug: `mock-${randomUUID()}`, displayName: 'Mock University', timezone: 'UTC', enabled: true })
    .returning();

  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: platform.issuer,
      clientId,
      oidcAuthEndpoint: 'https://mock-canvas.test/api/lti/authorize_redirect',
      tokenEndpoint: 'https://mock-canvas.test/login/oauth2/token',
      tokenAudience: 'https://mock-canvas.test/login/oauth2/token',
      platformJwksUri: platform.jwksUri,
      enabled: true,
    })
    .returning();

  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId, enabled: true, configuration: {} })
    .returning();

  return { institutionId: institution.id, registrationId: registration.id, deploymentRowId: deployment.id, clientId, deploymentId };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: passes (no test imports it yet, but it must type-check standalone)

- [ ] **Step 3: Commit**

```bash
git add server/tests/support/seed.ts
git commit -m "test: add seedInstitutionAndRegistration test support helper"
```

---

## Task 12: OIDC transactions (`lti/oidc-transactions.ts`)

**Files:**
- Create: `server/src/lti/oidc-transactions.ts`
- Test: `server/tests/lti/oidc-transactions.test.ts`

Covers §45 cases **3 (unknown_state)**, **4 (expired_state)**, **5 (reused_state)**.

**Interfaces:**
- Produces: `createOidcTransaction(db, params: { registrationId, deploymentId, targetLinkUri, ttlSeconds }): Promise<{ state: string; nonce: string; transactionId: string }>`; `consumeOidcTransaction(db, state: string): Promise<ConsumeTransactionResult>` where `ConsumeTransactionResult = { ok: true; transaction: { id, registrationId, deploymentId, nonceHash, targetLinkUri } } | { ok: false; reason: 'unknown_state' | 'expired_state' | 'reused_state' }`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/oidc-transactions.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations } from '../../src/database/schema.js';
import { createOidcTransaction, consumeOidcTransaction } from '../../src/lti/oidc-transactions.js';

async function seedRegistrationId(): Promise<string> {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'txn-test', displayName: 'Txn Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://txn.test',
      clientId: 'txn-client',
      oidcAuthEndpoint: 'https://txn.test/authorize',
      tokenEndpoint: 'https://txn.test/token',
      tokenAudience: 'https://txn.test/token',
      platformJwksUri: 'https://txn.test/jwks',
      enabled: true,
    })
    .returning();
  return registration.id;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once, after every
// describe in this file has finished (see the same note in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('createOidcTransaction / consumeOidcTransaction', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a transaction with 256-bit state/nonce and consumes it successfully once', async () => {
    const { db } = getTestDb();
    const registrationId = await seedRegistrationId();

    const created = await createOidcTransaction(db, {
      registrationId,
      deploymentId: 'deploy-1',
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    expect(Buffer.from(created.state, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(created.nonce, 'base64url').length).toBeGreaterThanOrEqual(32);

    const result = await consumeOidcTransaction(db, created.state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transaction.registrationId).toBe(registrationId);
      expect(result.transaction.deploymentId).toBe('deploy-1');
    }
  });

  it('§45 case 3: rejects an unknown state', async () => {
    const { db } = getTestDb();
    const result = await consumeOidcTransaction(db, 'never-issued-state-value');
    expect(result).toEqual({ ok: false, reason: 'unknown_state' });
  });

  it('§45 case 4: rejects an expired state', async () => {
    const { db } = getTestDb();
    const registrationId = await seedRegistrationId();
    const created = await createOidcTransaction(db, {
      registrationId,
      deploymentId: 'deploy-1',
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: -1, // already expired
    });

    const result = await consumeOidcTransaction(db, created.state);
    expect(result).toEqual({ ok: false, reason: 'expired_state' });
  });

  it('§45 case 5: rejects a reused state on the second consume', async () => {
    const { db } = getTestDb();
    const registrationId = await seedRegistrationId();
    const created = await createOidcTransaction(db, {
      registrationId,
      deploymentId: 'deploy-1',
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    const first = await consumeOidcTransaction(db, created.state);
    expect(first.ok).toBe(true);

    const second = await consumeOidcTransaction(db, created.state);
    expect(second).toEqual({ ok: false, reason: 'reused_state' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/oidc-transactions.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/oidc-transactions.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/oidc-transactions.ts
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, gt, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { oidcTransactions } from '../database/schema.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateOidcTransactionParams {
  registrationId: string;
  deploymentId: string;
  targetLinkUri: string;
  ttlSeconds: number;
}

export interface CreatedTransaction {
  state: string;
  nonce: string;
  transactionId: string;
}

export async function createOidcTransaction(db: Database, params: CreateOidcTransactionParams): Promise<CreatedTransaction> {
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);

  const [row] = await db
    .insert(oidcTransactions)
    .values({
      registrationId: params.registrationId,
      deploymentId: params.deploymentId,
      stateHash: hashToken(state),
      nonceHash: hashToken(nonce),
      targetLinkUri: params.targetLinkUri,
      expiresAt,
    })
    .returning();

  return { state, nonce, transactionId: row.id };
}

export interface ConsumedTransaction {
  id: string;
  registrationId: string;
  deploymentId: string;
  nonceHash: string;
  targetLinkUri: string;
}

export type ConsumeTransactionResult =
  | { ok: true; transaction: ConsumedTransaction }
  | { ok: false; reason: 'unknown_state' | 'expired_state' | 'reused_state' };

export async function consumeOidcTransaction(db: Database, state: string): Promise<ConsumeTransactionResult> {
  const stateHash = hashToken(state);

  const existing = await db.select().from(oidcTransactions).where(eq(oidcTransactions.stateHash, stateHash)).limit(1);
  const row = existing[0];
  if (!row) {
    return { ok: false, reason: 'unknown_state' };
  }
  if (row.consumedAt !== null) {
    return { ok: false, reason: 'reused_state' };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired_state' };
  }

  // Atomic single-use consume: closes the replay race in one round trip. The pre-checks above
  // exist only to classify the *common* failure reason precisely; this UPDATE is the actual guard.
  const updated = await db
    .update(oidcTransactions)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(oidcTransactions.stateHash, stateHash), isNull(oidcTransactions.consumedAt), gt(oidcTransactions.expiresAt, new Date())))
    .returning();

  const winner = updated[0];
  if (!winner) {
    return { ok: false, reason: 'reused_state' };
  }

  return {
    ok: true,
    transaction: {
      id: winner.id,
      registrationId: winner.registrationId,
      deploymentId: winner.deploymentId,
      nonceHash: winner.nonceHash,
      targetLinkUri: winner.targetLinkUri,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/oidc-transactions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/oidc-transactions.ts server/tests/lti/oidc-transactions.test.ts
git commit -m "feat: add OIDC transaction creation and atomic single-use consume"
```

---

## Task 13: Login redirect builder (`lti/login.ts`)

**Files:**
- Create: `server/src/lti/login.ts`
- Test: `server/tests/lti/login.test.ts`

Covers §45 case **24 (target-link open-redirect attempt)**.

**Interfaces:**
- Consumes: `createOidcTransaction`-shaped function, `findEnabledDeployment`-shaped function (both injected as deps, not imported directly, so this stays a pure/framework-agnostic module).
- Produces: `createAllowlist(uris: string[]): AllowedTargetLinkUris`, `buildLoginRedirect(params: LoginParams, deps: LoginDeps): Promise<LoginResult>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/login.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createAllowlist, buildLoginRedirect, type LoginDeps } from '../../src/lti/login.js';

function makeDeps(overrides: Partial<LoginDeps> = {}): LoginDeps {
  return {
    appBaseUrl: 'https://app.test',
    allowedTargetLinkUris: createAllowlist(['https://app.test/index.html']),
    findEnabledDeployment: vi.fn().mockResolvedValue({
      registration: { id: 'reg-1', oidcAuthEndpoint: 'https://canvas.test/authorize' },
      deployment: { id: 'dep-row-1', deploymentId: 'deploy-1' },
    }),
    createTransaction: vi.fn().mockResolvedValue({ state: 'state-value', nonce: 'nonce-value' }),
    ...overrides,
  };
}

const BASE_PARAMS = {
  iss: 'https://canvas.test',
  loginHint: 'hint-123',
  targetLinkUri: 'https://app.test/index.html',
  clientId: 'client-1',
  deploymentId: 'deploy-1',
};

describe('buildLoginRedirect', () => {
  it('builds a redirect URL with all required OIDC parameters on success', async () => {
    const deps = makeDeps();
    const result = await buildLoginRedirect(BASE_PARAMS, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = new URL(result.redirectUrl);
      expect(url.origin + url.pathname).toBe('https://canvas.test/authorize');
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(url.searchParams.get('login_hint')).toBe('hint-123');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/lti/launch');
      expect(url.searchParams.get('state')).toBe('state-value');
      expect(url.searchParams.get('nonce')).toBe('nonce-value');
      expect(url.searchParams.get('response_type')).toBe('id_token');
      expect(url.searchParams.get('response_mode')).toBe('form_post');
      expect(url.searchParams.get('scope')).toBe('openid');
    }
  });

  it('§45 case 24: rejects a target_link_uri not on the exact-match allowlist (open-redirect attempt)', async () => {
    const deps = makeDeps();
    const result = await buildLoginRedirect(
      { ...BASE_PARAMS, targetLinkUri: 'https://evil.test/steal-tokens' },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'disallowed_target_link_uri' });
    expect(deps.findEnabledDeployment).not.toHaveBeenCalled();
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a target_link_uri that is merely a prefix/substring match, not exact', async () => {
    const deps = makeDeps({ allowedTargetLinkUris: createAllowlist(['https://app.test/index.html']) });
    const result = await buildLoginRedirect(
      { ...BASE_PARAMS, targetLinkUri: 'https://app.test/index.html?malicious=1' },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'disallowed_target_link_uri' });
  });

  it('rejects an unknown/disabled deployment', async () => {
    const deps = makeDeps({ findEnabledDeployment: vi.fn().mockResolvedValue(null) });
    const result = await buildLoginRedirect(BASE_PARAMS, deps);

    expect(result).toEqual({ ok: false, reason: 'unknown_deployment' });
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/login.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/login.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/login.ts
export interface AllowedTargetLinkUris {
  isAllowed(uri: string): boolean;
}

export function createAllowlist(uris: string[]): AllowedTargetLinkUris {
  const set = new Set(uris);
  return { isAllowed: (uri: string) => set.has(uri) };
}

export interface LoginParams {
  iss: string;
  loginHint: string;
  targetLinkUri: string;
  clientId: string;
  deploymentId: string;
}

export interface LoginDeps {
  appBaseUrl: string;
  allowedTargetLinkUris: AllowedTargetLinkUris;
  findEnabledDeployment(
    iss: string,
    clientId: string,
    deploymentId: string,
  ): Promise<{
    registration: { id: string; oidcAuthEndpoint: string };
    deployment: { id: string; deploymentId: string };
  } | null>;
  createTransaction(params: {
    registrationId: string;
    deploymentId: string;
    targetLinkUri: string;
  }): Promise<{ state: string; nonce: string }>;
}

export type LoginResult =
  | { ok: true; redirectUrl: string; state: string }
  | { ok: false; reason: 'unknown_deployment' | 'disallowed_target_link_uri' };

export async function buildLoginRedirect(params: LoginParams, deps: LoginDeps): Promise<LoginResult> {
  if (!deps.allowedTargetLinkUris.isAllowed(params.targetLinkUri)) {
    return { ok: false, reason: 'disallowed_target_link_uri' };
  }

  const enabled = await deps.findEnabledDeployment(params.iss, params.clientId, params.deploymentId);
  if (!enabled) {
    return { ok: false, reason: 'unknown_deployment' };
  }

  const { state, nonce } = await deps.createTransaction({
    registrationId: enabled.registration.id,
    deploymentId: enabled.deployment.deploymentId,
    targetLinkUri: params.targetLinkUri,
  });

  const redirectUrl = new URL(enabled.registration.oidcAuthEndpoint);
  redirectUrl.searchParams.set('client_id', params.clientId);
  redirectUrl.searchParams.set('login_hint', params.loginHint);
  redirectUrl.searchParams.set('redirect_uri', `${deps.appBaseUrl}/lti/launch`);
  redirectUrl.searchParams.set('state', state);
  redirectUrl.searchParams.set('nonce', nonce);
  redirectUrl.searchParams.set('response_type', 'id_token');
  redirectUrl.searchParams.set('response_mode', 'form_post');
  redirectUrl.searchParams.set('scope', 'openid');

  return { ok: true, redirectUrl: redirectUrl.toString(), state };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/login.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/login.ts server/tests/lti/login.test.ts
git commit -m "feat: add login redirect builder with exact-match target_link_uri allowlist"
```

---

## Task 14: `GET`/`POST /lti/login` route

**Files:**
- Create: `server/src/routes/lti-login.ts`
- Test: `server/tests/routes/lti-login.test.ts`

Covers §45 case **24 (target-link open-redirect attempt)** at the route level — this is the one §45 case that is a login-time rejection rather than a launch-time one, so it is the one case whose "no `app_sessions` row" guarantee is asserted here (no transaction created, no session code path reachable) instead of in Task 23's launch sweep.

**Interfaces:**
- Consumes: `buildLoginRedirect`, `LoginDeps` (Task 13).
- Produces: `registerLtiLoginRoute(app: FastifyInstance, deps: LoginDeps): void`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/routes/lti-login.test.ts
import Fastify from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import { describe, it, expect, vi } from 'vitest';
import { registerLtiLoginRoute } from '../../src/routes/lti-login.js';
import { createAllowlist, type LoginDeps } from '../../src/lti/login.js';

function buildTestApp(deps: LoginDeps) {
  const app = Fastify({ logger: false });
  app.register(fastifyFormbody);
  registerLtiLoginRoute(app, deps);
  return app;
}

function makeDeps(): LoginDeps {
  return {
    appBaseUrl: 'https://app.test',
    allowedTargetLinkUris: createAllowlist(['https://app.test/index.html']),
    findEnabledDeployment: vi.fn().mockResolvedValue({
      registration: { id: 'reg-1', oidcAuthEndpoint: 'https://canvas.test/authorize' },
      deployment: { id: 'dep-row-1', deploymentId: 'deploy-1' },
    }),
    createTransaction: vi.fn().mockResolvedValue({ state: 'state-value', nonce: 'nonce-value' }),
  };
}

const QUERY = {
  iss: 'https://canvas.test',
  login_hint: 'hint-123',
  target_link_uri: 'https://app.test/index.html',
  client_id: 'client-1',
  deployment_id: 'deploy-1',
};

describe('GET/POST /lti/login', () => {
  it('GET redirects (302) to the Canvas authorization endpoint on a valid request', async () => {
    const app = buildTestApp(makeDeps());
    const query = new URLSearchParams(QUERY).toString();

    const response = await app.inject({ method: 'GET', url: `/lti/login?${query}` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://canvas.test/authorize');
  });

  it('POST (form-encoded, per Canvas §12.1) also redirects on a valid request', async () => {
    const app = buildTestApp(makeDeps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(QUERY).toString(),
    });

    expect(response.statusCode).toBe(302);
  });

  it('returns 400 for a request missing a required parameter', async () => {
    const app = buildTestApp(makeDeps());
    const { iss, ...missingIss } = QUERY;
    const query = new URLSearchParams(missingIss).toString();

    const response = await app.inject({ method: 'GET', url: `/lti/login?${query}` });

    expect(response.statusCode).toBe(400);
  });

  it('§45 case 24: returns 400 for a disallowed target_link_uri, never redirecting to it, and creating no OIDC transaction', async () => {
    const deps = makeDeps();
    const app = buildTestApp(deps);
    const query = new URLSearchParams({ ...QUERY, target_link_uri: 'https://evil.test/x' }).toString();

    const response = await app.inject({ method: 'GET', url: `/lti/login?${query}` });

    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    // Case 24 is the one §45 case that is rejected at LOGIN time, before any launch exists. The
    // matrix-wide "no app_sessions row" invariant is satisfied here structurally rather than by a
    // database count: /lti/login never creates a session (only /lti/launch does), and the
    // allowlist check runs before anything is written, so no oidc_transactions row is created
    // either. These two assertions pin exactly that.
    expect(deps.createTransaction).not.toHaveBeenCalled();
    expect(deps.findEnabledDeployment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/routes/lti-login.test.ts`
Expected: FAIL with "Cannot find module '../../src/routes/lti-login.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/routes/lti-login.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { buildLoginRedirect, type LoginDeps } from '../lti/login.js';

const loginParamsSchema = z.object({
  iss: z.string().min(1),
  login_hint: z.string().min(1),
  target_link_uri: z.string().min(1),
  client_id: z.string().min(1),
  deployment_id: z.string().min(1),
});

export function registerLtiLoginRoute(app: FastifyInstance, deps: LoginDeps): void {
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    const source = request.method === 'GET' ? request.query : request.body;
    const parsed = loginParamsSchema.safeParse(source);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid /lti/login request.' });
    }

    const result = await buildLoginRedirect(
      {
        iss: parsed.data.iss,
        loginHint: parsed.data.login_hint,
        targetLinkUri: parsed.data.target_link_uri,
        clientId: parsed.data.client_id,
        deploymentId: parsed.data.deployment_id,
      },
      deps,
    );

    if (!result.ok) {
      return reply.code(400).send({ error: result.reason });
    }

    return reply.redirect(result.redirectUrl, 302);
  }

  app.get('/lti/login', handler);
  app.post('/lti/login', handler);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/routes/lti-login.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/lti-login.ts server/tests/routes/lti-login.test.ts
git commit -m "feat: add GET/POST /lti/login route"
```

---

## Task 15: Canvas JWKS cache (`lti/jwks-cache.ts`)

**Files:**
- Create: `server/src/lti/jwks-cache.ts`
- Test: `server/tests/lti/jwks-cache.test.ts`

Covers §45 cases **12 (unknown `kid` followed by successful JWKS refresh)** and **13 (unknown `kid` after refresh, still fails)**.

**Interfaces:**
- Produces: `class JwksCache { getKey(registrationId: string, jwksUri: string, kid: string): Promise<Record<string, unknown> | null> }`, `createDefaultJwksCache(): JwksCache` (uses global `fetch`).

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/jwks-cache.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { JwksCache, createDefaultJwksCache } from '../../src/lti/jwks-cache.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';

describe('JwksCache', () => {
  let platform: MockCanvasPlatform | undefined;

  afterEach(async () => {
    await platform?.stop();
    platform = undefined;
  });

  it('§45 case 12: on an unknown kid, refetches the JWKS once and finds a newly rotated key', async () => {
    platform = new MockCanvasPlatform();
    await platform.start(); // publishes 'default-kid'
    const cache = createDefaultJwksCache();

    // Warm the cache with only 'default-kid' known.
    const initial = await cache.getKey('reg-1', platform.jwksUri, 'default-kid');
    expect(initial).not.toBeNull();

    // Canvas rotates in a brand-new key the cache has never seen.
    await platform.publishNewKey('rotated-kid');

    const rotated = await cache.getKey('reg-1', platform.jwksUri, 'rotated-kid');
    expect(rotated).not.toBeNull();
    expect(rotated?.kid).toBe('rotated-kid');
  });

  it('§45 case 13: on an unknown kid that was never published, fails after one refetch (no infinite retry)', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    const cache = createDefaultJwksCache();

    const result = await cache.getKey('reg-1', platform.jwksUri, 'kid-that-does-not-exist');
    expect(result).toBeNull();
  });

  it('does not refetch when the kid is already cached', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    let fetchCount = 0;
    const cache = new JwksCache({
      fetchJwks: async (jwksUri) => {
        fetchCount += 1;
        return fetch(jwksUri).then((r) => r.json());
      },
    });

    await cache.getKey('reg-1', platform.jwksUri, 'default-kid');
    await cache.getKey('reg-1', platform.jwksUri, 'default-kid');

    expect(fetchCount).toBe(1);
  });

  it('never falls back to another registration\'s cached keys', async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    const otherPlatform = new MockCanvasPlatform();
    await otherPlatform.start();
    try {
      const cache = createDefaultJwksCache();
      await cache.getKey('reg-A', platform.jwksUri, 'default-kid');
      await cache.getKey('reg-B', otherPlatform.jwksUri, 'default-kid');

      // reg-A's jwksUri never published 'kid-only-on-b', so looking it up under reg-A's
      // registration ID must fail even though 'kid-only-on-b' genuinely exists on reg-B's platform.
      await otherPlatform.publishNewKey('kid-only-on-b');
      const crossLookup = await cache.getKey('reg-A', platform.jwksUri, 'kid-only-on-b');
      expect(crossLookup).toBeNull();
    } finally {
      await otherPlatform.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/jwks-cache.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/jwks-cache.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/jwks-cache.ts
export interface JwksCacheDeps {
  fetchJwks(jwksUri: string): Promise<{ keys: Record<string, unknown>[] }>;
}

interface CacheEntry {
  keysByKid: Map<string, Record<string, unknown>>;
}

export class JwksCache {
  private cache = new Map<string, CacheEntry>();

  constructor(private deps: JwksCacheDeps) {}

  async getKey(registrationId: string, jwksUri: string, kid: string): Promise<Record<string, unknown> | null> {
    const cached = this.cache.get(registrationId);
    if (cached?.keysByKid.has(kid)) {
      return cached.keysByKid.get(kid) ?? null;
    }

    const refreshed = await this.fetchAndCache(registrationId, jwksUri);
    return refreshed.keysByKid.get(kid) ?? null;
  }

  private async fetchAndCache(registrationId: string, jwksUri: string): Promise<CacheEntry> {
    const response = await this.deps.fetchJwks(jwksUri);
    const keysByKid = new Map<string, Record<string, unknown>>();
    for (const key of response.keys) {
      if (typeof key.kid === 'string') {
        keysByKid.set(key.kid, key);
      }
    }
    const entry: CacheEntry = { keysByKid };
    this.cache.set(registrationId, entry);
    return entry;
  }
}

export function createDefaultJwksCache(): JwksCache {
  return new JwksCache({
    fetchJwks: async (jwksUri: string) => {
      const response = await fetch(jwksUri);
      if (!response.ok) {
        throw new Error(`Failed to fetch JWKS from ${jwksUri}: HTTP ${response.status}`);
      }
      return (await response.json()) as { keys: Record<string, unknown>[] };
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/jwks-cache.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/jwks-cache.ts server/tests/lti/jwks-cache.test.ts
git commit -m "feat: add per-registration Canvas JWKS cache with refetch-once-on-unknown-kid"
```

---

## Task 16: LTI claims validation (`lti/claims.ts`)

**Files:**
- Create: `server/src/lti/claims.ts`
- Test: `server/tests/lti/claims.test.ts`

Covers §45 cases **18 (wrong LTI version)**, **19 (wrong message type)**, **20 (missing context)**, **21 (missing roles)**.

**Interfaces:**
- Produces: `type ClaimsValidationFailureReason = 'wrong_version' | 'wrong_message_type' | 'missing_context' | 'missing_roles'`, `validateLtiClaims(rawClaims: unknown): { ok: true; claims: ValidatedLtiClaims } | { ok: false; reason: ClaimsValidationFailureReason }`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/claims.test.ts
import { describe, it, expect } from 'vitest';
import { validateLtiClaims } from '../../src/lti/claims.js';

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://canvas.test',
    aud: 'client-1',
    sub: 'user-1',
    exp: 9999999999,
    iat: 1000000000,
    nonce: 'nonce-value',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'deploy-1',
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'course-1' },
    'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
    ...overrides,
  };
}

describe('validateLtiClaims', () => {
  it('accepts a fully valid claim set', () => {
    const result = validateLtiClaims(validClaims());
    expect(result.ok).toBe(true);
  });

  it('§45 case 18: rejects the wrong LTI version', () => {
    const result = validateLtiClaims(validClaims({ 'https://purl.imsglobal.org/spec/lti/claim/version': '1.1.0' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_version' });
  });

  it('§45 case 19: rejects the wrong message type', () => {
    const result = validateLtiClaims(validClaims({ 'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiDeepLinkingRequest' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_message_type' });
  });

  it('§45 case 20: rejects a missing context claim', () => {
    const { 'https://purl.imsglobal.org/spec/lti/claim/context': _context, ...withoutContext } = validClaims();
    const result = validateLtiClaims(withoutContext);
    expect(result).toEqual({ ok: false, reason: 'missing_context' });
  });

  it('§45 case 21: rejects a missing roles claim', () => {
    const { 'https://purl.imsglobal.org/spec/lti/claim/roles': _roles, ...withoutRoles } = validClaims();
    const result = validateLtiClaims(withoutRoles);
    expect(result).toEqual({ ok: false, reason: 'missing_roles' });
  });

  it('rejects an empty roles array as missing_roles', () => {
    const result = validateLtiClaims(validClaims({ 'https://purl.imsglobal.org/spec/lti/claim/roles': [] }));
    expect(result).toEqual({ ok: false, reason: 'missing_roles' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/claims.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/claims.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/claims.ts
import { z } from 'zod';

const ltiClaimsSchema = z.object({
  sub: z.string().min(1),
  nonce: z.string().min(1),
  'https://purl.imsglobal.org/spec/lti/claim/version': z.literal('1.3.0'),
  'https://purl.imsglobal.org/spec/lti/claim/message_type': z.literal('LtiResourceLinkRequest'),
  'https://purl.imsglobal.org/spec/lti/claim/deployment_id': z.string().min(1),
  'https://purl.imsglobal.org/spec/lti/claim/context': z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    title: z.string().optional(),
  }),
  'https://purl.imsglobal.org/spec/lti/claim/roles': z.array(z.string()).min(1),
});

export type ValidatedLtiClaims = z.infer<typeof ltiClaimsSchema>;
export type ClaimsValidationFailureReason = 'wrong_version' | 'wrong_message_type' | 'missing_context' | 'missing_roles';
export type ClaimsValidationResult =
  | { ok: true; claims: ValidatedLtiClaims }
  | { ok: false; reason: ClaimsValidationFailureReason };

export function validateLtiClaims(rawClaims: unknown): ClaimsValidationResult {
  const parsed = ltiClaimsSchema.safeParse(rawClaims);
  if (parsed.success) {
    return { ok: true, claims: parsed.data };
  }

  // Match on the *first* path segment so a nested failure (e.g. context present but its `id`
  // missing, path ['...#context', 'id']) still classifies as that claim's failure rather than
  // falling through to the invariant throw below.
  const failsAt = (claim: string) => parsed.error.issues.some((issue) => issue.path[0] === claim);

  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/version')) return { ok: false, reason: 'wrong_version' };
  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/message_type')) return { ok: false, reason: 'wrong_message_type' };
  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/context')) return { ok: false, reason: 'missing_context' };
  if (failsAt('https://purl.imsglobal.org/spec/lti/claim/roles')) return { ok: false, reason: 'missing_roles' };

  // launch.ts only calls this after JWT signature/lifetime checks already passed, and Canvas's own
  // JWT always carries sub/nonce, so no §45 test case reaches this branch -- it's an invariant guard.
  throw new Error(`Unexpected LTI claims validation failure: ${parsed.error.message}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/claims.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/claims.ts server/tests/lti/claims.test.ts
git commit -m "feat: add LTI claims validation (version/message_type/context/roles)"
```

---

## Task 17: Role authorization (`lti/roles.ts`)

**Files:**
- Create: `server/src/lti/roles.ts`
- Test: `server/tests/lti/roles.test.ts`

Covers §45 case **22 (learner-only role)** at the unit level (route-level 403 assertion comes in Task 22).

**Interfaces:**
- Produces: `AUTHORIZED_INSTRUCTOR_ROLE_URIS: Set<string>`, `authorizeInstructorRole(roles: string[]): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/roles.test.ts
import { describe, it, expect } from 'vitest';
import { authorizeInstructorRole } from '../../src/lti/roles.js';

describe('authorizeInstructorRole', () => {
  it('authorizes the standard 1EdTech Instructor context-role URI', () => {
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'])).toBe(true);
  });

  it('authorizes the standard 1EdTech Administrator context-role URI', () => {
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator'])).toBe(true);
  });

  it('§45 case 22: rejects a learner-only role set', () => {
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'])).toBe(false);
  });

  it('rejects an empty role list', () => {
    expect(authorizeInstructorRole([])).toBe(false);
  });

  it('never authorizes via substring match -- a role that merely contains "Instructor" is rejected', () => {
    expect(authorizeInstructorRole(['NotAnInstructorRoleAtAllXYZ'])).toBe(false);
    expect(authorizeInstructorRole(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor-fake'])).toBe(false);
  });

  it('authorizes when at least one role in a mixed list matches', () => {
    expect(
      authorizeInstructorRole([
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
      ]),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/roles.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/roles.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/roles.ts
// Standard 1EdTech LTI context-role and institution-role URIs recognized as instructor/administrator.
// This set was written from the published 1EdTech role vocabulary, NOT from an observed Canvas
// launch, so it is the highest-risk assumption in this phase: if Canvas emits a role URI outside
// this set for a real instructor, every legitimate launch 403s, and if it emits one of these for a
// non-teacher, an unauthorized user gets in. It MUST therefore be verified against a real Canvas
// launch payload during the Phase 7 post-deployment Canvas verification in
// docs/canvas-installation.md (step 5) before this is trusted as load-bearing security logic.
export const AUTHORIZED_INSTRUCTOR_ROLE_URIS = new Set<string>([
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/role#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/role#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/system/role#Administrator',
]);

export function authorizeInstructorRole(roles: string[]): boolean {
  return roles.some((role) => AUTHORIZED_INSTRUCTOR_ROLE_URIS.has(role));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/roles.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/roles.ts server/tests/lti/roles.test.ts
git commit -m "feat: add exact-URI instructor role authorization (never substring match)"
```

---

## Task 18: Application sessions + cookie options (`auth/session.ts`, `auth/cookies.ts`)

**Files:**
- Create: `server/src/auth/cookies.ts`, `server/src/auth/session.ts`
- Test: `server/tests/auth/session.test.ts`

**Interfaces:**
- Produces (`cookies.ts`): `SESSION_COOKIE_NAME = 'attendance_session'`, `buildSessionCookieOptions(appBaseUrl: string, ttlHours: number): { httpOnly: true; secure: boolean; sameSite: 'lax'; path: '/'; maxAge: number }`.
- Produces (`session.ts`): `interface AppSession { id, institutionId, deploymentId, ltiSubject, displayName: string | null, courseId, roles: string[], csrfSecret }`; `createSession(db, params: CreateSessionParams): Promise<{ token: string; csrfSecret: string; sessionId: string }>`; `findValidSession(db, token: string): Promise<AppSession | null>`; `revokeSession(db, sessionId: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/auth/session.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import { createSession, findValidSession, revokeSession } from '../../src/auth/session.js';
import { buildSessionCookieOptions } from '../../src/auth/cookies.js';

async function seedCourseId(): Promise<{ institutionId: string; deploymentRowId: string; courseId: string }> {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'session-test', displayName: 'Session Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://session.test',
      clientId: 'session-client',
      oidcAuthEndpoint: 'https://session.test/a',
      tokenEndpoint: 'https://session.test/t',
      tokenAudience: 'https://session.test/t',
      platformJwksUri: 'https://session.test/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'session-deploy', enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'session-course', label: 'S101' })
    .returning();
  return { institutionId: institution.id, deploymentRowId: deployment.id, courseId: course.id };
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once, after every
// describe in this file has finished (see the same note in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('createSession / findValidSession / revokeSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a session, stores only its hash, and finds it back by the raw token', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedCourseId();

    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: 'Jane Instructor',
      courseId,
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      ttlHours: 8,
    });

    expect(Buffer.from(created.token, 'base64url').length).toBeGreaterThanOrEqual(32);

    const found = await findValidSession(db, created.token);
    expect(found).not.toBeNull();
    expect(found?.ltiSubject).toBe('user-1');
    expect(found?.displayName).toBe('Jane Instructor');
    expect(found?.roles).toEqual(['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor']);
    expect(found?.csrfSecret).toBe(created.csrfSecret);
  });

  it('never returns a session for a token that was never issued', async () => {
    const { db } = getTestDb();
    const found = await findValidSession(db, 'not-a-real-token');
    expect(found).toBeNull();
  });

  it('returns null after a session is revoked', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedCourseId();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-2',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });

    await revokeSession(db, created.sessionId);

    expect(await findValidSession(db, created.token)).toBeNull();
  });

  it('returns null for an already-expired session', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedCourseId();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-3',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: -1, // already expired
    });

    expect(await findValidSession(db, created.token)).toBeNull();
  });
});

describe('buildSessionCookieOptions', () => {
  it('sets secure:true for an https APP_BASE_URL', () => {
    const options = buildSessionCookieOptions('https://app.test', 8);
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 8 * 60 * 60 });
  });

  it('sets secure:false for an http APP_BASE_URL (local dev)', () => {
    const options = buildSessionCookieOptions('http://localhost:3000', 8);
    expect(options.secure).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auth/session.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/session.js'"

- [ ] **Step 3: Write `auth/cookies.ts`**

```ts
// server/src/auth/cookies.ts
export const SESSION_COOKIE_NAME = 'attendance_session';

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export function buildSessionCookieOptions(appBaseUrl: string, ttlHours: number): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: appBaseUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: ttlHours * 60 * 60,
  };
}
```

- [ ] **Step 4: Write `auth/session.ts`**

```ts
// server/src/auth/session.ts
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { appSessions } from '../database/schema.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionParams {
  institutionId: string;
  deploymentId: string;
  ltiSubject: string;
  displayName: string | null;
  courseId: string;
  roles: string[];
  ttlHours: number;
}

export interface CreatedSession {
  token: string;
  csrfSecret: string;
  sessionId: string;
}

export async function createSession(db: Database, params: CreateSessionParams): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfSecret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + params.ttlHours * 60 * 60 * 1000);

  const [row] = await db
    .insert(appSessions)
    .values({
      sessionTokenHash: hashToken(token),
      institutionId: params.institutionId,
      deploymentId: params.deploymentId,
      ltiSubject: params.ltiSubject,
      displayName: params.displayName,
      courseId: params.courseId,
      roles: params.roles,
      csrfSecret,
      expiresAt,
    })
    .returning();

  return { token, csrfSecret, sessionId: row.id };
}

export interface AppSession {
  id: string;
  institutionId: string;
  deploymentId: string;
  ltiSubject: string;
  displayName: string | null;
  courseId: string;
  roles: string[];
  csrfSecret: string;
}

export async function findValidSession(db: Database, token: string): Promise<AppSession | null> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.sessionTokenHash, tokenHash), isNull(appSessions.revokedAt), gt(appSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  await db.update(appSessions).set({ lastSeenAt: new Date() }).where(eq(appSessions.id, row.id));

  return {
    id: row.id,
    institutionId: row.institutionId,
    deploymentId: row.deploymentId,
    ltiSubject: row.ltiSubject,
    displayName: row.displayName,
    courseId: row.courseId,
    roles: row.roles as string[],
    csrfSecret: row.csrfSecret,
  };
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(appSessions).set({ revokedAt: new Date() }).where(eq(appSessions.id, sessionId));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/auth/session.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/cookies.ts server/src/auth/session.ts server/tests/auth/session.test.ts
git commit -m "feat: add opaque server-side application sessions with hashed tokens"
```

---

## Task 19: Launch orchestration, part 1 — transaction resolution (`lti/launch.ts`)

This is the first of five tasks building `lti/launch.ts`. Each task adds a new, independently-tested exported function; Task 23 assembles all of them into the final `verifyLaunch()` orchestrator. All five tasks share one growing test file, `server/tests/lti/launch.test.ts`.

**Files:**
- Create: `server/src/lti/launch.ts`
- Test: `server/tests/lti/launch.test.ts`

Covers §45 cases **3 (unknown_state)**, **4 (expired_state)**, **5 (reused_state)**, and part of **17 (wrong_deployment, via a disabled deployment)** at the transaction-resolution level.

**Interfaces:**
- Consumes: `consumeOidcTransaction` (Task 12), `findRegistrationById`/`findDeploymentByBusinessId` (Task 9), `LtiRegistration`/`LtiDeployment` (Task 9).
- Produces: `type LaunchFailureReason` (the full 21-value union used by every remaining task in this plan), `interface TransactionContext { transaction: ConsumedTransaction; registration: LtiRegistration; deployment: LtiDeployment }`, `resolveTransactionContext(db: Database, state: string): Promise<{ ok: true; context: TransactionContext } | { ok: false; reason: LaunchFailureReason }>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/lti/launch.test.ts
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { ltiDeployments } from '../../src/database/schema.js';
import { resolveTransactionContext } from '../../src/lti/launch.js';

// File scope, NOT inside a describe: Tasks 20-23 append four more describes to this same file, and
// db.ts's pg pool is module-level and shared by all of them. Closing it from inside the first
// describe would leave the pool the later describes re-create open (Vitest then warns about a
// hanging process). Do not move this into a describe when appending the later blocks.
afterAll(async () => {
  await closeTestDb();
});

describe('resolveTransactionContext', () => {
  let platform: MockCanvasPlatform;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterEach(async () => {
    await platform.stop();
  });

  it('§45 case 3: propagates unknown_state', async () => {
    const { db } = getTestDb();
    expect(await resolveTransactionContext(db, 'never-issued')).toEqual({ ok: false, reason: 'unknown_state' });
  });

  it('§45 case 4: propagates expired_state', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: -1,
    });
    expect(await resolveTransactionContext(db, created.state)).toEqual({ ok: false, reason: 'expired_state' });
  });

  it('§45 case 5: propagates reused_state on a second call for the same state', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    expect((await resolveTransactionContext(db, created.state)).ok).toBe(true);
    expect(await resolveTransactionContext(db, created.state)).toEqual({ ok: false, reason: 'reused_state' });
  });

  it('resolves the registration and deployment for a valid, unconsumed transaction', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    const result = await resolveTransactionContext(db, created.state);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.registration.clientId).toBe(seeded.clientId);
      expect(result.context.deployment.deploymentId).toBe(seeded.deploymentId);
    }
  });

  it('§45 case 17 (deployment-disabled variant): rejects when the deployment was disabled after the transaction was created', async () => {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    await db.update(ltiDeployments).set({ enabled: false }).where(eq(ltiDeployments.deploymentId, seeded.deploymentId));

    expect(await resolveTransactionContext(db, created.state)).toEqual({ ok: false, reason: 'wrong_deployment' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: FAIL with "Cannot find module '../../src/lti/launch.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lti/launch.ts
import type { Database } from '../database/client.js';
import { consumeOidcTransaction, type ConsumedTransaction } from './oidc-transactions.js';
import { findRegistrationById, findDeploymentByBusinessId } from './registrations.js';
import type { LtiRegistration, LtiDeployment } from './types.js';

export type LaunchFailureReason =
  | 'missing_state'
  | 'unknown_state'
  | 'expired_state'
  | 'reused_state'
  | 'nonce_mismatch'
  | 'nonce_replay'
  | 'unknown_issuer'
  | 'audience_mismatch'
  | 'invalid_azp'
  | 'invalid_signature'
  | 'unknown_kid'
  | 'unsupported_algorithm'
  | 'expired_token'
  | 'future_issued_token'
  | 'wrong_deployment'
  | 'wrong_version'
  | 'wrong_message_type'
  | 'missing_context'
  | 'missing_roles'
  | 'learner_only_role'
  | 'tampered_token';
// NOTE on 'nonce_replay' (§45 case 7): nonce and state are minted and consumed together as a
// single OIDC transaction row (spec §12.2 and §13.7), so nonce single-use is enforced by the exact
// same atomic UPDATE that enforces state single-use. That makes case 7 split into two concrete
// attacks, and neither of them can ever produce a distinct 'nonce_replay' reason:
//   (a) replaying a captured (state, id_token) PAIR -- caught as 'reused_state' in
//       resolveTransactionContext, before the nonce is even re-compared;
//   (b) pairing an OLD captured nonce with a FRESH state (the genuinely distinct threat) --
//       the fresh transaction row has a different nonce_hash, so validateNonceClaimsAndRole
//       rejects it as 'nonce_mismatch'.
// Task 23 has a test for each. This literal is kept in the union purely so a reader grepping for
// spec §45 case 7 lands on this explanation; no code path returns it, and no test expects it.

export interface TransactionContext {
  transaction: ConsumedTransaction;
  registration: LtiRegistration;
  deployment: LtiDeployment;
}

export type ResolveTransactionResult =
  | { ok: true; context: TransactionContext }
  | { ok: false; reason: LaunchFailureReason };

export async function resolveTransactionContext(db: Database, state: string): Promise<ResolveTransactionResult> {
  const consumed = await consumeOidcTransaction(db, state);
  if (!consumed.ok) {
    return { ok: false, reason: consumed.reason };
  }

  const registration = await findRegistrationById(db, consumed.transaction.registrationId);
  if (!registration || !registration.enabled) {
    return { ok: false, reason: 'unknown_issuer' };
  }

  const deployment = await findDeploymentByBusinessId(db, registration.id, consumed.transaction.deploymentId);
  if (!deployment || !deployment.enabled) {
    return { ok: false, reason: 'wrong_deployment' };
  }

  return { ok: true, context: { transaction: consumed.transaction, registration, deployment } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/launch.ts server/tests/lti/launch.test.ts
git commit -m "feat: add launch OIDC transaction resolution (launch.ts part 1/5)"
```

---

## Task 20: Launch orchestration, part 2 — JWT signature verification (`lti/launch.ts`)

**Files:**
- Modify: `server/src/lti/launch.ts`
- Test: `server/tests/lti/launch.test.ts`

Covers §45 cases **11 (invalid signature)**, **13 (unknown `kid` after refresh, still fails, at the launch level)**, **14 (expired JWT)**, **16 (unsupported signing algorithm)**, **23 (tampered JWT)**.

**Interfaces:**
- Consumes: `JwksCache` (Task 15).
- Produces (added to `launch.ts`): `verifyJwtSignature(idToken: string, registration: LtiRegistration, jwksCache: JwksCache, clockSkewSeconds: number): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: LaunchFailureReason }>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/tests/lti/launch.test.ts
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { verifyJwtSignature } from '../../src/lti/launch.js';
import type { LtiRegistration } from '../../src/lti/types.js';

function registrationFor(platform: MockCanvasPlatform, clientId = 'mock-client-id'): LtiRegistration {
  return {
    id: 'reg-1',
    institutionId: 'inst-1',
    issuer: platform.issuer,
    clientId,
    oidcAuthEndpoint: 'https://mock-canvas.test/authorize',
    tokenEndpoint: 'https://mock-canvas.test/token',
    tokenAudience: 'https://mock-canvas.test/token',
    platformJwksUri: platform.jwksUri,
    enabled: true,
  };
}

/** Rewrites only the `kid` field of a signed token's header, leaving payload/signature untouched. */
function withHeaderKid(token: string, kid: string): string {
  const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
  const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8')) as Record<string, unknown>;
  const newHeaderSegment = Buffer.from(JSON.stringify({ ...header, kid })).toString('base64url');
  return `${newHeaderSegment}.${payloadSegment}.${signatureSegment}`;
}

describe('verifyJwtSignature', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;

  beforeEach(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });
  afterEach(async () => {
    await platform.stop();
  });

  it('accepts a validly signed RS256 token', async () => {
    const token = await platform.mintIdToken();
    const result = await verifyJwtSignature(token, registrationFor(platform), jwksCache, 120);
    expect(result.ok).toBe(true);
  });

  it('§45 case 11: rejects a token signed by a key not in the platform JWKS (invalid signature)', async () => {
    const impostor = new MockCanvasPlatform();
    await impostor.start();
    try {
      const foreignToken = await impostor.mintIdToken({ iss: platform.issuer });
      const result = await verifyJwtSignature(foreignToken, registrationFor(platform), jwksCache, 120);
      expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
    } finally {
      await impostor.stop();
    }
  });

  it('§45 case 13: rejects a kid that was never published, after one refetch attempt', async () => {
    // Sign with the real, published 'default-kid', then rewrite only the header's `kid` field to
    // a value the platform never published. verifyJwtSignature looks up the kid *before* ever
    // calling jwtVerify, so this deterministically exercises the "still missing after refetch"
    // path without needing a signature that would otherwise fail for an unrelated reason.
    const token = await platform.mintIdToken();
    const tokenWithUnknownKid = withHeaderKid(token, 'never-published');

    const result = await verifyJwtSignature(tokenWithUnknownKid, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'unknown_kid' });
  });

  it('§45 case 14: rejects an expired JWT beyond the clock-skew allowance', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await platform.mintIdToken({ iat: now - 10000, exp: now - 9000 });
    const result = await verifyJwtSignature(token, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'expired_token' });
  });

  it('§45 case 16: rejects a token signed with an algorithm other than RS256', async () => {
    const token = await platform.mintIdToken({}, { alg: 'RS384' });
    const result = await verifyJwtSignature(token, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'unsupported_algorithm' });
  });

  it('§45 case 23: rejects a structurally tampered JWT (header segment is not valid JSON)', async () => {
    const token = await platform.mintIdToken();
    const [, payload, signature] = token.split('.');
    // A deterministic corruption: this base64url segment decodes to the literal text
    // "not valid json", which JSON.parse cannot parse -- decodeProtectedHeader throws reliably,
    // unlike a single-character flip (which can occasionally still decode as valid, different JSON).
    const tamperedHeader = Buffer.from('not valid json').toString('base64url');
    const tamperedToken = `${tamperedHeader}.${payload}.${signature}`;

    const result = await verifyJwtSignature(tamperedToken, registrationFor(platform), jwksCache, 120);
    expect(result).toEqual({ ok: false, reason: 'tampered_token' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: FAIL with "verifyJwtSignature is not a function" (existing `resolveTransactionContext` tests still pass)

- [ ] **Step 3: Add to `lti/launch.ts`**

Add these imports to the top of the file:

```ts
import { decodeProtectedHeader, jwtVerify, importJWK, type JWTPayload } from 'jose';
import type { JwksCache } from './jwks-cache.js';
```

Append this function to `server/src/lti/launch.ts`:

```ts
export type VerifyJwtSignatureResult = { ok: true; payload: JWTPayload } | { ok: false; reason: LaunchFailureReason };

export async function verifyJwtSignature(
  idToken: string,
  registration: LtiRegistration,
  jwksCache: JwksCache,
  clockSkewSeconds: number,
): Promise<VerifyJwtSignatureResult> {
  let header;
  try {
    header = decodeProtectedHeader(idToken);
  } catch {
    return { ok: false, reason: 'tampered_token' };
  }

  if (header.alg !== 'RS256') {
    return { ok: false, reason: 'unsupported_algorithm' };
  }
  if (!header.kid) {
    return { ok: false, reason: 'unknown_kid' };
  }

  const jwk = await jwksCache.getKey(registration.id, registration.platformJwksUri, header.kid);
  if (!jwk) {
    return { ok: false, reason: 'unknown_kid' };
  }

  let publicKey;
  try {
    publicKey = await importJWK(jwk, 'RS256');
  } catch {
    return { ok: false, reason: 'unknown_kid' };
  }

  try {
    const verified = await jwtVerify(idToken, publicKey, {
      algorithms: ['RS256'],
      clockTolerance: clockSkewSeconds,
    });
    return { ok: true, payload: verified.payload };
  } catch (err) {
    const code = (err as { code?: string; claim?: string })?.code;
    if (code === 'ERR_JWT_EXPIRED') {
      return { ok: false, reason: 'expired_token' };
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && (err as { claim?: string }).claim === 'nbf') {
      return { ok: false, reason: 'future_issued_token' };
    }
    return { ok: false, reason: 'invalid_signature' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: PASS (11 tests total: 5 from Task 19 + 6 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/launch.ts server/tests/lti/launch.test.ts
git commit -m "feat: add launch JWT signature/algorithm/kid/lifetime verification (launch.ts part 2/5)"
```

---

## Task 21: Launch orchestration, part 3 — issuer/audience/azp/lifetime (`lti/launch.ts`)

**Files:**
- Modify: `server/src/lti/launch.ts`
- Test: `server/tests/lti/launch.test.ts`

Covers §45 cases **8 (unknown issuer)**, **9 (wrong client ID/audience)**, **10 (invalid `azp`)**, **15 (future-issued JWT via `iat`)**.

**Interfaces:**
- Produces (added to `launch.ts`): `validateAudienceAndLifetime(payload: JWTPayload, registration: LtiRegistration, clockSkewSeconds: number): { ok: true } | { ok: false; reason: LaunchFailureReason }`.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/tests/lti/launch.test.ts
import { validateAudienceAndLifetime } from '../../src/lti/launch.js';

describe('validateAudienceAndLifetime', () => {
  const registration = {
    id: 'reg-1',
    institutionId: 'inst-1',
    issuer: 'https://canvas.test',
    clientId: 'client-1',
    oidcAuthEndpoint: 'https://canvas.test/authorize',
    tokenEndpoint: 'https://canvas.test/token',
    tokenAudience: 'https://canvas.test/token',
    platformJwksUri: 'https://canvas.test/jwks',
    enabled: true,
  };

  function payload(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: 'https://canvas.test', aud: 'client-1', iat: now, exp: now + 3600, ...overrides };
  }

  it('accepts a payload whose iss/aud/iat all match', () => {
    expect(validateAudienceAndLifetime(payload(), registration, 120)).toEqual({ ok: true });
  });

  it('§45 case 8: rejects a mismatched issuer', () => {
    const result = validateAudienceAndLifetime(payload({ iss: 'https://evil.test' }), registration, 120);
    expect(result).toEqual({ ok: false, reason: 'unknown_issuer' });
  });

  it('§45 case 9: rejects when aud does not contain this registration\'s client_id', () => {
    const result = validateAudienceAndLifetime(payload({ aud: 'someone-elses-client' }), registration, 120);
    expect(result).toEqual({ ok: false, reason: 'audience_mismatch' });
  });

  it('§45 case 10: rejects a multi-value aud with a missing/wrong azp', () => {
    const missingAzp = validateAudienceAndLifetime(payload({ aud: ['client-1', 'another-client'] }), registration, 120);
    expect(missingAzp).toEqual({ ok: false, reason: 'invalid_azp' });

    const wrongAzp = validateAudienceAndLifetime(
      payload({ aud: ['client-1', 'another-client'], azp: 'another-client' }),
      registration,
      120,
    );
    expect(wrongAzp).toEqual({ ok: false, reason: 'invalid_azp' });
  });

  it('accepts a multi-value aud when azp correctly identifies this client', () => {
    const result = validateAudienceAndLifetime(
      payload({ aud: ['client-1', 'another-client'], azp: 'client-1' }),
      registration,
      120,
    );
    expect(result).toEqual({ ok: true });
  });

  it('§45 case 15: rejects a JWT whose iat is implausibly far in the future', () => {
    const now = Math.floor(Date.now() / 1000);
    const result = validateAudienceAndLifetime(payload({ iat: now + 10000 }), registration, 120);
    expect(result).toEqual({ ok: false, reason: 'future_issued_token' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: FAIL with "validateAudienceAndLifetime is not a function" (previous 11 tests still pass)

- [ ] **Step 3: Append to `lti/launch.ts`**

```ts
export type ValidateAudienceResult = { ok: true } | { ok: false; reason: LaunchFailureReason };

export function validateAudienceAndLifetime(
  payload: JWTPayload,
  registration: LtiRegistration,
  clockSkewSeconds: number,
): ValidateAudienceResult {
  if (payload.iss !== registration.issuer) {
    return { ok: false, reason: 'unknown_issuer' };
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(registration.clientId)) {
    return { ok: false, reason: 'audience_mismatch' };
  }
  if (audiences.length > 1 && (typeof payload.azp !== 'string' || payload.azp !== registration.clientId)) {
    return { ok: false, reason: 'invalid_azp' };
  }

  // verifyJwtSignature's jwtVerify call already rejected exp/nbf outside clockSkewSeconds; iat is
  // not validated by jose at all, so an implausibly-future-issued token is only caught here.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat - clockSkewSeconds > now) {
    return { ok: false, reason: 'future_issued_token' };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: PASS (17 tests total: 11 previous + 6 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/launch.ts server/tests/lti/launch.test.ts
git commit -m "feat: add launch issuer/audience/azp/iat validation (launch.ts part 3/5)"
```

---

## Task 22: Launch orchestration, part 4 — nonce/claims/deployment-claim/role (`lti/launch.ts`)

**Files:**
- Modify: `server/src/lti/launch.ts`
- Test: `server/tests/lti/launch.test.ts`

Covers §45 cases **6 (nonce mismatch)**, the claim-level variant of **17 (wrong deployment)**, **20 (missing context, confirming propagation from Task 16's `claims.ts`)**, **22 (learner-only role, unit wiring)**. (§45 cases 18/19/21 are already fully covered at the `claims.ts` unit level in Task 16 and propagate through this same `validateLtiClaims` call — case 20 is re-asserted here as the one representative integration check.)

**Interfaces:**
- Consumes: `validateLtiClaims` (Task 16), `authorizeInstructorRole` (Task 17), `ConsumedTransaction` (Task 12).
- Produces (added to `launch.ts`): `interface NonceClaimsRoleResult { claims: ValidatedLtiClaims; roles: string[] }`, `validateNonceClaimsAndRole(payload: JWTPayload, transaction: ConsumedTransaction): { ok: true; result: NonceClaimsRoleResult } | { ok: false; reason: LaunchFailureReason }`.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/tests/lti/launch.test.ts
import { createHash } from 'node:crypto';
import { validateNonceClaimsAndRole } from '../../src/lti/launch.js';
import type { ConsumedTransaction } from '../../src/lti/oidc-transactions.js';

function hashForTest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function transactionFor(nonce: string, deploymentId = 'deploy-1'): ConsumedTransaction {
  return {
    id: 'txn-1',
    registrationId: 'reg-1',
    deploymentId,
    nonceHash: hashForTest(nonce),
    targetLinkUri: 'https://app.test/index.html',
  };
}

function claimsPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-1',
    nonce: 'real-nonce',
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': 'LtiResourceLinkRequest',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'deploy-1',
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: 'course-1' },
    'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
    ...overrides,
  };
}

describe('validateNonceClaimsAndRole', () => {
  it('accepts a matching nonce with valid claims and an instructor role', () => {
    const result = validateNonceClaimsAndRole(claimsPayload(), transactionFor('real-nonce'));
    expect(result.ok).toBe(true);
  });

  it("§45 case 6: rejects a nonce that does not match the transaction's stored nonce", () => {
    const result = validateNonceClaimsAndRole(claimsPayload({ nonce: 'wrong-nonce' }), transactionFor('real-nonce'));
    expect(result).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it("§45 case 17 (claim-level variant): rejects when the claimed deployment_id doesn't match the transaction's", () => {
    const result = validateNonceClaimsAndRole(
      claimsPayload({ 'https://purl.imsglobal.org/spec/lti/claim/deployment_id': 'other-deploy' }),
      transactionFor('real-nonce', 'deploy-1'),
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_deployment' });
  });

  it('§45 case 20: propagates missing_context from claims validation', () => {
    const { 'https://purl.imsglobal.org/spec/lti/claim/context': _context, ...withoutContext } = claimsPayload();
    const result = validateNonceClaimsAndRole(withoutContext, transactionFor('real-nonce'));
    expect(result).toEqual({ ok: false, reason: 'missing_context' });
  });

  it('§45 case 22: rejects a learner-only role', () => {
    const result = validateNonceClaimsAndRole(
      claimsPayload({
        'https://purl.imsglobal.org/spec/lti/claim/roles': ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
      }),
      transactionFor('real-nonce'),
    );
    expect(result).toEqual({ ok: false, reason: 'learner_only_role' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: FAIL with "validateNonceClaimsAndRole is not a function" (previous 17 tests still pass)

- [ ] **Step 3: Append to `lti/launch.ts`**

Add these imports to the top of the file:

```ts
import { createHash } from 'node:crypto';
import { validateLtiClaims, type ValidatedLtiClaims } from './claims.js';
import { authorizeInstructorRole } from './roles.js';
```

Append this to `server/src/lti/launch.ts`:

```ts
function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface NonceClaimsRoleResult {
  claims: ValidatedLtiClaims;
  roles: string[];
}

export type ValidateNonceClaimsAndRoleResult =
  | { ok: true; result: NonceClaimsRoleResult }
  | { ok: false; reason: LaunchFailureReason };

export function validateNonceClaimsAndRole(
  payload: JWTPayload,
  transaction: ConsumedTransaction,
): ValidateNonceClaimsAndRoleResult {
  if (typeof payload.nonce !== 'string' || hashToken(payload.nonce) !== transaction.nonceHash) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  const claimsResult = validateLtiClaims(payload);
  if (!claimsResult.ok) {
    return { ok: false, reason: claimsResult.reason };
  }
  const claims = claimsResult.claims;

  if (claims['https://purl.imsglobal.org/spec/lti/claim/deployment_id'] !== transaction.deploymentId) {
    return { ok: false, reason: 'wrong_deployment' };
  }

  const roles = claims['https://purl.imsglobal.org/spec/lti/claim/roles'];
  if (!authorizeInstructorRole(roles)) {
    return { ok: false, reason: 'learner_only_role' };
  }

  return { ok: true, result: { claims, roles } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: PASS (22 tests total: 17 previous + 5 new)

- [ ] **Step 5: Commit**

```bash
git add server/src/lti/launch.ts server/tests/lti/launch.test.ts
git commit -m "feat: add launch nonce/claims/deployment-claim/role validation (launch.ts part 4/5)"
```

---

## Task 23: Launch orchestration, part 5 — `verifyLaunch()` assembly + success path (`lti/launch.ts`)

**Files:**
- Modify: `server/src/lti/launch.ts`
- Test: `server/tests/lti/launch.test.ts`

Covers §45 case **1 (valid launch)**, case **2 (missing state)**, case **7 (nonce replay — both the full-(state, id_token)-pair replay and the distinct fresh-state/stale-nonce variant)**, plus a closing sweep that drives **every remaining §45 failure case reachable through `verifyLaunch`** end-to-end and asserts zero `app_sessions` rows for each.

Between this task's dedicated tests and its sweep, all 21 launch-time §45 failure cases (3, 4, 5, 6, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, plus 2 and 7) carry the "no session created" assertion required by the Global Constraints. Case 1 and case 12 are success cases; case 24 is login-time and is asserted in Task 14.

**Interfaces:**
- Consumes: `resolveTransactionContext` (Task 19), `verifyJwtSignature` (Task 20), `validateAudienceAndLifetime` (Task 21), `validateNonceClaimsAndRole` (Task 22), `findOrCreateCourse` (Task 9), `createSession`/`CreatedSession` (Task 18).
- Produces: `interface VerifyLaunchInput { state: string | undefined; idToken: string | undefined }`, `interface VerifyLaunchDeps { db: Database; jwksCache: JwksCache; clockSkewSeconds: number; sessionTtlHours: number }`, `type VerifyLaunchResult = { ok: true; session: CreatedSession; courseId: string; roles: string[]; targetLinkUri: string } | { ok: false; reason: LaunchFailureReason }`, `verifyLaunch(input: VerifyLaunchInput, deps: VerifyLaunchDeps): Promise<VerifyLaunchResult>` — **this is the function Task 24's route wiring calls.**
- `targetLinkUri` is the value the matching OIDC transaction stored at login time (spec §12.1/§14). Task 24's route redirects to it, which is why it has to survive out of this function rather than being dropped after `consumeOidcTransaction` returns it.

- [ ] **Step 1: Write the failing test**

```ts
// append to server/tests/lti/launch.test.ts
// New imports needed for this block (everything else -- eq, ltiDeployments, getTestDb, resetDb,
// seedInstitutionAndRegistration, MockCanvasPlatform, createOidcTransaction, JwksCache --
// reuses imports already added in Tasks 19-22):
import { appSessions } from '../../src/database/schema.js';
import { consumeOidcTransaction } from '../../src/lti/oidc-transactions.js';
import {
  verifyLaunch,
  type VerifyLaunchDeps,
  type VerifyLaunchInput,
  type LaunchFailureReason,
} from '../../src/lti/launch.js';

describe('verifyLaunch (full orchestration)', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });
  afterEach(async () => {
    await platform.stop();
  });

  async function countSessions(): Promise<number> {
    const { db } = getTestDb();
    return (await db.select().from(appSessions)).length;
  }

  async function setUpValidTransaction(targetLinkUri = 'https://app.test/index.html') {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    const created = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri,
      ttlSeconds: 300,
    });
    return { seeded, created };
  }

  function deps(): VerifyLaunchDeps {
    return { db: getTestDb().db, jwksCache, clockSkewSeconds: 120, sessionTtlHours: 8 };
  }

  it('§45 case 1: a fully valid launch succeeds and creates exactly one session', async () => {
    const { created } = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });

    const result = await verifyLaunch({ state: created.state, idToken }, deps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.roles).toContain('http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor');
      expect(result.courseId).toBeTruthy();
      // The transaction's stored target_link_uri survives out of verifyLaunch so Task 24's route
      // can redirect to it instead of hardcoding one page (spec §12.1/§14).
      expect(result.targetLinkUri).toBe('https://app.test/index.html');
    }
    expect(await countSessions()).toBe(1);
  });

  it('returns the transaction\'s own target_link_uri, not a hardcoded default', async () => {
    const { created } = await setUpValidTransaction('https://app.test/scanner.html');
    const idToken = await platform.mintIdToken({ nonce: created.nonce });

    const result = await verifyLaunch({ state: created.state, idToken }, deps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targetLinkUri).toBe('https://app.test/scanner.html');
    }
  });

  it('§45 case 2: rejects a request missing state or id_token, creating no session', async () => {
    expect(await verifyLaunch({ state: undefined, idToken: 'anything' }, deps())).toEqual({ ok: false, reason: 'missing_state' });
    expect(await verifyLaunch({ state: 'anything', idToken: undefined }, deps())).toEqual({ ok: false, reason: 'missing_state' });
    expect(await countSessions()).toBe(0);
  });

  it('§45 case 7 (pair replay): a full replay of a captured (state, id_token) pair is rejected on the second attempt, creating no second session', async () => {
    const { created } = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });

    const first = await verifyLaunch({ state: created.state, idToken }, deps());
    expect(first.ok).toBe(true);

    const second = await verifyLaunch({ state: created.state, idToken }, deps());
    expect(second).toEqual({ ok: false, reason: 'reused_state' });
    expect(await countSessions()).toBe(1); // still just the one session from the first (legitimate) attempt
  });

  it('§45 case 7 (stale nonce on a fresh state): an old captured nonce paired with a brand-new state is rejected, creating no session', async () => {
    const { db } = getTestDb();
    // This is the variant a pair-replay test cannot reach: the attacker starts a *legitimate* new
    // login (so `state` is fresh and unconsumed) but presents an id_token minted for an earlier
    // transaction's nonce. state single-use does not catch it; the nonce comparison must.
    const { seeded, created: stale } = await setUpValidTransaction();
    const staleNonceToken = await platform.mintIdToken({ nonce: stale.nonce });

    const fresh = await createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri: 'https://app.test/index.html',
      ttlSeconds: 300,
    });

    const result = await verifyLaunch({ state: fresh.state, idToken: staleNonceToken }, deps());

    expect(result).toEqual({ ok: false, reason: 'nonce_mismatch' });
    expect(await countSessions()).toBe(0);
  });

  it('every §45 failure case reachable through verifyLaunch rejects end-to-end with the documented reason and creates no session', async () => {
    // A second platform with its own key material, used only by the invalid_signature scenario.
    const impostor = new MockCanvasPlatform();
    await impostor.start();

    try {
      const scenarios: Array<{
        name: string;
        expectedReason: LaunchFailureReason;
        build: () => Promise<VerifyLaunchInput>;
      }> = [
        {
          name: 'case 3: unknown_state',
          expectedReason: 'unknown_state',
          build: async () => ({ state: 'never-issued-state-value', idToken: await platform.mintIdToken() }),
        },
        {
          name: 'case 4: expired_state',
          expectedReason: 'expired_state',
          build: async () => {
            const { db } = getTestDb();
            const seeded = await seedInstitutionAndRegistration(db, platform);
            const created = await createOidcTransaction(db, {
              registrationId: seeded.registrationId,
              deploymentId: seeded.deploymentId,
              targetLinkUri: 'https://app.test/index.html',
              ttlSeconds: -1,
            });
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce }) };
          },
        },
        {
          name: 'case 5: reused_state',
          expectedReason: 'reused_state',
          build: async () => {
            const { db } = getTestDb();
            const { created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            await consumeOidcTransaction(db, created.state); // burn it outside verifyLaunch
            return { state: created.state, idToken };
          },
        },
        {
          name: 'case 6: nonce_mismatch',
          expectedReason: 'nonce_mismatch',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: 'not-the-issued-nonce' }) };
          },
        },
        {
          name: 'case 8: unknown_issuer',
          expectedReason: 'unknown_issuer',
          build: async () => {
            const { created } = await setUpValidTransaction();
            // Signed by the registration's real platform key, so the signature check passes and the
            // iss comparison is genuinely what rejects it.
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, iss: 'https://evil.test' }) };
          },
        },
        {
          name: 'case 9: audience_mismatch',
          expectedReason: 'audience_mismatch',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, aud: 'someone-else' }) };
          },
        },
        {
          name: 'case 10: invalid_azp',
          expectedReason: 'invalid_azp',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, aud: ['mock-client-id', 'another-client'] }),
            };
          },
        },
        {
          name: 'case 11: invalid_signature',
          expectedReason: 'invalid_signature',
          build: async () => {
            const { created } = await setUpValidTransaction();
            // The impostor publishes its own 'default-kid', so the kid resolves against the real
            // platform's JWKS and the RSA verification -- not the kid lookup -- is what fails.
            return { state: created.state, idToken: await impostor.mintIdToken({ nonce: created.nonce }) };
          },
        },
        {
          name: 'case 13: unknown_kid (still missing after one JWKS refetch)',
          expectedReason: 'unknown_kid',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            return { state: created.state, idToken: withHeaderKid(idToken, 'never-published') };
          },
        },
        {
          name: 'case 14: expired_token',
          expectedReason: 'expired_token',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const now = Math.floor(Date.now() / 1000);
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, iat: now - 10000, exp: now - 9000 }),
            };
          },
        },
        {
          name: 'case 15: future_issued_token',
          expectedReason: 'future_issued_token',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const now = Math.floor(Date.now() / 1000);
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, iat: now + 10000 }) };
          },
        },
        {
          name: 'case 16: unsupported_algorithm',
          expectedReason: 'unsupported_algorithm',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce }, { alg: 'RS384' }) };
          },
        },
        {
          name: 'case 17a: wrong_deployment (deployment disabled between login and launch)',
          expectedReason: 'wrong_deployment',
          build: async () => {
            const { db } = getTestDb();
            const { seeded, created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            await db.update(ltiDeployments).set({ enabled: false }).where(eq(ltiDeployments.id, seeded.deploymentRowId));
            return { state: created.state, idToken };
          },
        },
        {
          name: 'case 17b: wrong_deployment (deployment_id claim does not match the transaction)',
          expectedReason: 'wrong_deployment',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, deploymentId: 'some-other-deployment' }),
            };
          },
        },
        {
          name: 'case 18: wrong_version',
          expectedReason: 'wrong_version',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, version: '1.1.0' }) };
          },
        },
        {
          name: 'case 19: wrong_message_type',
          expectedReason: 'wrong_message_type',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({ nonce: created.nonce, messageType: 'LtiDeepLinkingRequest' }),
            };
          },
        },
        {
          name: 'case 20: missing_context',
          expectedReason: 'missing_context',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, contextId: null }) };
          },
        },
        {
          name: 'case 21: missing_roles',
          expectedReason: 'missing_roles',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return { state: created.state, idToken: await platform.mintIdToken({ nonce: created.nonce, roles: null }) };
          },
        },
        {
          name: 'case 22: learner_only_role',
          expectedReason: 'learner_only_role',
          build: async () => {
            const { created } = await setUpValidTransaction();
            return {
              state: created.state,
              idToken: await platform.mintIdToken({
                nonce: created.nonce,
                roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
              }),
            };
          },
        },
        {
          name: 'case 23: tampered_token',
          expectedReason: 'tampered_token',
          build: async () => {
            const { created } = await setUpValidTransaction();
            const idToken = await platform.mintIdToken({ nonce: created.nonce });
            const [, payloadSegment, signatureSegment] = idToken.split('.');
            // Same deterministic corruption as Task 20's unit test: a header segment that decodes
            // to text JSON.parse cannot parse, so decodeProtectedHeader throws reliably.
            const tamperedHeader = Buffer.from('not valid json').toString('base64url');
            return { state: created.state, idToken: `${tamperedHeader}.${payloadSegment}.${signatureSegment}` };
          },
        },
      ];

      for (const scenario of scenarios) {
        await resetDb();
        const input = await scenario.build();
        const result = await verifyLaunch(input, deps());
        expect(result, scenario.name).toEqual({ ok: false, reason: scenario.expectedReason });
        expect(await countSessions(), scenario.name).toBe(0);
      }
    } finally {
      await impostor.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: FAIL with "verifyLaunch is not a function" (previous 22 tests still pass)

- [ ] **Step 3: Append to `lti/launch.ts`**

Add these imports to the top of the file (extend the existing `registrations.js` import with `findOrCreateCourse`, and add the session import):

```ts
import { findRegistrationById, findDeploymentByBusinessId, findOrCreateCourse } from './registrations.js';
import { createSession, type CreatedSession } from '../auth/session.js';
```

Append this to `server/src/lti/launch.ts`:

```ts
export interface VerifyLaunchInput {
  state: string | undefined;
  idToken: string | undefined;
}

export interface VerifyLaunchDeps {
  db: Database;
  jwksCache: JwksCache;
  clockSkewSeconds: number;
  sessionTtlHours: number;
}

export type VerifyLaunchResult =
  | { ok: true; session: CreatedSession; courseId: string; roles: string[]; targetLinkUri: string }
  | { ok: false; reason: LaunchFailureReason };

export async function verifyLaunch(input: VerifyLaunchInput, deps: VerifyLaunchDeps): Promise<VerifyLaunchResult> {
  if (!input.state || !input.idToken) {
    return { ok: false, reason: 'missing_state' };
  }

  const contextResult = await resolveTransactionContext(deps.db, input.state);
  if (!contextResult.ok) {
    return { ok: false, reason: contextResult.reason };
  }
  const { transaction, registration, deployment } = contextResult.context;

  const signatureResult = await verifyJwtSignature(input.idToken, registration, deps.jwksCache, deps.clockSkewSeconds);
  if (!signatureResult.ok) {
    return { ok: false, reason: signatureResult.reason };
  }

  const audienceResult = validateAudienceAndLifetime(signatureResult.payload, registration, deps.clockSkewSeconds);
  if (!audienceResult.ok) {
    return { ok: false, reason: audienceResult.reason };
  }

  const claimsRoleResult = validateNonceClaimsAndRole(signatureResult.payload, transaction);
  if (!claimsRoleResult.ok) {
    return { ok: false, reason: claimsRoleResult.reason };
  }
  const { claims, roles } = claimsRoleResult.result;

  const context = claims['https://purl.imsglobal.org/spec/lti/claim/context'];
  const course = await findOrCreateCourse(deps.db, {
    institutionId: registration.institutionId,
    // `deployment.id` is the lti_deployments ROW UUID, which is what courses.deployment_id FKs to.
    // Do NOT pass transaction.deploymentId here -- that is Canvas's business deployment ID string.
    deploymentId: deployment.id,
    ltiContextId: context.id,
    label: context.label,
    title: context.title,
  });

  const displayName = typeof signatureResult.payload.name === 'string' ? signatureResult.payload.name : null;

  const session = await createSession(deps.db, {
    institutionId: registration.institutionId,
    // Row UUID again, for the same reason: app_sessions.deployment_id is a FK to lti_deployments.id.
    deploymentId: deployment.id,
    ltiSubject: claims.sub,
    displayName,
    courseId: course.id,
    roles,
    ttlHours: deps.sessionTtlHours,
  });

  // The target_link_uri was already validated against the exact-match allowlist at login time
  // (lti/login.ts) before this transaction row was ever written, and it is read back from that row
  // rather than from anything in the current request -- so handing it to the route as a redirect
  // destination introduces no open-redirect surface (spec §12.1, §45 case 24).
  return { ok: true, session, courseId: course.id, roles, targetLinkUri: transaction.targetLinkUri };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/lti/launch.test.ts`
Expected: PASS (28 tests total: 22 previous + 6 new). The sweep is a single `it` that iterates 20 scenarios, so a failure inside it reports the failing scenario's `name` as the assertion message.

- [ ] **Step 5: Run the full test suite so far**

Run: `docker compose up -d && npm test`
Expected: all tests pass (Phase 0-2's 52 tests + every Phase 3 test written so far)

- [ ] **Step 6: Commit**

```bash
git add server/src/lti/launch.ts server/tests/lti/launch.test.ts
git commit -m "feat: assemble verifyLaunch() orchestrator with course/session creation (launch.ts part 5/5)"
```

---

## Task 24: `POST /lti/launch` route

**Files:**
- Create: `server/src/routes/lti-launch.ts`
- Test: `server/tests/routes/lti-launch.test.ts`

**Interfaces:**
- Consumes: `verifyLaunch`/`VerifyLaunchDeps` (Task 23), `SESSION_COOKIE_NAME`/`buildSessionCookieOptions` (Task 18).
- Produces: `interface LtiLaunchRouteDeps extends VerifyLaunchDeps { appBaseUrl: string }`, `registerLtiLaunchRoute(app: FastifyInstance, deps: LtiLaunchRouteDeps): void`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/routes/lti-launch.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { registerLtiLaunchRoute, type LtiLaunchRouteDeps } from '../../src/routes/lti-launch.js';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { seedInstitutionAndRegistration } from '../support/seed.js';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { createOidcTransaction } from '../../src/lti/oidc-transactions.js';
import { JwksCache } from '../../src/lti/jwks-cache.js';
import { appSessions } from '../../src/database/schema.js';

function buildTestApp(deps: LtiLaunchRouteDeps) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyFormbody);
  registerLtiLaunchRoute(app, deps);
  return app;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once (see the same note
// in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('POST /lti/launch', () => {
  let platform: MockCanvasPlatform;
  let jwksCache: JwksCache;

  beforeEach(async () => {
    await resetDb();
    platform = new MockCanvasPlatform();
    await platform.start();
    jwksCache = new JwksCache({ fetchJwks: (uri) => fetch(uri).then((r) => r.json()) });
  });
  afterEach(async () => {
    await platform.stop();
  });

  function deps(): LtiLaunchRouteDeps {
    return { db: getTestDb().db, jwksCache, clockSkewSeconds: 120, sessionTtlHours: 8, appBaseUrl: 'https://app.test' };
  }

  async function setUpValidTransaction(targetLinkUri = 'https://app.test/index.html') {
    const { db } = getTestDb();
    const seeded = await seedInstitutionAndRegistration(db, platform);
    return createOidcTransaction(db, {
      registrationId: seeded.registrationId,
      deploymentId: seeded.deploymentId,
      targetLinkUri,
      ttlSeconds: 300,
    });
  }

  it('redirects 303 to the transaction\'s target_link_uri and sets a Secure, HttpOnly session cookie on a valid launch', async () => {
    const created = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: idToken }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://app.test/index.html');
    const cookieHeader = response.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();
    const cookieString = Array.isArray(cookieHeader) ? cookieHeader.join(';') : String(cookieHeader);
    expect(cookieString).toContain('attendance_session=');
    expect(cookieString).toContain('HttpOnly');
    expect(cookieString).toContain('Secure');
  });

  it('redirects to the SECOND allowlist entry when that is what the launch targeted', async () => {
    // ALLOWED_TARGET_LINK_URIS is a multi-entry list (see Task 2), so a launch aimed at
    // /scanner.html must land on /scanner.html, not on whichever entry happens to be first.
    const created = await setUpValidTransaction('https://app.test/scanner.html');
    const idToken = await platform.mintIdToken({ nonce: created.nonce });
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: idToken }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('https://app.test/scanner.html');
  });

  it('§45 case 22 at the route level: returns 403 (not 400) for a learner-only launch, and creates no session', async () => {
    const created = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({
      nonce: created.nonce,
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    });
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: idToken }).toString(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'learner_only_role' });
    expect(response.headers['set-cookie']).toBeUndefined();

    const { db } = getTestDb();
    expect(await db.select().from(appSessions)).toHaveLength(0);
  });

  it('returns 400 for a request missing both state and id_token, and creates no session', async () => {
    const app = buildTestApp(deps());

    const response = await app.inject({ method: 'POST', url: '/lti/launch', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'missing_state' });

    const { db } = getTestDb();
    expect(await db.select().from(appSessions)).toHaveLength(0);
  });

  it('§45 case 23 at the route level: returns 400 (not 403) for a tampered launch', async () => {
    const created = await setUpValidTransaction();
    const idToken = await platform.mintIdToken({ nonce: created.nonce });
    const [, payload, signature] = idToken.split('.');
    // Same deterministic corruption as the launch.ts unit test: a header segment that decodes to
    // text JSON.parse cannot parse, so decodeProtectedHeader throws reliably.
    const tamperedHeader = Buffer.from('not valid json').toString('base64url');
    const app = buildTestApp(deps());

    const response = await app.inject({
      method: 'POST',
      url: '/lti/launch',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ state: created.state, id_token: `${tamperedHeader}.${payload}.${signature}` }).toString(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'tampered_token' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/routes/lti-launch.test.ts`
Expected: FAIL with "Cannot find module '../../src/routes/lti-launch.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/routes/lti-launch.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyLaunch, type VerifyLaunchDeps } from '../lti/launch.js';
import { SESSION_COOKIE_NAME, buildSessionCookieOptions } from '../auth/cookies.js';

const launchBodySchema = z.object({
  state: z.string().optional(),
  id_token: z.string().optional(),
});

const REASON_TO_STATUS: Record<string, number> = {
  learner_only_role: 403,
};

export interface LtiLaunchRouteDeps extends VerifyLaunchDeps {
  appBaseUrl: string;
}

export function registerLtiLaunchRoute(app: FastifyInstance, deps: LtiLaunchRouteDeps): void {
  app.post('/lti/launch', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = launchBodySchema.safeParse(request.body);
    const input = parsed.success ? parsed.data : {};

    const result = await verifyLaunch({ state: input.state, idToken: input.id_token }, deps);

    if (!result.ok) {
      const status = REASON_TO_STATUS[result.reason] ?? 400;
      return reply.code(status).send({ error: result.reason });
    }

    reply.setCookie(SESSION_COOKIE_NAME, result.session.token, buildSessionCookieOptions(deps.appBaseUrl, deps.sessionTtlHours));
    // `result.targetLinkUri` is the value the matching OIDC transaction stored at login time, and
    // /lti/login only ever stores a value that passed the exact-match ALLOWED_TARGET_LINK_URIS
    // allowlist (spec §12.1). That allowlist -- not this line -- is what makes redirecting to a
    // launch-supplied destination safe; never redirect to a target_link_uri read out of the
    // current request. Hardcoding one page here would silently break multi-entry allowlists.
    return reply.redirect(result.targetLinkUri, 303);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/routes/lti-launch.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/lti-launch.ts server/tests/routes/lti-launch.test.ts
git commit -m "feat: add POST /lti/launch route with cookie set and error-code mapping"
```

---

## Task 25: CSRF verification + `requireSession`/`requireCsrf` middleware

**Files:**
- Create: `server/src/auth/csrf.ts`, `server/src/auth/middleware.ts`
- Test: `server/tests/auth/csrf-middleware.test.ts`

**Interfaces:**
- Consumes: `findValidSession`/`AppSession` (Task 18), `SESSION_COOKIE_NAME` (Task 18).
- Produces (`csrf.ts`): `verifyCsrfToken(sessionCsrfSecret: string, providedToken: string | undefined): boolean`, `verifyOrigin(expectedOrigin: string, providedOrigin: string | undefined): boolean`, `isRejectedMutationContentType(contentTypeHeader: string | undefined): boolean`.
- Produces (`middleware.ts`): `createRequireSession(db: Database): (request, reply) => Promise<void>` (decorates `request.appSession`), `createRequireCsrf(expectedOrigin: string): (request, reply) => Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/auth/csrf-middleware.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import { createSession } from '../../src/auth/session.js';
import { createRequireSession, createRequireCsrf } from '../../src/auth/middleware.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/cookies.js';
import { verifyCsrfToken, verifyOrigin, isRejectedMutationContentType } from '../../src/auth/csrf.js';
import type { Database } from '../../src/database/client.js';

async function seedSessionCourse() {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'csrf-test', displayName: 'CSRF Test', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://csrf.test',
      clientId: 'csrf-client',
      oidcAuthEndpoint: 'https://csrf.test/a',
      tokenEndpoint: 'https://csrf.test/t',
      tokenAudience: 'https://csrf.test/t',
      platformJwksUri: 'https://csrf.test/jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'csrf-deploy', enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'csrf-course' })
    .returning();
  return { institutionId: institution.id, deploymentRowId: deployment.id, courseId: course.id };
}

function buildTestApp(db: Database) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  // Registered here for the same reason it is registered app-wide in index.ts: POST /lti/launch
  // needs to parse Canvas's `form_post` response. Its presence is exactly why requireCsrf must
  // reject form-encoded bodies itself (spec §15) -- without formbody, Fastify would 415 before the
  // preHandler ever ran and the content-type test below would prove nothing.
  app.register(fastifyFormbody);
  const requireSession = createRequireSession(db);
  const requireCsrf = createRequireCsrf('https://app.test');
  app.get('/protected', { preHandler: requireSession }, async () => ({ ok: true }));
  app.post('/mutate', { preHandler: [requireSession, requireCsrf] }, async () => ({ ok: true }));
  return app;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once, after every
// describe in this file has finished (see the same note in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('requireSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 401 with no session cookie', async () => {
    const app = buildTestApp(getTestDb().db);
    const response = await app.inject({ method: 'GET', url: '/protected' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for an invalid session cookie', async () => {
    const app = buildTestApp(getTestDb().db);
    const response = await app.inject({ method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE_NAME]: 'bogus' } });
    expect(response.statusCode).toBe(401);
  });

  it('allows the request through with a valid session cookie', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE_NAME]: created.token } });

    expect(response.statusCode).toBe(200);
  });
});

describe('requireCsrf', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 403 when the Origin header does not match', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: { origin: 'https://evil.test', 'x-csrf-token': created.csrfSecret },
    });

    expect(response.statusCode).toBe(403);
  });

  it('returns 403 when the CSRF token does not match', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: { origin: 'https://app.test', 'x-csrf-token': 'wrong-token' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('succeeds when Origin and CSRF token both match', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: { origin: 'https://app.test', 'x-csrf-token': created.csrfSecret },
    });

    expect(response.statusCode).toBe(200);
  });

  it('spec §15: returns 403 for a form-encoded mutation even when Origin and CSRF token are both correct', async () => {
    const { db } = getTestDb();
    const { institutionId, deploymentRowId, courseId } = await seedSessionCourse();
    const created = await createSession(db, {
      institutionId,
      deploymentId: deploymentRowId,
      ltiSubject: 'user-1',
      displayName: null,
      courseId,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({
      method: 'POST',
      url: '/mutate',
      cookies: { [SESSION_COOKIE_NAME]: created.token },
      headers: {
        origin: 'https://app.test',
        'x-csrf-token': created.csrfSecret,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ anything: '1' }).toString(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'form_encoded_mutation_rejected' });
  });
});

describe('verifyCsrfToken / verifyOrigin / isRejectedMutationContentType (unit)', () => {
  it('rejects when no token is provided', () => {
    expect(verifyCsrfToken('secret', undefined)).toBe(false);
  });

  it('rejects a same-length but different token', () => {
    expect(verifyCsrfToken('secret-a', 'secret-b')).toBe(false);
  });

  it('verifyOrigin requires an exact match', () => {
    expect(verifyOrigin('https://app.test', 'https://app.test')).toBe(true);
    expect(verifyOrigin('https://app.test', 'https://app.test.evil.com')).toBe(false);
    expect(verifyOrigin('https://app.test', undefined)).toBe(false);
  });

  it('isRejectedMutationContentType flags form encodings, ignoring parameters and case, and allows JSON', () => {
    expect(isRejectedMutationContentType('application/x-www-form-urlencoded')).toBe(true);
    expect(isRejectedMutationContentType('Application/X-WWW-Form-Urlencoded; charset=UTF-8')).toBe(true);
    expect(isRejectedMutationContentType('multipart/form-data; boundary=----abc')).toBe(true);
    expect(isRejectedMutationContentType('application/json')).toBe(false);
    expect(isRejectedMutationContentType(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/auth/csrf-middleware.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/middleware.js'"

- [ ] **Step 3: Write `auth/csrf.ts`**

```ts
// server/src/auth/csrf.ts
import { timingSafeEqual } from 'node:crypto';

export function verifyCsrfToken(sessionCsrfSecret: string, providedToken: string | undefined): boolean {
  if (!providedToken) return false;
  const expected = Buffer.from(sessionCsrfSecret);
  const actual = Buffer.from(providedToken);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function verifyOrigin(expectedOrigin: string, providedOrigin: string | undefined): boolean {
  return providedOrigin === expectedOrigin;
}

// Spec §15: "Reject form-encoded mutation endpoints except the LTI launch endpoint itself."
// `@fastify/formbody` is registered app-wide so POST /lti/launch can parse Canvas's `form_post`
// response mode, which means every other POST would otherwise also accept a form body -- and a
// cross-site HTML <form> can be submitted without JavaScript and without a preflight. Blocking the
// two form encodings on CSRF-protected routes removes that class of request entirely. POST
// /lti/launch does NOT use requireCsrf (it is authenticated by the signed id_token, not by a
// session cookie), so it is unaffected by this check.
const REJECTED_MUTATION_MEDIA_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

export function isRejectedMutationContentType(contentTypeHeader: string | undefined): boolean {
  if (!contentTypeHeader) return false;
  const mediaType = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return REJECTED_MUTATION_MEDIA_TYPES.has(mediaType);
}
```

- [ ] **Step 4: Write `auth/middleware.ts`**

```ts
// server/src/auth/middleware.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../database/client.js';
import { findValidSession, type AppSession } from './session.js';
import { verifyCsrfToken, verifyOrigin, isRejectedMutationContentType } from './csrf.js';
import { SESSION_COOKIE_NAME } from './cookies.js';

declare module 'fastify' {
  interface FastifyRequest {
    appSession?: AppSession;
  }
}

// NOTE on the `reply.code(...).send(...); return;` pattern used throughout this file: these are
// Fastify preHandler hooks declared as `Promise<void>`, and a Fastify hook signals "stop here, the
// response is already sent" by *sending*, not by returning the reply object. Writing
// `return reply.code(401).send(...)` returns a FastifyReply from a `Promise<void>` function and
// fails `npm run typecheck` with TS2322 ("Type 'FastifyReply' is not assignable to type 'void'").
export function createRequireSession(db: Database) {
  return async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    const session = await findValidSession(db, token);
    if (!session) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    request.appSession = session;
  };
}

export function createRequireCsrf(expectedOrigin: string) {
  return async function requireCsrf(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = request.appSession;
    if (!session) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    // Spec §15: form-encoded bodies are never acceptable on a CSRF-protected mutation. The LTI
    // launch endpoint is the documented exception and does not use this preHandler.
    if (isRejectedMutationContentType(request.headers['content-type'])) {
      reply.code(403).send({ error: 'form_encoded_mutation_rejected' });
      return;
    }
    const origin = request.headers.origin;
    const csrfHeader = request.headers['x-csrf-token'];
    const providedToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (!verifyOrigin(expectedOrigin, origin) || !verifyCsrfToken(session.csrfSecret, providedToken)) {
      reply.code(403).send({ error: 'csrf_check_failed' });
      return;
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/auth/csrf-middleware.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/csrf.ts server/src/auth/middleware.ts server/tests/auth/csrf-middleware.test.ts
git commit -m "feat: add CSRF verification and requireSession/requireCsrf Fastify preHandlers"
```

---

## Task 26: `GET /api/me`

**Files:**
- Create: `server/src/routes/me.ts`
- Test: `server/tests/routes/me.test.ts`

Implements spec §25.1's exact response shape. This route uses `requireSession` only, with **no** `requireCsrf`, and that is deliberate: spec §15 scopes CSRF protection to *state-changing* requests, and `/api/me` is a read-only GET. It is also the bootstrap endpoint that *hands the browser its CSRF token* in the first place ("the browser frontend receives its CSRF token through a same-origin authenticated bootstrap endpoint", §15), so requiring that token to fetch it would be circular and the page could never make its first mutation.

**Interfaces:**
- Consumes: `createRequireSession` (Task 25), `AppSession` (Task 18).
- Produces: `interface MeRouteDeps { requireSession: (request, reply) => Promise<void>; db: Database }`, `registerMeRoute(app: FastifyInstance, deps: MeRouteDeps): void`.

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/routes/me.test.ts
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { institutions, ltiRegistrations, ltiDeployments, courses } from '../../src/database/schema.js';
import { createSession } from '../../src/auth/session.js';
import { createRequireSession } from '../../src/auth/middleware.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/cookies.js';
import { registerMeRoute } from '../../src/routes/me.js';
import type { Database } from '../../src/database/client.js';

async function seedFullContext() {
  const { db } = getTestDb();
  const [institution] = await db
    .insert(institutions)
    .values({ slug: 'me-test', displayName: 'Me Test University', timezone: 'UTC', enabled: true })
    .returning();
  const [registration] = await db
    .insert(ltiRegistrations)
    .values({
      institutionId: institution.id,
      issuer: 'https://me.test',
      clientId: 'me-client',
      oidcAuthEndpoint: 'https://me.test/secret-auth-endpoint',
      tokenEndpoint: 'https://me.test/secret-token-endpoint',
      tokenAudience: 'https://me.test/secret-token-endpoint',
      platformJwksUri: 'https://me.test/secret-jwks',
      enabled: true,
    })
    .returning();
  const [deployment] = await db
    .insert(ltiDeployments)
    .values({ registrationId: registration.id, deploymentId: 'me-deploy', enabled: true, configuration: {} })
    .returning();
  const [course] = await db
    .insert(courses)
    .values({ institutionId: institution.id, deploymentId: deployment.id, ltiContextId: 'me-course', label: 'ME101', title: 'Me Course' })
    .returning();
  return { institution, deployment, course };
}

function buildTestApp(db: Database) {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  registerMeRoute(app, { requireSession: createRequireSession(db), db });
  return app;
}

// File scope so the shared module-level pg pool in db.ts is closed exactly once (see the same note
// in registrations.test.ts).
afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/me', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns the documented §25.1 shape, sourced from the launch session and course", async () => {
    const { db } = getTestDb();
    const { institution, deployment, course } = await seedFullContext();
    const created = await createSession(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiSubject: 'user-1',
      displayName: 'Jane Instructor',
      courseId: course.id,
      roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: created.token } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { displayName: 'Jane Instructor', roles: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'] },
      institution: { name: 'Me Test University' },
      course: { id: course.id, label: 'ME101', title: 'Me Course' },
      permissions: { takeAttendance: true, editAttendance: true },
      csrfToken: created.csrfSecret,
    });
  });

  it('falls back to ltiSubject as displayName when the launch had no name claim', async () => {
    const { db } = getTestDb();
    const { institution, deployment, course } = await seedFullContext();
    const created = await createSession(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiSubject: 'user-no-name',
      displayName: null,
      courseId: course.id,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: created.token } });

    expect(response.json().user.displayName).toBe('user-no-name');
  });

  it('returns 401 without a valid session', async () => {
    const app = buildTestApp(getTestDb().db);
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
  });

  it('never leaks the raw session token or any Canvas endpoint/JWKS URL', async () => {
    const { db } = getTestDb();
    const { institution, deployment, course } = await seedFullContext();
    const created = await createSession(db, {
      institutionId: institution.id,
      deploymentId: deployment.id,
      ltiSubject: 'user-1',
      displayName: 'Jane Instructor',
      courseId: course.id,
      roles: ['Instructor'],
      ttlHours: 8,
    });
    const app = buildTestApp(db);

    const response = await app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: created.token } });
    const raw = JSON.stringify(response.json());

    expect(raw).not.toContain(created.token);
    expect(raw).not.toContain('secret-auth-endpoint');
    expect(raw).not.toContain('secret-token-endpoint');
    expect(raw).not.toContain('secret-jwks');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/routes/me.test.ts`
Expected: FAIL with "Cannot find module '../../src/routes/me.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/routes/me.ts
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { institutions, courses } from '../database/schema.js';

export interface MeRouteDeps {
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  db: Database;
}

export function registerMeRoute(app: FastifyInstance, deps: MeRouteDeps): void {
  app.get('/api/me', { preHandler: deps.requireSession }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = request.appSession;
    if (!session) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const [institution] = await deps.db.select().from(institutions).where(eq(institutions.id, session.institutionId)).limit(1);
    const [course] = await deps.db.select().from(courses).where(eq(courses.id, session.courseId)).limit(1);

    return {
      user: { displayName: session.displayName ?? session.ltiSubject, roles: session.roles },
      institution: { name: institution?.displayName ?? '' },
      course: { id: course?.id ?? '', label: course?.label ?? '', title: course?.title ?? '' },
      permissions: { takeAttendance: true, editAttendance: true },
      csrfToken: session.csrfSecret,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/routes/me.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/me.ts server/tests/routes/me.test.ts
git commit -m "feat: add GET /api/me bootstrap route"
```

---

## Task 27: Cross-cutting hardening + `index.ts` wiring

**Files:**
- Create: `server/tests/routes/hardening.test.ts`
- Modify: `server/src/index.ts`, `README.md`

Wires every module built in Tasks 1-26 into the real Fastify app, and adds the two remaining spec §31 baseline controls: security headers (helmet) and rate limiting on `/lti/login`/`/lti/launch` (spec §31.10: 30 requests/minute/IP).

**Interfaces:**
- Consumes: every `registerXRoute` function and every dependency-builder from this entire plan.

- [ ] **Step 1: Write the configuration-pinning test for the security-header and rate-limit behaviors**

This test is **not** a red/green TDD cycle. It drives no new application logic — it pins the exact plugin configuration that Step 4 wires into `server/src/index.ts`, so that a later edit which drops a CSP directive, the `Permissions-Policy` header, or the rate limit fails loudly here.

```ts
// server/tests/routes/hardening.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { describe, it, expect } from 'vitest';

// buildCspDirectives + buildHardenedApp mirror, line for line, the helmet configuration and the
// Permissions-Policy hook in server/src/index.ts (Step 4 below). Keep the two in sync.
function buildCspDirectives(appBaseUrl: string, canvasOidcOrigins: string[]): Record<string, string[] | null> {
  const directives: Record<string, string[] | null> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    // Spec §31.3 asks for `form-action 'self' <configured Canvas OIDC destinations>`. The app's own
    // origin is covered by 'self'; the extra entries are the origins of the oidc_auth_endpoint
    // values in lti_registrations, because /lti/login sends the browser on to the platform's
    // authorization endpoint and Canvas form-POSTs the launch back.
    formAction: ["'self'", ...canvasOidcOrigins],
    frameAncestors: ["'none'"],
  };
  if (!appBaseUrl.startsWith('https://')) {
    // Helmet's default CSP includes `upgrade-insecure-requests`, which makes the browser rewrite
    // every http://localhost:3000 request to https:// and breaks local HTTP development. `null` is
    // helmet's documented way to remove one of its own default directives.
    directives.upgradeInsecureRequests = null;
  }
  return directives;
}

async function buildHardenedApp(appBaseUrl: string, canvasOidcOrigins: string[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: buildCspDirectives(appBaseUrl, canvasOidcOrigins) },
  });
  // Spec §31.2. Helmet does not set Permissions-Policy, and this app is a WebHID card scanner, so
  // it must explicitly grant `hid` to its own origin (and to nothing embedded).
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Permissions-Policy', 'hid=(self)');
  });
  app.get('/probe', async () => ({ ok: true }));
  return app;
}

describe('security headers (helmet, spec §31.2/§31.3)', () => {
  it('sets a restrictive CSP with frame-ancestors none, plus X-Content-Type-Options', async () => {
    const app = await buildHardenedApp('https://app.test', ['https://canvas.test']);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it("names the configured Canvas OIDC destinations in form-action, not just the app's own origin", async () => {
    const app = await buildHardenedApp('https://app.test', ['https://canvas.test', 'https://canvas-beta.test']);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    expect(String(response.headers['content-security-policy'])).toContain(
      "form-action 'self' https://canvas.test https://canvas-beta.test",
    );
  });

  it('sets Permissions-Policy: hid=(self) so the WebHID scanner keeps working (spec §31.2)', async () => {
    const app = await buildHardenedApp('https://app.test', ['https://canvas.test']);

    const response = await app.inject({ method: 'GET', url: '/probe' });

    expect(response.headers['permissions-policy']).toBe('hid=(self)');
  });

  it('omits upgrade-insecure-requests for an http APP_BASE_URL, keeps it for https', async () => {
    const httpApp = await buildHardenedApp('http://localhost:3000', ['https://canvas.test']);
    const httpsApp = await buildHardenedApp('https://app.test', ['https://canvas.test']);

    const httpResponse = await httpApp.inject({ method: 'GET', url: '/probe' });
    const httpsResponse = await httpsApp.inject({ method: 'GET', url: '/probe' });

    expect(String(httpResponse.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    expect(String(httpsResponse.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
  });
});

describe('rate limiting (spec §31.10: 30 requests/minute/IP on /lti/login and /lti/launch)', () => {
  it('returns 429 once the configured per-IP limit is exceeded within the window', async () => {
    const app = Fastify({ logger: false });
    await app.register(fastifyRateLimit, { max: 3, timeWindow: '1 minute' });
    app.get('/lti/login-probe', async () => ({ ok: true }));

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/lti/login-probe' });
      expect(response.statusCode).toBe(200);
    }

    const fourth = await app.inject({ method: 'GET', url: '/lti/login-probe' });
    expect(fourth.statusCode).toBe(429);
  });
});
```

- [ ] **Step 2: Run it — it should pass immediately**

Run: `npx vitest run server/tests/routes/hardening.test.ts`
Expected: PASS (5 tests). There is no red phase for this file: it exercises `@fastify/helmet` and `@fastify/rate-limit` (installed in Task 1) plus one Fastify hook, and pins configuration rather than driving new application logic. If it *fails*, that is a real signal — the plugin versions behave differently from what Step 4's `index.ts` config assumes — so fix the configuration in both this file and Step 4 before proceeding.

- [ ] **Step 3: Note the deliberate `/api/scans` decision before wiring**

Nothing to run for this step; it records a decision that Step 4's wiring makes visible. Spec §25 eventually puts scanning behind a session, but **Phase 3 deliberately leaves `POST /api/scans` unauthenticated, exactly as Phase 2 shipped it.** Do **not** add `requireSession`/`requireCsrf` to that route in this phase. Rationale, to be repeated in `docs/canvas-lti/progress.md` in Task 28:

- Phase 3 introduces **no new exposure** — the route is already public on `main`, and this phase only adds endpoints alongside it.
- The existing browser UI calls it without a session, and the standalone dev mode (spec §51) has no LTI launch at all; gating it now would break both before there is a replacement.
- Phase 5 retires it in favor of `POST /api/attendance-sessions/{id}/scans` behind `requireSession` + `requireCsrf`, which is the point at which the UI is migrated too. Adding auth here would be work Phase 5 immediately deletes.

- [ ] **Step 4: Rewrite `server/src/index.ts`**

```ts
// server/src/index.ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { registerScansRoute } from './routes/scans.js';
import { MockIdentityResolver } from './identity/mock-resolver.js';
import { createHttpIdentityResolverFromEnv } from './identity/http-resolver.js';
import { loadEnv, parseAllowedTargetLinkUris } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { ltiRegistrations } from './database/schema.js';
import { loadSigningKeysFromEnv } from './lti/signing-keys.js';
import { createDefaultJwksCache } from './lti/jwks-cache.js';
import { createAllowlist } from './lti/login.js';
import { findEnabledDeployment } from './lti/registrations.js';
import { createOidcTransaction } from './lti/oidc-transactions.js';
import { registerLtiJwksRoute } from './routes/lti-jwks.js';
import { registerLtiLoginRoute } from './routes/lti-login.js';
import { registerLtiLaunchRoute } from './routes/lti-launch.js';
import { registerMeRoute } from './routes/me.js';
import { createRequireSession } from './auth/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '../../web');

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
await applyMigrations(dbClient);
const { db } = dbClient;

const signingKeys = await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON);
const jwksCache = createDefaultJwksCache();
const allowedTargetLinkUris = createAllowlist(parseAllowedTargetLinkUris(env));

// Spec §31.3's form-action directive wants the *configured Canvas OIDC destinations*, and spec §11
// forbids deriving a Canvas endpoint from a hostname -- so read them from lti_registrations, which
// is where the real, discovery-sourced endpoints live. Read once at boot; a newly seeded
// registration needs a restart, which is already true of every other boot-time config here.
const registrationRows = await db
  .select({ oidcAuthEndpoint: ltiRegistrations.oidcAuthEndpoint })
  .from(ltiRegistrations)
  .where(eq(ltiRegistrations.enabled, true));
const canvasOidcOrigins = [...new Set(registrationRows.map((row) => new URL(row.oidcAuthEndpoint).origin))];

const cspDirectives: Record<string, string[] | null> = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  // 'self' already covers APP_BASE_URL; the extra entries are the Canvas authorization endpoints
  // /lti/login redirects the browser to and that form-POST the launch back to /lti/launch.
  formAction: ["'self'", ...canvasOidcOrigins],
  frameAncestors: ["'none'"],
};
if (!env.APP_BASE_URL.startsWith('https://')) {
  // Helmet's default CSP adds `upgrade-insecure-requests`, which rewrites every
  // http://localhost:3000 request to https:// and breaks local HTTP dev. `null` removes one of
  // helmet's own defaults.
  cspDirectives.upgradeInsecureRequests = null;
}

const app = Fastify({ logger: true });

await app.register(fastifyHelmet, {
  contentSecurityPolicy: { directives: cspDirectives },
});

// Spec §31.2. Helmet does not set Permissions-Policy, and this app is a WebHID card scanner: the
// scanner page needs `hid`, and nothing embedded should get it. Mirrored by
// server/tests/routes/hardening.test.ts.
app.addHook('onRequest', async (_request, reply) => {
  reply.header('Permissions-Policy', 'hid=(self)');
});

await app.register(fastifyCookie);
await app.register(fastifyFormbody);
await app.register(fastifyStatic, { root: webRoot });

// /lti/login and /lti/launch get rate-limited (spec §31.10: 30 req/min/IP) inside their own
// encapsulated plugin context so the limit doesn't apply to /api/scans (which needs classroom
// bursts, per spec §31.10's explicit "do not impose a rate limit that prevents a class from
// scanning through quickly").
await app.register(async (instance) => {
  await instance.register(fastifyRateLimit, { max: 30, timeWindow: '1 minute' });

  registerLtiLoginRoute(instance, {
    appBaseUrl: env.APP_BASE_URL,
    allowedTargetLinkUris,
    findEnabledDeployment: (iss, clientId, deploymentId) => findEnabledDeployment(db, iss, clientId, deploymentId),
    createTransaction: (params) =>
      createOidcTransaction(db, { ...params, ttlSeconds: env.LOGIN_TRANSACTION_TTL_SECONDS }),
  });

  registerLtiLaunchRoute(instance, {
    db,
    jwksCache,
    clockSkewSeconds: env.CLOCK_SKEW_SECONDS,
    sessionTtlHours: env.APP_SESSION_TTL_HOURS,
    appBaseUrl: env.APP_BASE_URL,
  });
});

registerLtiJwksRoute(app, signingKeys);

const requireSession = createRequireSession(db);
registerMeRoute(app, { requireSession, db });

app.get('/health', async () => ({ status: 'ok' }));

// Falls back to the Mock resolver whenever the real HTTP resolver's required env vars aren't set
// -- see docs/canvas-lti/progress.md's "Deferred decisions" section for why that's the case.
const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();
// DELIBERATE: POST /api/scans stays UNAUTHENTICATED in Phase 3 -- no requireSession, no
// requireCsrf, no rate limit. It is registered on the root `app`, outside the rate-limited plugin
// scope above, exactly as Phase 2 shipped it. Phase 3 adds endpoints beside it and introduces no
// new exposure; the existing browser UI and the standalone dev mode (spec §51, which never
// performs an LTI launch) both still call it without a session. Phase 5 retires this route in
// favour of POST /api/attendance-sessions/{id}/scans behind requireSession + requireCsrf, and
// migrates the UI at the same time. Do not add auth here.
registerScansRoute(app, identityResolver);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Add the new environment variables to `README.md`**

Insert this new section immediately before the existing `## Project structure` heading (currently line 215):

```markdown
## 12. LTI authentication environment variables (Phase 3)

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | -- | PostgreSQL connection string (Drizzle/`pg`). Local dev: `postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker` (matches `docker-compose.yml`). |
| `APP_BASE_URL` | yes | -- | This app's own public base URL, e.g. `https://attendance.example.edu`. Used to build the LTI `redirect_uri` and to decide whether the session cookie is marked `Secure` (only when this starts with `https://`). |
| `ALLOWED_TARGET_LINK_URIS` | yes | -- | Comma-separated exact-match allowlist of `target_link_uri` values `/lti/login` is allowed to redirect to. |
| `LTI_TOOL_SIGNING_KEYS_JSON` | no | unset -> an ephemeral key is generated at boot | JSON array of `{ kid, privateKeyPkcs8Pem, status: 'active' \| 'previous' }` for this app's own RSA signing keys, published at `GET /lti/jwks`. Leave unset only for local dev -- production must set this so keys survive a restart, and MUST NOT be committed to Git. |
| `CLOCK_SKEW_SECONDS` | no | `120` | Allowed clock skew when validating a Canvas launch JWT's `exp`/`nbf`/`iat`. |
| `LOGIN_TRANSACTION_TTL_SECONDS` | no | `300` | How long an `/lti/login`-issued `state`/`nonce` transaction remains valid before it's rejected as expired. |
| `APP_SESSION_TTL_HOURS` | no | `8` | How long an application session (created at `/lti/launch`) remains valid. |
| `TEST_DATABASE_URL` | no (tests only) | `postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_test` | Database `npm test` uses. Deliberately a **different** database from `DATABASE_URL`: the suite `TRUNCATE`s every table between test files, so sharing one would wipe your dev data. Created automatically on first `npm test` if it doesn't exist. |

### Running the tests

`npm test` requires the `docker-compose.yml` PostgreSQL service to be running (`docker compose up -d`). Vitest's
`globalSetup` creates and migrates the test database once before **any** test file runs -- including
the Phase 0-2 server tests and the `web/tests/**` browser tests, none of which touch the database
themselves. If Postgres is not up, the whole suite fails at global setup with a connection error
rather than a test assertion. Test files run serially (`poolOptions.forks.singleFork`) because they
share that one test database.

```

- [ ] **Step 6: Run the full suite, lint, and typecheck**

Run: `docker compose up -d && npm test && npm run lint && npm run typecheck`
Expected: all pass (every Phase 0-3 test green, zero lint errors, zero type errors)

- [ ] **Step 7: Manual boot smoke test**

Run (in a separate terminal, with a real `.env`-equivalent export of `DATABASE_URL`/`APP_BASE_URL`/`ALLOWED_TARGET_LINK_URIS` set): `npm run dev`
Expected: server boots without throwing, `curl http://localhost:3000/health` returns `{"status":"ok"}`, `curl http://localhost:3000/lti/jwks` returns a JWKS document with no `d` field.

Then check the headers actually land on a real response: `curl -sI http://localhost:3000/health`
Expected: a `permissions-policy: hid=(self)` line, an `x-content-type-options: nosniff` line, and a `content-security-policy` line that contains `frame-ancestors 'none'` and does **not** contain `upgrade-insecure-requests` (because `APP_BASE_URL` is `http://localhost:3000` here).

- [ ] **Step 8: Commit**

```bash
git add server/src/index.ts server/tests/routes/hardening.test.ts README.md
git commit -m "feat: wire LTI auth into index.ts with helmet security headers and rate limiting"
```

---

## Task 28: `seed-registration.ts` CLI + manual Canvas setup docs + progress tracker

**Files:**
- Create: `server/src/database/seed-registration.ts`, `docs/canvas-installation.md`
- Modify: `docs/canvas-lti/progress.md`

This is manual-testing support, not itself covered by an automated §45 case — but it's Definition-of-Done infrastructure required before the plan's manual Canvas verification checkpoint can happen.

**Interfaces:**
- Consumes: `loadEnv` (Task 2), `createDbClient` (Task 4), `institutions`/`ltiRegistrations`/`ltiDeployments` (Task 3).
- Produces: a runnable CLI script, no exported functions consumed by other modules.

- [ ] **Step 1: Write `server/src/database/seed-registration.ts`**

```ts
// server/src/database/seed-registration.ts
//
// Manual-testing CLI: upserts an institution + LTI registration + LTI deployment from the values
// gathered during Canvas Developer Key setup (see docs/canvas-installation.md). Idempotent for the
// institution and deployment rows; running it twice for the same issuer+client_id does NOT update
// an existing registration's endpoints -- delete that row manually first if you need to re-seed it.
//
// Usage:
//   npx tsx server/src/database/seed-registration.ts \
//     --institution-slug cedarville --institution-name "Cedarville University" \
//     --issuer https://canvas.instructure.com --client-id <client-id> \
//     --oidc-auth-endpoint https://<canvas-domain>/api/lti/authorize_redirect \
//     --token-endpoint https://<canvas-domain>/login/oauth2/token \
//     --platform-jwks-uri https://<canvas-domain>/api/lti/security/jwks \
//     --deployment-id <deployment-id>

import { and, eq } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { createDbClient } from './client.js';
import { institutions, ltiRegistrations, ltiDeployments } from './schema.js';

interface SeedArgs {
  institutionSlug: string;
  institutionName: string;
  issuer: string;
  clientId: string;
  oidcAuthEndpoint: string;
  tokenEndpoint: string;
  platformJwksUri: string;
  deploymentId: string;
}

const REQUIRED_FLAGS = [
  'institution-slug',
  'institution-name',
  'issuer',
  'client-id',
  'oidc-auth-endpoint',
  'token-endpoint',
  'platform-jwks-uri',
  'deployment-id',
] as const;

function parseArgs(argv: string[]): SeedArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      flags.set(key, value);
      i += 1;
    }
  }

  for (const key of REQUIRED_FLAGS) {
    if (!flags.has(key)) {
      throw new Error(`Missing required argument --${key}. See docs/canvas-installation.md for usage.`);
    }
  }

  return {
    institutionSlug: flags.get('institution-slug') as string,
    institutionName: flags.get('institution-name') as string,
    issuer: flags.get('issuer') as string,
    clientId: flags.get('client-id') as string,
    oidcAuthEndpoint: flags.get('oidc-auth-endpoint') as string,
    tokenEndpoint: flags.get('token-endpoint') as string,
    platformJwksUri: flags.get('platform-jwks-uri') as string,
    deploymentId: flags.get('deployment-id') as string,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const { db, pool } = createDbClient(env.DATABASE_URL);

  try {
    let [institution] = await db.select().from(institutions).where(eq(institutions.slug, args.institutionSlug)).limit(1);
    if (!institution) {
      [institution] = await db
        .insert(institutions)
        .values({ slug: args.institutionSlug, displayName: args.institutionName, timezone: 'UTC', enabled: true })
        .returning();
      console.log(`Created institution "${args.institutionSlug}" (${institution.id})`);
    } else {
      console.log(`Found existing institution "${args.institutionSlug}" (${institution.id})`);
    }

    let [registration] = await db
      .select()
      .from(ltiRegistrations)
      .where(and(eq(ltiRegistrations.issuer, args.issuer), eq(ltiRegistrations.clientId, args.clientId)))
      .limit(1);
    if (!registration) {
      [registration] = await db
        .insert(ltiRegistrations)
        .values({
          institutionId: institution.id,
          issuer: args.issuer,
          clientId: args.clientId,
          oidcAuthEndpoint: args.oidcAuthEndpoint,
          tokenEndpoint: args.tokenEndpoint,
          tokenAudience: args.tokenEndpoint,
          platformJwksUri: args.platformJwksUri,
          enabled: true,
        })
        .returning();
      console.log(`Created LTI registration for issuer "${args.issuer}" / client "${args.clientId}" (${registration.id})`);
    } else {
      console.log(
        `Found existing LTI registration (${registration.id}) -- endpoints are not updated by this script; ` +
          'delete the row manually first if you need to re-seed it.',
      );
    }

    const [existingDeployment] = await db
      .select()
      .from(ltiDeployments)
      .where(and(eq(ltiDeployments.registrationId, registration.id), eq(ltiDeployments.deploymentId, args.deploymentId)))
      .limit(1);
    if (!existingDeployment) {
      const [deployment] = await db
        .insert(ltiDeployments)
        .values({ registrationId: registration.id, deploymentId: args.deploymentId, enabled: true, configuration: {} })
        .returning();
      console.log(`Created LTI deployment "${args.deploymentId}" (${deployment.id})`);
    } else {
      console.log(`Found existing LTI deployment "${args.deploymentId}" (${existingDeployment.id})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Verify it compiles and runs against local Postgres**

Run: `npm run typecheck`
Expected: passes

Run (against the local `docker-compose.yml` Postgres, with the required env vars set):
```bash
docker compose up -d
DATABASE_URL=postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker \
APP_BASE_URL=http://localhost:3000 \
ALLOWED_TARGET_LINK_URIS=http://localhost:3000/index.html \
npx tsx server/src/database/seed-registration.ts \
  --institution-slug local-smoke-test --institution-name "Local Smoke Test" \
  --issuer https://local-smoke.test --client-id smoke-client \
  --oidc-auth-endpoint https://local-smoke.test/authorize \
  --token-endpoint https://local-smoke.test/token \
  --platform-jwks-uri https://local-smoke.test/jwks \
  --deployment-id smoke-deployment
```
Expected: prints three "Created ..." lines and exits 0. Running the exact same command again prints "Found existing ..." for all three, still exits 0.

Note on database separation: this smoke seed writes to the **dev** database named by `DATABASE_URL` (`attendance_tracker`). Step 5's `npm test` run uses `TEST_DATABASE_URL`, which Task 4 pointed at the separate `attendance_tracker_test` database, so the suite's `TRUNCATE`s do **not** delete these rows. If you ever override `TEST_DATABASE_URL` to point at the dev database, expect this seed to disappear the next time you run `npm test`.

- [ ] **Step 3: Write `docs/canvas-installation.md`**

This doc is *written* in Phase 3 but is **not executed until Phase 7**: registering the tool in a
real Canvas instance needs a publicly reachable HTTPS deployment, which does not exist until Phase 7.
Phase 3's exit criterion is the automated §45 matrix against the mock Canvas platform. Content to
write (keep it in sync with the shipped file — the file is authoritative if they ever diverge):

```markdown
# Canvas registration and real-launch verification (Phase 7, post-deployment)

This is the one-time, per-institution setup that registers this tool in Canvas and the checklist for
verifying an instructor launch works end-to-end against a **real** Canvas instance.

**This step cannot run until the app is deployed.** Canvas form-POSTs a signed `id_token` to a public
HTTPS URL and redirects the instructor's browser to another one; it cannot reach `http://localhost`.
So this requires a public HTTPS deployment — i.e. **Phase 7** (spec §54) must be done first. Phase 3's
exit criterion is met entirely by `npm test` (all 24 spec §45 cases against an in-process mock Canvas
platform). The steps here are the separate real-Canvas confirmation, and the only place
`server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS` set is checked against an actual launch
payload (step 5).

## 1. Register the tool in Canvas (Admin → Apps)

Register from the account-level **Admin → Apps** page. Canvas's current Apps form collects the
redirect URI, target link URI, OIDC initiation URL, and JWK/JWKS, but does **not** expose the LTI
Advantage (NRPS/AGS) scope toggles and has **no** placement "window target" / "open in new tab"
field. Both are required here and both are JSON-only, so configure the whole tool as JSON: in
**Admin → Apps**, add the app, choose the **paste-JSON / manual JSON configuration** option (label
varies by Canvas version), and paste the block below with `<APP_BASE_URL>` replaced by your deployed
origin (e.g. `https://attendance.example.edu`, no trailing slash):

    {
      "title": "Attendance",
      "description": "Classroom attendance via a browser-connected HID card reader",
      "oidc_initiation_url": "https://<APP_BASE_URL>/lti/login",
      "target_link_uri": "https://<APP_BASE_URL>/index.html",
      "public_jwk_url": "https://<APP_BASE_URL>/lti/jwks",
      "redirect_uris": ["https://<APP_BASE_URL>/lti/launch"],
      "scopes": [
        "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
        "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
        "https://purl.imsglobal.org/spec/lti-ags/scope/score"
      ],
      "extensions": [
        {
          "platform": "canvas.instructure.com",
          "domain": "<APP_BASE_URL>",
          "privacy_level": "name_only",
          "settings": {
            "text": "Attendance",
            "placements": [
              {
                "placement": "course_navigation",
                "message_type": "LtiResourceLinkRequest",
                "target_link_uri": "https://<APP_BASE_URL>/index.html",
                "text": "Attendance",
                "windowTarget": "_blank",
                "default": "enabled",
                "visibility": "admins"
              }
            ]
          }
        }
      ]
    }

Field notes:

- **`redirect_uris` → `/lti/launch`**: where Canvas form-POSTs the signed `id_token`. If you use the
  Apps form field instead of the JSON, its value must still be exactly this.
- **`target_link_uri` → `/index.html`, not `/lti/launch`.** Canvas copies this into the launch's
  `target_link_uri`; `/lti/launch` issues a 303 to it on success. Pointing it at `/lti/launch` would
  redirect the launch endpoint to itself. Must also appear verbatim in `ALLOWED_TARGET_LINK_URIS`
  (step 5.1).
- **`oidc_initiation_url` → `/lti/login`; `public_jwk_url` → `/lti/jwks`** (this app publishes its own
  public keys there — do not paste a static `public_jwk`).
- **`scopes`**: spec §10 requires NRPS context-membership read-only + AGS line items read/write + AGS
  scores write, and nothing else. Not called until Phases 4/6 but the registration is reused, so
  grant now. **Confirm these three strings against Canvas's current LTI configuration reference
  (spec §58) — do not trust this file's copy over Canvas's own docs.**
- **`windowTarget: "_blank"`** on `course_navigation` is required: WebHID's Permissions Policy
  defaults to `self`, so a Canvas iframe does not get WebHID capability and the scanner must open
  top-level (spec §8). JSON-only — the main reason the config goes in as JSON.
- **`visibility: "admins"`** shows the link to admins/instructors, not learners (UI convenience only;
  the backend still validates the role claim). **`privacy_level: "name_only"`** — NRPS returns
  `lis_person_sourcedid` and names but not email (spec §10.2).

Save, toggle the resulting key/app **On**, and copy its **Client ID**.

## 2. Install it in your test course

1. In the Canvas test course: **Settings → Apps → + App → By Client ID**, paste the Client ID,
   install it, and note the generated **Deployment ID** (shown after installation).

## 3. Fetch Canvas's real endpoints

**Never derive these from the Canvas hostname by pattern-matching a URL** -- the spec explicitly
forbids this, because Canvas's actual issuer/JWKS/token endpoints do not follow a fixed pattern
across all Canvas instances. Fetch them for real:

```bash
curl -s https://<canvas-domain>/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, token_endpoint}'
curl -s https://<canvas-domain>/api/lti/security/jwks | jq '.keys | length'   # just to confirm it responds
```

Use the `authorization_endpoint` value as `--oidc-auth-endpoint`, `token_endpoint` as
`--token-endpoint`, and `https://<canvas-domain>/api/lti/security/jwks` as `--platform-jwks-uri`.

## 4. Seed the registration

Run `server/src/database/seed-registration.ts` (see its usage comment) with the issuer, client ID,
endpoints, and deployment ID gathered above, against the `DATABASE_URL` of the deployed app instance.

## 5. Verify the launch

1. Set the deployed app's `ALLOWED_TARGET_LINK_URIS` to include the exact **target link URI** you
   configured in step 1 — `https://<APP_BASE_URL>/index.html` — since that is the page `/lti/launch`
   redirects to on success. (The list may hold several entries, e.g. `/index.html,/scanner.html`; a launch is
   redirected to whichever one Canvas sent, not to the first.) Also set
   `LTI_TOOL_SIGNING_KEYS_JSON` if this isn't a
   throwaway dev instance (otherwise a restart rotates the signing key and Canvas's cached JWKS
   fetch may briefly go stale).
2. From the test course, launch **Attendance** as an instructor.
3. Confirm: a new browser tab opens (per spec §8's window-target requirement), the launch
   completes without error, the browser lands on the scanner UI, and a session cookie
   (`attendance_session`) is set.
4. Attempt or simulate a learner-role launch of the same tool (e.g. a test student account, or a
   Canvas "Student View" launch if your Canvas instance's Student View sends learner-role claims).
   Confirm it returns **HTTP 403** and does **not** set a session cookie.
5. If step 4 fails in a way that suggests Canvas's real role-claim URIs differ from
   `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS` set, capture the actual `roles`
   claim from a real launch (e.g. via a temporary debug log statement, removed before committing)
   and update that set to match -- this set was written from the standard 1EdTech role vocabulary
   but has not yet been verified against a real Canvas launch payload before this checkpoint.
```

- [ ] **Step 4: Update `docs/canvas-lti/progress.md`**

Change the Phase 3 checklist line from:

```markdown
- [ ] **Phase 3 — LTI authentication** — `/lti/login`, `/lti/launch`,
      `/lti/jwks`; OIDC transaction storage; launch validation; application
      sessions; role authorization; full security test matrix (spec §45).
      Exit criterion: valid instructor Canvas launches work, malformed/replayed
      launches fail.
```

to:

```markdown
- [ ] **Phase 3 — LTI authentication** — `/lti/login`, `/lti/launch`,
      `/lti/jwks`; OIDC transaction storage; launch validation; application
      sessions; role authorization; full security test matrix (spec §45).
      Exit criterion: all 24 §45 cases pass against the in-process mock Canvas
      platform (`npm test`). Real-Canvas registration and instructor/learner
      launch verification (docs/canvas-installation.md) needs a public HTTPS
      deployment and is a **Phase 7** post-deploy step — it does not gate this
      checkbox.
```

Then append a new subsection right after the existing "## Phase 2 — what actually happened" section (before "## Deferred decisions"):

```markdown
## Phase 3 — what actually happened (automated portion)

- `server/src/lti/`, `server/src/auth/`, `server/src/database/`, and `server/src/config/` added
  per `docs/superpowers/plans/2026-08-26-canvas-lti-phase3-lti-authentication.md`. Hand-rolled LTI
  1.3 orchestration on `jose` rather than a maintained LTI framework: the available Node ones own
  their own datastore, session model, and Express-style routing, which would fight this repo's
  Fastify + Drizzle conventions and hide the very validation steps spec §45 requires us to test
  case by case. Drizzle ORM + PostgreSQL via the existing `docker-compose.yml` service.
- All 24 spec §45 test-matrix cases have a passing automated test against an in-process mock Canvas
  platform (`server/tests/support/mock-canvas.ts`, a real second Fastify server, not a mocked
  `fetch`). Every failure case asserts no `app_sessions` row was created: the 21 launch-time
  failure cases through a `SELECT` count of zero in `server/tests/lti/launch.test.ts`, and case 24
  (target-link open-redirect) structurally in `server/tests/routes/lti-login.test.ts`, since
  `/lti/login` rejects before writing an OIDC transaction and has no session-creation path at all.
  Cases 1 and 12 are success cases and do create a session.
- `GET /lti/jwks` publishes this app's own public signing keys (active + previous, env-configured
  or an ephemeral dev fallback); `POST /lti/login` and `POST /lti/launch` implement the full OIDC
  login/launch flow; `GET /api/me` returns the spec §25.1 bootstrap shape.
- **`POST /api/scans` is deliberately left unauthenticated in Phase 3**, exactly as Phase 2 shipped
  it. Phase 3 adds endpoints beside it and introduces no new exposure; the existing browser UI and
  the standalone dev mode (spec §51, which performs no LTI launch) both still call it without a
  session. Phase 5 retires it in favour of `POST /api/attendance-sessions/{id}/scans` behind
  `requireSession` + `requireCsrf` and migrates the UI at the same time.
- **Deferred to Phase 7 (needs a public HTTPS deployment):** the real-Canvas registration and
  instructor/learner launch verification in `docs/canvas-installation.md`. `server/src/lti/roles.ts`'s
  `AUTHORIZED_INSTRUCTOR_ROLE_URIS` set is written from the standard 1EdTech role vocabulary but is
  explicitly flagged there as unverified against a real Canvas launch payload until that manual
  step runs.
```

- [ ] **Step 5: Run the full suite one last time**

Run: `docker compose up -d && npm test && npm run lint && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/database/seed-registration.ts docs/canvas-installation.md docs/canvas-lti/progress.md
git commit -m "docs: add seed-registration CLI, Canvas registration guide, and Phase 3 progress note"
```

---

## Definition of Done for this plan

- [ ] All 24 §45 test-matrix cases pass automatically against the mock Canvas platform. Coverage lives in Tasks 12 and 15-23 for the 21 launch-time cases plus the two success cases, and in Tasks 13 and 14 for case 24 (target-link open-redirect), which is a login-time rejection.
- [ ] Every §45 **failure** case asserts that no `app_sessions` row was created — the 21 launch-time ones via a zero-row count in Task 23's dedicated tests and sweep, and case 24 via Task 14's "no transaction created, no session code path" assertions. (Cases 1 and 12 are success cases and legitimately create one session each.)
- [ ] `npm test`, `npm run lint`, `npm run typecheck` are all clean — with Postgres running, and with `npm test` writing only to `attendance_tracker_test`, never to the dev database.
- [ ] `GET /lti/jwks` never exposes private key material (Tasks 7, 8).
- [ ] Learner-only launches return HTTP 403 and create no session (Tasks 17, 22-24).
- [ ] Every other failure case returns HTTP 400 and creates no session.
- [ ] `GET /api/me` returns the exact spec §25.1 shape and leaks no secrets (Task 26).
- [ ] Security headers (CSP incl. Canvas OIDC `form-action`, `Permissions-Policy: hid=(self)`, no `upgrade-insecure-requests` on http) and rate limiting are wired into the real app (Task 27).
- [ ] A successful launch redirects to the transaction's own `target_link_uri`, so every entry in a multi-entry `ALLOWED_TARGET_LINK_URIS` is reachable (Tasks 23, 24).
- [ ] `docs/canvas-installation.md` and `seed-registration.ts` exist and work against local Postgres (Task 28).

**Explicitly deferred out of this plan (documented, not implemented):**

- Spec §31.9's *request correlation ID on error responses*. Every error payload this plan produces is already a bare `{ error: '<reason>' }` with no stack trace, SQL, hostname, secret, or JWT in it, which satisfies the rest of §31.9. Attaching Fastify's `request.id` would mean touching the error shape of all five new routes plus `scans.ts`, and re-asserting it across every route test — for a diagnostic that only pays off once structured logging and log aggregation exist. Deferred to Phase 8 hardening, alongside the logging work.
- Spec §17.2's *configurable overlap/retention period* for previous signing keys — rotation stays env-driven in Phase 3 (see Task 6).
- Spec §26's `courses.nrps_url` / `ags_lineitems_url` / `last_launched_at` — added by Phase 4's migration (see Task 3).
- Authentication on `POST /api/scans` — deliberately unchanged in Phase 3; Phase 5 replaces the route (see Task 27 Step 3).

- [ ] **Not part of this plan's automated tasks, and NOT a gate on checking Phase 3 off:** the
  real-Canvas registration and instructor/learner launch verification described in
  `docs/canvas-installation.md`. It needs a publicly reachable HTTPS deployment (Phase 7) and is
  listed as a Phase 7 post-deploy step in `docs/canvas-lti/progress.md`. Phase 3 is done when the
  §45 matrix above passes against the mock platform.
