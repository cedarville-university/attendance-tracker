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
