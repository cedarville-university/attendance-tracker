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
param identityApiUrl = ''
param identityApiKeyName = 'attendance-resolver'
