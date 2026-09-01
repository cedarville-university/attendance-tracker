using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param appHostname = 'attendance-dev.cedarville.edu'
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
param alertEmail = 'nbiggs112@cedarville.edu'
// Real ProxID resolver URL template is supplied at deploy time via the IDENTITY_API_URL
// GitHub 'dev' environment variable (-p identityApiUrl=... in deploy-dev.yml). Non-secret
// template; contains {CARD_CODE}/{KEY_NAME}/{KEY} placeholders, no key value.
param identityApiUrl = ''
param identityApiKeyName = 'ATTENDANCE'
// Enables the admin/setup page's token bootstrap on dev. Seed the `setup-token`
// secret in kv-attendance-dev BEFORE the next deploy, or the web app fails to
// resolve it:  az keyvault secret set --vault-name kv-attendance-dev --name setup-token --value "$(openssl rand -base64 24)"
// Remove this (and the KV secret) once an Administrator-role Canvas launch can reach /admin.html.
param setupTokenEnabled = true
// No secret value is committed: the password is read from the environment at
// compile time. The deploy pipeline / bootstrap exports PG_ADMIN_PASSWORD; for a
// local compile check, `export PG_ADMIN_PASSWORD=$(openssl rand -base64 24)` first.
// (An unset var fails BCP427 by design -- there is deliberately no fallback.)
param postgresAdministratorPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
