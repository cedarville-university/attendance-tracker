# Canvas LTI Phase 7 — Infrastructure and CI/CD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 0–6 application (runnable today only via `tsx` against a local Docker Postgres) into a deployable, observable, CI/CD-delivered service on Azure Container Apps, then perform the real-Canvas registration and launch verification that every earlier phase deferred.

**Architecture:** Executed inside-out across 8 milestones — (M1) npm workspaces + a real `tsc → dist/` production build, (M2) a testable `buildApp(env, deps)` Fastify factory with `/health/{live,ready}` + graceful SIGTERM + `security/` & `telemetry/` modules, (M3) a multi-stage Dockerfile + a Playwright end-to-end harness, (M4) Bicep for dev/stage/prod, (M5) a PR CI workflow + an OIDC-federated `deploy-dev` workflow, (M6) a `deploy-stage` workflow + OpenTelemetry/App Insights wiring, (M7) the real-Canvas verification gate against staging, (M8) authored-but-not-run production delivery. Nothing touches Azure until the container image is proven locally; the Bicep container-app module is written only after M2 fixes the env-var / port / health surface.

**Tech Stack:** Node.js 22 LTS, TypeScript, Fastify 5, `jose`, Zod, PostgreSQL + Drizzle ORM, Vitest, Playwright, pino (structured JSON logging), `@azure/monitor-opentelemetry` (OpenTelemetry → Application Insights), Docker (multi-stage), Bicep, GitHub Actions with Azure OIDC federation, Azure Container Apps + Container Apps Jobs, Azure Database for PostgreSQL Flexible Server, Azure Key Vault + user-assigned Managed Identity, Azure Container Registry, Log Analytics.

## Global Constraints

- **Branch base:** a fresh worktree off the current HEAD of `worktree-canvas-lti-phase0` (`bcd885c`) via `superpowers:using-git-worktrees` — **NOT** `main`. Phases 0–6 have not landed on `main`; that merge is a separate decision, out of scope here.
- **Tests need Postgres:** `docker compose up -d postgres` (compose project `canvas-lti-phase0`) before `npm test`. The suite creates and migrates a separate `attendance_tracker_test` database automatically.
- **Green bar at every commit:** `npm test` (currently 373 tests / 52 files), `npm run lint`, `npm run typecheck` all pass. Never commit red.
- **Never stage `.DS_Store`.** Never stage `.env`, signing-key material, or real secrets.
- **Runtime = Node 22 LTS.** Docker base image `node:22-bookworm-slim`.
- **Image tags = Git commit SHA only** (spec §35.5). Never build, push, or deploy `latest`.
- **No long-lived Azure credential in GitHub** (spec §41). Deployment auth is GitHub→Azure OIDC federation only; workflows declare `permissions: { contents: read, id-token: write }`.
- **No secret values in IaC** (spec §36). `.bicepparam` files hold only non-secret parameters; secret *values* are seeded into Key Vault out of band and referenced by `keyVaultUrl` + Managed Identity.
- **`/health/ready` must never depend on Canvas reachability** (spec §38). It checks process config + database only.
- **Structured logs never contain** names, student IDs, raw card codes, tokens, signing-key material, or Canvas service URLs (spec §31.8, §31.9, §44). Use the safe-field allowlist.
- **Repo:** `cedarville-university/attendance-tracker`. Default branch `main`.
- **Design of record:** `docs/superpowers/specs/2026-08-29-canvas-lti-phase7-infra-cicd-design.md`. Spec: `docs/canvas-lti/spec.md` §6, §35–§44, §46, §54 (Phase 7). Real-Canvas checklist: `docs/canvas-installation.md`.
- **Decisions locked (do not re-litigate):** full Azure access — deploy dev + stage; live Canvas test/beta available; **real ProxID resolver from first deploy** (real `IDENTITY_API_*` in dev + stage Key Vault; `MockIdentityResolver` stays the local default); npm workspaces `["server", "packages/*"]`, `web/` stays static, `packages/shared/` not created yet; migrations run as a **separate GitHub Actions runner job** with a just-in-time Postgres firewall rule; backlog item 6.1 (AGS line-item origin check) folded in; the five `docs/*.md` deliverables and the `service-url.ts`/`csrf.ts` relocation deferred to Phase 8; real-Canvas gate runs against **staging**; production is authored only. **[AMENDED 2026-08-31 — see `.superpowers/sdd/progress.md` "PLAN CHANGE 2026-08-31": Phase 7 collapses to TWO environments (`dev` + `prod`, no `stage`); `dev` runs the real ProxID resolver and is `v*`-tag-triggered; the real-Canvas gate runs against `dev`. Tasks 21–23 below are HISTORICAL — the operative specs are `.superpowers/sdd/task-2{1,2,3}-brief.md`.]**
- **Infra-as-code / workflow tasks are not classic TDD.** Their "test" is a validation command (`az bicep build`, `az deployment group what-if`, `actionlint`) or a live deploy + smoke check, called out explicitly per task.

---

## File Structure

**M1 — workspaces & build**
- `package.json` (modify) — add `workspaces`, move runtime deps out, make scripts delegate.
- `server/package.json` (create) — `@attendance/server`; owns runtime deps; `dev`/`build`/`start`/`start:worker`/`migrate` scripts.
- `server/tsconfig.json` (create) — extends root base.
- `server/tsconfig.build.json` (create) — emits `server/dist/`.
- `tsconfig.json` (modify) — stays `noEmit` typecheck-all base.
- `drizzle.config.ts` (modify) — `out` → `./server/migrations`.
- `migrations/**` → `server/migrations/**` (git mv).
- `server/src/database/client.ts` (modify) — resolve `migrationsFolder` from module location.
- `server/src/config/env.ts` (modify) — add `RUN_MIGRATIONS_ON_BOOT`.
- `server/src/migrate.ts` (create) — standalone migration entrypoint.
- `server/src/index.ts` / `server/src/worker.ts` (modify) — gate `applyMigrations` on `RUN_MIGRATIONS_ON_BOOT`.
- `server/tests/database/migrate-path.test.ts` (create).
- `server/tests/config/env.test.ts` (modify or create) — `RUN_MIGRATIONS_ON_BOOT` default logic.

**M2 — app factory / health / shutdown / security / telemetry**
- `server/src/security/csp.ts` (create) — `buildCspDirectives`.
- `server/src/security/same-origin.ts` (create) — `assertSameOrigin`.
- `server/src/lti/ags.ts` (modify) — call `assertSameOrigin` before trusting a Canvas line-item URL.
- `server/src/telemetry/logger.ts` (create) — pino options, redaction, `safeLogFields`.
- `server/src/telemetry/request-id.ts` (create) — `genReqId`, access-log + HTTP-metrics `onResponse` hook.
- `server/src/telemetry/metrics.ts` (create) — OTel meter + spec §44 instruments.
- `server/src/telemetry/otel.ts` (create) — `startTelemetry(env)` (Azure Monitor distro; no-op without a connection string).
- `server/src/app.ts` (create) — `buildApp(env, deps): Promise<FastifyInstance>`.
- `server/src/lifecycle.ts` (create) — `installShutdownHandlers(app, pool)`.
- `server/src/index.ts` (modify) — shrink to composition root + lifecycle.
- `server/src/worker.ts` (modify) — SIGTERM abort flag; maintenance pass.
- `server/src/attendance/grade-worker.ts` (modify) — `shouldStop?` in `ProcessGradeSyncJobsDeps`.
- `server/src/maintenance/purge.ts` (create) — `purgeExpiredOidcTransactions`, `purgeExpiredAppSessions`, `applyRetention` (flag-gated stub).
- `server/src/config/env.ts` (modify) — add `RETENTION_DAYS` (optional).
- `server/tests/app.test.ts` (create).
- `server/tests/security/csp.test.ts`, `server/tests/security/same-origin.test.ts` (create).
- `server/tests/lti/ags-origin.test.ts` (create).
- `server/tests/telemetry/logger.test.ts` (create).
- `server/tests/lifecycle.test.ts` (create).
- `server/tests/maintenance/purge.test.ts` (create).
- `server/tests/routes/hardening.test.ts` (modify) — delete the hand-copied CSP block.

**M3 — image & e2e**
- `Dockerfile` (create), `.dockerignore` (create).
- `playwright.config.ts` (create).
- `e2e/instructor-flow.spec.ts` (create), `e2e/support/webhid-shim.ts` (create).
- `package.json` (modify) — `test:e2e` script; `@playwright/test` devDep.

**M4 — Bicep**
- `infra/azure/main.bicep`, `infra/azure/modules/{identity,registry,observability,keyvault,postgres,containerapp-env,web,worker-job,alerts}.bicep`, `infra/azure/environments/{dev,stage,prod}.bicepparam`, `infra/azure/README.md` (all create).

**M5 — PR CI + dev deploy**
- `.github/workflows/pull-request.yml` (create).
- `.github/workflows/deploy-dev.yml` (create).
- `infra/azure/README.md` (modify) — bootstrap runbook.

**M6 — staging + observability**
- `.github/workflows/deploy-stage.yml` (create).

**M7 — real-Canvas gate**
- `docs/canvas-lti/progress.md` (modify) — Phase 7 outcomes.
- `server/src/lti/roles.ts` (modify, if the real `roles` array differs).

**M8 — production authoring**
- `.github/workflows/deploy-prod.yml` (create).
- `infra/azure/environments/prod.bicepparam` (already created in M4; values finalised here).
- `docs/canvas-lti/progress.md` (modify) — mark Phase 7 complete.

---

## Task 1: npm workspaces skeleton and delegating scripts

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/tsconfig.build.json`
- Modify: `package.json` (root)
- Modify: `tsconfig.json` (root)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm -w @attendance/server run build` emits `server/dist/`; root `npm run build|start|dev|worker|migrate` delegate to the `@attendance/server` workspace; root `npm test|lint|typecheck` unchanged in behaviour.

- [ ] **Step 1: Write the failing test** — a shell assertion, since this task is packaging. Create `server/package.json`'s expected contract as a check:

```bash
# Run from repo root — expected to FAIL now (no server/package.json, no build script)
test -f server/package.json && npm run build --silent && test -f server/dist/index.js && echo "PASS: build emits dist"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash -c 'test -f server/package.json && npm run build --silent && test -f server/dist/index.js && echo PASS'`
Expected: FAIL — `server/package.json` does not exist; `npm run build` is not a script.

- [ ] **Step 3: Create `server/package.json`**

```json
{
  "name": "@attendance/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "dev:worker": "tsx watch src/worker.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "start:worker": "node dist/worker.js",
    "migrate": "node dist/migrate.js"
  },
  "dependencies": {
    "@azure/monitor-opentelemetry": "^1.8.0",
    "@fastify/cookie": "^11.1.2",
    "@fastify/formbody": "^9.0.0",
    "@fastify/helmet": "^13.1.1",
    "@fastify/rate-limit": "^11.2.0",
    "@fastify/static": "^10.1.3",
    "@opentelemetry/api": "^1.9.0",
    "drizzle-orm": "^0.45.2",
    "fastify": "^5.12.1",
    "jose": "^6.2.10",
    "pg": "^8.23.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/pg": "^8.23.1",
    "tsx": "^4.23.12"
  }
}
```

- [ ] **Step 4: Create `server/tsconfig.json`** (editor + typecheck for the workspace)

```json
{
  "extends": "../tsconfig.json",
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 5: Create `server/tsconfig.build.json`** (emit `dist/`, exclude tests)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["tests/**", "dist/**"]
}
```

- [ ] **Step 6: Modify root `package.json`** — add `workspaces`, remove the runtime `dependencies` block (they move to `server/`), keep shared dev tooling, make scripts delegate. Full new file:

```json
{
  "name": "attendance-tracker",
  "private": true,
  "type": "module",
  "workspaces": ["server", "packages/*"],
  "scripts": {
    "dev": "RUN_MIGRATIONS_ON_BOOT=true npm -w @attendance/server run dev",
    "worker": "RUN_MIGRATIONS_ON_BOOT=true npm -w @attendance/server run start:worker",
    "build": "npm -w @attendance/server run build",
    "start": "npm -w @attendance/server run start",
    "start:worker": "npm -w @attendance/server run start:worker",
    "migrate": "npm -w @attendance/server run migrate",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@eslint/js": "^9.19.0",
    "@playwright/test": "^1.49.1",
    "@types/node": "^26.3.0",
    "drizzle-kit": "^0.31.10",
    "eslint": "^9.19.0",
    "eslint-config-prettier": "^9.1.0",
    "globals": "^15.14.0",
    "prettier": "^3.4.2",
    "tsx": "^4.23.12",
    "typescript": "^5.7.3",
    "typescript-eslint": "^8.68.0",
    "vitest": "^3.0.4"
  }
}
```

Notes: `tsx` stays in BOTH root (used by `vitest`, config files) and `server` devDeps (used by `server`'s own `dev` script); npm dedupes it. `drizzle-kit` stays at root (it reads root `drizzle.config.ts`). `@types/pg` moves to `server`. `@playwright/test` added at root (M3 needs it; add now so one `npm install` covers it). `dev`/`worker` root scripts set `RUN_MIGRATIONS_ON_BOOT=true` so local runs still auto-migrate once Task 3 lands (harmless until then).

- [ ] **Step 7: Modify root `tsconfig.json`** — keep it as the typecheck-all base; it must still compile because `server/tsconfig*.json` extend it. Full new file:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["server/src/**/*.ts", "server/tests/**/*.ts", "*.ts"]
}
```

(Unchanged from today — documented here so the implementer confirms it is left intact and that `server/tsconfig.build.json`'s `noEmit: false` + `outDir`/`rootDir` override it.)

- [ ] **Step 8: Reinstall and rebuild the workspace graph**

Run: `rm -rf node_modules package-lock.json && npm install`
Expected: one root `package-lock.json` regenerated covering both the root and `@attendance/server`; `npm ls @attendance/server` shows the workspace linked.

- [ ] **Step 9: Run the Step-1 assertion — now expected to PASS**

Run: `npm run build && test -f server/dist/index.js && echo "PASS: build emits dist"`
Expected: `server/dist/index.js` exists (compiled from `server/src/index.ts`). (It will still `await applyMigrations` unconditionally — Task 3 fixes that.)

- [ ] **Step 10: Full green bar**

Run: `docker compose up -d postgres && npm test && npm run lint && npm run typecheck`
Expected: 373 tests pass, lint clean, typecheck clean. If `vitest`/`eslint` resolution breaks because of the workspace move, confirm `vitest.config.ts` and `eslint.config.js` are still at repo root and unmodified (they are — they glob `server/tests/**` and `server/**/*.ts` by path, not by package).

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json server/package.json server/tsconfig.json server/tsconfig.build.json
git commit -m "build(phase7): introduce npm workspaces and a real tsc build path

Root package.json gains workspaces [\"server\", \"packages/*\"]; runtime deps
move to @attendance/server. New server/tsconfig.build.json emits server/dist/.
Root scripts delegate to the workspace.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 2: Relocate migrations into the workspace; make `applyMigrations` cwd-independent

**Files:**
- Move: `migrations/**` → `server/migrations/**` (`git mv`, preserves the `meta/` journal)
- Modify: `drizzle.config.ts` — `out: './server/migrations'`
- Modify: `server/src/database/client.ts` — resolve `migrationsFolder` from `import.meta.url`
- Create: `server/tests/database/migrate-path.test.ts`

**Interfaces:**
- Consumes: Task 1's workspace layout.
- Produces: `applyMigrations(client)` finds the SQL regardless of `process.cwd()` — works from `vitest` (cwd = repo root), from `node server/dist/migrate.js`, and from the Docker WORKDIR. In the built image the migrations directory sits at `server/dist/migrations/` (Task 13's Dockerfile copies it there); in source/test it is `server/migrations/`. The resolution `new URL('../../migrations', import.meta.url)` yields `server/migrations` from `server/src/database/client.ts` and `server/dist/migrations` from `server/dist/database/client.js`.

- [ ] **Step 1: Write the failing test** — `server/tests/database/migrate-path.test.ts`

```ts
// server/tests/database/migrate-path.test.ts
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { resolveMigrationsFolder } from '../../src/database/client.js';

describe('resolveMigrationsFolder', () => {
  it('resolves to a directory that exists and contains the initial migration + meta journal', () => {
    const folder = resolveMigrationsFolder();
    expect(existsSync(folder)).toBe(true);
    const entries = readdirSync(folder);
    expect(entries).toContain('meta');
    expect(entries.some((e) => /^0000_.*\.sql$/.test(e))).toBe(true);
  });

  it('is an absolute path, not cwd-relative', () => {
    const folder = resolveMigrationsFolder();
    expect(folder.startsWith('/')).toBe(true);
    // sanity: it lives under a `server` directory in source layout
    expect(fileURLToPath(new URL('.', import.meta.url))).toContain('/server/');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/database/migrate-path.test.ts`
Expected: FAIL — `resolveMigrationsFolder` is not exported from `client.ts`.

- [ ] **Step 3: `git mv` the migrations directory**

```bash
git mv migrations server/migrations
```

Expected: `server/migrations/0000_lethal_rockslide.sql` … `0004_outgoing_speedball.sql` and `server/migrations/meta/` now exist; `migrations/` at repo root is gone.

- [ ] **Step 4: Modify `drizzle.config.ts`** — change only the `out` line:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/src/database/schema.ts',
  out: './server/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker',
  },
});
```

- [ ] **Step 5: Modify `server/src/database/client.ts`** — full new file:

```ts
// server/src/database/client.ts
import { fileURLToPath } from 'node:url';
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

// Resolve the migrations directory from THIS module's location, never from process.cwd():
//  - source/tests   server/src/database/client.ts  -> ../../migrations = server/migrations
//  - built image    server/dist/database/client.js -> ../../migrations = server/dist/migrations
// Task 13's Dockerfile copies server/migrations -> server/dist/migrations so the built path exists.
export function resolveMigrationsFolder(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

export async function applyMigrations(client: DbClient): Promise<void> {
  await migrate(client.db, { migrationsFolder: resolveMigrationsFolder() });
}
```

- [ ] **Step 6: Run the new test — expected PASS**

Run: `npx vitest run server/tests/database/migrate-path.test.ts`
Expected: PASS.

- [ ] **Step 7: Full green bar** (the global setup migrates the test DB via `applyMigrations` — this proves the new resolution works end to end)

Run: `npm test && npm run lint && npm run typecheck`
Expected: 374 tests pass (373 + 2 new − 1 file-count bookkeeping is fine), lint clean, typecheck clean.

- [ ] **Step 8: Confirm `drizzle-kit` still sees the migrations** (no spurious diff)

Run: `npx drizzle-kit generate --name phase7_noop_check` then inspect: it must report "No schema changes, nothing to migrate" (or produce an empty migration you immediately delete). If it emits a real migration, the schema import path in `drizzle.config.ts` is wrong — stop and fix.
Cleanup: `rm -f server/migrations/*phase7_noop_check*` and restore `server/migrations/meta/_journal.json` with `git checkout server/migrations/meta` if `generate` touched it.

- [ ] **Step 9: Commit**

```bash
git add server/migrations drizzle.config.ts server/src/database/client.ts server/tests/database/migrate-path.test.ts
git commit -m "build(phase7): move migrations into the server workspace, resolve folder from module path

git mv migrations -> server/migrations. applyMigrations now resolves the
folder from import.meta.url instead of process.cwd(), so it works from
vitest, from node dist/migrate.js, and from the container WORKDIR.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 3: `server/src/migrate.ts` entrypoint + `RUN_MIGRATIONS_ON_BOOT` gate

**Files:**
- Create: `server/src/migrate.ts`
- Modify: `server/src/config/env.ts` — add `RUN_MIGRATIONS_ON_BOOT`
- Modify: `server/src/index.ts` — gate the boot-time `applyMigrations` call
- Modify: `server/src/worker.ts` — gate the boot-time `applyMigrations` call
- Create: `server/tests/config/env.test.ts` (if it does not already exist; otherwise modify)

**Interfaces:**
- Consumes: `loadEnv()` from `config/env.ts`; `createDbClient`, `applyMigrations` from `database/client.ts`.
- Produces: `node dist/migrate.js` applies all pending migrations then exits `0` (or `1` on failure) — this is what the CI migrate job (Task 19) runs and what `npm run migrate` runs locally. `Env.RUN_MIGRATIONS_ON_BOOT: boolean` — defaults to `true` when `NODE_ENV !== 'production'`, `false` otherwise; `index.ts`/`worker.ts` only call `applyMigrations` at boot when it is `true`.

- [ ] **Step 1: Write the failing test** — `server/tests/config/env.test.ts`

```ts
// server/tests/config/env.test.ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_BASE_URL: 'https://app.test',
  ALLOWED_TARGET_LINK_URIS: 'https://app.test/index.html',
};

describe('RUN_MIGRATIONS_ON_BOOT', () => {
  it('defaults to true when NODE_ENV is not production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(env.RUN_MIGRATIONS_ON_BOOT).toBe(true);
  });

  it('defaults to false when NODE_ENV is production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'production' });
    expect(env.RUN_MIGRATIONS_ON_BOOT).toBe(false);
  });

  it('honours an explicit "false" even outside production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development', RUN_MIGRATIONS_ON_BOOT: 'false' });
    expect(env.RUN_MIGRATIONS_ON_BOOT).toBe(false);
  });

  it('honours an explicit "true" in production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'production', RUN_MIGRATIONS_ON_BOOT: 'true' });
    expect(env.RUN_MIGRATIONS_ON_BOOT).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/config/env.test.ts`
Expected: FAIL — `RUN_MIGRATIONS_ON_BOOT` is `undefined` on the parsed env.

- [ ] **Step 3: Modify `server/src/config/env.ts`** — add the field. Full new file:

```ts
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Normalize to the bare origin (scheme + host + port, no path, no trailing
  // slash). Browsers send an `Origin` header with no path, and csrf.ts's
  // verifyOrigin is an exact-string compare -- a configured `https://host/`
  // would 403 every protected mutation. login.ts also concatenates
  // `${appBaseUrl}/lti/launch`, which a trailing slash turns into `//`.
  APP_BASE_URL: z
    .string()
    .url()
    .transform((v) => new URL(v).origin),
  ALLOWED_TARGET_LINK_URIS: z.string().min(1),
  LTI_TOOL_SIGNING_KEYS_JSON: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  CLOCK_SKEW_SECONDS: z.coerce.number().int().positive().default(120),
  LOGIN_TRANSACTION_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  APP_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
  NODE_ENV: z.string().optional(),
  // Boot-time schema migration. Unset -> true unless NODE_ENV=production (see refine below).
  // In Azure the runtime image sets NODE_ENV=production, so web/worker never migrate at boot;
  // only the CI migrate job (node dist/migrate.js) touches schema. Local `npm run dev`/`worker`
  // set this true explicitly.
  RUN_MIGRATIONS_ON_BOOT: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // Optional retention window for maintenance/purge (spec §34). Unset -> retention sweep is a no-op.
  RETENTION_DAYS: z.coerce.number().int().positive().optional(),
});

const withDefaults = envSchema.transform((env) => ({
  ...env,
  RUN_MIGRATIONS_ON_BOOT:
    env.RUN_MIGRATIONS_ON_BOOT ?? env.NODE_ENV !== 'production',
}));

export type Env = z.infer<typeof withDefaults>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = withDefaults.safeParse(source);
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

- [ ] **Step 4: Run the env test — expected PASS**

Run: `npx vitest run server/tests/config/env.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Create `server/src/migrate.ts`**

```ts
// server/src/migrate.ts
//
// Standalone schema-migration entrypoint (spec §39). Applies all pending migrations then exits.
// Run by:
//   - the CI deploy workflow's dedicated `migrate` job (node dist/migrate.js) — spec §39 requires
//     migrations to be a separate deployment step, not a race between app replicas at boot;
//   - `npm run migrate` locally.
// Needs only DATABASE_URL from the environment.

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const client = createDbClient(env.DATABASE_URL);
  try {
    await applyMigrations(client);
    // Tally line only — no connection string, no schema detail (spec §31.8).
    console.log('[migrate] all pending migrations applied');
  } finally {
    await client.pool.end();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[migrate] failed', err instanceof Error ? err.message : 'unknown error');
    process.exit(1);
  },
);
```

- [ ] **Step 6: Modify `server/src/index.ts`** — replace the unconditional line 32–35 region. Change:

```ts
const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
await applyMigrations(dbClient);
const { db } = dbClient;
```

to:

```ts
const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}
const { db } = dbClient;
```

(Leave the rest of `index.ts` untouched in this task — Task 9 restructures it around `buildApp`.)

- [ ] **Step 7: Modify `server/src/worker.ts`** — change:

```ts
const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
await applyMigrations(dbClient);
const { db, pool } = dbClient;
```

to:

```ts
const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}
const { db, pool } = dbClient;
```

Also update the stale comment block at the top of `worker.ts` (lines 8–12): replace "Phase 7 decides whether the web or the worker owns `applyMigrations` at deploy time" with "In deployed environments a dedicated CI job runs `node dist/migrate.js`; the worker only migrates at boot when `RUN_MIGRATIONS_ON_BOOT` is set (local dev)."

- [ ] **Step 8: Manual verification of `migrate.ts`** against the local dev DB

Run:
```bash
docker compose up -d postgres
DATABASE_URL='postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker' \
  npm run build && \
DATABASE_URL='postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker' \
  node server/dist/migrate.js
```
Expected: prints `[migrate] all pending migrations applied`, exits 0. Run it a second time — still exits 0 (idempotent), no error.

- [ ] **Step 9: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green. Existing tests that call `loadEnv(...)` with a fixture object still pass because every new field is optional/defaulted.

- [ ] **Step 10: Commit**

```bash
git add server/src/migrate.ts server/src/config/env.ts server/src/index.ts server/src/worker.ts server/tests/config/env.test.ts
git commit -m "feat(phase7): standalone migrate entrypoint + RUN_MIGRATIONS_ON_BOOT gate

node dist/migrate.js applies pending migrations then exits (spec §39 — a
separate deploy step, not a replica race). index.ts/worker.ts only migrate
at boot when RUN_MIGRATIONS_ON_BOOT is set; it defaults on outside
production and off (NODE_ENV=production) in the container image.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M1 checkpoint

From a clean checkout: `rm -rf node_modules && npm install && docker compose up -d postgres && npm run build && npm test && npm run lint && npm run typecheck` — all green; `node server/dist/index.js` boots and serves; `node server/dist/migrate.js` is idempotent.

---

## Task 4: Extract `buildCspDirectives` into `server/src/security/csp.ts`

**Files:**
- Create: `server/src/security/csp.ts`
- Create: `server/tests/security/csp.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildCspDirectives(appBaseUrl: string, canvasOidcOrigins: string[]): Record<string, string[] | null>` — the exact directive object `index.ts` currently builds inline (lines 63–80). Consumed by Task 9's `buildApp`.

- [ ] **Step 1: Write the failing test** — `server/tests/security/csp.test.ts`

```ts
// server/tests/security/csp.test.ts
import { describe, it, expect } from 'vitest';
import { buildCspDirectives } from '../../src/security/csp.js';

describe('buildCspDirectives', () => {
  it('locks down default/script/style/connect to self and denies object/base/frame-ancestors', () => {
    const d = buildCspDirectives('https://app.test', []);
    expect(d.defaultSrc).toEqual(["'self'"]);
    expect(d.scriptSrc).toEqual(["'self'"]);
    expect(d.styleSrc).toEqual(["'self'"]);
    expect(d.connectSrc).toEqual(["'self'"]);
    expect(d.objectSrc).toEqual(["'none'"]);
    expect(d.baseUri).toEqual(["'none'"]);
    expect(d.frameAncestors).toEqual(["'none'"]);
  });

  it('adds the configured Canvas OIDC origins to form-action after self', () => {
    const d = buildCspDirectives('https://app.test', ['https://canvas.test', 'https://canvas-beta.test']);
    expect(d.formAction).toEqual(["'self'", 'https://canvas.test', 'https://canvas-beta.test']);
  });

  it('removes upgrade-insecure-requests for an http base url, keeps helmet default for https', () => {
    expect(buildCspDirectives('http://localhost:3000', []).upgradeInsecureRequests).toBeNull();
    expect('upgradeInsecureRequests' in buildCspDirectives('https://app.test', [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/security/csp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/security/csp.ts`**

```ts
// server/src/security/csp.ts
//
// Content-Security-Policy directives for @fastify/helmet (spec §31.3). Extracted verbatim from the
// inline block that lived in server/src/index.ts through Phase 6 so it can be unit-tested and so
// server/tests/routes/hardening.test.ts no longer needs a hand-maintained copy.

export function buildCspDirectives(
  appBaseUrl: string,
  canvasOidcOrigins: string[],
): Record<string, string[] | null> {
  const directives: Record<string, string[] | null> = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    // Spec §31.3: `form-action 'self' <configured Canvas OIDC destinations>`. 'self' covers
    // APP_BASE_URL; the extra entries are the origins of the oidc_auth_endpoint values in
    // lti_registrations -- /lti/login redirects the browser there and Canvas form-POSTs the
    // launch back to /lti/launch.
    formAction: ["'self'", ...canvasOidcOrigins],
    frameAncestors: ["'none'"],
  };
  if (!appBaseUrl.startsWith('https://')) {
    // Helmet's default CSP adds `upgrade-insecure-requests`, which rewrites every
    // http://localhost:3000 request to https:// and breaks local HTTP dev. `null` removes one of
    // helmet's own defaults.
    directives.upgradeInsecureRequests = null;
  }
  return directives;
}
```

- [ ] **Step 4: Run the test — expected PASS**

Run: `npx vitest run server/tests/security/csp.test.ts`
Expected: PASS.

- [ ] **Step 5: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green. `index.ts` still has its inline copy — Task 9 removes it. No behaviour change yet.

- [ ] **Step 6: Commit**

```bash
git add server/src/security/csp.ts server/tests/security/csp.test.ts
git commit -m "refactor(phase7): extract buildCspDirectives into server/src/security/csp.ts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 5: `assertSameOrigin` in `server/src/security/same-origin.ts`

**Files:**
- Create: `server/src/security/same-origin.ts`
- Create: `server/tests/security/same-origin.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `assertSameOrigin(candidateUrl: string, anchorUrl: string): void` — throws `Error` with message `same-origin:mismatch` unless `new URL(candidateUrl).origin === new URL(anchorUrl).origin`; throws `same-origin:unparseable` if either argument is not a valid absolute URL. Consumed by Task 6 (`ags.ts`).

- [ ] **Step 1: Write the failing test** — `server/tests/security/same-origin.test.ts`

```ts
// server/tests/security/same-origin.test.ts
import { describe, it, expect } from 'vitest';
import { assertSameOrigin } from '../../src/security/same-origin.js';

describe('assertSameOrigin', () => {
  it('passes when scheme, host and port all match', () => {
    expect(() =>
      assertSameOrigin('https://canvas.test/api/lti/courses/1/line_items/9', 'https://canvas.test/api/lti/courses/1/line_items'),
    ).not.toThrow();
  });

  it('throws same-origin:mismatch on a different host', () => {
    expect(() =>
      assertSameOrigin('https://evil.test/line_items/9', 'https://canvas.test/api/lti/courses/1/line_items'),
    ).toThrow('same-origin:mismatch');
  });

  it('throws same-origin:mismatch on a different port', () => {
    expect(() => assertSameOrigin('https://canvas.test:8443/x', 'https://canvas.test/x')).toThrow('same-origin:mismatch');
  });

  it('throws same-origin:mismatch on a different scheme', () => {
    expect(() => assertSameOrigin('http://canvas.test/x', 'https://canvas.test/x')).toThrow('same-origin:mismatch');
  });

  it('throws same-origin:unparseable when an argument is not an absolute URL', () => {
    expect(() => assertSameOrigin('/relative/path', 'https://canvas.test/x')).toThrow('same-origin:unparseable');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/security/same-origin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/security/same-origin.ts`**

```ts
// server/src/security/same-origin.ts
//
// Backlog item 6.1: before the grade worker sends a bearer-token AGS Score POST to a line-item URL
// that Canvas returned in a response body, confirm that URL is on the SAME ORIGIN as the
// launch-persisted courses.ags_lineitems_url (the SSRF trust anchor -- spec §31.7). A compromised
// or buggy Canvas-shaped response could otherwise redirect a valid AGS bearer token to an
// attacker origin.

export function assertSameOrigin(candidateUrl: string, anchorUrl: string): void {
  let candidate: URL;
  let anchor: URL;
  try {
    candidate = new URL(candidateUrl);
    anchor = new URL(anchorUrl);
  } catch {
    throw new Error('same-origin:unparseable');
  }
  if (candidate.origin !== anchor.origin) {
    throw new Error('same-origin:mismatch');
  }
}
```

- [ ] **Step 4: Run the test — expected PASS**

Run: `npx vitest run server/tests/security/same-origin.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/security/same-origin.ts server/tests/security/same-origin.test.ts
git commit -m "feat(phase7): assertSameOrigin helper for the AGS line-item origin check (backlog 6.1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 6: Enforce the line-item origin check in `ags.ts`

**Files:**
- Modify: `server/src/lti/ags.ts` — in `ensureLineItem`, validate the Canvas-returned line-item URL's origin before returning `ok:true`
- Create: `server/tests/lti/ags-origin.test.ts`

**Interfaces:**
- Consumes: `assertSameOrigin` from `security/same-origin.js`.
- Produces: `ensureLineItem(lineItemsUrl, accessToken, deps)` returns `{ ok:false, error:{ kind:'client-error', message:'ags:untrusted-lineitem-origin', retryable:false } }` when a matched or newly-created line item's `id` URL is not same-origin with `lineItemsUrl`. `postScore`'s `lineItemUrl` is therefore already origin-checked by the time it is called.

- [ ] **Step 1: Write the failing test** — `server/tests/lti/ags-origin.test.ts`

```ts
// server/tests/lti/ags-origin.test.ts
import { describe, it, expect } from 'vitest';
import { ensureLineItem } from '../../src/lti/ags.js';

const TOKEN = 'test-token';
const ANCHOR = 'https://canvas.test/api/lti/courses/1/line_items';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ensureLineItem — line-item origin check (backlog 6.1)', () => {
  it('accepts a matched line item whose id is same-origin with the line-items URL', async () => {
    const fetchImpl = (async () =>
      jsonResponse([{ id: `${ANCHOR}/42`, tag: 'attendance', resourceId: 'attendance-cumulative-v1' }])) as typeof fetch;
    const result = await ensureLineItem(ANCHOR, TOKEN, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('rejects a matched line item whose id points at a different origin', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { id: 'https://evil.test/api/lti/line_items/42', tag: 'attendance', resourceId: 'attendance-cumulative-v1' },
      ])) as typeof fetch;
    const result = await ensureLineItem(ANCHOR, TOKEN, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'client-error', message: 'ags:untrusted-lineitem-origin', retryable: false },
    });
  });

  it('rejects a newly-created line item whose id points at a different origin', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return jsonResponse([]); // no existing match -> triggers create
      return jsonResponse({ id: 'https://evil.test/line_items/99' }, 200); // create response
    }) as typeof fetch;
    const result = await ensureLineItem(ANCHOR, TOKEN, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'client-error', message: 'ags:untrusted-lineitem-origin', retryable: false },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/lti/ags-origin.test.ts`
Expected: FAIL — the cross-origin cases currently return `ok:true`.

- [ ] **Step 3: Modify `server/src/lti/ags.ts`** — add the import and a guarded `toEnsured` call. At the top, add to the existing import line:

```ts
import { validateCanvasServiceUrl } from './service-url.js';
import { assertSameOrigin } from '../security/same-origin.js';
```

Add a helper just above `ensureLineItem`:

```ts
// Backlog 6.1: the line-item `id` comes from a Canvas response body; before any later bearer-token
// score POST targets it, confirm it is on the same origin as the launch-persisted line-items URL.
function ensuredOrUntrusted(
  raw: Record<string, unknown>,
  lineItemsUrl: string,
): AgsResult<EnsuredLineItem> {
  const ensured = toEnsured(raw);
  try {
    assertSameOrigin(ensured.canvasLineItemUrl, lineItemsUrl);
  } catch {
    return {
      ok: false,
      error: { kind: 'client-error', message: 'ags:untrusted-lineitem-origin', retryable: false },
    };
  }
  return { ok: true, value: ensured };
}
```

Then change the two `return { ok: true, value: toEnsured(...) }` sites in `ensureLineItem`:

- the reuse path: `if (match) return { ok: true, value: toEnsured(match) };` → `if (match) return ensuredOrUntrusted(match, lineItemsUrl);`
- the create path: `return { ok: true, value: toEnsured(createdJson as Record<string, unknown>) };` → `return ensuredOrUntrusted(createdJson as Record<string, unknown>, lineItemsUrl);`

- [ ] **Step 4: Run the test — expected PASS**

Run: `npx vitest run server/tests/lti/ags-origin.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Full green bar** — the existing `mock-canvas-ags` + `grade-worker` + `grade-sync-integration` suites must stay green (the mock Canvas returns same-origin line-item ids, so they are unaffected)

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/lti/ags.ts server/tests/lti/ags-origin.test.ts
git commit -m "fix(phase7): reject a Canvas line-item id on a foreign origin before the score POST (backlog 6.1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 7: `server/src/telemetry/logger.ts` — pino options, redaction, safe-field allowlist

**Files:**
- Create: `server/src/telemetry/logger.ts`
- Create: `server/tests/telemetry/logger.test.ts`

**Interfaces:**
- Consumes: `Env` from `config/env.ts` (for `NODE_ENV`).
- Produces:
  - `loggerOptions(env: Env): FastifyServerOptions['logger']` — a pino options object with a `redact` path list and structured output; passed as `Fastify({ logger: loggerOptions(env) })` in `buildApp`.
  - `SAFE_LOG_FIELDS: readonly string[]` — the spec §44 allowlist.
  - `safeLogFields(request, extra?): Record<string, unknown>` — picks only allowlisted fields for an access-log line.

- [ ] **Step 1: Write the failing test** — `server/tests/telemetry/logger.test.ts`

```ts
// server/tests/telemetry/logger.test.ts
import { describe, it, expect } from 'vitest';
import { loggerOptions, SAFE_LOG_FIELDS, safeLogFields } from '../../src/telemetry/logger.js';

const env = (nodeEnv?: string) =>
  ({ NODE_ENV: nodeEnv, RUN_MIGRATIONS_ON_BOOT: false }) as unknown as import('../../src/config/env.js').Env;

describe('loggerOptions', () => {
  it('redacts authorization, cookie, token and card-code paths', () => {
    const opts = loggerOptions(env('production')) as { redact?: { paths: string[] } | string[] };
    const paths = Array.isArray(opts.redact) ? opts.redact : (opts.redact?.paths ?? []);
    for (const p of [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.id_token',
      '*.client_secret',
      '*.cardCode',
      '*.access_token',
    ]) {
      expect(paths).toContain(p);
    }
  });

  it('uses pretty transport only outside production', () => {
    expect((loggerOptions(env('production')) as Record<string, unknown>).transport).toBeUndefined();
    expect((loggerOptions(env('development')) as Record<string, unknown>).transport).toBeDefined();
  });
});

describe('safeLogFields', () => {
  it('includes only the spec §44 allowlist, dropping anything else', () => {
    const fakeReq = { id: 'req-1', method: 'POST', url: '/api/x', routeOptions: { url: '/api/x' } };
    const out = safeLogFields(fakeReq as never, {
      httpStatus: 200,
      durationMs: 12,
      institutionId: 'inst-1',
      displayName: 'Jane Student', // must be dropped
      cardCode: 'ABC123', // must be dropped
    });
    expect(out).toHaveProperty('requestId', 'req-1');
    expect(out).toHaveProperty('httpStatus', 200);
    expect(out).toHaveProperty('institutionId', 'inst-1');
    expect(out).not.toHaveProperty('displayName');
    expect(out).not.toHaveProperty('cardCode');
  });

  it('exposes the allowlist as a stable constant', () => {
    expect(SAFE_LOG_FIELDS).toContain('requestId');
    expect(SAFE_LOG_FIELDS).toContain('attendanceSessionId');
    expect(SAFE_LOG_FIELDS).not.toContain('displayName');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/telemetry/logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/telemetry/logger.ts`**

```ts
// server/src/telemetry/logger.ts
//
// One pino configuration for the whole app (spec §31.8, §44). Fastify owns the logger instance;
// this module only supplies its options. Two jobs:
//  1. redact() — belt-and-suspenders removal of credential-bearing paths from any logged object;
//  2. safeLogFields() — the positive allowlist for the per-request access log, so a route that
//     logs `{ ...record }` can never leak a name / card code / student id.

import type { FastifyServerOptions, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.authorization',
  '*.id_token',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.client_assertion',
  '*.cardCode',
  '*.rawCardCode',
  '*.privateKeyPkcs8Pem',
  '*.IDENTITY_API_KEY',
];

export function loggerOptions(env: Env): FastifyServerOptions['logger'] {
  const isProd = env.NODE_ENV === 'production';
  return {
    level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // pino-pretty only in local dev; production emits raw JSON lines that Container Apps ships to
    // Log Analytics.
    ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }),
  };
}

// spec §44 "Structured logs should include safe fields such as:"
export const SAFE_LOG_FIELDS = [
  'timestamp',
  'level',
  'requestId',
  'environment',
  'route',
  'httpStatus',
  'durationMs',
  'institutionId',
  'courseInternalId',
  'attendanceSessionId',
  'errorType',
] as const;

export function safeLogFields(
  request: Pick<FastifyRequest, 'id'> & { routeOptions?: { url?: string }; url?: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    requestId: request.id,
    route: request.routeOptions?.url ?? request.url,
    ...extra,
  };
  const out: Record<string, unknown> = {};
  for (const key of SAFE_LOG_FIELDS) {
    if (key in merged && merged[key] !== undefined) out[key] = merged[key];
  }
  return out;
}
```

- [ ] **Step 4: Add `pino-pretty` as a `server` devDependency** (only used by the non-prod transport)

Run: `npm i -D -w @attendance/server pino-pretty@^13.0.0`
Expected: added to `server/package.json` devDependencies; lockfile updated.

- [ ] **Step 5: Run the test — expected PASS**

Run: `npx vitest run server/tests/telemetry/logger.test.ts`
Expected: PASS.

- [ ] **Step 6: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green (nothing consumes `logger.ts` yet — Task 9 wires it).

- [ ] **Step 7: Commit**

```bash
git add server/src/telemetry/logger.ts server/tests/telemetry/logger.test.ts server/package.json package-lock.json
git commit -m "feat(phase7): structured logging config with redaction + safe-field allowlist (spec §44)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 8: `server/src/telemetry/{metrics,request-id,otel}.ts`

**Files:**
- Create: `server/src/telemetry/metrics.ts`
- Create: `server/src/telemetry/request-id.ts`
- Create: `server/src/telemetry/otel.ts`
- Create: `server/tests/telemetry/metrics.test.ts`
- Create: `server/tests/telemetry/request-id.test.ts`

**Interfaces:**
- Consumes: `@opentelemetry/api`, `@azure/monitor-opentelemetry`; `safeLogFields` from `logger.js`.
- Produces:
  - `metrics` — an object of named OTel instruments (spec §44): `ltiLaunch` (Counter, attr `result`, `reason`), `nrpsLatencyMs` (Histogram), `nrpsErrors` (Counter), `identityLookupLatencyMs` (Histogram), `identityLookupErrors` (Counter), `scans` (Counter), `unexpectedScans` (Counter), `lookupErrors` (Counter), `sessionClose` (Counter), `agsLatencyMs` (Histogram), `agsErrors` (Counter), `dbLatencyMs` (Histogram), `http5xx` (Counter). Plus `setGradeJobGauges(pending: number, failed: number)` feeding two ObservableGauges.
  - `genReqId(req): string` — prefers an inbound `x-request-id` header, else a UUID.
  - `registerRequestTelemetry(app)` — an `onResponse` hook that emits one `safeLogFields` access-log line and bumps `http5xx` / an HTTP latency histogram.
  - `startTelemetry(env)` — starts the Azure Monitor OpenTelemetry distro when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set; a no-op otherwise. Idempotent.

- [ ] **Step 1: Write the failing tests**

`server/tests/telemetry/request-id.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { genReqId } from '../../src/telemetry/request-id.js';

describe('genReqId', () => {
  it('uses a well-formed inbound x-request-id', () => {
    const req = { headers: { 'x-request-id': 'abc-123' } };
    expect(genReqId(req as never)).toBe('abc-123');
  });
  it('rejects an overlong or unsafe inbound value and falls back to a uuid', () => {
    const req = { headers: { 'x-request-id': 'x'.repeat(200) } };
    const id = genReqId(req as never);
    expect(id).not.toContain('xxxx'.repeat(10));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('generates a uuid when no header is present', () => {
    expect(genReqId({ headers: {} } as never)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

`server/tests/telemetry/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { metrics, setGradeJobGauges } from '../../src/telemetry/metrics.js';

describe('metrics instruments', () => {
  it('exposes every spec §44 instrument and they are callable without a configured exporter', () => {
    expect(() => {
      metrics.ltiLaunch.add(1, { result: 'success' });
      metrics.nrpsLatencyMs.record(42);
      metrics.agsErrors.add(1, { kind: 'rate-limited' });
      metrics.scans.add(1);
      metrics.http5xx.add(1, { route: '/api/x' });
      setGradeJobGauges(3, 1);
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run server/tests/telemetry/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `server/src/telemetry/metrics.ts`**

```ts
// server/src/telemetry/metrics.ts
//
// The spec §44 metric set as OpenTelemetry instruments. metrics.getMeter() returns a no-op meter
// until startTelemetry() installs a MeterProvider, so importing this module and calling .add()/
// .record() is always safe (tests do exactly that).

import { metrics as otelMetrics, type ObservableResult } from '@opentelemetry/api';

const meter = otelMetrics.getMeter('attendance-tracker');

let pendingGradeJobs = 0;
let failedGradeJobs = 0;

const pendingGauge = meter.createObservableGauge('grade_jobs.pending', {
  description: 'Grade-sync jobs awaiting a successful Canvas post',
});
const failedGauge = meter.createObservableGauge('grade_jobs.failed', {
  description: 'Grade-sync jobs that have exhausted retries',
});
pendingGauge.addCallback((r: ObservableResult) => r.observe(pendingGradeJobs));
failedGauge.addCallback((r: ObservableResult) => r.observe(failedGradeJobs));

export function setGradeJobGauges(pending: number, failed: number): void {
  pendingGradeJobs = pending;
  failedGradeJobs = failed;
}

export const metrics = {
  ltiLaunch: meter.createCounter('lti.launch', { description: 'LTI launch attempts by result/reason' }),
  nrpsLatencyMs: meter.createHistogram('nrps.latency', { unit: 'ms' }),
  nrpsErrors: meter.createCounter('nrps.errors'),
  identityLookupLatencyMs: meter.createHistogram('identity_lookup.latency', { unit: 'ms' }),
  identityLookupErrors: meter.createCounter('identity_lookup.errors'),
  scans: meter.createCounter('scan.count'),
  unexpectedScans: meter.createCounter('scan.unexpected'),
  lookupErrors: meter.createCounter('scan.lookup_errors'),
  sessionClose: meter.createCounter('attendance.session_close'),
  agsLatencyMs: meter.createHistogram('ags.latency', { unit: 'ms' }),
  agsErrors: meter.createCounter('ags.errors'),
  dbLatencyMs: meter.createHistogram('db.latency', { unit: 'ms' }),
  http5xx: meter.createCounter('http.server.5xx'),
  httpRequestLatencyMs: meter.createHistogram('http.server.duration', { unit: 'ms' }),
} as const;
```

- [ ] **Step 4: Create `server/src/telemetry/request-id.ts`**

```ts
// server/src/telemetry/request-id.ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { metrics } from './metrics.js';
import { safeLogFields } from './logger.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/;

export function genReqId(req: Pick<FastifyRequest, 'headers'>): string {
  const inbound = req.headers['x-request-id'];
  if (typeof inbound === 'string' && SAFE_REQUEST_ID.test(inbound)) return inbound;
  return randomUUID();
}

export function registerRequestTelemetry(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Math.round(reply.elapsedTime);
    const httpStatus = reply.statusCode;
    metrics.httpRequestLatencyMs.record(durationMs, { route: request.routeOptions?.url ?? 'unrouted' });
    if (httpStatus >= 500) {
      metrics.http5xx.add(1, { route: request.routeOptions?.url ?? 'unrouted' });
    }
    request.log.info(
      safeLogFields(request, {
        httpStatus,
        durationMs,
        environment: process.env.NODE_ENV ?? 'development',
        errorType: httpStatus >= 500 ? 'server_error' : httpStatus >= 400 ? 'client_error' : undefined,
      }),
      'request completed',
    );
  });
}
```

- [ ] **Step 5: Create `server/src/telemetry/otel.ts`**

```ts
// server/src/telemetry/otel.ts
//
// Starts the Azure Monitor OpenTelemetry distribution (traces + metrics + logs -> Application
// Insights) when APPLICATIONINSIGHTS_CONNECTION_STRING is set. A no-op otherwise, so local dev and
// the test suite import metrics.ts safely. MUST be called before any other local import does I/O —
// index.ts and worker.ts call it as their first statement.

let started = false;

export function startTelemetry(): void {
  if (started) return;
  started = true;
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) return;
  // Imported lazily so the dependency is only loaded when actually configured.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useAzureMonitor } = require('@azure/monitor-opentelemetry') as typeof import('@azure/monitor-opentelemetry');
  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio: Number(process.env.OTEL_SAMPLING_RATIO ?? '1'),
  });
}
```

Note: `require` in an ESM file needs `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` at the top of the file — add that. If the implementer prefers a top-level `await import(...)`, make `startTelemetry` `async` and `await` it in `index.ts`/`worker.ts` before `buildApp`.

- [ ] **Step 6: Run the tests — expected PASS**

Run: `npx vitest run server/tests/telemetry/`
Expected: PASS (metrics + request-id).

- [ ] **Step 7: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add server/src/telemetry/metrics.ts server/src/telemetry/request-id.ts server/src/telemetry/otel.ts server/tests/telemetry/metrics.test.ts server/tests/telemetry/request-id.test.ts
git commit -m "feat(phase7): OTel metric instruments, request-id, Azure Monitor bootstrap (spec §44)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 9: `server/src/app.ts` — `buildApp(env, deps)`; slim `index.ts`; drop the CSP copy in `hardening.test.ts`

**Files:**
- Create: `server/src/app.ts`
- Modify: `server/src/index.ts` — reduce to composition root (lifecycle handlers come in Task 11)
- Modify: `server/tests/routes/hardening.test.ts` — delete the hand-copied CSP/`buildHardenedApp` block; keep the rate-limit `describe` (it is self-contained)
- Create: `server/tests/app.test.ts`

**Interfaces:**
- Consumes: everything `index.ts` wires today — `loadEnv`, `parseAllowedTargetLinkUris`, `createDbClient`, `ltiRegistrations`, `loadSigningKeysFromEnv`, `getActiveSigningKey`, `createDefaultJwksCache`, `createAllowlist`, `findEnabledDeployment`, `createOidcTransaction`, all `register*Route`, `createRequireSession`, `createRequireCsrf`, `MockIdentityResolver`, `createHttpIdentityResolverFromEnv`; plus `buildCspDirectives` (Task 4), `loggerOptions` (Task 7), `registerRequestTelemetry` + `genReqId` (Task 8).
- Produces:
  - `interface AppDeps { db: Database; signingKeys: ToolSigningKey[]; jwksCache: JwksCache; identityResolver: IdentityResolver }`
  - `buildApp(env: Env, deps: AppDeps): Promise<FastifyInstance>` — registers helmet (CSP from `buildCspDirectives`), the `Permissions-Policy: hid=(self)` hook, cookie/formbody/static, the encapsulated rate-limited `/lti/login`+`/lti/launch` scope, `/lti/jwks`, `/api/me`, `/api/course/*`, `/api/attendance-sessions/*`, the request-telemetry hook, and the health routes (added in Task 10). Does **not** call `app.listen`.

- [ ] **Step 1: Write the failing test** — `server/tests/app.test.ts` (uses the shared test DB + `seed.ts` helpers; mirror the setup in `server/tests/routes/course-roster-integration.test.ts`)

```ts
// server/tests/app.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { getTestDb, resetDb, closeTestDb } from './support/db.js';
import { seedInstitutionAndRegistration } from './support/seed.js';
import { loadSigningKeysFromEnv } from '../src/lti/signing-keys.js';
import { createDefaultJwksCache } from '../src/lti/jwks-cache.js';
import { MockIdentityResolver } from '../src/identity/mock-resolver.js';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';

const baseEnv = {
  DATABASE_URL: 'unused-in-buildApp',
  APP_BASE_URL: 'https://app.test',
  ALLOWED_TARGET_LINK_URIS: 'https://app.test/index.html',
};

async function makeApp(overrides: Record<string, string> = {}) {
  const { db } = getTestDb();
  const env = loadEnv({ ...baseEnv, ...overrides });
  const app = await buildApp(env, {
    db,
    signingKeys: await loadSigningKeysFromEnv(undefined),
    jwksCache: createDefaultJwksCache(),
    identityResolver: new MockIdentityResolver(),
  });
  return app;
}

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closeTestDb();
});

describe('buildApp — security headers via the real middleware chain', () => {
  it('emits the locked-down CSP including the seeded Canvas OIDC origin in form-action', async () => {
    // seed a registration whose oidc_auth_endpoint is on https://canvas.example.test
    await seedInstitutionAndRegistration(getTestDb().db, { oidcAuthEndpoint: 'https://canvas.example.test/api/lti/authorize_redirect' });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://canvas.example.test");
    expect(res.headers['permissions-policy']).toBe('hid=(self)');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('omits upgrade-insecure-requests when APP_BASE_URL is http', async () => {
    const app = await makeApp({ APP_BASE_URL: 'http://localhost:3000' });
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(String(res.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    await app.close();
  });
});

describe('buildApp — rate-limit scoping (spec §31.10)', () => {
  it('rate-limits /lti/login but not the attendance scan endpoint', async () => {
    const app = await makeApp();
    let sawLimited = false;
    for (let i = 0; i < 35; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/lti/login', payload: {} });
      if (r.statusCode === 429) sawLimited = true;
    }
    expect(sawLimited).toBe(true);

    for (let i = 0; i < 35; i += 1) {
      const r = await app.inject({ method: 'POST', url: '/api/attendance-sessions/does-not-exist/scans', payload: {} });
      expect(r.statusCode).not.toBe(429); // 401/404, never rate-limited
    }
    await app.close();
  });
});
```

If `server/tests/support/seed.ts` has no `seedInstitutionAndRegistration` with an `oidcAuthEndpoint` override, extend it (small helper change) so the test can control that column; keep the existing signature working.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/app.test.ts`
Expected: FAIL — `../src/app.js` not found.

- [ ] **Step 3: Create `server/src/app.ts`** — move the wiring out of `index.ts` verbatim, parameterised by `deps`:

```ts
// server/src/app.ts
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import type { Env } from './config/env.js';
import { parseAllowedTargetLinkUris } from './config/env.js';
import type { Database } from './database/client.js';
import { ltiRegistrations } from './database/schema.js';
import type { ToolSigningKey } from './lti/signing-keys.js';
import { getActiveSigningKey } from './lti/signing-keys.js';
import type { JwksCache } from './lti/jwks-cache.js';
import type { IdentityResolver } from './identity/types.js';
import { createAllowlist } from './lti/login.js';
import { findEnabledDeployment } from './lti/registrations.js';
import { createOidcTransaction } from './lti/oidc-transactions.js';
import { registerLtiJwksRoute } from './routes/lti-jwks.js';
import { registerLtiLoginRoute } from './routes/lti-login.js';
import { registerLtiLaunchRoute } from './routes/lti-launch.js';
import { registerMeRoute } from './routes/me.js';
import { registerCourseRosterRoutes } from './routes/course-roster.js';
import { registerAttendanceSessionsRoute } from './routes/attendance-sessions.js';
import { createRequireSession, createRequireCsrf } from './auth/middleware.js';
import { buildCspDirectives } from './security/csp.js';
import { loggerOptions } from './telemetry/logger.js';
import { genReqId, registerRequestTelemetry } from './telemetry/request-id.js';
import { registerHealthRoutes } from './routes/health.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

export interface AppDeps {
  db: Database;
  signingKeys: ToolSigningKey[];
  jwksCache: JwksCache;
  identityResolver: IdentityResolver;
}

async function resolveCanvasOidcOrigins(db: Database): Promise<string[]> {
  const rows = await db
    .select({ id: ltiRegistrations.id, issuer: ltiRegistrations.issuer, oidcAuthEndpoint: ltiRegistrations.oidcAuthEndpoint })
    .from(ltiRegistrations)
    .where(eq(ltiRegistrations.enabled, true));
  return [
    ...new Set(
      rows.map((row) => {
        try {
          return new URL(row.oidcAuthEndpoint).origin;
        } catch {
          throw new Error(
            `lti_registrations row ${row.id} (issuer ${row.issuer}) has a malformed oidc_auth_endpoint: ${JSON.stringify(row.oidcAuthEndpoint)}`,
          );
        }
      }),
    ),
  ];
}

export async function buildApp(env: Env, deps: AppDeps): Promise<FastifyInstance> {
  const { db, signingKeys, jwksCache, identityResolver } = deps;
  const canvasOidcOrigins = await resolveCanvasOidcOrigins(db);
  const allowedTargetLinkUris = createAllowlist(parseAllowedTargetLinkUris(env));

  const app = Fastify({ logger: loggerOptions(env), genReqId });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: buildCspDirectives(env.APP_BASE_URL, canvasOidcOrigins) },
  });

  // Spec §31.2 — WebHID scanner: grant `hid` to this origin only, nothing embedded.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Permissions-Policy', 'hid=(self)');
  });

  registerRequestTelemetry(app);

  await app.register(fastifyCookie);
  await app.register(fastifyFormbody);
  await app.register(fastifyStatic, { root: webRoot });

  registerHealthRoutes(app, { db });

  // Encapsulated rate-limit scope so classroom scan bursts on the attendance endpoint are never
  // throttled (spec §31.10: 30 req/min/IP on /lti/login + /lti/launch only).
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
  const requireCsrf = createRequireCsrf(env.APP_BASE_URL);
  registerMeRoute(app, { requireSession, db });
  registerCourseRosterRoutes(app, { db, requireSession, requireCsrf, signingKey: getActiveSigningKey(signingKeys) });
  registerAttendanceSessionsRoute(app, {
    db,
    resolver: identityResolver,
    requireSession,
    requireCsrf,
    signingKey: getActiveSigningKey(signingKeys),
  });

  return app;
}
```

(If `JwksCache` / `IdentityResolver` type names differ in the codebase, use the actual exported type names — check `server/src/lti/jwks-cache.ts` and `server/src/identity/types.ts`.)

- [ ] **Step 4: Rewrite `server/src/index.ts`** as the composition root (SIGTERM handlers are added in Task 11 — leave a `// Task 11:` marker comment where they go):

```ts
// server/src/index.ts
import { startTelemetry } from './telemetry/otel.js';
startTelemetry();

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeysFromEnv } from './lti/signing-keys.js';
import { createDefaultJwksCache } from './lti/jwks-cache.js';
import { MockIdentityResolver } from './identity/mock-resolver.js';
import { createHttpIdentityResolverFromEnv } from './identity/http-resolver.js';
import { buildApp } from './app.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}

const signingKeys = await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON);
const identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver();

const app = await buildApp(env, {
  db: dbClient.db,
  signingKeys,
  jwksCache: createDefaultJwksCache(),
  identityResolver,
});

// Task 11: installShutdownHandlers(app, dbClient.pool) goes here.

app.listen({ port: env.PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
```

Note: the ESM `import` after a statement is legal only if `startTelemetry()` is not truly required to run first at module-evaluation time. If lint/TS complains about `import` after code, move `startTelemetry()` into a tiny `server/src/telemetry/otel-preload.ts` that self-executes on import, and make it the very first `import` line. Prefer whichever the implementer finds cleaner; the requirement is only that telemetry starts before `buildApp`.

- [ ] **Step 5: Edit `server/tests/routes/hardening.test.ts`** — delete `buildCspDirectives`, `buildHardenedApp`, and the entire `describe('security headers ...')` block (now covered by `app.test.ts`). Keep the file's `describe('rate limiting ...')` block, which stands alone. If that leaves unused imports (`fastifyHelmet`), remove them. Add a one-line header comment: `// CSP / Permissions-Policy assertions now live in server/tests/app.test.ts against the real buildApp middleware.`

- [ ] **Step 6: Run the new test** (Task 10 creates `routes/health.ts`; if doing tasks in order, `buildApp`'s `registerHealthRoutes` import will not resolve yet — create a minimal stub `server/src/routes/health.ts` exporting `registerHealthRoutes(app, _deps) {}` now and flesh it out in Task 10, OR reorder to do Task 10's file first). Recommended: create the stub now.)

Run: `npx vitest run server/tests/app.test.ts server/tests/routes/hardening.test.ts`
Expected: `app.test.ts` PASS; `hardening.test.ts` PASS (rate-limit block only).

- [ ] **Step 7: Manual boot check**

Run: `npm run build && DATABASE_URL=... APP_BASE_URL=http://localhost:3000 ALLOWED_TARGET_LINK_URIS=http://localhost:3000/index.html node server/dist/index.js`
Expected: server listens on 3000; `curl -s localhost:3000/index.html` returns the SPA; `curl -sI localhost:3000/index.html` shows the CSP + `Permissions-Policy` headers.

- [ ] **Step 8: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/src/routes/health.ts server/tests/app.test.ts server/tests/routes/hardening.test.ts server/tests/support/seed.ts
git commit -m "refactor(phase7): extract buildApp(env, deps); index.ts becomes a composition root

The full Fastify wiring moves to server/src/app.ts behind buildApp(env, deps).
New server/tests/app.test.ts exercises the real middleware chain (CSP with
dynamic Canvas origins, Permissions-Policy, rate-limit scoping); the
hand-copied CSP block in hardening.test.ts is deleted.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 10: `/health/live` + `/health/ready` (spec §38)

**Files:**
- Create/replace: `server/src/routes/health.ts` (replaces the Task-9 stub)
- Modify: `server/src/app.ts` — already calls `registerHealthRoutes` (no change if Task 9 wired it); remove any leftover `app.get('/health', ...)` if present
- Create: `server/tests/routes/health.test.ts`

**Interfaces:**
- Consumes: `Database` from `database/client.ts`.
- Produces: `registerHealthRoutes(app: FastifyInstance, deps: { db: Database }): void` — registers `GET /health/live` (`200 {status:'ok'}`, no I/O) and `GET /health/ready` (`SELECT 1` with a 2s timeout → `200 {status:'ready'}` or `503 {status:'not-ready', checks:{db:false}}`). Never contacts Canvas.

- [ ] **Step 1: Write the failing test** — `server/tests/routes/health.test.ts`

```ts
// server/tests/routes/health.test.ts
import Fastify from 'fastify';
import { describe, it, expect, afterEach } from 'vitest';
import { registerHealthRoutes } from '../../src/routes/health.js';

let app: Awaited<ReturnType<typeof makeApp>>;

async function makeApp(db: unknown) {
  const instance = Fastify({ logger: false });
  registerHealthRoutes(instance, { db: db as never });
  await instance.ready();
  return instance;
}

afterEach(async () => {
  await app?.close();
});

describe('GET /health/live', () => {
  it('returns 200 without touching the database', async () => {
    const db = { execute: () => { throw new Error('db must not be called'); } };
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('returns 200 {status:ready} when SELECT 1 succeeds', async () => {
    const db = { execute: async () => ({ rows: [{ '?column?': 1 }] }) };
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 {status:not-ready, checks:{db:false}} when the db check throws', async () => {
    const db = { execute: async () => { throw new Error('connection refused'); } };
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not-ready', checks: { db: false } });
  });

  it('returns 503 when the db check exceeds the timeout', async () => {
    const db = { execute: () => new Promise(() => {}) }; // never resolves
    app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/routes/health.test.ts`
Expected: FAIL — stub `registerHealthRoutes` registers nothing.

- [ ] **Step 3: Create `server/src/routes/health.ts`**

```ts
// server/src/routes/health.ts
//
// spec §38 — two probes. `live` = process is up (no I/O). `ready` = config parsed + database
// reachable. Readiness MUST NOT depend on Canvas (spec §38 explicit): a Canvas outage must not
// take this app out of the Container Apps load-balancer rotation.

import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../database/client.js';

const READY_DB_TIMEOUT_MS = 2000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: { db: Database }): void {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await withTimeout(deps.db.execute(sql`SELECT 1`), READY_DB_TIMEOUT_MS);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not-ready', checks: { db: false } });
    }
  });
}
```

- [ ] **Step 4: Ensure `buildApp` no longer registers the old `/health`** — grep `server/src/app.ts` for `'/health'`; only `registerHealthRoutes(app, { db })` should remain.

- [ ] **Step 5: Run the test — expected PASS**

Run: `npx vitest run server/tests/routes/health.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 6: Full green bar + manual probe check**

Run: `npm test && npm run lint && npm run typecheck`
Then: `node server/dist/index.js` (after `npm run build`) and `curl -s localhost:3000/health/live` → `{"status":"ok"}`; `curl -s -o /dev/null -w '%{http_code}' localhost:3000/health/ready` → `200`; stop Postgres (`docker compose stop postgres`) and re-curl `/health/ready` → `503`. Restart Postgres afterward.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/health.ts server/tests/routes/health.test.ts server/src/app.ts
git commit -m "feat(phase7): /health/live and /health/ready probes (spec §38)

live = process only; ready = SELECT 1 with a 2s timeout, never Canvas.
Replaces the single GET /health.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 11: Graceful SIGTERM — `server/src/lifecycle.ts` + worker abort

**Files:**
- Create: `server/src/lifecycle.ts`
- Modify: `server/src/index.ts` — call `installShutdownHandlers(app, dbClient.pool)`
- Modify: `server/src/worker.ts` — SIGTERM sets an abort flag; pass `shouldStop` into `processGradeSyncJobs`
- Modify: `server/src/attendance/grade-worker.ts` — add `shouldStop?: () => boolean` to `ProcessGradeSyncJobsDeps`, check it between courses
- Create: `server/tests/lifecycle.test.ts`

**Interfaces:**
- Consumes: `FastifyInstance`, `pg.Pool`.
- Produces:
  - `installShutdownHandlers(app: FastifyInstance, pool: Pool, opts?: { timeoutMs?: number; signals?: NodeJS.Signals[]; onExit?: (code: number) => void }): void` — on `SIGTERM`/`SIGINT` (once): `await app.close()` → `await pool.end()` → `onExit(0)` (defaults to `process.exit`); a `timeoutMs` (default 10000) hard-cap forces `onExit(1)`.
  - `ProcessGradeSyncJobsDeps.shouldStop?: () => boolean` — when it returns `true`, `processGradeSyncJobs` stops claiming further courses and returns its tally so far.

- [ ] **Step 1: Write the failing test** — `server/tests/lifecycle.test.ts`

```ts
// server/tests/lifecycle.test.ts
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { installShutdownHandlers } from '../src/lifecycle.js';

function fakeApp() {
  return { close: vi.fn().mockResolvedValue(undefined), log: { info: vi.fn(), error: vi.fn() } };
}
function fakePool() {
  return { end: vi.fn().mockResolvedValue(undefined) };
}

describe('installShutdownHandlers', () => {
  it('closes the app then the pool then exits 0 on SIGTERM', async () => {
    const app = fakeApp();
    const pool = fakePool();
    const bus = new EventEmitter();
    const onExit = vi.fn();
    installShutdownHandlers(app as never, pool as never, {
      signals: [],
      onExit,
      // inject the emitter
      // @ts-expect-error test hook
      _process: bus,
    });
    bus.emit('SIGTERM');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0));
    expect(app.close).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
    expect(app.close.mock.invocationCallOrder[0]).toBeLessThan(pool.end.mock.invocationCallOrder[0]);
  });

  it('is idempotent — a second signal does not re-run shutdown', async () => {
    const app = fakeApp();
    const pool = fakePool();
    const bus = new EventEmitter();
    const onExit = vi.fn();
    installShutdownHandlers(app as never, pool as never, { signals: [], onExit, _process: bus } as never);
    bus.emit('SIGTERM');
    bus.emit('SIGTERM');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0));
    expect(app.close).toHaveBeenCalledOnce();
  });

  it('forces exit 1 if app.close hangs past the timeout', async () => {
    vi.useFakeTimers();
    const app = { close: vi.fn(() => new Promise(() => {})), log: { info: vi.fn(), error: vi.fn() } };
    const pool = fakePool();
    const bus = new EventEmitter();
    const onExit = vi.fn();
    installShutdownHandlers(app as never, pool as never, { signals: [], onExit, timeoutMs: 5000, _process: bus } as never);
    bus.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(5001);
    expect(onExit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/lifecycle.ts`**

```ts
// server/src/lifecycle.ts
//
// Graceful shutdown for the web process (spec §38 "implement graceful SIGTERM shutdown").
// Container Apps sends SIGTERM before evicting a replica; Fastify's app.close() stops accepting
// new connections and lets in-flight requests finish. A hard timeout guards against a hung close.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

type ProcessLike = Pick<NodeJS.Process, 'on'>;

interface ShutdownOpts {
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  onExit?: (code: number) => void;
  /** test seam */
  _process?: ProcessLike;
}

export function installShutdownHandlers(app: FastifyInstance, pool: Pool, opts: ShutdownOpts = {}): void {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const signals = opts.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
  const onExit = opts.onExit ?? ((code: number) => process.exit(code));
  const proc: ProcessLike = opts._process ?? process;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutdown: draining');
    const hard = setTimeout(() => {
      app.log.error('shutdown: timed out, forcing exit');
      onExit(1);
    }, timeoutMs);
    hard.unref?.();
    void (async () => {
      try {
        await app.close();
        await pool.end();
        clearTimeout(hard);
        app.log.info('shutdown: clean');
        onExit(0);
      } catch (err) {
        clearTimeout(hard);
        app.log.error({ err: err instanceof Error ? err.message : 'unknown' }, 'shutdown: error');
        onExit(1);
      }
    })();
  };

  for (const signal of signals) proc.on(signal, () => shutdown(signal));
  // Also allow tests / callers to drive it directly via a custom emitter:
  if (opts._process) (opts._process as unknown as NodeJS.EventEmitter).on?.('SIGTERM', () => shutdown('SIGTERM'));
}
```

(If the double-registration for the test seam is awkward, the implementer may instead accept an `EventEmitter` and always use it, defaulting to `process`. Keep the observable contract: app.close → pool.end → onExit(0); idempotent; timeout → onExit(1).)

- [ ] **Step 4: Wire `index.ts`** — replace the `// Task 11:` marker with:

```ts
import { installShutdownHandlers } from './lifecycle.js';
// ...after `const app = await buildApp(...)`:
installShutdownHandlers(app, dbClient.pool);
```

- [ ] **Step 5: Modify `server/src/attendance/grade-worker.ts`** — add to `ProcessGradeSyncJobsDeps`:

```ts
export interface ProcessGradeSyncJobsDeps {
  signingKey: ToolSigningKey;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxJobs?: number;
  rand?: () => number;
  /** Cooperative cancellation — checked between courses so a SIGTERM'd worker stops cleanly. */
  shouldStop?: () => boolean;
}
```

In `processGradeSyncJobs`, at the top of the `for (const [courseId, courseJobs] of byCourse)` loop body, add:

```ts
    if (deps.shouldStop?.()) break;
```

- [ ] **Step 6: Modify `server/src/worker.ts`** — add a SIGTERM abort flag and pass `shouldStop`. New file:

```ts
// server/src/worker.ts
//
// The attendance-grade-worker process (spec §35.2). Runs ONE maintenance + grade-sync pass and
// exits. In Azure a Container Apps Job invokes it on a 5-minute cron (Task 16); the same image as
// the web server, different command. NOT wired into Fastify.
//
// In deployed environments a dedicated CI job runs `node dist/migrate.js`; the worker only
// migrates at boot when RUN_MIGRATIONS_ON_BOOT is set (local dev).

import { startTelemetry } from './telemetry/otel.js';
startTelemetry();

import { loadEnv } from './config/env.js';
import { createDbClient, applyMigrations } from './database/client.js';
import { loadSigningKeysFromEnv, getActiveSigningKey } from './lti/signing-keys.js';
import { processGradeSyncJobs } from './attendance/grade-worker.js';
import { runMaintenancePass } from './maintenance/purge.js';
import { setGradeJobGauges } from './telemetry/metrics.js';
import { countGradeJobsByState } from './attendance/grade-sync-store.js';

const env = loadEnv();
const dbClient = createDbClient(env.DATABASE_URL);
if (env.RUN_MIGRATIONS_ON_BOOT) {
  await applyMigrations(dbClient);
}
const { db, pool } = dbClient;

let stopRequested = false;
process.on('SIGTERM', () => {
  stopRequested = true;
});
const shouldStop = () => stopRequested;

try {
  const maintenance = await runMaintenancePass(db, { retentionDays: env.RETENTION_DAYS, shouldStop });
  const signingKey = getActiveSigningKey(await loadSigningKeysFromEnv(env.LTI_TOOL_SIGNING_KEYS_JSON));
  const grade = await processGradeSyncJobs(db, { signingKey, shouldStop });
  const gauges = await countGradeJobsByState(db);
  setGradeJobGauges(gauges.pending, gauges.failed);
  console.log(`[worker] ${JSON.stringify({ maintenance, grade })}`);
} catch (err) {
  console.error('[worker] pass failed', err instanceof Error ? err.message : 'unknown error');
  await pool.end();
  process.exit(1);
}

await pool.end();
process.exit(0);
```

If `countGradeJobsByState` does not exist in `grade-sync-store.ts`, add it: a single `SELECT state, count(*) ... GROUP BY state` returning `{ pending: number; synced: number; failed: number }`. (`getGradeSyncSummary` today loads all rows per course — this is a cheap global aggregate for the gauge.)

- [ ] **Step 7: Run the tests — expected PASS**

Run: `npx vitest run server/tests/lifecycle.test.ts server/tests/attendance/`
Expected: `lifecycle.test.ts` PASS; existing grade-worker tests still PASS (the new `shouldStop` is optional).

- [ ] **Step 8: Full green bar**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add server/src/lifecycle.ts server/src/index.ts server/src/worker.ts server/src/attendance/grade-worker.ts server/src/attendance/grade-sync-store.ts server/tests/lifecycle.test.ts
git commit -m "feat(phase7): graceful SIGTERM for web (drain) and worker (cooperative stop) — spec §38

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 12: Worker maintenance pass — expired-OIDC / expired-session purge + retention stub

**Files:**
- Create: `server/src/maintenance/purge.ts`
- Create: `server/tests/maintenance/purge.test.ts`
- (`server/src/worker.ts` already calls `runMaintenancePass` from Task 11 Step 6.)

**Interfaces:**
- Consumes: `Database`; `oidcTransactions`, `appSessions` from `database/schema.js`; `Env.RETENTION_DAYS`.
- Produces: `runMaintenancePass(db, opts: { retentionDays?: number; now?: () => Date; shouldStop?: () => boolean }): Promise<{ oidcPurged: number; sessionsPurged: number; retentionDeleted: number }>` — deletes `oidc_transactions` and `app_sessions` rows whose `expires_at < now`; when `retentionDays` is set, deletes `audit_events` older than the window (the only table safe to prune without policy input — attendance rows wait for the Phase 8 retention policy). Honours `shouldStop` between steps.

- [ ] **Step 1: Write the failing test** — `server/tests/maintenance/purge.test.ts`

```ts
// server/tests/maintenance/purge.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, resetDb, closeTestDb } from '../support/db.js';
import { runMaintenancePass } from '../../src/maintenance/purge.js';
import { oidcTransactions, appSessions } from '../../src/database/schema.js';

const { db } = getTestDb();

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closeTestDb();
});

async function seedExpiredOidc() {
  // minimal insert — only NOT NULL columns; adapt column names to schema.ts
  await db.execute(sql`
    INSERT INTO oidc_transactions (state_hash, nonce_hash, deployment_id, target_link_uri, registration_id, expires_at)
    VALUES ('s1','n1','d1','https://app/x', gen_random_uuid(), now() - interval '1 hour')
  `);
}

describe('runMaintenancePass', () => {
  it('deletes expired oidc_transactions and app_sessions, leaves live rows', async () => {
    await seedExpiredOidc();
    const before = await db.select().from(oidcTransactions);
    expect(before.length).toBe(1);
    const result = await runMaintenancePass(db, {});
    expect(result.oidcPurged).toBe(1);
    const after = await db.select().from(oidcTransactions);
    expect(after.length).toBe(0);
  });

  it('is a no-op for retention when retentionDays is unset', async () => {
    const result = await runMaintenancePass(db, {});
    expect(result.retentionDeleted).toBe(0);
  });

  it('stops early when shouldStop returns true', async () => {
    await seedExpiredOidc();
    const result = await runMaintenancePass(db, { shouldStop: () => true });
    // stopped before the oidc delete step
    expect(result.oidcPurged).toBe(0);
  });
});
```

(If `oidc_transactions` / `app_sessions` NOT NULL columns differ, adjust the seed SQL to match `server/src/database/schema.ts` — the assertion is about the delete counts, not the exact columns.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run server/tests/maintenance/purge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/maintenance/purge.ts`**

```ts
// server/src/maintenance/purge.ts
//
// Housekeeping the worker runs every pass alongside grade sync (spec §35.2: "expired OIDC
// transactions / expired application sessions / retention/purge tasks").
//
// Retention is deliberately conservative for Phase 7: only audit_events beyond RETENTION_DAYS are
// pruned. Pruning attendance data needs the per-institution retention policy from Phase 8
// (spec §34) — it is not done here.

import { sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';

interface MaintenanceOpts {
  retentionDays?: number;
  now?: () => Date;
  shouldStop?: () => boolean;
}

export interface MaintenanceResult {
  oidcPurged: number;
  sessionsPurged: number;
  retentionDeleted: number;
}

export async function runMaintenancePass(db: Database, opts: MaintenanceOpts): Promise<MaintenanceResult> {
  const now = (opts.now ?? (() => new Date()))();
  const result: MaintenanceResult = { oidcPurged: 0, sessionsPurged: 0, retentionDeleted: 0 };

  if (opts.shouldStop?.()) return result;
  const oidc = await db.execute(sql`DELETE FROM oidc_transactions WHERE expires_at < ${now}`);
  result.oidcPurged = oidc.rowCount ?? 0;

  if (opts.shouldStop?.()) return result;
  const sessions = await db.execute(sql`DELETE FROM app_sessions WHERE expires_at < ${now}`);
  result.sessionsPurged = sessions.rowCount ?? 0;

  if (opts.shouldStop?.()) return result;
  if (opts.retentionDays && opts.retentionDays > 0) {
    const cutoff = new Date(now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000);
    const audit = await db.execute(sql`DELETE FROM audit_events WHERE created_at < ${cutoff}`);
    result.retentionDeleted = audit.rowCount ?? 0;
  }

  return result;
}
```

(Confirm the `audit_events` timestamp column name in `schema.ts` — likely `created_at`. Adjust if different.)

- [ ] **Step 4: Run the test — expected PASS**

Run: `npx vitest run server/tests/maintenance/purge.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Full green bar + worker smoke**

Run: `npm test && npm run lint && npm run typecheck`
Then: `npm run build && DATABASE_URL=... node server/dist/worker.js` → prints `[worker] {"maintenance":{...},"grade":{...}}`, exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/maintenance/purge.ts server/tests/maintenance/purge.test.ts
git commit -m "feat(phase7): worker maintenance pass — expired OIDC/session purge + audit retention (spec §35.2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M2 checkpoint

`npm test && npm run lint && npm run typecheck` green. `node server/dist/index.js` boots via `buildApp`, serves the SPA with the full header set, answers `/health/live` + `/health/ready`, and shuts down cleanly on `Ctrl-C`. `node server/dist/worker.js` runs one maintenance + grade pass and exits 0. `hardening.test.ts` no longer carries a CSP copy.

---

## Task 13: Multi-stage Dockerfile + `.dockerignore`

**Files:**
- Create: `Dockerfile` (repo root)
- Create: `.dockerignore` (repo root)

**Interfaces:**
- Consumes: the M1 build (`npm -w @attendance/server run build` → `server/dist/`), `server/migrations/`, `web/`.
- Produces: an image that runs `node server/dist/index.js` as non-root on one port (`PORT`, default 3000); the worker is the same image with `command: ["node","server/dist/worker.js"]`; the migrate entrypoint is `["node","server/dist/migrate.js"]`. `server/migrations/` is copied to `server/dist/migrations/` so `resolveMigrationsFolder()` (Task 2) finds it.

- [ ] **Step 1: Write the failing check**

```bash
# Expected to FAIL now — no Dockerfile
docker build -t attendance:phase7-test . && \
docker run --rm --entrypoint node attendance:phase7-test -e "require('fs').accessSync('server/dist/index.js'); require('fs').accessSync('server/dist/migrations/0000_lethal_rockslide.sql'); console.log('PASS layout')"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker build -t attendance:phase7-test . 2>&1 | tail -3`
Expected: FAIL — `failed to read dockerfile`.

- [ ] **Step 3: Create `.dockerignore`**

```
.git
**/.env
**/.env.*
node_modules
**/node_modules
server/dist
dist
**/tests
e2e
docs
.superpowers
.claude
.playwright-mcp
.github
infra
*.md
LICENSE
.DS_Store
**/.DS_Store
coverage
playwright-report
test-results
```

- [ ] **Step 4: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# Multi-stage build (spec §38). Runtime image = compiled app only, non-root, no .git / .env /
# signing keys / dev deps / tests.

# ---- deps: install the full workspace graph from the lockfile ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
# packages/* has no members yet; the glob is harmless if empty.
COPY packages ./packages
RUN npm ci

# ---- build: compile TypeScript, then produce a production-only node_modules ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY server ./server
RUN npm -w @attendance/server run build
# prune to production deps for the runtime layer
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# non-root (the base image ships an unprivileged `node` user)
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server/node_modules ./server/node_modules
COPY --chown=node:node --from=build /app/server/dist ./server/dist
COPY --chown=node:node --from=build /app/server/package.json ./server/package.json
# migrations must sit where resolveMigrationsFolder() looks from server/dist/database/client.js
COPY --chown=node:node --from=build /app/server/migrations ./server/dist/migrations
COPY --chown=node:node web ./web

USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

Note on `server/node_modules`: npm workspaces usually hoist everything to the root `node_modules`, so `server/node_modules` may not exist. Make the two `COPY --from ... /app/server/node_modules` lines tolerant — either drop them (if `npm ci` hoists fully, which is the common case for this dependency set) or keep them behind a build that `mkdir -p server/node_modules` first. The implementer confirms with `docker build` which form is needed; the requirement is that `require('fastify')` resolves at runtime.

- [ ] **Step 5: Build and run the layout check — expected PASS**

Run:
```bash
docker build -t attendance:phase7-test .
docker run --rm --entrypoint node attendance:phase7-test -e "require('fs').accessSync('server/dist/index.js'); require('fs').accessSync('server/dist/migrations/0000_lethal_rockslide.sql'); require.resolve('fastify'); console.log('PASS layout')"
```
Expected: `PASS layout`.

- [ ] **Step 6: Run the container end to end against local Postgres**

Run:
```bash
docker compose up -d postgres
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgres://attendance_tracker:attendance_tracker@host.docker.internal:5432/attendance_tracker' \
  -e APP_BASE_URL='http://localhost:3000' \
  -e ALLOWED_TARGET_LINK_URIS='http://localhost:3000/index.html' \
  -e RUN_MIGRATIONS_ON_BOOT=true \
  attendance:phase7-test &
sleep 3
curl -s localhost:3000/health/live      # {"status":"ok"}
curl -s localhost:3000/health/ready     # {"status":"ready"}
curl -sI localhost:3000/index.html | grep -i 'content-security-policy\|permissions-policy'
docker kill $(docker ps -q --filter ancestor=attendance:phase7-test)
```
Expected: live + ready both 200; CSP + Permissions-Policy headers present; SIGKILL via `docker kill` is fine here (SIGTERM drain is unit-tested). Optionally `docker stop` (sends SIGTERM) and confirm the container exits within ~1s, not after the 10s Docker kill grace.

- [ ] **Step 7: Verify forbidden content is absent**

Run:
```bash
docker run --rm --entrypoint sh attendance:phase7-test -c 'ls -a /app; test ! -e /app/.git && test ! -e /app/.env && test ! -e /app/server/tests && echo "PASS no forbidden content"'
```
Expected: `PASS no forbidden content`; no `.git`, `.env`, `server/tests`, `docs`, signing keys.

- [ ] **Step 8: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build(phase7): multi-stage Dockerfile — non-root runtime, compiled app only (spec §38)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 14: Playwright end-to-end harness (whole-branch follow-up #7)

**Files:**
- Create: `playwright.config.ts` (repo root)
- Create: `e2e/support/webhid-shim.ts`
- Create: `e2e/support/seed-launch.ts`
- Create: `e2e/instructor-flow.spec.ts`
- Modify: `package.json` — `test:e2e` script (added in Task 1); ensure `@playwright/test` installed
- Modify: `.gitignore` — add `playwright-report/`, `test-results/`

**Interfaces:**
- Consumes: the built server (`node server/dist/index.js`), Docker Postgres, the existing test mint helper for an instructor `id_token` (reuse `server/tests/support/mock-canvas.ts` / `seed.ts` patterns), the existing `MockCanvasPlatform` for NRPS/AGS.
- Produces: `e2e/instructor-flow.spec.ts` — one spec that drives login → launch → Start Attendance → synthetic scan → Close → Reopen, then runs `node server/dist/worker.js` and asserts the grade-sync summary reflects the close. WebHID is shimmed in the page context. Runs headless Chromium in CI (Task 17).

- [ ] **Step 1: Install Playwright browsers**

Run: `npx playwright install --with-deps chromium`
Expected: Chromium downloaded.

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_e2e';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    // build is run separately in CI; locally, prebuild with `npm run build`
    command: `node server/dist/index.js`,
    url: `http://localhost:${PORT}/health/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      DATABASE_URL,
      APP_BASE_URL: `http://localhost:${PORT}`,
      ALLOWED_TARGET_LINK_URIS: `http://localhost:${PORT}/index.html`,
      RUN_MIGRATIONS_ON_BOOT: 'true',
      CARD_FINGERPRINT_SECRET: 'e2e-secret-not-for-prod',
    },
  },
});
```

- [ ] **Step 3: Create `e2e/support/webhid-shim.ts`** — an `addInitScript` payload that fakes `navigator.hid` so the scanner UI's "Connect reader" path resolves and a synthetic input report can be dispatched:

```ts
// e2e/support/webhid-shim.ts
// Injected via page.addInitScript before any app code runs. Mirrors the shim used in
// web/tests — a fake HIDDevice that the app can `open()` and that emits one `inputreport`.
export const webhidShimScript = `
(() => {
  class FakeHIDDevice extends EventTarget {
    constructor() { super(); this.opened = false; this.collections = []; this.productName = 'Fake OMNIKEY'; }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    // test hook: window.__emitCard('=E280...') dispatches an inputreport the parser accepts
  }
  const device = new FakeHIDDevice();
  navigator.hid = {
    requestDevice: async () => [device],
    getDevices: async () => [device],
    addEventListener() {}, removeEventListener() {},
  };
  window.__fakeHidDevice = device;
  window.__emitCard = (bytes) => {
    const data = new DataView(new Uint8Array(bytes).buffer);
    device.dispatchEvent(Object.assign(new Event('inputreport'), { device, reportId: 0, data }));
  };
})();
`;
```

(The exact byte layout must match what `web/omnikey-parser.js` expects — reuse the fixture bytes from `web/tests/omnikey-parser.test.js`.)

- [ ] **Step 4: Create `e2e/support/seed-launch.ts`** — a helper that, before the browser steps, seeds an institution + enabled registration + deployment directly in the e2e DB and returns a signed instructor `id_token` + the `/lti/login` params. Reuse `server/src/database/seed-registration.ts` and the `mintIdToken` helper from `server/tests/support/mock-canvas.ts` (import from source; e2e runs under `tsx`/`ts-node` via Playwright's TS support). Keep it a thin wrapper — no new signing logic.

- [ ] **Step 5: Create `e2e/instructor-flow.spec.ts`**

```ts
import { test, expect } from '@playwright/test';
import { webhidShimScript } from './support/webhid-shim.js';
import { seedInstructorLaunch, runWorkerOnce, readGradeSyncSummary } from './support/seed-launch.js';

test('instructor: login -> launch -> start -> scan -> close -> reopen -> grade sync', async ({ page, context }) => {
  await context.addInitScript(webhidShimScript);
  const { loginUrl, launchForm } = await seedInstructorLaunch();

  // 1. OIDC login initiation -> Canvas would redirect; we post the launch form directly.
  await page.goto(loginUrl);
  await page.evaluate((form) => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = form.action;
    for (const [k, v] of Object.entries(form.fields)) {
      const i = document.createElement('input'); i.name = k; i.value = v as string; f.appendChild(i);
    }
    document.body.appendChild(f); f.submit();
  }, launchForm);

  // 2. lands on the scanner UI
  await expect(page.getByRole('button', { name: /start attendance/i })).toBeVisible();

  // 3. Start
  await page.getByRole('button', { name: /start attendance/i }).click();
  await expect(page.getByText(/session (open|in progress)/i)).toBeVisible();

  // 4. synthetic scan
  await page.evaluate(() => (window as unknown as { __emitCard: (b: number[]) => void }).__emitCard(
    /* fixture bytes for a roster learner card */ [/* ... */],
  ));
  await expect(page.getByText(/present/i)).toBeVisible();

  // 5. Close, then Reopen
  await page.getByRole('button', { name: /^close/i }).click();
  await expect(page.getByText(/closed/i)).toBeVisible();
  await page.getByRole('button', { name: /reopen/i }).click();
  await expect(page.getByText(/reopened/i)).toBeVisible();

  // 6. run the worker once, assert grade sync ran for the close
  await runWorkerOnce();
  const summary = await readGradeSyncSummary();
  expect(summary.state).toMatch(/synced|pending/);
});
```

(Byte fixtures and exact UI text: fill from `web/tests/*` and the actual `web/index.html` / `web/ui.js` labels — no invented selectors. If Start/Close/Reopen labels differ, use the real ones.)

- [ ] **Step 6: Add the e2e database to the local flow** — document in `e2e/support/seed-launch.ts` header that it uses `attendance_tracker_e2e` (auto-created like the test DB). Update `.gitignore`:

```
playwright-report/
test-results/
```

- [ ] **Step 7: Run the spec locally**

Run: `npm run build && npx playwright test`
Expected: 1 passed. If flaky on timing, add explicit `await expect(...).toBeVisible()` waits rather than fixed sleeps.

- [ ] **Step 8: Full green bar** (unit suite unaffected — `vitest.config.ts` `include` does not match `e2e/`)

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green. Add `e2e/**` to `eslint.config.js` ignores or give it the node globs if lint complains.

- [ ] **Step 9: Commit**

```bash
git add playwright.config.ts e2e .gitignore package.json package-lock.json eslint.config.js
git commit -m "test(phase7): Playwright instructor-flow e2e harness with a mocked WebHID reader (follow-up #7)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M3 checkpoint

`docker build .` succeeds; the container serves `/health/*` and the SPA and holds no forbidden content; `npx playwright test` runs the full instructor flow green against the built server. Nothing has touched Azure yet.

---

## Task 15: Bicep — foundation modules (identity, registry, observability, key vault) + params scaffold

**Files:**
- Create: `infra/azure/main.bicep`
- Create: `infra/azure/modules/identity.bicep`
- Create: `infra/azure/modules/registry.bicep`
- Create: `infra/azure/modules/observability.bicep`
- Create: `infra/azure/modules/keyvault.bicep`
- Create: `infra/azure/environments/dev.bicepparam`
- Create: `infra/azure/environments/stage.bicepparam`
- Create: `infra/azure/environments/prod.bicepparam`
- Create: `infra/azure/README.md`

**Interfaces:**
- Consumes: nothing (deployed by hand in M5, by workflows later).
- Produces: `main.bicep` at `resourceGroup` scope with params per spec §36 and outputs `containerRegistryLoginServer`, `managedIdentityId`, `managedIdentityClientId`, `keyVaultName`, `logAnalyticsWorkspaceId`, `appInsightsConnectionString` (marked `@secure()` output where relevant). Task 16 adds the compute modules and wires them.

- [ ] **Step 1: Failing check**

Run: `az bicep build --file infra/azure/main.bicep`
Expected: FAIL — file does not exist.

- [ ] **Step 2: Create `infra/azure/modules/identity.bicep`**

```bicep
@description('User-assigned managed identity for this environment. Used by Container Apps to pull from ACR and read Key Vault, and by the GitHub OIDC federated credential.')
param name string
param location string
param tags object = {}

resource mi 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

output id string = mi.id
output principalId string = mi.properties.principalId
output clientId string = mi.properties.clientId
output name string = mi.name
```

- [ ] **Step 3: Create `infra/azure/modules/registry.bicep`**

```bicep
@description('Azure Container Registry. Images are tagged with the git SHA; `latest` is never deployed (spec §35.5).')
param name string
param location string
param tags object = {}
@allowed(['Basic', 'Standard', 'Premium'])
param sku string = 'Standard'
@description('Principal ID of the managed identity that needs AcrPull.')
param pullPrincipalId string

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: { name: sku }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

// AcrPull for the managed identity (role definition id is well-known and constant).
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, pullPrincipalId, 'AcrPull')
  scope: acr
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

output loginServer string = acr.properties.loginServer
output name string = acr.name
```

- [ ] **Step 4: Create `infra/azure/modules/observability.bicep`**

```bicep
@description('Log Analytics workspace + workspace-based Application Insights (spec §35, §44).')
param workspaceName string
param appInsightsName string
param location string
param tags object = {}
@description('Log retention in days (spec §36 parameter).')
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionInDays
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
@secure()
output appInsightsConnectionString string = appInsights.properties.ConnectionString
```

- [ ] **Step 5: Create `infra/azure/modules/keyvault.bicep`**

```bicep
@description('Key Vault holding session secret, LTI signing keys, resolver credentials, DB URL, card-fingerprint key, App Insights connection string (spec §35.4). NO secret VALUES live in IaC — they are seeded out of band.')
param name string
param location string
param tags object = {}
param tenantId string = subscription().tenantId
@description('Principal ID of the managed identity that needs Key Vault Secrets User.')
param secretsReaderPrincipalId string
@description('Optional additional principal (e.g. the deploy identity) that needs Secrets User for the migrate job.')
param deployPrincipalId string = ''

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

var secretsUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, secretsReaderPrincipalId, 'KeyVaultSecretsUser')
  scope: kv
  properties: {
    principalId: secretsReaderPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleId
  }
}

resource deployAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployPrincipalId)) {
  name: guid(kv.id, deployPrincipalId, 'KeyVaultSecretsUser')
  scope: kv
  properties: {
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRoleId
  }
}

output name string = kv.name
output uri string = kv.properties.vaultUri
```

- [ ] **Step 6: Create `infra/azure/main.bicep`** (foundation only; Task 16 appends compute)

```bicep
targetScope = 'resourceGroup'

@description('Short environment name: dev | stage | prod')
@allowed(['dev', 'stage', 'prod'])
param environmentName string
param location string = resourceGroup().location
@description('Public hostname the app is served on, e.g. attendance-dev.example.edu. Used for APP_BASE_URL and the Container Apps custom domain.')
param appHostname string
@description('Postgres Flexible Server SKU name, e.g. Standard_B1ms.')
param postgresSkuName string = 'Standard_B1ms'
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param postgresSkuTier string = 'Burstable'
param postgresStorageGb int = 32
param postgresBackupRetentionDays int = 7
param postgresGeoRedundantBackup bool = false
param containerCpu string = '0.5'
param containerMemory string = '1Gi'
param webMinReplicas int = 0
param webMaxReplicas int = 2
param logRetentionDays int = 30
param acrSku string = 'Standard'
@description('Email that Azure Monitor alerts are sent to.')
param alertEmail string
@description('Object ID of the Postgres administrator (an Entra group is recommended). Empty = password auth only.')
param postgresAdminObjectId string = ''
param postgresAdminLogin string = 'attendance_admin'

var namePrefix = 'attendance-${environmentName}'
var tags = {
  application: 'attendance-tracker'
  environment: environmentName
  managedBy: 'bicep'
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    name: 'id-${namePrefix}'
    location: location
    tags: tags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  params: {
    workspaceName: 'log-${namePrefix}'
    appInsightsName: 'appi-${namePrefix}'
    location: location
    tags: tags
    retentionInDays: logRetentionDays
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    // ACR names are alphanumeric only, <=50 chars.
    name: replace('acr${namePrefix}', '-', '')
    location: location
    tags: tags
    sku: acrSku
    pullPrincipalId: identity.outputs.principalId
  }
}

module keyvault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    // KV names <=24 chars, alphanumeric + dashes.
    name: take('kv-${namePrefix}', 24)
    location: location
    tags: tags
    secretsReaderPrincipalId: identity.outputs.principalId
  }
}

output containerRegistryLoginServer string = registry.outputs.loginServer
output managedIdentityId string = identity.outputs.id
output managedIdentityClientId string = identity.outputs.clientId
output managedIdentityPrincipalId string = identity.outputs.principalId
output keyVaultName string = keyvault.outputs.name
output keyVaultUri string = keyvault.outputs.uri
output logAnalyticsWorkspaceId string = observability.outputs.workspaceId
@secure()
output appInsightsConnectionString string = observability.outputs.appInsightsConnectionString
```

- [ ] **Step 7: Create the three `.bicepparam` files** — non-secret parameters only (spec §36).

`infra/azure/environments/dev.bicepparam`:

```bicep
using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param appHostname = 'attendance-dev.CHANGEME.edu'
param postgresSkuName = 'Standard_B1ms'
param postgresSkuTier = 'Burstable'
param postgresStorageGb = 32
param postgresBackupRetentionDays = 7
param postgresGeoRedundantBackup = false
param containerCpu = '0.5'
param containerMemory = '1Gi'
param webMinReplicas = 0
param webMaxReplicas = 2
param logRetentionDays = 30
param acrSku = 'Basic'
param alertEmail = 'CHANGEME@example.edu'
```

`infra/azure/environments/stage.bicepparam`:

```bicep
using '../main.bicep'

param environmentName = 'stage'
param location = 'eastus'
param appHostname = 'attendance-stage.CHANGEME.edu'
param postgresSkuName = 'Standard_B2s'
param postgresSkuTier = 'Burstable'
param postgresStorageGb = 32
param postgresBackupRetentionDays = 7
param postgresGeoRedundantBackup = false
param containerCpu = '0.5'
param containerMemory = '1Gi'
param webMinReplicas = 1
param webMaxReplicas = 3
param logRetentionDays = 30
param acrSku = 'Standard'
param alertEmail = 'CHANGEME@example.edu'
```

`infra/azure/environments/prod.bicepparam`:

```bicep
using '../main.bicep'

param environmentName = 'prod'
param location = 'eastus'
param appHostname = 'attendance.CHANGEME.edu'
param postgresSkuName = 'Standard_D2ds_v5'
param postgresSkuTier = 'GeneralPurpose'
param postgresStorageGb = 64
param postgresBackupRetentionDays = 14
param postgresGeoRedundantBackup = true
param containerCpu = '0.5'
param containerMemory = '1Gi'
param webMinReplicas = 1
param webMaxReplicas = 5
param logRetentionDays = 90
param acrSku = 'Standard'
param alertEmail = 'CHANGEME@example.edu'
```

- [ ] **Step 8: Create `infra/azure/README.md`** — the bootstrap runbook. Include: prerequisites (`az` logged in, subscription set, an RG per env `rg-attendance-{env}`); the deploy command `az deployment group create -g rg-attendance-dev -f infra/azure/main.bicep -p infra/azure/environments/dev.bicepparam`; the `what-if` variant; the ordered Key Vault secret-seeding commands (from the design doc §5 — `app-session-secret`, `lti-tool-signing-keys-json`, `card-fingerprint-secret`, `identity-api-key`, `database-url`, `appinsights-connection-string`); and a "secrets are NEVER committed" warning. Leave the OIDC-federation steps as a `## TODO (Task 18)` placeholder heading — Task 18 fills it.

- [ ] **Step 9: Validate**

Run: `az bicep build --file infra/azure/main.bicep && for e in dev stage prod; do az bicep build-params --file infra/azure/environments/$e.bicepparam; done`
Expected: no errors; `main.json` compiles; each `.bicepparam` resolves.

- [ ] **Step 10: Commit**

```bash
git add infra/azure
git commit -m "infra(phase7): Bicep foundation — identity, ACR, Log Analytics/App Insights, Key Vault (spec §35-36)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 16: Bicep — Postgres, Container Apps env, web app, worker job, alerts

**Files:**
- Create: `infra/azure/modules/postgres.bicep`
- Create: `infra/azure/modules/containerapp-env.bicep`
- Create: `infra/azure/modules/web.bicep`
- Create: `infra/azure/modules/worker-job.bicep`
- Create: `infra/azure/modules/alerts.bicep`
- Modify: `infra/azure/main.bicep` — wire the five modules and add outputs

**Interfaces:**
- Consumes: Task 15 outputs (`managedIdentityId`, `managedIdentityPrincipalId`, `keyVaultUri`, `logAnalyticsWorkspaceId`, ACR login server, App Insights connection string).
- Produces: `main.bicep` outputs additionally `webAppFqdn`, `webAppName`, `workerJobName`, `postgresFqdn`. The web Container App reads all secrets as Key Vault references via the managed identity; env vars are set from params + those references. The worker is a `Microsoft.App/jobs` schedule-triggered job (cron `*/5 * * * *`) using the same image with `command: ["node","server/dist/worker.js"]`.

- [ ] **Step 1: Failing check** — `az bicep build` after wiring will fail on missing modules; start there.

Run: `grep -q "modules/postgres.bicep" infra/azure/main.bicep`
Expected: FAIL (not wired yet).

- [ ] **Step 2: Create `infra/azure/modules/postgres.bicep`**

```bicep
@description('Azure Database for PostgreSQL Flexible Server (spec §35.3). TLS required; PITR via backup retention. Public network access ON so the CI migrate job can connect through a just-in-time firewall rule (spec §39 / decision #8); tightening to a private path is a Phase 8 item.')
param name string
param location string
param tags object = {}
param skuName string
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string
param storageGb int
param backupRetentionDays int
param geoRedundantBackup bool
param administratorLogin string
@secure()
param administratorPassword string
param databaseName string = 'attendance'
@description('Entra admin object id (optional). Empty = password auth only.')
param aadAdminObjectId string = ''
param aadAdminPrincipalName string = ''

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: { storageSizeGB: storageGb, autoGrow: 'Enabled' }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: {
      activeDirectoryAuth: empty(aadAdminObjectId) ? 'Disabled' : 'Enabled'
      passwordAuth: 'Enabled'
    }
  }
}

// require_secure_transport is ON by default on Flexible Server; pin it explicitly.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: pg
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Allow other Azure services (Container Apps egress) to reach the server. The CI migrate job adds
// and removes its own runner-IP rule at deploy time.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource aadAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = if (!empty(aadAdminObjectId)) {
  parent: pg
  name: aadAdminObjectId
  properties: {
    principalType: 'Group'
    principalName: aadAdminPrincipalName
    tenantId: subscription().tenantId
  }
}

output fqdn string = pg.properties.fullyQualifiedDomainName
output name string = pg.name
output databaseName string = databaseName
```

- [ ] **Step 3: Create `infra/azure/modules/containerapp-env.bicep`**

```bicep
@description('Container Apps managed environment, log destination = the shared Log Analytics workspace.')
param name string
param location string
param tags object = {}
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

output id string = env.id
output defaultDomain string = env.properties.defaultDomain
```

- [ ] **Step 4: Create `infra/azure/modules/web.bicep`**

```bicep
@description('attendance-web Container App (spec §35.1). Same image runs static frontend + API + LTI + JWKS + health. One warm replica in prod.')
param name string
param location string
param tags object = {}
param environmentId string
param image string
param managedIdentityId string
param managedIdentityClientId string
param acrLoginServer string
param keyVaultUri string
param appBaseUrl string
param allowedTargetLinkUris string
param cpu string
param memory string
param minReplicas int
param maxReplicas int
@description('Identity API base URL for the real ProxID resolver (decision #3). Non-secret.')
param identityApiUrl string
param identityApiKeyName string

var kvRef = '${keyVaultUri}secrets/'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: acrLoginServer, identity: managedIdentityId }
      ]
      secrets: [
        { name: 'database-url', keyVaultUrl: '${kvRef}database-url', identity: managedIdentityId }
        { name: 'app-session-secret', keyVaultUrl: '${kvRef}app-session-secret', identity: managedIdentityId }
        { name: 'lti-tool-signing-keys-json', keyVaultUrl: '${kvRef}lti-tool-signing-keys-json', identity: managedIdentityId }
        { name: 'card-fingerprint-secret', keyVaultUrl: '${kvRef}card-fingerprint-secret', identity: managedIdentityId }
        { name: 'identity-api-key', keyVaultUrl: '${kvRef}identity-api-key', identity: managedIdentityId }
        { name: 'appinsights-connection-string', keyVaultUrl: '${kvRef}appinsights-connection-string', identity: managedIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          command: ['node', 'server/dist/index.js']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '3000' }
            { name: 'RUN_MIGRATIONS_ON_BOOT', value: 'false' }
            { name: 'APP_BASE_URL', value: appBaseUrl }
            { name: 'ALLOWED_TARGET_LINK_URIS', value: allowedTargetLinkUris }
            { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
            { name: 'IDENTITY_API_URL', value: identityApiUrl }
            { name: 'IDENTITY_API_KEY_NAME', value: identityApiKeyName }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'APP_SESSION_SECRET', secretRef: 'app-session-secret' }
            { name: 'LTI_TOOL_SIGNING_KEYS_JSON', secretRef: 'lti-tool-signing-keys-json' }
            { name: 'CARD_FINGERPRINT_SECRET', secretRef: 'card-fingerprint-secret' }
            { name: 'IDENTITY_API_KEY', secretRef: 'identity-api-key' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
          ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health/live', port: 3000 }, periodSeconds: 10, failureThreshold: 3 }
            { type: 'Readiness', httpGet: { path: '/health/ready', port: 3000 }, periodSeconds: 10, failureThreshold: 3 }
            { type: 'Startup', httpGet: { path: '/health/ready', port: 3000 }, periodSeconds: 5, failureThreshold: 30 }
          ]
        }
      ]
      scale: { minReplicas: minReplicas, maxReplicas: maxReplicas }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output name string = app.name
```

(Note: the app's runtime `Env` schema — `server/src/config/env.ts` — does not read `APP_SESSION_SECRET` or `CARD_FINGERPRINT_SECRET` through Zod today (`CARD_FINGERPRINT_SECRET` is read directly via `process.env` in the scan-service; `APP_SESSION_SECRET` may not exist yet). If session-secret handling is still hard-coded, either add it to `env.ts` in an M2 follow-up commit or drop the unused secret ref here. The implementer reconciles the env-var list against `env.ts` + `grep -rn "process.env" server/src` before deploying — the Bicep must not declare a secret the app never reads, and must declare every one it does.)

- [ ] **Step 5: Create `infra/azure/modules/worker-job.bicep`**

```bicep
@description('attendance-grade-worker (spec §35.2) as a schedule-triggered Container Apps Job. Same image as web, command node server/dist/worker.js, every 5 minutes, one replica, scale-to-zero between runs.')
param name string
param location string
param tags object = {}
param environmentId string
param image string
param managedIdentityId string
param managedIdentityClientId string
param acrLoginServer string
param keyVaultUri string
param identityApiUrl string
param identityApiKeyName string
param cpu string
param memory string

var kvRef = '${keyVaultUri}secrets/'

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${managedIdentityId}': {} }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 600
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        { server: acrLoginServer, identity: managedIdentityId }
      ]
      secrets: [
        { name: 'database-url', keyVaultUrl: '${kvRef}database-url', identity: managedIdentityId }
        { name: 'lti-tool-signing-keys-json', keyVaultUrl: '${kvRef}lti-tool-signing-keys-json', identity: managedIdentityId }
        { name: 'card-fingerprint-secret', keyVaultUrl: '${kvRef}card-fingerprint-secret', identity: managedIdentityId }
        { name: 'identity-api-key', keyVaultUrl: '${kvRef}identity-api-key', identity: managedIdentityId }
        { name: 'appinsights-connection-string', keyVaultUrl: '${kvRef}appinsights-connection-string', identity: managedIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'grade-worker'
          image: image
          resources: { cpu: json(cpu), memory: memory }
          command: ['node', 'server/dist/worker.js']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'RUN_MIGRATIONS_ON_BOOT', value: 'false' }
            { name: 'AZURE_CLIENT_ID', value: managedIdentityClientId }
            { name: 'IDENTITY_API_URL', value: identityApiUrl }
            { name: 'IDENTITY_API_KEY_NAME', value: identityApiKeyName }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'LTI_TOOL_SIGNING_KEYS_JSON', secretRef: 'lti-tool-signing-keys-json' }
            { name: 'CARD_FINGERPRINT_SECRET', secretRef: 'card-fingerprint-secret' }
            { name: 'IDENTITY_API_KEY', secretRef: 'identity-api-key' }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'appinsights-connection-string' }
          ]
        }
      ]
    }
  }
}

output name string = job.name
```

- [ ] **Step 6: Create `infra/azure/modules/alerts.bicep`**

```bicep
@description('Azure Monitor action group + alert rules (spec §44). Thresholds are conservative defaults, tuned in Phase 8.')
param namePrefix string
param location string = 'global'
param tags object = {}
param alertEmail string
param appInsightsId string
param postgresResourceId string
param webContainerAppId string

resource ag 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${namePrefix}-ag'
  location: location
  tags: tags
  properties: {
    groupShortName: take(namePrefix, 12)
    enabled: true
    emailReceivers: [
      { name: 'ops', emailAddress: alertEmail, useCommonAlertSchema: true }
    ]
  }
}

// Elevated 5xx rate (App Insights requests failed).
resource fivexx 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-5xx'
  location: 'global'
  tags: tags
  properties: {
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failedRequests'
          metricNamespace: 'microsoft.insights/components'
          metricName: 'requests/failed'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

// Database unavailable (Postgres up-time / connections).
resource dbDown 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-db-down'
  location: 'global'
  tags: tags
  properties: {
    severity: 1
    enabled: true
    scopes: [postgresResourceId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'connectionsFailed'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'connections_failed'
          operator: 'GreaterThan'
          threshold: 5
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: ag.id }]
  }
}

// Sustained LTI launch failures / card-resolver failures / grade-job failures + Key Vault access
// failure are custom-metric or log-query alerts. Provision them as scheduledQueryRules over the
// App Insights customMetrics / traces emitted by server/src/telemetry/metrics.ts. One example:
resource launchFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${namePrefix}-lti-launch-failures'
  location: location == 'global' ? resourceGroup().location : location
  tags: tags
  kind: 'LogAlert'
  properties: {
    severity: 2
    enabled: true
    scopes: [appInsightsId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'customMetrics | where name == "lti.launch" | extend result = tostring(customDimensions.result) | where result == "failure" | summarize failures = sum(value) | where failures > 10'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ag.id] }
  }
}

output actionGroupId string = ag.id
```

(The grade-job / card-resolver / Key Vault-access alerts follow the same `scheduledQueryRules` shape over the corresponding metric names — `grade_jobs.failed`, `identity_lookup.errors`, and an Azure Activity-log / Key Vault `SecretGetFail` query. Add them as siblings; keep the queries pinned to the metric names in `metrics.ts`.)

- [ ] **Step 7: Wire the modules into `infra/azure/main.bicep`** — append after the Task-15 modules. Add params: `param containerImage string` (defaults to a placeholder `'REPLACED_BY_PIPELINE'`), `@secure() param postgresAdministratorPassword string`, `param identityApiUrl string = ''`, `param identityApiKeyName string = 'attendance-resolver'`. Then:

```bicep
module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: 'psql-${namePrefix}'
    location: location
    tags: tags
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageGb: postgresStorageGb
    backupRetentionDays: postgresBackupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdministratorPassword
    aadAdminObjectId: postgresAdminObjectId
  }
}

module caeEnv 'modules/containerapp-env.bicep' = {
  name: 'cae'
  params: {
    name: 'cae-${namePrefix}'
    location: location
    tags: tags
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    logAnalyticsSharedKey: listKeys(observability.outputs.workspaceId, '2023-09-01').primarySharedKey
  }
}

module web 'modules/web.bicep' = {
  name: 'web'
  params: {
    name: 'ca-${namePrefix}-web'
    location: location
    tags: tags
    environmentId: caeEnv.outputs.id
    image: containerImage
    managedIdentityId: identity.outputs.id
    managedIdentityClientId: identity.outputs.clientId
    acrLoginServer: registry.outputs.loginServer
    keyVaultUri: keyvault.outputs.uri
    appBaseUrl: 'https://${appHostname}'
    allowedTargetLinkUris: 'https://${appHostname}/index.html'
    cpu: containerCpu
    memory: containerMemory
    minReplicas: webMinReplicas
    maxReplicas: webMaxReplicas
    identityApiUrl: identityApiUrl
    identityApiKeyName: identityApiKeyName
  }
}

module workerJob 'modules/worker-job.bicep' = {
  name: 'worker'
  params: {
    name: 'caj-${namePrefix}-grade-worker'
    location: location
    tags: tags
    environmentId: caeEnv.outputs.id
    image: containerImage
    managedIdentityId: identity.outputs.id
    managedIdentityClientId: identity.outputs.clientId
    acrLoginServer: registry.outputs.loginServer
    keyVaultUri: keyvault.outputs.uri
    identityApiUrl: identityApiUrl
    identityApiKeyName: identityApiKeyName
    cpu: containerCpu
    memory: containerMemory
  }
}

module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    namePrefix: namePrefix
    location: location
    tags: tags
    alertEmail: alertEmail
    appInsightsId: resourceId('Microsoft.Insights/components', 'appi-${namePrefix}')
    postgresResourceId: resourceId('Microsoft.DBforPostgreSQL/flexibleServers', 'psql-${namePrefix}')
    webContainerAppId: web.outputs.name
  }
}

output webAppFqdn string = web.outputs.fqdn
output webAppName string = web.outputs.name
output workerJobName string = workerJob.outputs.name
output postgresFqdn string = postgres.outputs.fqdn
```

- [ ] **Step 8: Add the new secure/param entries to each `.bicepparam`** — `param identityApiUrl`, `param identityApiKeyName`; leave `containerImage` and `postgresAdministratorPassword` unset in the files (passed on the CLI: `-p containerImage=... -p postgresAdministratorPassword=...` come from the deploy workflow / bootstrap, NOT the committed params — a password in a committed `.bicepparam` violates spec §36).

- [ ] **Step 9: Validate + what-if against a scratch RG**

Run:
```bash
az bicep build --file infra/azure/main.bicep
az group create -n rg-attendance-devtest -l eastus
az deployment group what-if -g rg-attendance-devtest \
  -f infra/azure/main.bicep -p infra/azure/environments/dev.bicepparam \
  -p containerImage='mcr.microsoft.com/k8se/quickstart:latest' \
  -p postgresAdministratorPassword="$(openssl rand -base64 24)"
```
Expected: `what-if` prints a clean resource-creation plan (identity, ACR, LA, App Insights, KV, Postgres, CAE, web app, job, alerts) with no template errors. Delete the scratch RG afterward: `az group delete -n rg-attendance-devtest --yes --no-wait`.

- [ ] **Step 10: Commit**

```bash
git add infra/azure
git commit -m "infra(phase7): Bicep compute — Postgres Flexible, Container Apps env + web + worker job, alerts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M4 checkpoint

`az bicep build --file infra/azure/main.bicep` is clean; `az deployment group what-if` for the dev params produces a sensible plan against a scratch RG. No real environment deployed yet. Every secret the web/worker containers reference is a Key Vault reference; no secret value appears in any committed file.

---

## Task 17: `pull-request.yml` — the PR CI workflow (spec §40)

**Files:**
- Create: `.github/workflows/pull-request.yml`

**Interfaces:**
- Consumes: the repo's `npm` scripts, the `Dockerfile`, `playwright.config.ts`.
- Produces: a workflow that runs on every PR to `main` and never deploys. Jobs: `verify` (lint + typecheck + unit + build, with a Postgres service), `e2e` (Playwright, built server + Postgres service), `docker` (`docker build`, no push), `dep-scan` (advisory).

- [ ] **Step 1: Failing check**

Run: `test -f .github/workflows/pull-request.yml`
Expected: FAIL.

- [ ] **Step 2: Create `.github/workflows/pull-request.yml`**

```yaml
name: pull-request

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: pr-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: attendance_tracker
          POSTGRES_PASSWORD: attendance_tracker
          POSTGRES_DB: attendance_tracker
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U attendance_tracker"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker
      TEST_DATABASE_URL: postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: attendance_tracker
          POSTGRES_PASSWORD: attendance_tracker
          POSTGRES_DB: attendance_tracker
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U attendance_tracker"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      E2E_DATABASE_URL: postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_e2e
      CI: 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          load: true
          tags: attendance:pr-${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  dep-scan:
    runs-on: ubuntu-latest
    continue-on-error: true # advisory in Phase 7; promoted to blocking in Phase 8
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm audit --audit-level=high
      - uses: google/osv-scanner-action/osv-scanner-action@v1
        with:
          scan-args: |-
            --lockfile=package-lock.json
```

- [ ] **Step 3: Lint the workflow**

Run: `npx --yes @action-validator/cli .github/workflows/pull-request.yml` (or `actionlint` if available: `brew install actionlint && actionlint`).
Expected: no errors.

- [ ] **Step 4: Push a throwaway branch + open a draft PR to confirm it runs green**

```bash
git checkout -b phase7/ci-smoke && git commit --allow-empty -m "ci: smoke pull-request workflow" && git push -u origin phase7/ci-smoke
gh pr create --draft --title "ci smoke" --body "verifying pull-request.yml" --base main
gh pr checks --watch
```
Expected: `verify`, `e2e`, `docker` all green; `dep-scan` runs (may be yellow/advisory). Then `gh pr close --delete-branch`.

- [ ] **Step 5: Commit**

```bash
git checkout -  # back to the phase7 worktree branch
git add .github/workflows/pull-request.yml
git commit -m "ci(phase7): pull-request workflow — lint/typecheck/unit/build/e2e/docker/dep-scan (spec §40)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 18: Azure + GitHub bootstrap (dev) — RG, first `main.bicep` deploy, secret seeding, OIDC federation

**Files:**
- Modify: `infra/azure/README.md` — fill the OIDC-federation runbook section
- No application code. This task is executed with `az` + `gh` against real Azure/GitHub and documented so it is reproducible for stage/prod.

**Interfaces:**
- Consumes: `infra/azure/main.bicep`, `environments/dev.bicepparam`.
- Produces: a live `rg-attendance-dev` with every resource from `main.bicep`; the dev Key Vault seeded with all six secrets; a GitHub Environment `dev` with variables `AZURE_CLIENT_ID` (the dev managed identity's client id), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `ACR_LOGIN_SERVER`, `RESOURCE_GROUP`, `WEB_APP_NAME`, `WORKER_JOB_NAME`, `POSTGRES_FQDN`, `KEY_VAULT_NAME`, `APP_HOSTNAME`; a federated credential on the dev managed identity for `repo:cedarville-university/attendance-tracker:environment:dev`.

- [ ] **Step 1: Create the resource group and deploy the foundation + compute**

```bash
az account set --subscription "<SUBSCRIPTION_ID>"
az group create -n rg-attendance-dev -l eastus
PG_PW="$(openssl rand -base64 24)"
az deployment group create -g rg-attendance-dev \
  -f infra/azure/main.bicep -p infra/azure/environments/dev.bicepparam \
  -p containerImage='mcr.microsoft.com/k8se/quickstart:latest' \
  -p postgresAdministratorPassword="$PG_PW" \
  -p identityApiUrl='<REAL_OR_EMPTY>' \
  --query 'properties.outputs' -o json | tee /tmp/dev-outputs.json
```
Expected: succeeds; outputs include `containerRegistryLoginServer`, `managedIdentityClientId`, `managedIdentityPrincipalId`, `keyVaultName`, `keyVaultUri`, `webAppName`, `workerJobName`, `postgresFqdn`, `appInsightsConnectionString`. The web app initially runs the Microsoft quickstart image (placeholder until Task 19's first real deploy).

- [ ] **Step 2: Seed Key Vault secrets** (values generated/collected here, never committed)

```bash
KV=$(jq -r .keyVaultName.value /tmp/dev-outputs.json)
PG_FQDN=$(jq -r .postgresFqdn.value /tmp/dev-outputs.json)
AI_CS=$(jq -r .appInsightsConnectionString.value /tmp/dev-outputs.json)

az keyvault secret set --vault-name "$KV" --name database-url \
  --value "postgres://attendance_admin:${PG_PW}@${PG_FQDN}:5432/attendance?sslmode=require"
az keyvault secret set --vault-name "$KV" --name app-session-secret --value "$(openssl rand -base64 48)"
az keyvault secret set --vault-name "$KV" --name card-fingerprint-secret --value "$(openssl rand -base64 32)"
az keyvault secret set --vault-name "$KV" --name lti-tool-signing-keys-json --value "$(node scripts/generate-signing-keys.mjs)"  # see note
az keyvault secret set --vault-name "$KV" --name identity-api-key --value "<REAL_CEDARVILLE_PROXID_KEY_OR_PLACEHOLDER>"
az keyvault secret set --vault-name "$KV" --name appinsights-connection-string --value "$AI_CS"
```
Note: `lti-tool-signing-keys-json` must be a JSON array matching `rawSigningKeyConfigArraySchema` in `server/src/lti/signing-keys.ts` (`[{kid, privateKeyPkcs8Pem, status}]`). If no generator script exists, add a tiny `scripts/generate-signing-keys.mjs` that uses `jose.generateKeyPair('RS256')` + `exportPKCS8` and prints the array — commit that script (it contains no key material, only the generator).

- [ ] **Step 3: Create the dev federated identity credential**

```bash
MI_NAME="id-attendance-dev"
az identity federated-credential create \
  --name "github-env-dev" \
  --identity-name "$MI_NAME" -g rg-attendance-dev \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:cedarville-university/attendance-tracker:environment:dev" \
  --audiences "api://AzureADTokenExchange"
```

- [ ] **Step 4: Grant the managed identity deploy permissions** (AcrPush + a scoped Contributor for `az containerapp update` + Key Vault Secrets User was granted by Bicep)

```bash
MI_PRINCIPAL=$(jq -r .managedIdentityPrincipalId.value /tmp/dev-outputs.json)
SUB=$(az account show --query id -o tsv)
az role assignment create --assignee-object-id "$MI_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "AcrPush" --scope "/subscriptions/$SUB/resourceGroups/rg-attendance-dev"
az role assignment create --assignee-object-id "$MI_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Contributor" --scope "/subscriptions/$SUB/resourceGroups/rg-attendance-dev"
```
(Phase 8 tightens `Contributor` to `Container Apps Contributor` + `Managed Identity Operator`.)

- [ ] **Step 5: Create the GitHub Environment and variables**

```bash
gh api -X PUT repos/cedarville-university/attendance-tracker/environments/dev
for kv in \
  "AZURE_CLIENT_ID=$(jq -r .managedIdentityClientId.value /tmp/dev-outputs.json)" \
  "AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)" \
  "AZURE_SUBSCRIPTION_ID=$SUB" \
  "ACR_LOGIN_SERVER=$(jq -r .containerRegistryLoginServer.value /tmp/dev-outputs.json)" \
  "RESOURCE_GROUP=rg-attendance-dev" \
  "WEB_APP_NAME=$(jq -r .webAppName.value /tmp/dev-outputs.json)" \
  "WORKER_JOB_NAME=$(jq -r .workerJobName.value /tmp/dev-outputs.json)" \
  "POSTGRES_FQDN=$(jq -r .postgresFqdn.value /tmp/dev-outputs.json)" \
  "KEY_VAULT_NAME=$(jq -r .keyVaultName.value /tmp/dev-outputs.json)" \
  "APP_HOSTNAME=attendance-dev.CHANGEME.edu" ; do
  gh variable set "${kv%%=*}" --env dev --body "${kv#*=}"
done
```

- [ ] **Step 6: Fill `infra/azure/README.md`'s OIDC section** — paste the Steps 1–5 commands (parameterised) under `## GitHub OIDC federation (per environment)`, plus a table of the GitHub Environment variables each `deploy-*.yml` expects. Commit only the README change.

- [ ] **Step 7: Commit**

```bash
git add infra/azure/README.md scripts/generate-signing-keys.mjs
git commit -m "docs(phase7): Azure + GitHub OIDC bootstrap runbook; signing-key generator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

## Task 19: `deploy-dev.yml` + first real dev deployment

**Files:**
- Create: `.github/workflows/deploy-dev.yml`

**Interfaces:**
- Consumes: the `dev` GitHub Environment variables from Task 18; `infra/azure/main.bicep` + `environments/dev.bicepparam`; the `Dockerfile`.
- Produces: on push to `main`, an end-to-end deploy — build+push SHA-tagged image to ACR, `az deployment group create` (idempotent infra), a separate migrate job (JIT Postgres firewall rule + `node server/dist/migrate.js`), `az containerapp update` + `az containerapp job update` to the new image, a readiness wait on the new revision, and a smoke test.

- [ ] **Step 1: Failing check** — `test -f .github/workflows/deploy-dev.yml` → FAIL.

- [ ] **Step 2: Create `.github/workflows/deploy-dev.yml`**

```yaml
name: deploy-dev

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-dev
  cancel-in-progress: false

jobs:
  build-push:
    runs-on: ubuntu-latest
    environment: dev
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: ACR login
        run: az acr login --name "${{ vars.ACR_LOGIN_SERVER }}"
      - id: meta
        run: echo "image=${{ vars.ACR_LOGIN_SERVER }}/attendance:${{ github.sha }}" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.image }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  infra:
    needs: build-push
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: Deploy Bicep (idempotent)
        run: |
          az deployment group create -g "${{ vars.RESOURCE_GROUP }}" \
            -f infra/azure/main.bicep -p infra/azure/environments/dev.bicepparam \
            -p containerImage='${{ needs.build-push.outputs.image }}' \
            -p postgresAdministratorPassword='${{ secrets.PG_ADMIN_PASSWORD }}'
        # PG_ADMIN_PASSWORD is a GitHub *environment secret* set once at bootstrap; it is only
        # used to satisfy the template's @secure() param and matches the value already in Postgres.

  migrate:
    needs: [build-push, infra]
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: Open JIT Postgres firewall for this runner
        id: fw
        run: |
          RUNNER_IP=$(curl -s https://api.ipify.org)
          echo "ip=$RUNNER_IP" >> "$GITHUB_OUTPUT"
          PG_NAME=$(az postgres flexible-server list -g "${{ vars.RESOURCE_GROUP }}" --query '[0].name' -o tsv)
          echo "pg=$PG_NAME" >> "$GITHUB_OUTPUT"
          az postgres flexible-server firewall-rule create \
            -g "${{ vars.RESOURCE_GROUP }}" -n "$PG_NAME" \
            --rule-name "ci-migrate-${{ github.run_id }}" \
            --start-ip-address "$RUNNER_IP" --end-ip-address "$RUNNER_IP"
      - name: Run migrations
        run: |
          DB_URL=$(az keyvault secret show --vault-name "${{ vars.KEY_VAULT_NAME }}" --name database-url --query value -o tsv)
          npm ci
          npm run build
          DATABASE_URL="$DB_URL" node server/dist/migrate.js
      - name: Remove JIT firewall rule
        if: always()
        run: |
          az postgres flexible-server firewall-rule delete \
            -g "${{ vars.RESOURCE_GROUP }}" -n "${{ steps.fw.outputs.pg }}" \
            --rule-name "ci-migrate-${{ github.run_id }}" --yes || true

  deploy:
    needs: [build-push, migrate]
    runs-on: ubuntu-latest
    environment: dev
    steps:
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - name: Roll web + worker to the new image
        run: |
          az containerapp update -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WEB_APP_NAME }}" \
            --image '${{ needs.build-push.outputs.image }}'
          az containerapp job update -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WORKER_JOB_NAME }}" \
            --image '${{ needs.build-push.outputs.image }}'
      - name: Wait for readiness on the new revision
        run: |
          FQDN=$(az containerapp show -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WEB_APP_NAME }}" \
            --query 'properties.configuration.ingress.fqdn' -o tsv)
          for i in $(seq 1 40); do
            code=$(curl -s -o /dev/null -w '%{http_code}' "https://$FQDN/health/ready" || true)
            if [ "$code" = "200" ]; then echo "ready after ${i}0s"; exit 0; fi
            sleep 10
          done
          echo "new revision never became ready"; exit 1
      - name: Smoke test
        run: |
          FQDN=$(az containerapp show -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WEB_APP_NAME }}" \
            --query 'properties.configuration.ingress.fqdn' -o tsv)
          curl -sf "https://$FQDN/health/live" | grep -q '"status":"ok"'
          curl -sf "https://$FQDN/lti/jwks" | grep -q '"keys"'
          curl -sf "https://$FQDN/index.html" | grep -qi '<title'
```

Note: `secrets.PG_ADMIN_PASSWORD` is a GitHub Environment **secret** (not a variable) set once during Task 18 bootstrap to the same value passed to `postgresAdministratorPassword` in Task 18 Step 1. Storing it is acceptable — it is the DB admin password, not an Azure deployment credential; spec §41 forbids the latter, and it is scoped to the `dev` environment. Alternative (cleaner, note for the implementer): read it from Key Vault in the `infra` job the same way `migrate` reads `database-url`, and drop the GitHub secret entirely.

- [ ] **Step 3: Lint the workflow** — `actionlint .github/workflows/deploy-dev.yml` → no errors.

- [ ] **Step 4: Trigger the first deploy**

Push the Phase 7 branch's merge to `main` is NOT wanted yet (Phase 7 is still on its own branch). Instead run it manually against the branch:
```bash
gh workflow run deploy-dev.yml --ref <phase7-branch>
gh run watch
```
Expected: all jobs green; the final smoke step passes against `https://<dev-fqdn>/`.

- [ ] **Step 5: Manual confirmation**

```bash
FQDN=$(az containerapp show -g rg-attendance-dev -n <web-app-name> --query 'properties.configuration.ingress.fqdn' -o tsv)
curl -s "https://$FQDN/health/ready"     # {"status":"ready"}
curl -sI "https://$FQDN/index.html" | grep -i 'content-security-policy\|strict-transport-security'
az containerapp job start -g rg-attendance-dev -n <worker-job-name>   # kick one worker run
az containerapp job execution list -g rg-attendance-dev -n <worker-job-name> --query '[0].properties.status'  # Succeeded
```
Expected: ready 200; HTTPS + security headers present; a manual worker execution reports `Succeeded`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy-dev.yml
git commit -m "ci(phase7): deploy-dev workflow — OIDC, SHA image, separate migrate job, readiness wait, smoke (spec §41-42)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M5 checkpoint

A PR runs `pull-request.yml` green. A `workflow_dispatch` of `deploy-dev.yml` builds a SHA-tagged image, deploys infra idempotently, runs migrations as an isolated job with a JIT firewall rule that is always torn down, rolls the web app + worker job, and passes a readiness + smoke check against the live dev URL over HTTPS. No long-lived Azure credential exists in GitHub.

---

## Task 20: Confirm observability end-to-end; deploy and test-fire alerts

**Files:**
- No new files (alerts already in `infra/azure/modules/alerts.bicep` from Task 16; this task verifies them live and tunes queries if the metric names don't line up).
- Modify: `infra/azure/modules/alerts.bicep` — only if a `scheduledQueryRules` query needs its metric name corrected to match `server/src/telemetry/metrics.ts`.

**Interfaces:**
- Consumes: the dev deployment from M5; `APPLICATIONINSIGHTS_CONNECTION_STRING` wired via Key Vault.
- Produces: verified traces + metrics in Application Insights; alert rules present and at least one confirmed to fire.

- [ ] **Step 1: Generate traffic against dev and confirm telemetry lands**

```bash
FQDN=<dev-fqdn>
for i in $(seq 1 20); do curl -s "https://$FQDN/health/ready" >/dev/null; curl -s "https://$FQDN/index.html" >/dev/null; done
# force some 4xx
for i in $(seq 1 5); do curl -s "https://$FQDN/api/me" >/dev/null; done
```
Then in Application Insights (portal or `az monitor app-insights query`):
```bash
AI_APP_ID=$(az monitor app-insights component show -g rg-attendance-dev -a appi-attendance-dev --query appId -o tsv)
az monitor app-insights query --app "$AI_APP_ID" --analytics-query \
  "requests | where timestamp > ago(15m) | summarize count() by resultCode | order by resultCode asc"
az monitor app-insights query --app "$AI_APP_ID" --analytics-query \
  "customMetrics | where timestamp > ago(15m) | summarize count() by name"
```
Expected: `requests` rows for `/health/ready` and `/index.html`; `customMetrics` includes `http.server.duration` and at least the counters emitted so far. If `customMetrics` is empty, `startTelemetry()` is not running before `buildApp` — fix the import order in `index.ts` (Task 9 Step 4 note) and redeploy.

- [ ] **Step 2: Confirm structured logs reach Log Analytics with redaction intact**

```bash
WS_ID=$(az monitor log-analytics workspace show -g rg-attendance-dev -n log-attendance-dev --query customerId -o tsv)
az monitor log-analytics query -w "$WS_ID" --analytics-query \
  "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(15m) | where Log_s has 'requestId' | take 5"
```
Expected: JSON log lines with `requestId`, `route`, `httpStatus`, `durationMs`; **no** `authorization`, `set-cookie`, `cardCode`, or token values (grep the output to be sure).

- [ ] **Step 3: Confirm the alert rules exist and are enabled**

```bash
az monitor metrics alert list -g rg-attendance-dev -o table
az monitor scheduled-query list -g rg-attendance-dev -o table
```
Expected: `attendance-dev-5xx`, `attendance-dev-db-down`, `attendance-dev-lti-launch-failures` (+ any siblings added) all `Enabled=true`, action group `attendance-dev-ag` attached.

- [ ] **Step 4: Test-fire one alert** — temporarily lower the 5xx threshold and drive some 500s, or use `az monitor metrics alert update ... --condition` to a trivially-true condition for 5 minutes, confirm the email arrives, then restore. Document the test in `infra/azure/README.md` under `## Alert verification`.

- [ ] **Step 5: Commit (only if a query/threshold was corrected)**

```bash
git add infra/azure/modules/alerts.bicep infra/azure/README.md
git commit -m "infra(phase7): verify observability + alerts against dev; align alert queries to metric names

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

> **SUPERSEDED 2026-08-31** — no `stage` env. Task 21 is now a `deploy-dev.yml` retrofit
> (`v*`-tag trigger) + wiring the real ProxID resolver into `dev`. Operative spec:
> `.superpowers/sdd/task-21-brief.md`.

## Task 21: `deploy-stage.yml` + staging environment (with the real ProxID resolver)

**Files:**
- Create: `.github/workflows/deploy-stage.yml`
- Modify: `infra/azure/README.md` — stage bootstrap deltas

**Interfaces:**
- Consumes: `environments/stage.bicepparam`; a `stage` GitHub Environment bootstrapped exactly like `dev` (Task 18 runbook, `environmentName=stage`, `rg-attendance-stage`, federated subject `...:environment:stage`).
- Produces: on a `v*` tag or `workflow_dispatch`, the same deploy pipeline as `deploy-dev.yml` targeting staging. The stage Key Vault holds the **real** Cedarville `IDENTITY_API_*` values (decision #3), so `createHttpIdentityResolverFromEnv()` returns a real resolver there.

- [ ] **Step 1: Bootstrap the stage environment** — run the Task 18 runbook with stage values:

```bash
az group create -n rg-attendance-stage -l eastus
PG_PW_STAGE="$(openssl rand -base64 24)"
az deployment group create -g rg-attendance-stage \
  -f infra/azure/main.bicep -p infra/azure/environments/stage.bicepparam \
  -p containerImage='mcr.microsoft.com/k8se/quickstart:latest' \
  -p postgresAdministratorPassword="$PG_PW_STAGE" \
  -p identityApiUrl='<REAL_CEDARVILLE_IDENTITY_API_URL>' \
  --query 'properties.outputs' -o json | tee /tmp/stage-outputs.json
# seed secrets (same six names) — identity-api-key = the REAL ProxID key this time
# create federated credential subject repo:...:environment:stage
# gh api -X PUT .../environments/stage ; gh variable set ... --env stage
```
Expected: `rg-attendance-stage` fully provisioned; stage Key Vault seeded; `identity-api-key` is the real value; GitHub Environment `stage` variables set.

- [ ] **Step 2: Create `.github/workflows/deploy-stage.yml`** — identical structure to `deploy-dev.yml` with three changes: (a) trigger, (b) `environment: stage`, (c) param file.

```yaml
name: deploy-stage

on:
  push:
    tags: ['v*']
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-stage
  cancel-in-progress: false

jobs:
  build-push:
    runs-on: ubuntu-latest
    environment: stage
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: az acr login --name "${{ vars.ACR_LOGIN_SERVER }}"
      - id: meta
        run: echo "image=${{ vars.ACR_LOGIN_SERVER }}/attendance:${{ github.sha }}" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with: { context: ., push: true, tags: '${{ steps.meta.outputs.image }}', cache-from: type=gha, cache-to: 'type=gha,mode=max' }

  infra:
    needs: build-push
    runs-on: ubuntu-latest
    environment: stage
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: |
          az deployment group create -g "${{ vars.RESOURCE_GROUP }}" \
            -f infra/azure/main.bicep -p infra/azure/environments/stage.bicepparam \
            -p containerImage='${{ needs.build-push.outputs.image }}' \
            -p postgresAdministratorPassword='${{ secrets.PG_ADMIN_PASSWORD }}' \
            -p identityApiUrl='${{ vars.IDENTITY_API_URL }}'

  migrate:
    needs: [build-push, infra]
    runs-on: ubuntu-latest
    environment: stage
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - id: fw
        run: |
          RUNNER_IP=$(curl -s https://api.ipify.org)
          PG_NAME=$(az postgres flexible-server list -g "${{ vars.RESOURCE_GROUP }}" --query '[0].name' -o tsv)
          echo "pg=$PG_NAME" >> "$GITHUB_OUTPUT"
          az postgres flexible-server firewall-rule create -g "${{ vars.RESOURCE_GROUP }}" -n "$PG_NAME" \
            --rule-name "ci-migrate-${{ github.run_id }}" --start-ip-address "$RUNNER_IP" --end-ip-address "$RUNNER_IP"
      - run: |
          DB_URL=$(az keyvault secret show --vault-name "${{ vars.KEY_VAULT_NAME }}" --name database-url --query value -o tsv)
          npm ci && npm run build
          DATABASE_URL="$DB_URL" node server/dist/migrate.js
      - if: always()
        run: az postgres flexible-server firewall-rule delete -g "${{ vars.RESOURCE_GROUP }}" -n "${{ steps.fw.outputs.pg }}" --rule-name "ci-migrate-${{ github.run_id }}" --yes || true

  deploy:
    needs: [build-push, migrate]
    runs-on: ubuntu-latest
    environment: stage
    steps:
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      - run: |
          az containerapp update -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WEB_APP_NAME }}" --image '${{ needs.build-push.outputs.image }}'
          az containerapp job update -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WORKER_JOB_NAME }}" --image '${{ needs.build-push.outputs.image }}'
      - name: Wait for readiness
        run: |
          FQDN=$(az containerapp show -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WEB_APP_NAME }}" --query 'properties.configuration.ingress.fqdn' -o tsv)
          for i in $(seq 1 40); do
            [ "$(curl -s -o /dev/null -w '%{http_code}' "https://$FQDN/health/ready")" = "200" ] && exit 0
            sleep 10
          done
          exit 1
      - name: Smoke
        run: |
          FQDN=$(az containerapp show -g "${{ vars.RESOURCE_GROUP }}" -n "${{ vars.WEB_APP_NAME }}" --query 'properties.configuration.ingress.fqdn' -o tsv)
          curl -sf "https://$FQDN/health/live" | grep -q '"status":"ok"'
          curl -sf "https://$FQDN/lti/jwks" | grep -q '"keys"'
```

- [ ] **Step 3: Lint** — `actionlint .github/workflows/deploy-stage.yml` → no errors.

- [ ] **Step 4: Tag and deploy**

```bash
git tag v0.7.0-rc1 && git push origin v0.7.0-rc1     # or: gh workflow run deploy-stage.yml --ref <phase7-branch>
gh run watch
```
Expected: full pipeline green against `https://<stage-fqdn>/`.

- [ ] **Step 5: Confirm the real resolver is active on stage** — check the stage container's env (`az containerapp show ... --query "properties.template.containers[0].env"`) shows `IDENTITY_API_URL` set and `IDENTITY_API_KEY` as a `secretRef`; check App Insights `customMetrics` for `identity_lookup.latency` after driving a scan through a stage LTI launch (done fully in Task 22). If `createHttpIdentityResolverFromEnv()` still returns `null`, its required env-var names don't match what Bicep set — reconcile against `server/src/identity/http-resolver.ts` and redeploy.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy-stage.yml infra/azure/README.md
git commit -m "ci(phase7): deploy-stage workflow (v* tag / dispatch); staging runs the real ProxID resolver

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M6 checkpoint

Traces, custom metrics, and redacted structured logs from the dev deployment are visible in Application Insights + Log Analytics; alert rules exist and one has been confirmed to fire. `deploy-stage.yml` deploys a `v*` tag to a fully-provisioned staging environment whose resolver is the real Cedarville ProxID service. Staging is reachable over HTTPS at its own hostname.

---

> **SUPERSEDED 2026-08-31** — the gate runs against `dev` (the single non-prod env), not a
> separate staging env. Operative spec: `.superpowers/sdd/task-22-brief.md`.

## Task 22: Real-Canvas verification gate against staging — THE EXIT CRITERION (spec §54 Phase 7)

**Files:**
- Modify: `docs/canvas-lti/progress.md` — record every step's result under a new `## Phase 7 — what actually happened` section
- Modify: `server/src/lti/roles.ts` — only if step 7 shows the real Canvas `roles` array needs it (follow-up #8-roles)
- Create (if `roles.ts` changes): `server/tests/lti/roles-real-canvas.test.ts` — pin the reconciled URI set with a comment citing the captured payload

**Interfaces:**
- Consumes: the live staging deployment (M6); the institution's Canvas test/beta instance + admin + Developer Key; `docs/canvas-installation.md`.
- Produces: a completed verification record proving an instructor launch from a real Canvas course succeeds (new tab) and a learner-role launch is refused (HTTP 403). This is the milestone that closes Phase 7.

- [ ] **Step 1: Register the tool in Canvas test/beta** — Admin → Apps → paste-JSON, using the block in `docs/canvas-installation.md` §1 with `<APP_BASE_URL>` = the staging origin (`https://attendance-stage.<domain>`). **Before pasting, re-confirm the three scope strings against Canvas's current LTI configuration reference (spec §58)** — do not trust the doc's copy. Toggle the key On; copy the **Client ID**.

- [ ] **Step 2: Install in a test course** — test course → Settings → Apps → +App → By Client ID → paste → install. Note the **Deployment ID**.

- [ ] **Step 3: Fetch Canvas's real endpoints** (never pattern-match the hostname — spec §11)

```bash
curl -s https://<canvas-domain>/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, token_endpoint}'
curl -s https://<canvas-domain>/api/lti/security/jwks | jq '.keys | length'
```

- [ ] **Step 4: Set staging launch config + seed the registration**

- Set the staging web app's `ALLOWED_TARGET_LINK_URIS` to include exactly `https://attendance-stage.<domain>/index.html` (it already is, from Bicep — confirm).
- Confirm `LTI_TOOL_SIGNING_KEYS_JSON` is the persistent Key Vault value (not an ephemeral per-boot key) — it is, from Task 21 seeding.
- Seed the registration against the **staging** `DATABASE_URL`:

```bash
DB_URL=$(az keyvault secret show --vault-name <stage-kv> --name database-url --query value -o tsv)
# open a JIT firewall rule for your workstation IP, then:
DATABASE_URL="$DB_URL" npx tsx server/src/database/seed-registration.ts \
  --issuer "<issuer>" --client-id "<client-id>" --deployment-id "<deployment-id>" \
  --oidc-auth-endpoint "<authorization_endpoint>" --token-endpoint "<token_endpoint>" \
  --platform-jwks-uri "https://<canvas-domain>/api/lti/security/jwks"
# remove the firewall rule
```
(Use `seed-registration.ts`'s actual flag names — check its usage comment.)

- [ ] **Step 5: Instructor launch** — from the test course, click **Attendance** as an instructor. Confirm ALL of:
  - a **new browser tab** opens (spec §8 window-target);
  - the launch completes with no error;
  - the scanner UI renders;
  - an `attendance_session` cookie is set (DevTools → Application → Cookies).
  Record pass/fail + screenshots in `progress.md`.

- [ ] **Step 6: Learner-role launch** — as a test student (or Canvas Student View if it sends learner-role claims), launch the same tool. Confirm: **HTTP 403** and **no** session cookie. Record the exact response.

- [ ] **Step 7: Reconcile `AUTHORIZED_INSTRUCTOR_ROLE_URIS`** — from a real instructor launch, capture the `roles` claim (temporary debug log in `launch.ts` or `claims.ts`, removed before commit; or inspect the decoded `id_token` from Canvas's launch POST). Compare against `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS`. If Canvas sends a URI not in the set that should authorize (or the set contains one Canvas never sends), update `roles.ts` and add `server/tests/lti/roles-real-canvas.test.ts` pinning the reconciled set with a comment quoting the captured `roles` array (values only — no names/ids). Run `npm test`.

- [ ] **Step 8: Run the live §46 AGS matrix once** — against the staging deployment + Canvas test/beta, exercise the spec §46 AGS cases end to end: create a real attendance session in the test course, close it, let the worker post scores, and verify in the Canvas Gradebook: line-item created; a second close updates the score (not a duplicate line item); a concluded-course case; a correction that changes the cumulative grade re-posts. Record each case's result in `progress.md`. (Automating this as a `RUN_LIVE_CANVAS=1`-gated Vitest suite is optional; the record is the deliverable.)

- [ ] **Step 9: Write the `progress.md` Phase 7 section** — mirror the style of the existing `## Phase 6 — what actually happened`: what was built (M1–M6), what was verified live (M7 steps 5/6/8 with outcomes), and any deferred items discovered. Explicitly state the exit criterion result: "instructor launch from a real Canvas course against staging succeeded; learner-role launch returned 403."

- [ ] **Step 10: Commit**

```bash
git add docs/canvas-lti/progress.md server/src/lti/roles.ts server/tests/lti/roles-real-canvas.test.ts
git commit -m "docs(phase7): real-Canvas verification against staging — exit criterion met

Instructor launch from a real Canvas test/beta course opened the scanner in
a new tab; a learner-role launch returned HTTP 403. AUTHORIZED_INSTRUCTOR_ROLE_URIS
reconciled against the captured roles claim. Live §46 AGS matrix run; results
in progress.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M7 checkpoint — **Phase 7 exit criterion**

A tagged/approved release deployed to staging with **no long-lived Azure deployment password in GitHub**; an instructor LTI launch from a **real Canvas course** against the deployed staging instance **succeeded** (scanner opened in a new tab); a **learner-role launch was refused with HTTP 403**. Recorded in `docs/canvas-lti/progress.md`.

---

> **SUPERSEDED 2026-08-31** — `deploy-prod.yml` mirrors the FINAL `deploy-dev.yml` (there is no
> `deploy-stage.yml`). Operative spec: `.superpowers/sdd/task-23-brief.md`.

## Task 23: Production delivery — authored, not run (M8)

**Files:**
- Create: `.github/workflows/deploy-prod.yml`
- Modify: `infra/azure/environments/prod.bicepparam` — finalise the real prod hostname / SKUs / alert email
- Modify: `infra/azure/README.md` — prod bootstrap runbook + "prod deploy is a deliberate manual step" note
- Modify: `docs/canvas-lti/progress.md` — mark Phase 7 complete; list Phase 8 carry-overs

**Interfaces:**
- Consumes: the same `main.bicep`; a `production` GitHub Environment with required reviewers.
- Produces: a `deploy-prod.yml` that is lint-clean and structurally identical to `deploy-stage.yml` but gated on the `production` environment and triggered only by `workflow_dispatch` or a GitHub Release. **No production deploy is executed in Phase 7.**

- [ ] **Step 1: Create `.github/workflows/deploy-prod.yml`** — copy `deploy-stage.yml`, then:
  - `on:` → `workflow_dispatch:` only (optionally `release: { types: [published] }`);
  - every job `environment: production`;
  - param file → `infra/azure/environments/prod.bicepparam`;
  - add a first job `guard` that `echo`s the target and requires the `production` environment (its required-reviewers gate blocks the rest until approved);
  - `concurrency.group: deploy-prod`.

```yaml
name: deploy-prod

on:
  workflow_dispatch:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-prod
  cancel-in-progress: false

jobs:
  # ... identical job graph to deploy-stage.yml, every job `environment: production`,
  # param file infra/azure/environments/prod.bicepparam.
  # The `production` GitHub Environment's required-reviewers rule gates build-push
  # until a human approves the run.
```

(Write the jobs out in full, mirroring `deploy-stage.yml` verbatim with the three substitutions above — do not leave a `# ...` comment in the committed file.)

- [ ] **Step 2: Configure the `production` GitHub Environment**

```bash
gh api -X PUT repos/cedarville-university/attendance-tracker/environments/production \
  -f "reviewers[][type]=User" -F "reviewers[][id]=<REVIEWER_USER_ID>" \
  -F "deployment_branch_policy[protected_branches]=true" -F "deployment_branch_policy[custom_branch_policies]=false"
```
Expected: `production` environment with required reviewers and branch protection. Do NOT create the prod resource group or run the workflow.

- [ ] **Step 3: Document the prod bootstrap** in `infra/azure/README.md` — the same Task-18 runbook with `environmentName=prod`, `rg-attendance-prod`, federated subject `repo:cedarville-university/attendance-tracker:environment:production`, and a bold note: "Run this, seed prod secrets, and dispatch `deploy-prod.yml` only when the team decides to go live — it is intentionally not part of Phase 7."

- [ ] **Step 4: Lint**

Run: `actionlint .github/workflows/deploy-prod.yml`
Expected: no errors.

- [ ] **Step 5: Validate prod params compile**

Run: `az bicep build-params --file infra/azure/environments/prod.bicepparam`
Expected: resolves with no `CHANGEME` left (replace with the real hostname / alert email; SKUs already set).

- [ ] **Step 6: Update `docs/canvas-lti/progress.md`** — flip the Phase 7 checklist box to `[x]`, note "production authored, not deployed", and list the Phase 8 carry-overs (the five `docs/*.md`, private DB migration path, `Contributor`→least-privilege, blocking dep-scan, per-institution grading policy, retention policy surface, the carried cleanup backlog).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/deploy-prod.yml infra/azure/environments/prod.bicepparam infra/azure/README.md docs/canvas-lti/progress.md
git commit -m "ci(phase7): author deploy-prod workflow + production environment (no prod deploy run)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01A3nhkWXAJX5nANhFxiw8rZ"
```

---

### Milestone M8 checkpoint

`deploy-prod.yml` is committed and lint-clean; `prod.bicepparam` compiles with real values; the `production` GitHub Environment has required reviewers. No production resources exist and no prod deploy has run. `docs/canvas-lti/progress.md` marks Phase 7 complete with Phase 8 carry-overs listed.

---

## Post-plan: review and finish

After M8:

1. **Phase-7 range review** — `$BASE/scripts/review-package <base> <head>` where `<base>` is the branch point (`bcd885c`) and `<head>` is the final Phase 7 commit; run `superpowers:requesting-code-review` over the package.
2. Address review findings via `superpowers:receiving-code-review`.
3. **`superpowers:finishing-a-development-branch`** — present merge/PR/cleanup options for the Phase 7 branch (note: Phases 0–6 are still unmerged on `worktree-canvas-lti-phase0`; the finish step must account for the whole stack, not just Phase 7).
4. Then plan Phase 8 separately → `docs/superpowers/plans/2026-08-29-canvas-lti-phase8-hardening.md`.

---

## Self-Review

**Spec coverage (spec §6, §35–§44, §46, §54 Phase 7):**

| Spec item | Task |
|---|---|
| §6 npm workspaces, `server/src/{security,telemetry}/`, `infra/azure/` layout | 1, 4, 8, 15–16 |
| §35.1 web Container App (static+API+LTI+JWKS+health, warm replica) | 16 (web.bicep), 15 params |
| §35.2 worker: same image / diff command, 5-min cadence, purge + retention | 12, 16 (worker-job.bicep) |
| §35.3 Postgres Flexible, TLS required, backups/PITR | 16 (postgres.bicep) |
| §35.4 Key Vault contents + Managed Identity + unversioned refs | 15 (keyvault.bicep), 16 (web/worker secret refs) |
| §35.5 ACR, SHA tags, never `latest` | 16 (registry.bicep), 19/21 (image tag = `github.sha`) |
| §36 IaC under `infra/azure/`, Bicep, param list, dev/stage/prod, no secrets | 15–16 |
| §37 dev/stage/prod isolation, never share schemas | 15–16 (separate RG/DB/registration per env), 18/21/23 |
| §38 multi-stage Docker, non-root, no .git/.env/key, one port, SIGTERM, `/health/{live,ready}` | 10, 11, 13 |
| §39 versioned migrations, no replica race, separate CI job, committed | 2, 3, 19 (migrate job) |
| §40 PR workflow (lint/typecheck/unit/LTI-security/frontend/build/docker/dep-scan), no prod deploy, Chromium e2e, mocked WebHID | 14, 17 |
| §41 OIDC federation, no stored Azure password, `id-token: write`, prod-scoped federation | 18, 19, 21, 23 |
| §42 deploy sequence (CI→OIDC→build→SHA tag→push→bicep→migrate→revision→readiness→smoke), single-revision rollback | 19, 21 |
| §43 promotion model (main→dev, tag→stage, approved env→prod), GitHub Environments | 19 (push main), 21 (v* tag), 23 (production env + reviewers) |
| §44 request IDs, structured JSON + safe fields + redaction, OTel metrics list, alerts list | 7, 8, 16 (alerts.bicep), 20 |
| §46 AGS/NRPS matrix against real nonproduction Canvas | 22 step 8 |
| §54 Phase 7 real-Canvas register/install/seed/launch, learner 403, verify role URIs, exit criterion | 22 |
| Backlog 6.1 AGS line-item origin check | 5, 6 |
| Follow-up #7 Playwright launch→…→grade-sync | 14 |
| Follow-up #8 `buildApp(env, deps)` + integration test, delete hardening CSP copy | 9 |
| Follow-up #8-roles reconcile `AUTHORIZED_INSTRUCTOR_ROLE_URIS` | 22 step 7 |
| Decision #3 real ProxID resolver from first deploy | 16 (identity env), 18/21 (seed real key) |
| Decision #6 `security/`+`telemetry/` dirs in P7, docs deferred | 4, 5, 7, 8; docs listed as Phase 8 carry-over in 23 |
| Decision #8 migrations = runner job + JIT firewall rule | 19, 21 |

No spec item in scope is left without a task.

**Placeholder scan:** Bicep/YAML tasks give complete file content. Two intentional "fill from the real thing" spots remain and are explicitly bounded: (a) Task 14's WebHID fixture bytes / UI selector text — the plan says reuse `web/tests/*` fixtures and real `web/ui.js` labels, not invent them; (b) Task 16's web.bicep env-var list — the plan requires reconciling against `server/src/config/env.ts` + `grep process.env` before deploy. These are verification instructions, not TODOs. `CHANGEME` in `.bicepparam` is deliberate (real hostnames/emails are environment-specific and set at bootstrap, not in the plan) and Task 23 step 5 gates on removing it for prod.

**Type consistency:** `buildApp(env, deps)` / `AppDeps` (Task 9) matches its consumers in Task 10 (`registerHealthRoutes(app, { db })`), Task 11 (`installShutdownHandlers(app, pool)`), Task 14 (e2e boots `node dist/index.js`, not `buildApp` directly — fine). `resolveMigrationsFolder()` (Task 2) is consumed by `applyMigrations` (same file) and `migrate.ts` (Task 3) via `applyMigrations`. `RUN_MIGRATIONS_ON_BOOT` (Task 3) consumed in `index.ts`/`worker.ts` (Tasks 3, 9, 11) and set `false` in Bicep (Task 16). `shouldStop` added to `ProcessGradeSyncJobsDeps` (Task 11) and passed by `worker.ts` (Task 11). `runMaintenancePass` signature (Task 12) matches its call in `worker.ts` (Task 11 step 6) — Task 11 is written before Task 12 but references it; the plan notes the stub-first option. `metrics` / `setGradeJobGauges` (Task 8) consumed by `request-id.ts` (Task 8) and `worker.ts` (Task 11). `safeLogFields` / `SAFE_LOG_FIELDS` (Task 7) consumed by `request-id.ts` (Task 8). `buildCspDirectives` (Task 4) consumed by `app.ts` (Task 9) and asserted in `app.test.ts` (Task 9). `assertSameOrigin` (Task 5) consumed by `ags.ts` (Task 6). GitHub Environment variable names in Task 18 (`AZURE_CLIENT_ID`, `ACR_LOGIN_SERVER`, `RESOURCE_GROUP`, `WEB_APP_NAME`, `WORKER_JOB_NAME`, `KEY_VAULT_NAME`, `POSTGRES_FQDN`) match their `${{ vars.* }}` uses in Tasks 19, 21, 23.

**Ordering note for the executor:** Task 9 imports `registerHealthRoutes` (Task 10) and `app.ts` is referenced by nothing until Task 9 — create the Task-10 stub during Task 9 as the plan says, or run Task 10 first. Task 11's `worker.ts` references `runMaintenancePass` (Task 12) and `countGradeJobsByState` — create those as stubs during Task 11 or reorder 12 before 11's worker edit. Both are called out inline.






