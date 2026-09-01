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
@description('Container image ref (registry/repo:tag). Supplied by the deploy pipeline on the CLI; never committed to a .bicepparam.')
param containerImage string = 'REPLACED_BY_PIPELINE'
@description('Postgres administrator password. Supplied on the CLI from the bootstrap / deploy workflow; never committed (spec §36).')
@secure()
param postgresAdministratorPassword string
@description('Identity API base URL for the real ProxID resolver (decision #3). Non-secret; empty disables the HTTP resolver.')
param identityApiUrl string = ''
param identityApiKeyName string = 'attendance-resolver'
@description('When true, wire SETUP_TOKEN into the web app from the `setup-token` Key Vault secret (admin/setup page bootstrap). Seed that secret in the vault BEFORE deploying, or the web deploy fails to resolve it. Enable in dev only.')
param setupTokenEnabled bool = false
@description('When false, skip creating the managed-identity role assignments in the foundation modules. Set false for CI/pipeline deploys — the assignments are created once at bootstrap by an Owner. Default true so a first bootstrap works.')
param deployRoleAssignments bool = true

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
    deployRoleAssignments: deployRoleAssignments
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
    deployRoleAssignments: deployRoleAssignments
  }
}

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
    logAnalyticsSharedKey: observability.outputs.workspacePrimarySharedKey
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
    appHostname: appHostname
    cpu: containerCpu
    memory: containerMemory
    minReplicas: webMinReplicas
    maxReplicas: webMaxReplicas
    identityApiUrl: identityApiUrl
    identityApiKeyName: identityApiKeyName
    setupTokenEnabled: setupTokenEnabled
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
    appBaseUrl: 'https://${appHostname}'
    allowedTargetLinkUris: 'https://${appHostname}/index.html'
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

output containerRegistryLoginServer string = registry.outputs.loginServer
output managedIdentityId string = identity.outputs.id
output managedIdentityClientId string = identity.outputs.clientId
output managedIdentityPrincipalId string = identity.outputs.principalId
output keyVaultName string = keyvault.outputs.name
output keyVaultUri string = keyvault.outputs.uri
output logAnalyticsWorkspaceId string = observability.outputs.workspaceId
@secure()
output appInsightsConnectionString string = observability.outputs.appInsightsConnectionString
output webAppFqdn string = web.outputs.fqdn
output webAppName string = web.outputs.name
output workerJobName string = workerJob.outputs.name
output postgresFqdn string = postgres.outputs.fqdn
