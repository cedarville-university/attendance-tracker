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
param identityApiUrl = '' // CHANGEME: real Identity API base URL required before go-live
param identityApiKeyName = 'attendance-resolver'
// No secret value is committed: the password is read from the environment at
// compile time. The deploy pipeline / bootstrap exports PG_ADMIN_PASSWORD; for a
// local compile check, `export PG_ADMIN_PASSWORD=$(openssl rand -base64 24)` first.
// (An unset var fails BCP427 by design -- there is deliberately no fallback.)
param postgresAdministratorPassword = readEnvironmentVariable('PG_ADMIN_PASSWORD')
