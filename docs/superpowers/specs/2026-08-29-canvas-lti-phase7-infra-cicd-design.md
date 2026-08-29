# Canvas LTI — Phase 7: Infrastructure and CI/CD — Design

**Date:** 2026-08-29
**Spec:** `docs/canvas-lti/spec.md` §6, §35–§44, §46, §54 (Phase 7)
**Branch base:** current HEAD of `worktree-canvas-lti-phase0` (`bcd885c`), a fresh worktree
(`superpowers:using-git-worktrees`) — **not** `main`. Phases 0–6 have not landed on `main`; that
merge is a separate decision and not part of this work.

This is the design (spec) that `superpowers:writing-plans` turns into
`docs/superpowers/plans/2026-08-29-canvas-lti-phase7-infra-cicd.md`.

---

## 1. Goal and exit criterion

Take the Phase 0–6 application — today runnable only via `tsx` against a local Docker Postgres — and
make it a deployable, observable, CI/CD-delivered service on Azure Container Apps, then perform the
real-Canvas registration and launch verification that every earlier phase deferred.

**Exit criterion (spec §54 Phase 7):** a tagged/approved release deploys to the **staging**
environment with **no long-lived Azure deployment password stored in GitHub** (OIDC federation
only), and an instructor LTI launch from a **real Canvas course** (the institution's Canvas
test/beta instance) against the deployed staging instance **succeeds** — opening the scanner in a
new tab — while a **learner-role launch is refused with HTTP 403**. The §46 AGS/NRPS integration
matrix is exercised once against that live instance.

Production Bicep and `deploy-prod.yml` are **authored** in Phase 7 and the `production` GitHub
Environment is configured, but the first production *deploy* is left as a deliberate later
button-press.

---

## 2. Decisions already made (do not re-litigate)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Azure access | Full — subscription + RG + OIDC federation available via `az`. Phase 7 authors Bicep **and** deploys (dev + stage). |
| 2 | Nonproduction Canvas | Available now — test/beta instance + admin + Developer Key. Phase 7 runs the full real-Canvas verification gate. |
| 3 | ProxID resolver | **Real resolver from the start.** Real `IDENTITY_API_*` values go into the dev + stage Key Vaults; `createHttpIdentityResolverFromEnv()` returns a real resolver in deployed envs. `MockIdentityResolver` stays the local-dev default. |
| 4 | npm workspaces | **Introduce**, minimal shape: `["server", "packages/*"]`; `web/` stays a static asset dir (not a workspace); `packages/shared/` not created until a real shared module exists. |
| 5 | Hosting | **Azure Container Apps** — `attendance-web` (Container App) + `attendance-grade-worker` (Container Apps **Job**, cron), Postgres Flexible Server, Key Vault + user-assigned Managed Identity, Log Analytics + Application Insights, ACR. |
| 6 | Docs `architecture/security/operations/development/identity-resolvers` + `service-url.ts`/`csrf.ts` relocation | **Split** — create `server/src/security/` + `server/src/telemetry/` in Phase 7 where code naturally lands; write the five `docs/*.md` files in **Phase 8**. |
| 7 | Backlog 6.1 (AGS line-item origin check) | **Fold into Phase 7** (security-adjacent; Phase 7 runs the first live AGS verification). |
| 8 | DB migrations on deploy | **Separate GitHub Actions runner job** (`node dist/migrate.js`), not migrate-on-boot. Postgres Flexible Server has public network access enabled; the migrate job adds a **just-in-time firewall rule** for the runner's egress IP and removes it in an `always()` step. Moving to a private path (Container Apps Job / private endpoint) is a Phase 8 hardening item. |
| 9 | Phase 7 decomposition | **One plan**, internally organised as milestones M1–M8 (§9). |
| 10 | Real-Canvas verification target | **Staging → Canvas test/beta.** Dev + staging Container Apps environments both stood up in Phase 7; prod authored only. |
| 11 | Execution sequencing | **Inside-out** (Approach A): app → image → infra → deploy → verify. Nothing touches Azure until the container image is proven locally; the Bicep container-app module is written after M2 finalises the env-var / port / health surface. |

---

## 3. Application packaging (M1–M2)

### 3.1 Workspaces layout

```
attendance-tracker/
├── package.json          # "private": true, "workspaces": ["server", "packages/*"]
│                         #   keeps shared dev tooling: eslint, prettier, typescript,
│                         #   vitest, drizzle-kit, @playwright/test
│                         #   root scripts delegate, e.g.
│                         #     "build":  "npm -w @attendance/server run build"
│                         #     "start":  "npm -w @attendance/server run start"
│                         #     "dev":    "npm -w @attendance/server run dev"
│                         #     "worker": "npm -w @attendance/server run start:worker"
│                         #     "migrate":"npm -w @attendance/server run migrate"
│                         #     "test" / "lint" / "typecheck" stay root-level (cover web/ too)
├── tsconfig.json         # thin base + `include` for web/tests so typecheck-all still works
├── vitest.config.ts      # unchanged (already includes server/tests + web/tests)
├── eslint.config.js      # unchanged (already scopes server/**/*.ts and web/**/*.js)
├── server/
│   ├── package.json      # "name": "@attendance/server", "type": "module",
│   │                     #   "main": "dist/index.js"
│   │                     #   dependencies: fastify, jose, pg, drizzle-orm, zod, @fastify/*
│   │                     #   dependencies: @azure/monitor-opentelemetry (+ OTel API)
│   │                     #   scripts:
│   │                     #     "dev": "tsx watch src/index.ts"
│   │                     #     "build": "tsc -p tsconfig.build.json"
│   │                     #     "start": "node dist/index.js"
│   │                     #     "start:worker": "node dist/worker.js"
│   │                     #     "migrate": "node dist/migrate.js"
│   ├── tsconfig.json         # extends ../tsconfig.json
│   ├── tsconfig.build.json   # extends ./tsconfig.json; noEmit false, outDir "dist",
│   │                         #   rootDir "src", exclude ["tests/**"]
│   ├── src/
│   ├── tests/
│   └── migrations/       # MOVED from repo root; `drizzle.config.ts` `out` → "./server/migrations",
│                         #   meta/ journal moves with it. Colocated with the workspace that
│                         #   owns it; resolves deterministically relative to dist/ and to the
│                         #   container WORKDIR.
├── packages/             # present but effectively empty until a real shared module appears
└── web/                  # unchanged static ES modules; served by @fastify/static; NOT a workspace
```

**Churn is contained:** `web/` does not move, `server/src` and `server/tests` do not move, so no
`.ts`/`.js` import path changes. The only file move is `migrations/` → `server/migrations/`.
`@types/pg`, `drizzle-kit` placement: `drizzle-kit` stays a **root** devDep (it reads
`drizzle.config.ts` at repo root); `@types/pg` moves to `server` devDeps.

**Lockfile:** a single root `package-lock.json` covering all workspaces (npm workspaces default).
CI installs with `npm ci` at the root.

### 3.2 Production build / run path

- `tsc -p server/tsconfig.build.json` emits `server/dist/` (mirrors `src/` tree, ESM `.js` with
  the existing `.js` import specifiers already in the source).
- **New entrypoint `server/src/migrate.ts`** — standalone: `loadEnv` (needs only `DATABASE_URL`) →
  `createDbClient` → `applyMigrations` → `pool.end()` → `exit(0/1)`. This is what the CI migrate
  job runs and what `npm run migrate` runs locally.
- **`applyMigrations` path fix** — `server/src/database/client.ts` currently passes
  `migrationsFolder: 'migrations'`, which is `process.cwd()`-relative and breaks from `dist/` or a
  container WORKDIR. Change to resolve deterministically from the module location:
  `fileURLToPath(new URL('../../migrations', import.meta.url))` (from `dist/database/client.js` →
  `server/migrations`). One test asserts the resolved path exists and contains `0000_*.sql`.
- **Migration ownership at boot (spec §39)** — `index.ts` and `worker.ts` **stop** calling
  `applyMigrations` unconditionally. New env `RUN_MIGRATIONS_ON_BOOT`; when unset it defaults to
  **`true` if `NODE_ENV !== 'production'`, `false` otherwise**. The runtime Docker image sets
  `NODE_ENV=production` (§4), so `attendance-web` and `attendance-grade-worker` never migrate at
  boot in Azure — only the CI migrate job touches schema — while local `npm run dev` /
  `npm run worker` (no `NODE_ENV`) still bring a fresh DB up to date automatically. `web.bicep` /
  `worker-job.bicep` also set `RUN_MIGRATIONS_ON_BOOT=false` explicitly (belt-and-suspenders).
  `/health/ready` does **not** gate on migration version (Phase 8 candidate).

### 3.3 `buildApp(env, deps)` extraction (whole-branch follow-up #8)

New `server/src/app.ts`:

```ts
export interface AppDeps {
  db: Database;
  signingKeys: ToolSigningKey[];
  jwksCache: JwksCache;
  identityResolver: IdentityResolver;
}

export async function buildApp(env: Env, deps: AppDeps): Promise<FastifyInstance>;
```

Everything from today's `index.ts` lines ~38–146 moves into `buildApp`: helmet + CSP, the
`canvas_oidc_origins` DB read (needs `deps.db`), the `Permissions-Policy: hid=(self)` hook,
`@fastify/cookie` / `@fastify/formbody` / `@fastify/static`, the encapsulated rate-limited plugin
scope (`/lti/login`, `/lti/launch`), all route registration, and the health routes. The CSP
directive construction extracts to `server/src/security/csp.ts`
(`buildCspDirectives(env, canvasOidcOrigins): Record<string, string[] | null>`).

`server/src/index.ts` shrinks to a **composition root + process lifecycle**:

```
startTelemetry(env)            // OTel SDK — must run before other imports do work
loadEnv()
createDbClient(DATABASE_URL)
if (RUN_MIGRATIONS_ON_BOOT) applyMigrations()
loadSigningKeysFromEnv()
identityResolver = createHttpIdentityResolverFromEnv() ?? new MockIdentityResolver()
app = await buildApp(env, { db, signingKeys, jwksCache, identityResolver })
await app.listen({ port: env.PORT, host: '0.0.0.0' })
installShutdownHandlers(app, pool)   // §3.5
```

**New test `server/tests/app.test.ts`** — boots `buildApp` with real deps (Dockerized Postgres),
asserts against the **real middleware chain**:

- CSP header contains the expected directives **including** the dynamic `form-action` Canvas
  origins derived from seeded `lti_registrations` rows;
- `Permissions-Policy: hid=(self)`;
- HSTS present when `APP_BASE_URL` is `https://`, absent (and no `upgrade-insecure-requests`) when
  `http://`;
- `GET /health/live` → 200; `GET /health/ready` → 200 with DB up, 503 with the DB ping forced to
  fail;
- `/lti/login` is rate-limited (31st request in the window → 429) but
  `POST /api/attendance-sessions/:id/scans` is **not**.

**`server/tests/routes/hardening.test.ts`'s hand-copied CSP block is deleted** — `app.test.ts`
covers CSP against the actual `buildCspDirectives` output and the real helmet registration. Any
genuinely separate assertion in `hardening.test.ts` is kept or folded into `app.test.ts`.

### 3.4 Health endpoints (spec §38)

| Route | Behaviour |
|-------|-----------|
| `GET /health/live` | `200 {status:'ok'}`. Zero I/O. Process liveness only. |
| `GET /health/ready` | `SELECT 1` with a ~2 s timeout. `200 {status:'ready'}` on success; `503 {status:'not-ready', checks:{db:false}}` on failure. **Never** checks Canvas reachability (spec §38 explicit). |

Today's `GET /health` is **removed** (nothing depends on it — only the progress doc mentions it).
Container Apps probes: `livenessProbe` → `/health/live`, `readinessProbe` + `startupProbe` →
`/health/ready` (startup with a generous `failureThreshold`).

### 3.5 Graceful shutdown (spec §38)

`server/src/lifecycle.ts` → `installShutdownHandlers(app, pool)`:

- **Web** — on `SIGTERM` / `SIGINT`: set a re-entrancy guard, `await app.close()` (Fastify stops
  accepting connections and drains in-flight requests), `await pool.end()`, `process.exit(0)`. A
  10 s hard timeout forces `process.exit(1)` if drain hangs.
- **Worker** — `server/src/worker.ts` gains a `SIGTERM` handler that flips an abort flag.
  `processGradeSyncJobs(db, { signingKey, shouldStop })` gains an optional `shouldStop: () =>
  boolean` predicate, checked between jobs and between courses, so a Container Apps Job eviction
  stops cleanly after the current unit of work, then `pool.end()`.

### 3.6 `server/src/security/` and `server/src/telemetry/` (decision #6)

`server/src/security/`:
- `csp.ts` — `buildCspDirectives(env, canvasOidcOrigins)`, extracted from `index.ts`.
- `same-origin.ts` — `assertSameOrigin(candidateUrl, anchorUrl)`: throws unless
  `new URL(candidateUrl).origin === new URL(anchorUrl).origin`. The backlog-6.1 primitive.

`service-url.ts` (SSRF structural validation) and `auth/csrf.ts` **stay where they are** for
Phase 7 — moving them churns many importers for no functional gain. Relocating them into
`security/` is an optional Phase 8 tidy.

`server/src/telemetry/`:
- `otel.ts` — `startTelemetry(env)`: bootstraps the OpenTelemetry SDK with the Azure Monitor
  distribution (`@azure/monitor-opentelemetry`), reading
  `APPLICATIONINSIGHTS_CONNECTION_STRING`. No-op when the connection string is unset (local dev).
  Called first thing in `index.ts` and `worker.ts`.
- `logger.ts` — the shared pino config: JSON, `redact` paths for `authorization` /
  `set-cookie` / `id_token` / `client_secret` / `IDENTITY_API_KEY` / `cardCode`, a `serializers`
  set, and the spec §44 **safe-field allowlist** helper `safeLogFields(request, extra)`
  (`timestamp, level, requestId, environment, route, httpStatus, duration, institutionId,
  courseInternalId, attendanceSessionId, errorType`). No names / student IDs / card codes.
- `metrics.ts` — the OTel meter + the spec §44 instruments (§7).
- `request-id.ts` — Fastify `genReqId` (prefer an inbound `x-request-id`, else a UUID) plus an
  `onResponse` hook that emits the HTTP metrics and one structured access-log line via
  `safeLogFields`.

### 3.7 Backlog 6.1 — AGS line-item origin check

In `server/src/lti/ags.ts`, immediately before the bearer-token Score `PUT`/`POST` to the
Canvas-returned line-item `id`: `assertSameOrigin(lineItem.id, course.agsLineItemsUrl)` (the
launch-provenance anchor persisted in Phase 4). A mismatch throws the **permanent** (never
auto-retried) error code `ags:untrusted-lineitem-origin`. New unit test
`server/tests/lti/ags-origin.test.ts` covers same-origin pass, cross-origin reject, and that the
reject is classified permanent.

---

## 4. Container image (M3)

Multi-stage `Dockerfile` at repo root; base `node:22-bookworm-slim`.

| Stage | Does |
|-------|------|
| `deps` | Copy `package.json`, `package-lock.json`, `server/package.json`, `packages/*/package.json`. `npm ci` (all workspaces). |
| `build` | Copy sources. `npm -w @attendance/server run build`. Then produce a pruned production `node_modules` (`npm ci --omit=dev` into a clean layer). |
| `runtime` | `USER node`. Copy `server/dist/`, `server/migrations/`, the pruned `node_modules`, `web/`, and the `package.json` files. `ENV NODE_ENV=production`. `EXPOSE 3000`. `CMD ["node", "server/dist/index.js"]`. |

Runtime image MUST NOT contain (spec §38): `.git`, any `.env`, LTI signing key material,
`server/tests`, `docs/`, `.superpowers/`, `.claude/`, dev dependencies. Enforced by a
`.dockerignore` and by copying only the explicit paths above.

- **Worker** uses the same image with `command: ["node", "server/dist/worker.js"]`.
- **Migrate job** (CI, §6.4) uses the same image with
  `command: ["node", "server/dist/migrate.js"]` — but per decision #8 the migrate job runs on the
  **GitHub runner**, not in Azure; it runs `node server/dist/migrate.js` directly from the built
  workspace, so this image command exists mainly for parity / future use.
- No `HEALTHCHECK` in the image — Container Apps owns probe semantics (§3.4).
- One HTTP port (`PORT`, default 3000). Ingress target port set from the same value in Bicep.

---

## 5. Azure infrastructure — Bicep (M4)

```
infra/azure/
├── main.bicep                    # target scope: resourceGroup; orchestrates modules
├── modules/
│   ├── identity.bicep            # user-assigned Managed Identity (per environment)
│   ├── registry.bicep            # Azure Container Registry (Basic dev / Standard stage+prod)
│   ├── observability.bicep       # Log Analytics workspace + Application Insights (workspace-based)
│   ├── keyvault.bicep            # Key Vault; RBAC: MI → "Key Vault Secrets User"
│   ├── postgres.bicep            # Flexible Server: require_secure_transport ON, TLS 1.2 min,
│   │                             #   backupRetentionDays, geoRedundantBackup per env, PITR,
│   │                             #   one DB, firewall (public access ON; rules param-driven)
│   ├── containerapp-env.bicep    # Container Apps managed environment, linked to Log Analytics
│   ├── web.bicep                 # attendance-web Container App:
│   │                             #   ingress external, targetPort=PORT, transport auto (HTTP/2)
│   │                             #   probes (§3.4); scale min/max per env
│   │                             #   secrets: keyVaultUrl refs via the MI
│   │                             #   env vars: DATABASE_URL, APP_BASE_URL, ALLOWED_TARGET_LINK_URIS,
│   │                             #     LTI_TOOL_SIGNING_KEYS_JSON (secret ref), APP_SESSION_SECRET,
│   │                             #     CARD_FINGERPRINT_SECRET, IDENTITY_API_* (secret ref for KEY),
│   │                             #     APPLICATIONINSIGHTS_CONNECTION_STRING, RUN_MIGRATIONS_ON_BOOT=false
│   ├── worker-job.bicep          # attendance-grade-worker: Container Apps Job,
│   │                             #   triggerType Schedule, cronExpression "*/5 * * * *",
│   │                             #   parallelism 1, replicaCompletionCount 1, replicaTimeout,
│   │                             #   same image + env, command ["node","server/dist/worker.js"]
│   └── alerts.bicep              # Azure Monitor: action group (email param) + alert rules (§7)
├── environments/
│   ├── dev.bicepparam
│   ├── stage.bicepparam
│   └── prod.bicepparam
└── README.md                     # bootstrap order, secret-seeding commands, `what-if` usage
```

**Parameters (spec §36):** environment name, Azure region, application hostname / custom domain,
Postgres SKU + storage + backup retention, Container Apps CPU/memory, min/max replicas, log
retention days, Key Vault name, ACR name, alert action-group email. **No secret values in any
`.bicepparam`** (spec §36). Secret *values* are seeded out of band:

```
az keyvault secret set --vault-name <kv> --name app-session-secret        --value ...
az keyvault secret set --vault-name <kv> --name lti-tool-signing-keys-json --value ...
az keyvault secret set --vault-name <kv> --name card-fingerprint-secret   --value ...
az keyvault secret set --vault-name <kv> --name identity-api-key          --value ...     # decision #3
az keyvault secret set --vault-name <kv> --name database-url              --value ...
az keyvault secret set --vault-name <kv> --name appinsights-connection-string --value ...
```

The Container Apps `secrets` array references these by `keyVaultUrl` + the user-assigned MI;
Container Apps auto-refreshes unversioned secret references (spec §35.4).

**Environment sizing:**

| | dev | stage | prod |
|---|---|---|---|
| web min/max replicas | 0 / 2 | 1 / 3 | 1 / 5 |
| Postgres SKU | Burstable B1ms | Burstable B2s | GP small (param) |
| geo-redundant backup | off | off | on (param) |
| ACR SKU | Basic | Standard | Standard |
| log retention | 30 d | 30 d | 90 d (param) |

**Bootstrap** (one-time, documented in `infra/azure/README.md`, done via `az` in Phase 7): create
RG, deploy `main.bicep` with `what-if` then apply, seed Key Vault secrets, create the GitHub OIDC
federated credentials (§6.5), grant the MI `AcrPush` + `Contributor` (scoped to the RG) +
`Key Vault Secrets User`.

---

## 6. CI/CD — GitHub Actions (M5–M6, M8)

Repo: `cedarville-university/attendance-tracker`. All workflows:
`permissions: { contents: read, id-token: write }`.

### 6.1 `pull-request.yml` (spec §40)

Trigger: `pull_request`. A PR **must not** deploy. Jobs (a Postgres `services:` container where
tests need it):

1. `install` — `npm ci` from the root lockfile (cached).
2. `lint` — `npm run lint`.
3. `typecheck` — `npm run typecheck`.
4. `unit` — `npm test` (full Vitest; includes the §45 LTI security matrix and the §46 mock-Canvas
   integration tests). Runs against the Postgres service container.
5. `frontend` — the `web/tests/**` Vitest project (already part of `npm test`; a named step so a
   failure is legible).
6. `build` — `npm run build` (proves `tsc -p tsconfig.build.json` is clean).
7. `docker` — `docker build .` (no push).
8. `e2e` — Playwright (§8): build, `node server/dist/index.js` against the Postgres service with a
   seeded mock registration, run `e2e/instructor-flow.spec.ts` headless Chromium.
9. `dep-scan` — `npm audit --audit-level=high`; `osv-scanner` (or Trivy) over the repo and the
   built image. Advisory (non-blocking) initially; promote to blocking in Phase 8's dependency
   review.

### 6.2 `deploy-dev.yml`

Trigger: `push` to `main`. Environment: `dev` (no required reviewers). Jobs:

1. `ci` — reuse §6.1's checks via `workflow_call` (or repeat lint/typecheck/unit/build).
2. `build-and-push` — `azure/login@v2` (OIDC, dev identity) → `docker build` →
   tag `:${{ github.sha }}` (never `latest`, spec §35.5) → push to dev ACR.
3. `bicep` — `az deployment group create` for `main.bicep` + `environments/dev.bicepparam`
   (`what-if` logged first).
4. `migrate` — **separate job** (spec §39): `azure/login` → `az keyvault secret show` for
   `database-url` → resolve runner egress IP (`curl -s https://api.ipify.org`) →
   `az postgres flexible-server firewall-rule create` (JIT) →
   `npm ci && npm -w @attendance/server run build && node server/dist/migrate.js` →
   **`always()`** `az postgres flexible-server firewall-rule delete`.
5. `deploy` — `az containerapp update --image <acr>/<repo>@sha` for `attendance-web`;
   `az containerapp job update` for `attendance-grade-worker`.
6. `wait-ready` — poll the new revision's FQDN `/health/ready` until 200 or timeout; Container
   Apps single-revision mode keeps traffic on the old revision until the new one is ready
   (spec §42) — this is the rollback mechanism (no old-image rebuild).
7. `smoke` — assert `/health/live` 200, `/lti/jwks` returns ≥1 key, `/` serves the SPA shell;
   a lightweight resolver reachability probe (decision #3) via a dedicated
   `GET /health/ready` sub-check is **not** added (readiness must not depend on external
   services) — resolver health is a metric/alert instead (§7).

### 6.3 `deploy-stage.yml`

Trigger: a `v*` tag **or** `workflow_dispatch`. Environment: `stage`. Same job shape as
`deploy-dev.yml` with `environments/stage.bicepparam` and the stage identity / Key Vault / ACR.
After a successful deploy, the **real-Canvas verification gate** (§8.3) runs against staging.

### 6.4 `deploy-prod.yml` (authored, not first-run in Phase 7)

Trigger: `workflow_dispatch` (or GitHub Release published). Environment: `production` — required
reviewers, and the prod OIDC federated-credential subject is scoped to
`repo:cedarville-university/attendance-tracker:environment:production` (spec §41, §43). Same job
shape, `environments/prod.bicepparam`. Phase 7 stops at "authored + environment configured".

### 6.5 OIDC federation (spec §41)

One **user-assigned Managed Identity per environment** (`id-attendance-dev`, `-stage`, `-prod`),
each with a GitHub federated credential keyed by `environment:<name>`. GitHub secrets hold only
non-secret identifiers: `AZURE_CLIENT_ID` (per env, via GitHub Environment), `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`. **No client secret, no publish profile** anywhere. RBAC per identity:
`AcrPush` on that env's ACR, `Contributor` scoped to that env's RG (tighten to Container Apps +
Managed Identity Operator in Phase 8), `Key Vault Secrets User` on that env's vault (for the
migrate job's `database-url` read).

---

## 7. Observability (spec §44)

- **Structured logging** — pino JSON everywhere (`server/src/telemetry/logger.ts`), `redact` list
  per §3.6, safe-field allowlist for access logs. Container Apps ships stdout to the linked Log
  Analytics workspace automatically.
- **Request IDs** — `genReqId` prefers inbound `x-request-id`, else UUID; every log line and error
  response (`{error, requestId}`, already the pattern in `attendance-sessions.ts`) carries it.
- **Tracing + metrics** — `@azure/monitor-opentelemetry` distro started at process boot; auto
  instrumentation for HTTP + `pg`. Custom OTel instruments (`server/src/telemetry/metrics.ts`),
  one per spec §44 line:
  LTI launch success / failure counters (+ `reason` attribute); NRPS latency histogram + error
  counter; identity-lookup latency histogram + error counter; scan counter; unexpected-scan
  counter; lookup-error counter; session-close counter; AGS latency histogram + error counter;
  `pending_grade_jobs` / `failed_grade_jobs` observable gauges (set by the worker each pass and by
  a periodic query in the web process); DB latency histogram; HTTP 5xx counter (from the
  `onResponse` hook).
- **Alerts** — `infra/azure/modules/alerts.bicep` provisions an action group (email param) and
  rules (spec §44): elevated 5xx rate; database unavailable (`/health/ready` failing / DB metric);
  sustained LTI launch failures; sustained card-resolver failures; grade jobs failing or retrying
  beyond a threshold; Key Vault access failure. Thresholds are Bicep params with conservative
  defaults; tuned in Phase 8.

---

## 8. Testing and the real-Canvas verification gate (M3, M7)

### 8.1 New automated tests (run in CI)

| Test | Covers |
|------|--------|
| `server/tests/app.test.ts` | `buildApp` middleware chain — CSP (dynamic origins), Permissions-Policy, HSTS-by-scheme, `/health/live`, `/health/ready` (200 + 503), rate-limit scoping (§3.3). |
| `server/tests/lti/ags-origin.test.ts` | Backlog 6.1 — same-origin pass, cross-origin reject, permanent classification (§3.7). |
| `server/tests/database/migrate-path.test.ts` | `applyMigrations` resolves `server/migrations/` regardless of cwd (§3.2). |
| `server/tests/lifecycle.test.ts` | SIGTERM handler closes the app then the pool, once, with a timeout fallback (§3.5). |
| `e2e/instructor-flow.spec.ts` (Playwright) | follow-up #7 — against a **built** `node dist/index.js` + Docker Postgres + seeded mock registration, WebHID shimmed: mint instructor `id_token` → `POST /lti/login` → `POST /lti/launch` → scanner UI → Start Attendance → synthetic scan → Close → Reopen → run `node dist/worker.js` → assert grade-sync summary reflects the close. Physical-reader validation stays a separate manual step (spec §40). |

`playwright.config.ts` added at repo root; `@playwright/test` a root devDep; a `webServer` /
global-setup that builds and boots the server and brings up Postgres.

### 8.2 Live §46 matrix (manual / `workflow_dispatch`, post-stage-deploy)

A `describe`-gated integration suite (`RUN_LIVE_CANVAS=1` + Canvas test/beta Developer Key creds
in the workflow's environment) that runs the spec §46 **AGS** list (line item absent / existing
match / score update / Canvas 429 / transient 500 / missing student / concluded course / stale
timestamp / retry after failure / repeated same calculation / correction changes cumulative
grade) and the cheap parts of the **NRPS** list against the real instance. Not part of
`pull-request.yml`; invoked from `deploy-stage.yml` as an optional gated job or run by hand.

### 8.3 Real-Canvas verification checklist — the exit criterion (`docs/canvas-installation.md`)

Run against **staging** once `deploy-stage.yml` has deployed and `<APP_BASE_URL>` resolves:

1. Register the tool in the Canvas test/beta instance — **Admin → Apps, JSON configuration** (the
   block in `docs/canvas-installation.md` with `<APP_BASE_URL>` = the staging origin). Confirm the
   three scope strings against Canvas's current LTI reference (spec §58). Toggle On, copy the
   Client ID.
2. Install in a test course by Client ID; note the Deployment ID.
3. Fetch Canvas's real `issuer` / `authorization_endpoint` / `token_endpoint` from
   `/.well-known/openid-configuration` (never pattern-match the hostname — spec §11).
4. Set the staging app's `ALLOWED_TARGET_LINK_URIS` to include the exact target link URI, and set
   a persistent `LTI_TOOL_SIGNING_KEYS_JSON`. Run `server/src/database/seed-registration.ts`
   against the staging `DATABASE_URL` with the issuer / client ID / endpoints / deployment ID.
5. **Instructor launch** from the test course → a new browser tab opens, the launch completes, the
   scanner UI loads, an `attendance_session` cookie is set.
6. **Learner-role launch** (test student or Student View) → **HTTP 403**, no session cookie.
7. Capture the real `roles` claim from an actual launch (temporary debug log, removed before
   commit) and reconcile `server/src/lti/roles.ts`'s `AUTHORIZED_INSTRUCTOR_ROLE_URIS` against it
   (follow-up #8-roles).
8. Run the §8.2 live AGS matrix once. Record all results in `docs/canvas-lti/progress.md`.

Steps 5 + 6 passing **is** the Phase 7 exit criterion.

---

## 9. Milestones (one plan, executed inside-out — decision #11)

| M | Title | Key outputs | Verified by |
|---|-------|-------------|-------------|
| **M1** | Workspaces + build path | `server/package.json`, `tsconfig.build.json`, root delegating scripts, `migrations/` → `server/migrations/`, `migrate.ts`, `applyMigrations` path fix, `RUN_MIGRATIONS_ON_BOOT` | `npm ci && npm run build && npm test && npm run lint && npm run typecheck` green from a clean checkout; `node server/dist/index.js` boots |
| **M2** | `buildApp` + health + shutdown + `security/`/`telemetry/` skeleton + backlog 6.1 | `app.ts`, `security/csp.ts`, `security/same-origin.ts`, `telemetry/*`, `lifecycle.ts`, `/health/{live,ready}`, `index.ts`/`worker.ts` slimmed, `hardening.test.ts` CSP block deleted, AGS origin check | new tests in §8.1 (minus Playwright) green; suite still fully green |
| **M3** | Dockerfile + Playwright harness | multi-stage `Dockerfile`, `.dockerignore`, `playwright.config.ts`, `e2e/instructor-flow.spec.ts` | `docker build` + `docker run` serves `/health/live` and the SPA; `e2e` spec green against the built image / built server |
| **M4** | Bicep authoring | `infra/azure/**` (all modules + 3 `.bicepparam` + README) | `az bicep build` clean; `az deployment group what-if` succeeds against a scratch RG for `dev` params |
| **M5** | `pull-request.yml` + `deploy-dev.yml` + OIDC bootstrap | the two workflows, GitHub Environments `dev`/`stage`/`production`, per-env managed identities + federated creds, Key Vault secrets seeded (dev) | a PR runs the full `pull-request.yml` green; a merge to `main` deploys dev and `wait-ready` + `smoke` pass |
| **M6** | Staging + observability | `deploy-stage.yml`, stage Key Vault secrets (incl. real `IDENTITY_API_*` — decision #3), OTel wired and confirmed in App Insights, `alerts.bicep` deployed | a `v*` tag deploys stage; traces + custom metrics visible in Application Insights; test-fire one alert |
| **M7** | Real-Canvas verification gate | executed §8.3 checklist against staging; `roles.ts` reconciled; §8.2 live AGS matrix run; results in `docs/canvas-lti/progress.md` | instructor launch succeeds (new tab), learner launch → 403 — **exit criterion** |
| **M8** | Production authoring | `deploy-prod.yml`, `environments/prod.bicepparam`, `production` Environment reviewers + prod-scoped federation | `az bicep build` + `what-if` clean for prod params; workflow lints; **no prod deploy executed** |

After M8: Phase-7 range review (`$BASE/scripts/review-package <base> <head>`), then
`superpowers:finishing-a-development-branch`.

---

## 10. Explicitly out of scope (→ Phase 8 or backlog)

- The five `docs/{architecture,security,operations,development,identity-resolvers}.md` deliverables
  (spec §57) — **Phase 8** (decision #6).
- Relocating `service-url.ts` / `auth/csrf.ts` into `security/` — optional Phase 8 tidy.
- Private DB path for migrations (Container Apps Job / private endpoint / self-hosted runner) —
  **Phase 8**. Phase 7 ships the JIT-firewall-rule approach on a public-access Flexible Server
  (decision #8).
- Migration-version gate in `/health/ready` — Phase 8 candidate.
- Per-institution grading policy config + editor (spec §27.2, §52) — **Phase 8** (already tracked).
- Retention/purge policy specifics (spec §34) — **Phase 8**. Phase 7's worker adds
  `purgeExpiredOidcTransactions` + `purgeExpiredAppSessions` (mechanical) and a conservative,
  env-flag-gated retention sweep stub only; the policy surface is Phase 8.
- `packages/shared/` — not created until a real shared module exists.
- Multi-revision / blue-green Container Apps traffic splitting — not needed; single-revision
  auto-rollback is sufficient (spec §42).
- Promoting `dep-scan` to blocking — Phase 8 dependency review.
- The carried cleanup backlog (Phase 6 Minors 5.1 / 6.2 / 7.1 / 7.2, self-review
  Q9–Q11 / Q14 / Q15, whole-branch follow-ups #1–#4) — absorb opportunistically during M1–M2
  where a task already touches the file; anything not naturally absorbed stays on the backlog and
  is listed for the user at the Phase-7 range review.

---

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| GitHub runner egress IP not single / stable → JIT firewall rule insufficient | `api.ipify.org` returns the actual egress IP for that job run; rule is created for exactly that IP and torn down in `always()`. If GitHub uses an IP range, fall back to the documented Actions IP ranges or (Phase 8) move migrations into the VNet. |
| `@azure/monitor-opentelemetry` started too late misses early spans | `startTelemetry` is the very first statement in `index.ts` / `worker.ts`, before any other local import does I/O. |
| Real ProxID resolver unreachable from Container Apps at first deploy (decision #3) | Resolver failures surface as a metric + alert, not as `/health/ready` failures; the mock stays wired for local dev; a deploy is not blocked by resolver health. Getting real `IDENTITY_API_*` values into the stage vault is an explicit M6 task. |
| Canvas JSON registration scope strings drift from Canvas's current reference | §8.3 step 1 requires confirming the three scopes against Canvas's own LTI docs (spec §58), not this repo's copy. |
| `web/` not being a workspace confuses tooling | `web/` has no `package.json` and no deps today; `@fastify/static` serves it by path. Nothing in the build or the workspace graph references it as a package. |
| Moving `migrations/` breaks `drizzle-kit` | `drizzle.config.ts` `out` updated in the same M1 task; `drizzle-kit` stays a root devDep and is run from repo root; the `meta/` journal moves with the SQL files. A `drizzle-kit generate` dry run in M1 confirms no spurious diff. |

---

## 12. References

- `docs/canvas-lti/spec.md` — §6 (repo structure), §35–§44 (infra, Docker, migrations, CI/CD,
  observability), §46 (Canvas integration tests), §54 Phase 7, §57 (doc deliverables), §58
  (authoritative external references).
- `docs/canvas-installation.md` — the real-Canvas registration + verification checklist.
- `docs/canvas-lti/progress.md` — Phase 0–6 outcomes; "Deferred decisions"; the 8 whole-branch
  follow-ups.
- `.superpowers/sdd/progress.md` — SDD detail (gitignored).
- Prior plans: `docs/superpowers/plans/2026-08-26-canvas-lti-phase{3,4,5,6}-*.md`.
