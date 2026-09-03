# Production deployment — `attendance.cedarville.edu`

Design for standing up the first production environment and switching the release
model to tag-driven deploys off `main`.

This completes Phase 7 Task 23, which authored the production delivery path but
deliberately never ran it. Nothing about production exists yet: no resource group,
no `deploy-prod.yml`, no `production` GitHub Environment.

## Starting state

- `dev` is live and proven: `rg-attendance-dev`, custom domain
  `attendance-dev.cedarville.edu` bound with a managed certificate, the real
  Cedarville ProxID resolver, App Insights receiving traces, three alert rules.
- `main` holds the original flat browser-only app (16 files at the repo root).
  `canvas-lti-phase7` is 183 commits ahead and strictly contains it — a clean
  fast-forward.
- `deploy-dev.yml` triggers on any `v*` tag push.
- `infra/azure/environments/prod.bicepparam` exists but carries `CHANGEME`
  placeholders for `appHostname` and `alertEmail`.

## Release model

`main` becomes the release branch. Tags divide the two environments:

| Trigger | Workflow | Gate |
| --- | --- | --- |
| `git tag dev-vX.Y.Z && git push origin dev-vX.Y.Z` | `deploy-dev` | none |
| `git tag vX.Y.Z && git push origin vX.Y.Z` | `deploy-prod` | `guard` job → required reviewer |
| `workflow_dispatch` | either | approval on prod |

`deploy-dev.yml`'s trigger moves from `v*` to `dev-v*` so one tag never rolls both
environments.

`canvas-lti-phase7` merges to `main` with `--no-ff`, so the merge point is a real
commit that can be tagged and reverted as a unit.

## Infrastructure changes

### `prod.bicepparam`

Placeholders replaced and the SKUs right-sized for one campus. The authored values
specified a GeneralPurpose Postgres with geo-redundant backup (~$200–250/mo);
measured against expected load that is overprovisioned.

| Parameter | Was | Now |
| --- | --- | --- |
| `appHostname` | `attendance.CHANGEME.edu` | `attendance.cedarville.edu` |
| `alertEmail` | `CHANGEME@example.edu` | `nbiggs112@cedarville.edu` |
| `postgresSkuName` | `Standard_D2ds_v5` | `Standard_B2s` |
| `postgresSkuTier` | `GeneralPurpose` | `Burstable` |
| `postgresGeoRedundantBackup` | `true` | `false` |
| `acrSku` | `Standard` | `Basic` |
| `webMaxReplicas` | `5` | `3` |
| `identityApiKeyName` | `attendance-resolver` | `ATTENDANCE` |
| `setupTokenEnabled` | (absent, default `false`) | `true` — temporary, see below |
| `retentionDays` | (did not exist) | `365` |

Unchanged: `postgresStorageGb = 64`, `postgresBackupRetentionDays = 14`,
`webMinReplicas = 1`, `logRetentionDays = 90`, `containerCpu`/`containerMemory`.
`identityApiUrl` stays `''` in the file and is supplied at deploy time from the
`IDENTITY_API_URL` GitHub environment variable, exactly as on dev.

Expected steady-state cost: roughly $95–120/mo across Postgres, one always-warm
Container App replica, ACR, and Log Analytics.

### New parameter: `bindCustomDomain`

`web.bicep` creates a `managedCertificates` resource whenever a real (non-
`CHANGEME`) `appHostname` is supplied, and Azure validates that certificate
against live DNS at provisioning time. The DNS record must point at the Container
App's FQDN — which does not exist until the app is created. The first deploy of a
new environment therefore cannot both set the hostname and bind the certificate.

`bindCustomDomain bool = true` threads from `main.bicep` into `web.bicep` and
gates the certificate resource and the `customDomains` binding, independently of
`appHostname`. Bootstrap passes 1 and 2 run with `-p bindCustomDomain=false`, so
`APP_BASE_URL` and `ALLOWED_TARGET_LINK_URIS` are correct from the first boot
while the certificate waits for DNS. Pass 3 omits the flag and the certificate
issues.

CI never passes the parameter, so every pipeline deploy uses the `true` default.

The existing `useCustomDomain` guard (empty or `CHANGEME` hostname disables the
binding) is retained and ANDed with the new flag, so environments that have not
chosen a hostname still deploy cleanly.

### New parameter: `retentionDays`

`RETENTION_DAYS` is currently set on neither the web app nor the worker job, so
the audit-event retention sweep in `server/src/worker.ts` is a documented no-op in
every deployed environment. Production holds real student attendance and audit
data and needs the sweep active.

`retentionDays int = 0` threads from `main.bicep` into `worker-job.bicep`. When
greater than zero it emits a `RETENTION_DAYS` container environment variable; at
`0` it emits nothing, preserving today's behavior. Prod sets `365`; dev is left
alone.

Only the worker consumes it — the web app never runs the sweep — so the variable
is added to `worker-job.bicep` only.

## `deploy-prod.yml`

Mirrors the final `deploy-dev.yml` rather than reinventing it. That workflow
diverged roughly eight fixes past its authoring review and each of those fixes
encodes something learned against live Azure; reproducing the structure verbatim
is the point.

Carried over unchanged:

- The four-job graph `build-push → infra → migrate → deploy`.
- `permissions: { contents: read, id-token: write }` and OIDC `azure/login` via
  `${{ vars.AZURE_* }}` — no stored cloud credentials.
- The image decouple: the `infra` job pins the app's **current** image so a Bicep
  pass cannot roll code ahead of the schema; `deploy` rolls to the new image only
  after `migrate` succeeds.
- The `infra` until-retry, because Postgres Flexible Server serialises
  control-plane operations and the `require_secure_transport` re-PUT intermittently
  returns `ServerIsBusy`.
- `PG_ADMIN_PASSWORD` as a job-level `env:` on `infra`, never a
  `-p postgresAdministratorPassword=` argument — the `.bicepparam` resolves it via
  `readEnvironmentVariable` at param-file compile time on the runner.
- `az extension add --name containerapp` before any `az containerapp*` call.
- The just-in-time Postgres firewall rule around the migrate job, opened for the
  runner's own IP and removed in an `always()` step, with `--server-name`/`--name`
  flags.
- `-p deployRoleAssignments=false` (role assignments are Owner-run at bootstrap,
  not by the CI identity).
- `-p identityApiUrl='${{ vars.IDENTITY_API_URL }}'`.
- The readiness poll on `/health/ready` and the three smoke curls.
- Every `timeout-minutes`.

Differences from `deploy-dev.yml`, and only these:

| | `deploy-dev.yml` | `deploy-prod.yml` |
| --- | --- | --- |
| `name` | `deploy-dev` | `deploy-prod` |
| tag trigger | `dev-v*` | `v*` |
| `environment` | `dev` | `production` |
| `concurrency.group` | `deploy-dev` | `deploy-prod` |
| param file | `dev.bicepparam` | `prod.bicepparam` |
| first job | `build-push` | `guard` |

### The `guard` job

A no-op job carrying `environment: production` that every other job declares in
`needs:`. Its only work is echoing the target environment and image SHA. Because
the `production` GitHub Environment has a required reviewer, the pipeline suspends
at `guard` until a human approves — before `build-push` has run and long before
anything touches Azure. Pushing a `v*` tag becomes a proposal, not an
irreversible act.

## Bootstrap sequence

Three deploy passes, because the certificate cannot validate until DNS points at
an app that does not yet exist.

**Pass 1 — foundation.** Create `rg-attendance-prod`. Deploy `main.bicep` with
`bindCustomDomain=false` and the quickstart placeholder image. The foundation
(managed identity, ACR, Log Analytics, App Insights, Key Vault and its role
assignment, Postgres, the Container Apps environment) provisions. The web app and
worker job **fail** with `unable to fetch secret … using Managed identity`,
because Container Apps resolves Key Vault secret references when it provisions a
revision and the secrets do not exist yet. This failure is expected and the
deployment outputs are still emitted.

**Pass 2 — secrets, then redeploy.** The Key Vault is RBAC-authorized, so
subscription Owner grants the management plane only; the operator needs **Key Vault
Secrets Officer** scoped to the vault before writing secret values. Seed six
secrets:

| Secret | Source |
| --- | --- |
| `database-url` | composed from the Postgres FQDN and the bootstrap admin password |
| `card-fingerprint-secret` | `openssl rand -base64 32` |
| `lti-tool-signing-keys-json` | `node scripts/generate-signing-keys.mjs` |
| `identity-api-key` | piped from `kv-attendance-dev` — same ProxID key as dev |
| `appinsights-connection-string` | pass-1 deployment output |
| `setup-token` | `openssl rand -base64 24` |

Then re-run the identical pass-1 command. It is idempotent; web and worker
provision. The app is live on its `*.azurecontainerapps.io` FQDN.

The ProxID key is copied vault-to-vault through a shell pipe so the value never
enters the transcript, a file, or shell history that is committed.

**DNS — blocking handoff.** Two records for `attendance.cedarville.edu`: a `CNAME`
at the Container App FQDN and a `TXT` at `asuid.attendance` carrying the app's
`customDomainVerificationId`. Both values come from pass 2 and are handed over
verbatim.

**Pass 3 — bind the domain.** Re-deploy omitting `bindCustomDomain`. The managed
certificate issues against the now-live DNS and `https://attendance.cedarville.edu`
serves.

### Wiring CI

After pass 3:

- Federated credential `github-env-production` on `id-attendance-prod`, subject
  `repo:cedarville-university@48759751/attendance-tracker@1345554752:environment:production`.
  GitHub presents the `name@id` form; the Azure credential subject must match it
  exactly.
- `AcrPush` and `Contributor` on the resource group for the managed identity.
  (Tightening `Contributor` to least privilege is a Phase 8 item.)
- The `production` GitHub Environment with a required reviewer and a
  protected-branches deployment policy.
- Ten environment variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID`, `ACR_LOGIN_SERVER`, `RESOURCE_GROUP`, `WEB_APP_NAME`,
  `WORKER_JOB_NAME`, `POSTGRES_FQDN`, `KEY_VAULT_NAME`, `APP_HOSTNAME`) plus
  `IDENTITY_API_URL`, and the one environment secret `PG_ADMIN_PASSWORD`.

### First release

Merge `canvas-lti-phase7` to `main` with `--no-ff`, tag `v1.0.0`, approve the
`guard` job, and watch the pipeline build, migrate, and roll.

## Handoffs

Three things require human hands and are not automatable from here:

1. **DNS records** for `attendance.cedarville.edu`. Blocks pass 3.
2. **Canvas Developer Key** in production Canvas. The LTI registration body is
   served at `https://attendance.cedarville.edu/lti/config.json`; Canvas returns a
   client ID.
3. **`/admin.html`** — create the institution and Canvas registration using the
   generated `SETUP_TOKEN`.

`setupTokenEnabled` exists only to bridge step 3: the admin page normally requires
an LTI Administrator-role session, which cannot exist before the first
registration. Once an Administrator launch reaches `/admin.html`, flip
`setupTokenEnabled` back to `false`, delete the `setup-token` secret, and redeploy.

## Deliberately out of scope

- **`IDENTITY_API_UNIVERSITY_ID_FIELD` and its siblings** remain unwired in
  `web.bicep`. Prod uses the same ProxID resolver as dev, so it inherits the same
  working field defaults (`redwoodId`, `firstName`, `lastName`, `email`). Wiring
  the overrides is only needed if the two environments ever diverge.
- **The alert fire→email round trip** is still unproven end to end. Rule
  configuration and the action-group email receiver are verified by inspection;
  a live test-fire is a Phase 8 item.
- **Tightening the CI identity's `Contributor` role**, the private Postgres
  networking path, and `stage` — all Phase 8.
- **Attendance-data retention.** `retentionDays` prunes `audit_events` only;
  attendance records are never swept, by design.

## Verification

- `az bicep build --file infra/azure/main.bicep` compiles clean.
- `az bicep build-params` compiles for all three environment files with
  `PG_ADMIN_PASSWORD` exported; no `CHANGEME` remains in `prod.bicepparam`.
- `actionlint` reports no errors on both deploy workflows.
- `deploy-prod.yml` diffed against `deploy-dev.yml` shows only the six differences
  tabulated above.
- Live: `https://attendance.cedarville.edu/health/live` returns
  `{"status":"ok"}`, `/lti/jwks` returns a key set, `/lti/config.json` returns the
  registration body with the production hostname, and the certificate is
  Azure-managed and valid.
