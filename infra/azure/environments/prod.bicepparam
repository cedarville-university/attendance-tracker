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
param identityApiUrl = ''
param identityApiKeyName = 'attendance-resolver'
