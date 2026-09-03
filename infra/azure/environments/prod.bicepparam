using '../main.bicep'

param environmentName = 'prod'
param location = 'eastus'
param appHostname = 'attendance.cedarville.edu'
// Burstable rather than GeneralPurpose: one campus of classroom scan bursts does not
// need committed IOPS, and B2s is ~4x cheaper. Raise the SKU here and redeploy if
// sustained load ever exhausts burst credits.
param postgresSkuName = 'Standard_B2s'
param postgresSkuTier = 'Burstable'
param postgresStorageGb = 64
param postgresBackupRetentionDays = 14
param postgresGeoRedundantBackup = false
param containerCpu = '0.5'
param containerMemory = '1Gi'
// One warm replica: an LTI launch that cold-starts inside Canvas's iframe reads as a broken tool.
param webMinReplicas = 1
param webMaxReplicas = 3
param logRetentionDays = 90
param acrSku = 'Basic'
param alertEmail = 'nbiggs112@cedarville.edu'
// Real ProxID resolver URL template is supplied at deploy time via the IDENTITY_API_URL
// GitHub 'production' environment variable (-p identityApiUrl=... in deploy-prod.yml).
// Non-secret template; contains {CARD_CODE}/{KEY_NAME}/{KEY} placeholders, no key value.
param identityApiUrl = ''
param identityApiKeyName = 'ATTENDANCE'
// TEMPORARY — the admin page normally requires an LTI Administrator-role session, which
// cannot exist until the first Canvas registration is seeded. Seed the `setup-token` secret
// in kv-attendance-prod BEFORE deploying, or the web app fails to resolve the secret ref:
//   az keyvault secret set --vault-name kv-attendance-prod --name setup-token --value "$(openssl rand -base64 24)"
// Flip to false, delete the KV secret, and redeploy once an Administrator launch reaches /admin.html.
param setupTokenEnabled = true
// Prune audit_events after a year. Attendance records are never swept.
param retentionDays = 365
// No secret value is committed: the password is read from the environment at
// compile time. The deploy pipeline / bootstrap exports PG_ADMIN_PASSWORD; for a
// local compile check, `export PG_ADMIN_PASSWORD=$(openssl rand -base64 24)` first.
// (An unset var fails BCP427 by design -- there is deliberately no fallback.)
param postgresAdministratorPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
