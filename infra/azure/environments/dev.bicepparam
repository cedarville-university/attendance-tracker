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
param identityApiUrl = ''
param identityApiKeyName = 'attendance-resolver'
